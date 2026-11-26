import {
  normalizeProductRef,
  type CodeBinding,
  type DocFile,
  type DocSymbolShape,
  type ProductDoc,
} from "@necronomidoc/docmodel";
import { compact, detailOf, fileRow, oneLine, symbolSummary, symbolView, type Detail } from "./detail.js";
import { isUseful, pickBestAnswer, prepareQuery, rankHits, type PreparedQuery, type RankedHit } from "./ranking.js";
import { productSummary } from "./search.js";
import type { ManifestStore } from "./store.js";

/** Offset-based opaque cursor. */
export function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}
export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

const SEARCH_PAGE = 15;
const FILES_PAGE = 75;

export interface ToolResult {
  [key: string]: unknown;
}

/**
 * Out-of-band marker a tool sets on a result that failed the agent (no
 * useful hit). Symbol-keyed, so `JSON.stringify` never sends it; the MCP
 * server reads it to feed the miss log (decision 0024).
 */
export const MISS = Symbol.for("necronomidoc.miss");
export interface MissInfo {
  query: string;
  repo?: string;
  hits: number;
  topScore?: number;
}
export function markMiss<T extends ToolResult>(result: T, info: MissInfo): T {
  (result as Record<symbol, unknown>)[MISS] = info;
  return result;
}

/** Keeps a giant spec's get_file_doc response under client tool-result caps. */
const ENDPOINTS_MAX = 300;

/**
 * Group a spec file's endpoint symbols by their first OpenAPI tag — the
 * compact "is there already an endpoint that does X?" index (slice 4 §3).
 */
function endpointsByTag(file: DocFile, detail: Detail): {
  endpointsByTag: { tag: string; endpoints: ToolResult[] }[];
  endpointsTruncated?: number;
} {
  const groups = new Map<string, ToolResult[]>();
  let total = 0;
  let truncated = 0;
  for (const s of file.symbols) {
    if (s.kind !== "endpoint") continue;
    if (total >= ENDPOINTS_MAX) {
      truncated++;
      continue;
    }
    total++;
    const tag = s.doc?.tags.find((t) => t.tag === "tag")?.text ?? "untagged";
    const list = groups.get(tag) ?? [];
    list.push(
      detail === "brief"
        ? { id: s.id, endpoint: s.name }
        : {
            id: s.id,
            endpoint: s.name,
            line: s.location.line,
            summary: s.enrichment?.summary ?? s.doc?.summary,
            deprecated: s.doc?.deprecated ? true : undefined,
          },
    );
    groups.set(tag, list);
  }
  return {
    endpointsByTag: [...groups.entries()].map(([tag, endpoints]) => ({ tag, endpoints })),
    endpointsTruncated: truncated > 0 ? truncated : undefined,
  };
}

/** Compact list row for a product doc. */
export function productDigest(doc: ProductDoc, detail: Detail = "normal"): ToolResult {
  if (detail === "brief") return { id: doc.id, type: doc.type, title: doc.title };
  return {
    id: doc.id,
    type: doc.type,
    title: doc.title,
    status: doc.status,
    statement: productSummary(doc),
    provenance: doc.provenance,
    stale: doc.stale || undefined,
  };
}

/** Does a binding point at this file (or a symbol in it / a dir containing it)? */
export function bindingHitsPath(binding: CodeBinding, path: string, symbol?: string): boolean {
  const t = binding.target;
  if (!t) return false;
  if (t.kind === "dir") return path === t.path || path.startsWith(`${t.path}/`);
  if (t.path !== path) return false;
  if (!symbol || t.kind === "file") return true;
  return t.name === symbol || t.name?.startsWith(`${symbol}.`) === true;
}

/**
 * The product docs whose code bindings run through a file (or symbol): the
 * sessions with the steps that touch it and the outcomes to preserve, and the
 * stories with acceptance criteria to keep true. Shared by
 * find_intents_for_code, check_change and get_context_for_task.
 */
export function intentsForCode(
  store: ManifestStore,
  repo: string,
  path: string,
  symbol: string | undefined,
  detail: Detail,
): ToolResult[] {
  const product = store.getProduct(repo);
  if (!product) return [];
  return product.docs.flatMap((doc): ToolResult[] => {
    const bindings = doc.bindings.filter((b) => bindingHitsPath(b, path, symbol));
    if (bindings.length === 0) return [];
    if (detail === "brief") {
      return [
        compact({
          ...productDigest(doc, "brief"),
          keep:
            doc.type === "session"
              ? doc.outcomes.map((o) => `${doc.id}.${o.id}`)
              : doc.type === "story"
                ? doc.acceptance.map((a) => `${doc.id}.${a.id}`)
                : undefined,
        }),
      ];
    }
    const base = {
      ...productDigest(doc),
      via: bindings.map((b) => ({ ref: b.ref, step: b.step, state: b.state })),
      ...(detail === "full" ? { tests: doc.tests.map((t) => `${t.path}:${t.line} [${t.ref}]`) } : {}),
    };
    if (doc.type === "session") {
      const steps = new Set(bindings.map((b) => b.step).filter(Boolean));
      return [
        {
          ...base,
          intent: doc.intent,
          job: doc.job,
          steps: doc.steps.filter((s) => steps.has(s.id)).map((s) => ({ id: s.id, action: s.action, expects: s.expects })),
          outcomesToPreserve: doc.outcomes.map((o) => ({ id: `${doc.id}.${o.id}`, kind: o.kind, title: o.title, criteria: o.criteria })),
        },
      ];
    }
    if (doc.type === "story") {
      return [
        {
          ...base,
          acceptanceToPreserve: doc.acceptance.map((a) => ({ id: `${doc.id}.${a.id}`, title: a.title, text: a.text })),
          requirements: doc.requirements.map((r) => `${doc.id}.${r.id}: ${r.text}`),
        },
      ];
    }
    return [base];
  });
}

const PRODUCT_BODY_MAX = 6000;
const FULL_TEXT_MAX = 30_000;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text;
}

/** Curated synonyms of every repo in scope, merged. */
function synonymsFor(store: ManifestStore, repo?: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const slugs = repo ? [repo] : store.listRepos().map((r) => r.slug);
  for (const slug of slugs) {
    for (const [k, v] of Object.entries(store.getAgent(slug)?.synonyms ?? {})) {
      out[k] = [...new Set([...(out[k] ?? []), ...v])];
    }
  }
  return out;
}

/** Ranked, collapsed search (decision 0024) — the engine behind search_docs and the task tools. */
export function rankedSearch(
  store: ManifestStore,
  query: string,
  repo?: string,
): { ranked: RankedHit[]; prepared: PreparedQuery } {
  const prepared = prepareQuery(query, synonymsFor(store, repo));
  const raw = store.search(prepared.text, repo);
  const ranked = rankHits(raw, query, prepared, {
    exported: (id) => store.getSymbolById(id)?.exported,
  });
  return { ranked, prepared };
}

/** One search hit at the requested detail level. */
function hitView(store: ManifestStore, h: RankedHit, detail: Detail): ToolResult {
  if (detail === "brief") {
    return compact({ id: h.id, type: h.type, path: h.path, name: h.name, summary: oneLine(h.summary), matches: h.matches?.map((m) => m.name) });
  }
  const base: ToolResult = {
    id: h.id,
    type: h.type,
    repo: h.repo,
    path: h.path,
    name: h.name,
    kind: h.kind,
    summary: h.summary,
    ...(h.matches ? { matches: h.matches } : {}),
    ...(h.fileSummary ? { fileSummary: h.fileSummary } : {}),
  };
  if (detail === "full") {
    const symbol = h.type === "symbol" ? store.getSymbolById(h.id) : undefined;
    base["score"] = Math.round(h.score * 100) / 100;
    base["coverage"] = Math.round(h.coverage * 100) / 100;
    if (symbol) base["signature"] = symbol.signature;
    if (h.type === "file" || h.type === "symbol") base["trust"] = store.trustFor(h.repo, h.path, symbol);
  }
  return base;
}

/**
 * The best answer, expanded enough to act on without a follow-up call:
 * signature, purpose, trust, invariants and one real call site.
 */
export function bestAnswerView(store: ManifestStore, h: RankedHit, confidence: string, reason: string): ToolResult {
  const symbol = h.type === "symbol" ? store.getSymbolById(h.id) : undefined;
  const file = h.type === "file" || h.type === "symbol" ? store.getFile(h.repo, h.path) : undefined;
  return compact({
    id: h.id,
    type: h.type,
    repo: h.repo,
    path: h.path,
    name: h.name,
    kind: h.kind,
    signature: symbol?.signature,
    purpose: symbol ? symbolSummary(symbol) : h.summary,
    trust: file ? store.trustFor(h.repo, h.path, symbol) : undefined,
    invariants: file ? store.invariantsFor(h.repo, h.path, symbol) : undefined,
    usage: symbol ? store.getAgent(h.repo)?.usages[symbol.id]?.[0] : undefined,
    confidence,
    reason,
  });
}

/** Up to three close symbol names for a failed lookup. */
function didYouMean(store: ManifestStore, repo: string, name: string): string[] {
  const { ranked } = rankedSearch(store, name, repo);
  return ranked.filter((h) => h.type === "symbol").slice(0, 3).map((h) => `${h.name} (${h.id})`);
}

/** Symbols of a file narrowed to one name (and its members). */
function narrowSymbols(file: DocFile, symbol: string | undefined): DocSymbolShape[] {
  if (!symbol) return file.symbols;
  const out: DocSymbolShape[] = [];
  const walk = (list: DocSymbolShape[], prefix: string): void => {
    for (const s of list) {
      const dotted = prefix ? `${prefix}.${s.name}` : s.name;
      if (s.name === symbol || dotted === symbol) out.push(s);
      else if (s.members) walk(s.members, dotted);
    }
  };
  walk(file.symbols, "");
  return out;
}

/** The ten established documentation tools (now detail-aware). */
export const coreTools = {
  list_repos(store: ManifestStore, args: { detail?: Detail } = {}): ToolResult {
    const detail = detailOf(args.detail);
    return {
      repos: store.listRepos().map((r) =>
        detail === "brief"
          ? { slug: r.slug, name: r.name, summary: oneLine(r.summary) }
          : {
              slug: r.slug,
              name: r.name,
              files: r.fileCount,
              symbols: r.symbolCount,
              summary: r.summary,
              enrichment: r.enrichment,
              ...(detail === "full" ? { version: store.getVersions(r.slug)?.versions[0]?.version, commit: store.getVersions(r.slug)?.versions[0]?.commit } : {}),
            },
      ),
    };
  },

  search_docs(
    store: ManifestStore,
    args: { query: string; repo?: string; cursor?: string; detail?: Detail },
  ): ToolResult {
    const detail = detailOf(args.detail);
    const { ranked } = rankedSearch(store, args.query, args.repo);
    const offset = decodeCursor(args.cursor);
    const page = ranked.slice(offset, offset + SEARCH_PAGE);
    const nextOffset = offset + SEARCH_PAGE;
    const best = offset === 0 ? pickBestAnswer(ranked, args.query) : undefined;
    const useful = ranked.filter(isUseful).length;
    const result: ToolResult = {
      query: args.query,
      total: ranked.length,
      ...(best ? { bestAnswer: bestAnswerView(store, best.hit, best.confidence, best.reason) } : {}),
      hits: page.map((h) => hitView(store, h, detail)),
      nextCursor: nextOffset < ranked.length ? encodeCursor(nextOffset) : undefined,
      ...(offset === 0 && useful === 0
        ? { note: "No hit covers this query — the concept may be undocumented or named differently. Try other words, get_context_for_task, or list_files." }
        : {}),
    };
    return useful === 0 && offset === 0
      ? markMiss(result, { query: args.query, repo: args.repo, hits: ranked.length, topScore: ranked[0]?.score })
      : result;
  },

  get_file_doc(
    store: ManifestStore,
    args: { repo: string; path: string; symbol?: string; detail?: Detail },
  ): ToolResult {
    const detail = detailOf(args.detail);
    const file = store.getFile(args.repo, args.path);
    if (!file) {
      const base = args.path.split("/").pop() ?? args.path;
      const near = store
        .listFiles(args.repo)
        .filter((f) => f.path.endsWith(`/${base}`) || f.path === base)
        .slice(0, 3)
        .map((f) => f.path);
      return { error: `No file "${args.path}" in repo "${args.repo}".`, ...(near.length ? { didYouMean: near } : {}) };
    }
    const symbols = narrowSymbols(file, args.symbol);
    if (args.symbol && symbols.length === 0) {
      return {
        error: `No symbol "${args.symbol}" in ${file.path}.`,
        symbols: file.symbols.map((s) => s.name),
      };
    }
    const invariants = store.invariantsFor(args.repo, file.path);
    const trust = store.trustFor(args.repo, file.path);

    if (detail === "brief") {
      return compact({
        repo: args.repo,
        path: file.path,
        format: file.format === "source" ? undefined : file.format,
        title: file.format === "source" ? undefined : file.title,
        purpose: oneLine(file.enrichment?.summary),
        trust,
        invariants,
        ...(file.format === "openapi" && !args.symbol
          ? endpointsByTag(file, "brief")
          : { symbols: symbols.map((s) => symbolView(store, args.repo, file.path, s, "brief")) }),
      });
    }

    // Prose documents return their body (bounded well under client caps).
    // Specs return their operations grouped by tag instead of the raw spec.
    const contentMax = detail === "full" ? FULL_TEXT_MAX : 8000;
    const contentExtra =
      args.symbol
        ? {}
        : file.format === "markdown" && file.content
          ? { format: file.format, title: file.title, content: truncate(file.content, contentMax) }
          : file.format === "openapi"
            ? { format: file.format, title: file.title, ...endpointsByTag(file, detail) }
            : {};
    return {
      repo: args.repo,
      path: file.path,
      ...contentExtra,
      purpose: file.enrichment?.summary,
      detail: file.enrichment?.purpose,
      provenance: file.enrichment?.provenance,
      stale: file.enrichment?.stale ?? false,
      trust,
      ...(invariants.length > 0 ? { invariants } : {}),
      moduleDoc: file.moduleDoc?.summary,
      imports: file.imports.map((i) => i.moduleSpecifier),
      exports: file.exports,
      // Spec files already list every operation in endpointsByTag — repeating
      // them as symbol digests would double a large spec's response size.
      symbols:
        file.format === "openapi" && !args.symbol
          ? undefined
          : symbols.map((s) => symbolView(store, args.repo, file.path, s, detail)),
      ...(detail === "full"
        ? compact({ usedBy: store.importersOf(args.repo, file.path), testedBy: store.testsFor(args.repo, file.path) })
        : {}),
    };
  },

  get_function_doc(
    store: ManifestStore,
    args: { repo: string; id?: string; name?: string; detail?: Detail },
  ): ToolResult {
    const detail = detailOf(args.detail);
    let symbol: DocSymbolShape | undefined;
    if (args.id) symbol = store.getSymbolById(args.id);
    else if (args.name) symbol = store.findSymbolByName(args.repo, args.name);
    if (!symbol) {
      const near = args.name || args.id ? didYouMean(store, args.repo, args.name ?? args.id!.split("#").pop() ?? "") : [];
      const result: ToolResult = {
        error: `Symbol not found (id=${args.id ?? "-"}, name=${args.name ?? "-"}).`,
        ...(near.length > 0 ? { didYouMean: near } : {}),
      };
      return markMiss(result, { query: args.name ?? args.id ?? "", repo: args.repo, hits: near.length });
    }
    const file = store.fileOfSymbol(symbol.id);
    const repo = symbol.id.split(":")[0]!;
    const path = file?.path ?? symbol.location.path;
    if (detail === "brief") return { ...symbolView(store, repo, path, symbol, "brief"), path };
    const invariants = store.invariantsFor(repo, path, symbol);
    const usages = store.getAgent(repo)?.usages[symbol.id];
    return {
      id: symbol.id,
      name: symbol.name,
      kind: symbol.kind,
      exported: symbol.exported,
      path: file?.path,
      location: symbol.location,
      signature: symbol.signature,
      doc: symbol.doc,
      props: symbol.props,
      members: symbol.members?.map((m) => symbolView(store, repo, path, m, detail === "full" ? "normal" : "brief")),
      enrichment: symbol.enrichment,
      trust: store.trustFor(repo, path, symbol),
      ...(invariants.length > 0 ? { invariants } : {}),
      ...(usages?.length ? { usages } : {}),
      ...(detail === "full"
        ? compact({ usedBy: store.importersOf(repo, path), testedBy: store.testsFor(repo, path) })
        : {}),
    };
  },

  get_core_doc(store: ManifestStore, args: { repo: string; doc: string; detail?: Detail }): ToolResult {
    const detail = detailOf(args.detail);
    const manifest = store.getCoreDocs(args.repo);
    if (!manifest) return { error: `No core docs published for repo "${args.repo}" — rebuild it.` };
    const doc = manifest.docs.find((d) => d.kind === args.doc);
    if (!doc) {
      return {
        error: `Unknown core doc "${args.doc}" — one of: ${manifest.docs.map((d) => d.kind).join(", ")}.`,
      };
    }
    const max = detail === "brief" ? 1500 : detail === "full" ? 40_000 : 12_000;
    return {
      repo: args.repo,
      doc: doc.kind,
      title: doc.title,
      provenance: doc.provenance,
      stale: doc.stale,
      ...(detail === "brief"
        ? { sections: (doc.content.match(/^#{1,3} .+$/gm) ?? []).map((h) => h.replace(/^#+\s*/, "")) }
        : { updatedAt: doc.updatedAt }),
      content: truncate(doc.content, max),
    };
  },

  get_subsystem_overview(
    store: ManifestStore,
    args: { repo: string; dir?: string; detail?: Detail },
  ): ToolResult {
    const detail = detailOf(args.detail);
    const files = store.listFiles(args.repo);
    if (files.length === 0) return { error: `No repo "${args.repo}".` };

    const prefix = args.dir?.replace(/\/+$/, "");
    const manifest = store.getSubsystems(args.repo);

    // Curated (or heuristic-published) subsystem map: purpose + boundaries +
    // entry points, with each subsystem's files resolved by dir prefix.
    if (manifest && manifest.subsystems.length > 0) {
      const inSubsystem = (path: string, dirs: string[]): boolean =>
        dirs.length === 0
          ? !path.includes("/") // dir-less subsystems own root files
          : dirs.some((d) => path === d || path.startsWith(`${d.replace(/\/+$/, "")}/`));

      const FILES_MAX = detail === "full" ? 200 : 30;
      // Name/inbound-edge indexes over the WHOLE map, so a scoped query still
      // reports who references the selected subsystems (both-way relationships).
      const nameById = new Map(manifest.subsystems.map((s) => [s.id, s.name]));
      const inboundById = new Map<string, { from: string; fromId: string; relation: string }[]>();
      for (const s of manifest.subsystems) {
        for (const r of s.related) {
          if (!r.to || !nameById.has(r.to)) continue;
          const list = inboundById.get(r.to) ?? [];
          list.push({ from: s.name, fromId: s.id, relation: r.relation });
          inboundById.set(r.to, list);
        }
      }
      // Keep the pre-existing `{ name, relation }` shape (name = the target's
      // display label) and add `to` = the internal subsystem id when the edge
      // resolves, so old consumers keep working and new ones can navigate.
      const namedRelated = (rel: typeof manifest.subsystems[number]["related"]) =>
        rel.map((r) => {
          const internal = r.to && nameById.has(r.to);
          return {
            name: internal ? nameById.get(r.to!) : r.name,
            ...(internal ? { to: r.to } : {}),
            relation: r.relation,
          };
        });

      const selected = manifest.subsystems.filter(
        (s) =>
          !prefix ||
          s.dirs.some((d) => d === prefix || d.startsWith(`${prefix}/`) || prefix.startsWith(`${d}/`)),
      );
      if (selected.length > 0) {
        const claimed = new Set<string>();
        const subsystems = selected.map((s) => {
          const owned = files.filter((f) => inSubsystem(f.path, s.dirs));
          owned.forEach((f) => claimed.add(f.path));
          if (detail === "brief") {
            return compact({
              id: s.id,
              name: s.name,
              purpose: oneLine(s.purpose),
              dirs: s.dirs,
              fileCount: owned.length,
              invariants: s.invariants,
            });
          }
          return {
            id: s.id,
            name: s.name,
            purpose: s.purpose,
            owns: s.owns,
            doesNotOwn: s.notOwns,
            ...(s.invariants.length > 0 ? { invariants: s.invariants } : {}),
            entryPoints: s.entryPoints,
            related: namedRelated(s.related),
            referencedBy: inboundById.get(s.id) ?? [],
            dirs: s.dirs,
            provenance: s.provenance,
            fileCount: owned.length,
            files: owned.slice(0, FILES_MAX).map((f) => ({
              path: f.path,
              purpose: f.enrichment?.summary,
              ...(detail === "full" ? { exports: f.symbols.filter((x) => x.exported).map((x) => x.name) } : {}),
            })),
            filesTruncated: owned.length > FILES_MAX ? owned.length - FILES_MAX : undefined,
          };
        });
        const unclaimed = files.filter((f) => !claimed.has(f.path)).length;
        return {
          repo: args.repo,
          scope: prefix ?? "(whole repo)",
          curated: manifest.subsystems.some((s) => s.provenance !== "heuristic"),
          ...(manifest.overview && detail !== "brief" ? { overview: manifest.overview } : {}),
          subsystems,
          ...(prefix ? {} : { filesOutsideAnySubsystem: unclaimed }),
        };
      }
      // fall through: dir doesn't match any subsystem — use directory grouping
    }

    // Fallback: group files by the directory one level below the scope root.
    const scoped = prefix
      ? files.filter((f) => f.path.startsWith(`${prefix}/`) || f.path === prefix)
      : files;
    const groupKey = (f: DocFile): string => {
      const rest = prefix ? f.path.slice(prefix.length + 1) : f.path;
      const seg = rest.split("/");
      return seg.length > 1 ? (prefix ? `${prefix}/${seg[0]}` : seg[0]!) : prefix || ".";
    };

    const groups = new Map<string, DocFile[]>();
    for (const f of scoped) {
      const key = groupKey(f);
      const list = groups.get(key) ?? [];
      list.push(f);
      groups.set(key, list);
    }

    return {
      repo: args.repo,
      scope: prefix ?? "(repo root)",
      curated: false,
      subsystems: [...groups.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([dir, dirFiles]) => ({
          dir,
          fileCount: dirFiles.length,
          files: dirFiles.map((f) =>
            detail === "brief"
              ? { path: f.path }
              : {
                  path: f.path,
                  purpose: f.enrichment?.summary,
                  exports: f.symbols.filter((s) => s.exported).map((s) => s.name),
                },
          ),
        })),
    };
  },

  get_product_overview(store: ManifestStore, args: { repo: string; detail?: Detail }): ToolResult {
    const detail = detailOf(args.detail);
    const product = store.getProduct(args.repo);
    if (!product) return { error: `No product docs published for repo "${args.repo}" — rebuild it with a current server.` };
    const byType = (type: ProductDoc["type"]) => product.docs.filter((d) => d.type === type).map((d) => productDigest(d, detail));
    const errors = product.findings.filter((f) => f.level === "error");
    const hint =
      product.source === "none"
        ? { hint: "No product docs yet: write docs/product/ (necronomidoc product init / product new) or run `necronomidoc enrich --product` for drafts." }
        : {};
    if (detail === "brief") {
      return {
        repo: args.repo,
        source: product.source,
        stale: product.stale,
        personas: byType("persona"),
        jobs: byType("job"),
        sessions: byType("session"),
        stories: byType("story"),
        journeys: byType("journey"),
        epics: byType("epic"),
        findings: { errors: errors.length },
        ...hint,
      };
    }
    const surfacesMax = detail === "full" ? 500 : 40;
    const errorsMax = detail === "full" ? 200 : 10;
    return {
      repo: args.repo,
      source: product.source,
      stale: product.stale,
      overview: product.overview?.slice(0, detail === "full" ? 12_000 : 3000),
      personas: byType("persona"),
      jobs: byType("job"),
      sessions: product.docs
        .filter((d) => d.type === "session")
        .map((d) => ({
          ...productDigest(d),
          job: d.type === "session" ? d.job : undefined,
          outcomes: d.type === "session" ? d.outcomes.map((o) => `${o.id} ${o.kind}: ${o.title}`) : undefined,
        })),
      journeys: byType("journey"),
      epics: byType("epic"),
      stories: byType("story"),
      coverage: product.coverage,
      uncoveredSurfaces: product.surfaces.filter((s) => s.coveredBy.length === 0).slice(0, surfacesMax).map((s) => `${s.kind}: ${s.name} (${s.path})`),
      findings: { errors: errors.length, warnings: product.findings.filter((f) => f.level === "warn").length, topErrors: errors.slice(0, errorsMax).map((f) => `${f.docId ?? f.path ?? ""}: ${f.message}`) },
      ...hint,
    };
  },

  get_product_doc(store: ManifestStore, args: { repo: string; id: string; detail?: Detail }): ToolResult {
    const detail = detailOf(args.detail);
    const product = store.getProduct(args.repo);
    if (!product) return { error: `No product docs published for repo "${args.repo}".` };
    const key = normalizeProductRef(args.id);
    const doc = product.docs.find((d) => normalizeProductRef(d.id) === key);
    if (!doc) return { error: `No product doc "${args.id}" in "${args.repo}" — call get_product_overview for the ids.` };
    if (detail === "brief") {
      return compact({
        repo: args.repo,
        ...productDigest(doc, "normal"),
        path: doc.path,
        keep:
          doc.type === "session"
            ? doc.outcomes.map((o) => `${doc.id}.${o.id} ${o.kind}: ${o.title}`)
            : doc.acceptance.map((a) => `${doc.id}.${a.id}: ${a.title}`),
      });
    }
    const titles = new Map(product.docs.map((d) => [d.id, d.title]));
    const { body, diagrams, docHash, referencedBy, ...fields } = doc;
    return {
      repo: args.repo,
      ...fields,
      statement: productSummary(doc),
      referencedBy: referencedBy.map((l) => ({ ...l, title: titles.get(l.id) })),
      findings: product.findings.filter((f) => f.docId === doc.id).map((f) => `${f.level}: ${f.message}`),
      flowDiagram: diagrams.flow,
      ...(detail === "full" ? { diagrams } : {}),
      body: truncate(body, detail === "full" ? FULL_TEXT_MAX : PRODUCT_BODY_MAX),
    };
  },

  find_intents_for_code(
    store: ManifestStore,
    args: { repo: string; path: string; symbol?: string; detail?: Detail },
  ): ToolResult {
    const detail = detailOf(args.detail);
    const product = store.getProduct(args.repo);
    if (!product) return { error: `No product docs published for repo "${args.repo}".` };
    const path = args.path.replace(/^\.\//, "");
    const hits = intentsForCode(store, args.repo, path, args.symbol, detail);
    return {
      repo: args.repo,
      path,
      symbol: args.symbol,
      intents: hits,
      ...(hits.length === 0
        ? { note: "No product doc binds to this code. Either it is not user-facing, or the sessions/stories that exercise it don't list it in `code:` yet." }
        : { note: "Changing this code can affect these user intents — keep the listed outcomes and acceptance criteria true, and run the tests citing their ids (check_change lists them)." }),
    };
  },

  list_files(store: ManifestStore, args: { repo: string; cursor?: string; detail?: Detail }): ToolResult {
    const detail = detailOf(args.detail);
    const files = store.listFiles(args.repo);
    const offset = decodeCursor(args.cursor);
    const pageSize = detail === "brief" ? FILES_PAGE * 2 : FILES_PAGE;
    const page = files.slice(offset, offset + pageSize);
    const nextOffset = offset + pageSize;
    return {
      repo: args.repo,
      total: files.length,
      files: page.map((f) => fileRow(store, args.repo, f, detail)),
      nextCursor: nextOffset < files.length ? encodeCursor(nextOffset) : undefined,
    };
  },
};
