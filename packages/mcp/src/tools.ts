import {
  normalizeProductRef,
  type CodeBinding,
  type DocFile,
  type DocSymbolShape,
  type ProductDoc,
} from "@necronomidoc/docmodel";
import { productSummary } from "./search.js";
import type { ManifestStore } from "./store.js";

/** Offset-based opaque cursor. */
function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

const SEARCH_PAGE = 15;
const FILES_PAGE = 75;

function symbolDigest(s: DocSymbolShape) {
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    exported: s.exported,
    line: s.location.line,
    signature: s.signature,
    summary: s.enrichment?.summary ?? s.doc?.summary,
    provenance: s.enrichment?.provenance,
    stale: s.enrichment?.stale ?? false,
  };
}

export interface ToolResult {
  [key: string]: unknown;
}

/** Keeps a giant spec's get_file_doc response under client tool-result caps. */
const ENDPOINTS_MAX = 300;

/**
 * Group a spec file's endpoint symbols by their first OpenAPI tag — the
 * compact "is there already an endpoint that does X?" index (slice 4 §3).
 */
function endpointsByTag(file: DocFile): {
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
    list.push({
      id: s.id,
      endpoint: s.name,
      line: s.location.line,
      summary: s.enrichment?.summary ?? s.doc?.summary,
      deprecated: s.doc?.deprecated ? true : undefined,
    });
    groups.set(tag, list);
  }
  return {
    endpointsByTag: [...groups.entries()].map(([tag, endpoints]) => ({ tag, endpoints })),
    endpointsTruncated: truncated > 0 ? truncated : undefined,
  };
}

/** Compact list row for a product doc. */
function productDigest(doc: ProductDoc): ToolResult {
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
function bindingHitsPath(binding: CodeBinding, path: string, symbol?: string): boolean {
  const t = binding.target;
  if (!t) return false;
  if (t.kind === "dir") return path === t.path || path.startsWith(`${t.path}/`);
  if (t.path !== path) return false;
  if (!symbol || t.kind === "file") return true;
  return t.name === symbol || t.name?.startsWith(`${symbol}.`) === true;
}

const PRODUCT_BODY_MAX = 6000;

export const tools = {
  list_repos(store: ManifestStore): ToolResult {
    return {
      repos: store.listRepos().map((r) => ({
        slug: r.slug,
        name: r.name,
        files: r.fileCount,
        symbols: r.symbolCount,
        summary: r.summary,
        enrichment: r.enrichment,
      })),
    };
  },

  search_docs(
    store: ManifestStore,
    args: { query: string; repo?: string; cursor?: string },
  ): ToolResult {
    const all = store.search(args.query, args.repo);
    const offset = decodeCursor(args.cursor);
    const page = all.slice(offset, offset + SEARCH_PAGE);
    const nextOffset = offset + SEARCH_PAGE;
    return {
      query: args.query,
      total: all.length,
      hits: page.map((h) => ({
        id: h.id,
        type: h.type,
        repo: h.repo,
        path: h.path,
        name: h.name,
        kind: h.kind,
        summary: h.summary,
      })),
      nextCursor: nextOffset < all.length ? encodeCursor(nextOffset) : undefined,
    };
  },

  get_file_doc(store: ManifestStore, args: { repo: string; path: string }): ToolResult {
    const file = store.getFile(args.repo, args.path);
    if (!file) return { error: `No file "${args.path}" in repo "${args.repo}".` };
    // Prose documents return their body (bounded well under client caps).
    // Specs return their operations grouped by tag instead of the raw spec.
    const CONTENT_MAX = 8000;
    const contentExtra =
      file.format === "markdown" && file.content
        ? {
            format: file.format,
            title: file.title,
            content:
              file.content.length > CONTENT_MAX
                ? `${file.content.slice(0, CONTENT_MAX)}\n…(truncated)`
                : file.content,
          }
        : file.format === "openapi"
          ? { format: file.format, title: file.title, ...endpointsByTag(file) }
          : {};
    return {
      repo: args.repo,
      path: file.path,
      ...contentExtra,
      purpose: file.enrichment?.summary,
      detail: file.enrichment?.purpose,
      provenance: file.enrichment?.provenance,
      stale: file.enrichment?.stale ?? false,
      moduleDoc: file.moduleDoc?.summary,
      imports: file.imports.map((i) => i.moduleSpecifier),
      exports: file.exports,
      // Spec files already list every operation in endpointsByTag — repeating
      // them as symbol digests would double a large spec's response size.
      symbols: file.format === "openapi" ? undefined : file.symbols.map(symbolDigest),
    };
  },

  get_function_doc(
    store: ManifestStore,
    args: { repo: string; id?: string; name?: string },
  ): ToolResult {
    let symbol: DocSymbolShape | undefined;
    if (args.id) symbol = store.getSymbolById(args.id);
    else if (args.name) symbol = store.findSymbolByName(args.repo, args.name);
    if (!symbol) return { error: `Symbol not found (id=${args.id ?? "-"}, name=${args.name ?? "-"}).` };
    const file = store.fileOfSymbol(symbol.id);
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
      members: symbol.members?.map(symbolDigest),
      enrichment: symbol.enrichment,
    };
  },

  get_core_doc(store: ManifestStore, args: { repo: string; doc: string }): ToolResult {
    const manifest = store.getCoreDocs(args.repo);
    if (!manifest) return { error: `No core docs published for repo "${args.repo}" — rebuild it.` };
    const doc = manifest.docs.find((d) => d.kind === args.doc);
    if (!doc) {
      return {
        error: `Unknown core doc "${args.doc}" — one of: ${manifest.docs.map((d) => d.kind).join(", ")}.`,
      };
    }
    const CORE_DOC_MAX = 12_000;
    return {
      repo: args.repo,
      doc: doc.kind,
      title: doc.title,
      provenance: doc.provenance,
      stale: doc.stale,
      updatedAt: doc.updatedAt,
      content:
        doc.content.length > CORE_DOC_MAX
          ? `${doc.content.slice(0, CORE_DOC_MAX)}\n…(truncated)`
          : doc.content,
    };
  },

  get_subsystem_overview(
    store: ManifestStore,
    args: { repo: string; dir?: string },
  ): ToolResult {
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

      const FILES_MAX = 30;
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
          return {
            id: s.id,
            name: s.name,
            purpose: s.purpose,
            owns: s.owns,
            doesNotOwn: s.notOwns,
            entryPoints: s.entryPoints,
            related: namedRelated(s.related),
            referencedBy: inboundById.get(s.id) ?? [],
            dirs: s.dirs,
            provenance: s.provenance,
            fileCount: owned.length,
            files: owned.slice(0, FILES_MAX).map((f) => ({
              path: f.path,
              purpose: f.enrichment?.summary,
            })),
            filesTruncated: owned.length > FILES_MAX ? owned.length - FILES_MAX : undefined,
          };
        });
        const unclaimed = files.filter((f) => !claimed.has(f.path)).length;
        return {
          repo: args.repo,
          scope: prefix ?? "(whole repo)",
          curated: manifest.subsystems.some((s) => s.provenance !== "heuristic"),
          ...(manifest.overview ? { overview: manifest.overview } : {}),
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
          files: dirFiles.map((f) => ({
            path: f.path,
            purpose: f.enrichment?.summary,
            exports: f.symbols.filter((s) => s.exported).map((s) => s.name),
          })),
        })),
    };
  },

  get_product_overview(store: ManifestStore, args: { repo: string }): ToolResult {
    const product = store.getProduct(args.repo);
    if (!product) return { error: `No product docs published for repo "${args.repo}" — rebuild it with a current server.` };
    const byType = (type: ProductDoc["type"]) => product.docs.filter((d) => d.type === type).map(productDigest);
    const errors = product.findings.filter((f) => f.level === "error");
    return {
      repo: args.repo,
      source: product.source,
      stale: product.stale,
      overview: product.overview?.slice(0, 3000),
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
      uncoveredSurfaces: product.surfaces.filter((s) => s.coveredBy.length === 0).slice(0, 40).map((s) => `${s.kind}: ${s.name} (${s.path})`),
      findings: { errors: errors.length, warnings: product.findings.filter((f) => f.level === "warn").length, topErrors: errors.slice(0, 10).map((f) => `${f.docId ?? f.path ?? ""}: ${f.message}`) },
      ...(product.source === "none"
        ? { hint: "No product docs yet: write docs/product/ (necronomidoc product init / product new) or run `necronomidoc enrich --product` for drafts." }
        : {}),
    };
  },

  get_product_doc(store: ManifestStore, args: { repo: string; id: string }): ToolResult {
    const product = store.getProduct(args.repo);
    if (!product) return { error: `No product docs published for repo "${args.repo}".` };
    const key = normalizeProductRef(args.id);
    const doc = product.docs.find((d) => normalizeProductRef(d.id) === key);
    if (!doc) return { error: `No product doc "${args.id}" in "${args.repo}" — call get_product_overview for the ids.` };
    const titles = new Map(product.docs.map((d) => [d.id, d.title]));
    const { body, diagrams, docHash, referencedBy, ...fields } = doc;
    return {
      repo: args.repo,
      ...fields,
      statement: productSummary(doc),
      referencedBy: referencedBy.map((l) => ({ ...l, title: titles.get(l.id) })),
      findings: product.findings.filter((f) => f.docId === doc.id).map((f) => `${f.level}: ${f.message}`),
      flowDiagram: diagrams.flow,
      body: body.length > PRODUCT_BODY_MAX ? `${body.slice(0, PRODUCT_BODY_MAX)}\n…(truncated)` : body,
    };
  },

  find_intents_for_code(
    store: ManifestStore,
    args: { repo: string; path: string; symbol?: string },
  ): ToolResult {
    const product = store.getProduct(args.repo);
    if (!product) return { error: `No product docs published for repo "${args.repo}".` };
    const path = args.path.replace(/^\.\//, "");
    const hits = product.docs.flatMap((doc) => {
      const bindings = doc.bindings.filter((b) => bindingHitsPath(b, path, args.symbol));
      if (bindings.length === 0) return [];
      const base = { ...productDigest(doc), via: bindings.map((b) => ({ ref: b.ref, step: b.step, state: b.state })) };
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
    return {
      repo: args.repo,
      path,
      symbol: args.symbol,
      intents: hits,
      ...(hits.length === 0
        ? { note: "No product doc binds to this code. Either it is not user-facing, or the sessions/stories that exercise it don't list it in `code:` yet." }
        : { note: "Changing this code can affect these user intents — keep the listed outcomes and acceptance criteria true, and run the tests citing their ids." }),
    };
  },

  list_files(store: ManifestStore, args: { repo: string; cursor?: string }): ToolResult {
    const files = store.listFiles(args.repo);
    const offset = decodeCursor(args.cursor);
    const page = files.slice(offset, offset + FILES_PAGE);
    const nextOffset = offset + FILES_PAGE;
    return {
      repo: args.repo,
      total: files.length,
      files: page.map((f) => ({
        path: f.path,
        purpose: f.enrichment?.summary,
        provenance: f.enrichment?.provenance,
        stale: f.enrichment?.stale ?? false,
        symbols: f.symbols.length,
      })),
      nextCursor: nextOffset < files.length ? encodeCursor(nextOffset) : undefined,
    };
  },
};
