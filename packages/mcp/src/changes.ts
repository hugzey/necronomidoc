import type { DocFile, DocModel, DocSymbolShape, DocVersionEntry, ProductManifest, SubsystemsManifest } from "@necronomidoc/docmodel";
import { compact, detailOf, oneLine, symbolSummary, type Detail } from "./detail.js";
import type { ManifestStore } from "./store.js";
import type { ToolResult } from "./tools.js";

/**
 * Change-scoped answers (decision 0024): given a version number or commit an
 * agent last saw, return only what moved since — files, symbols, product
 * intents, code bindings and subsystems — diffed from the version journal's
 * per-version archive against the live state. A returning agent pays for a
 * small update instead of re-reading everything.
 */

interface State {
  model: DocModel;
  product?: ProductManifest;
  subsystems?: SubsystemsManifest;
}

function cap<T>(list: T[], max: number): { items: T[]; truncated?: number } {
  return list.length > max ? { items: list.slice(0, max), truncated: list.length - max } : { items: list };
}

function allSymbols(model: DocModel): Map<string, { s: DocSymbolShape; path: string }> {
  const out = new Map<string, { s: DocSymbolShape; path: string }>();
  for (const f of model.files) {
    const walk = (list: DocSymbolShape[]): void => {
      for (const s of list) {
        out.set(s.id, { s, path: f.path });
        if (s.members) walk(s.members);
      }
    };
    walk(f.symbols);
  }
  return out;
}

function docsFingerprint(f: { enrichment?: DocFile["enrichment"] }): string {
  const e = f.enrichment;
  return JSON.stringify([e?.summary, e?.purpose, e?.scope, e?.notes, e?.invariants, e?.provenance, e?.stale]);
}

function symbolRow(entry: { s: DocSymbolShape; path: string }, detail: Detail): ToolResult {
  const { s, path } = entry;
  if (detail === "brief") return { id: s.id, name: s.name };
  return compact({
    id: s.id,
    name: s.name,
    kind: s.kind,
    path,
    signature: s.signature,
    ...(detail === "full" ? { summary: oneLine(symbolSummary(s), 240) } : {}),
  });
}

/** Diff two published states. Pure; exported for tests. */
export function diffStates(before: State, after: State, detail: Detail = "normal"): ToolResult {
  const max = detail === "brief" ? 200 : 100;
  const oldFiles = new Map(before.model.files.map((f) => [f.path, f]));
  const newFiles = new Map(after.model.files.map((f) => [f.path, f]));
  const filesAdded = [...newFiles.keys()].filter((p) => !oldFiles.has(p)).sort();
  const filesRemoved = [...oldFiles.keys()].filter((p) => !newFiles.has(p)).sort();
  const filesChanged: string[] = [];
  const docsChanged: string[] = [];
  for (const [path, nf] of newFiles) {
    const of = oldFiles.get(path);
    if (!of) continue;
    if (of.contentHash !== nf.contentHash) filesChanged.push(path);
    else if (docsFingerprint(of) !== docsFingerprint(nf)) docsChanged.push(path);
  }

  const oldSyms = allSymbols(before.model);
  const newSyms = allSymbols(after.model);
  const symAdded = [...newSyms.keys()].filter((id) => !oldSyms.has(id)).sort();
  const symRemoved = [...oldSyms.keys()].filter((id) => !newSyms.has(id)).sort();
  const symChanged: ToolResult[] = [];
  const symDocsChanged: string[] = [];
  for (const [id, n] of newSyms) {
    const o = oldSyms.get(id);
    if (!o) continue;
    if (o.s.contentHash !== n.s.contentHash || o.s.signature !== n.s.signature) {
      symChanged.push({
        ...symbolRow(n, detail),
        ...(o.s.signature !== n.s.signature && detail !== "brief" ? { signatureWas: o.s.signature } : {}),
      });
    } else if (docsFingerprint(o.s) !== docsFingerprint(n.s)) {
      symDocsChanged.push(id);
    }
  }

  // Product intents + code bindings.
  const oldDocs = new Map((before.product?.docs ?? []).map((d) => [d.id, d]));
  const newDocs = new Map((after.product?.docs ?? []).map((d) => [d.id, d]));
  const intentsAdded = [...newDocs.values()].filter((d) => !oldDocs.has(d.id)).map((d) => `${d.id} ${d.title}`);
  const intentsRemoved = [...oldDocs.values()].filter((d) => !newDocs.has(d.id)).map((d) => `${d.id} ${d.title}`);
  const intentsChanged: string[] = [];
  const bindings: ToolResult[] = [];
  for (const [id, nd] of newDocs) {
    const od = oldDocs.get(id);
    if (!od) continue;
    if (od.docHash !== nd.docHash || od.status !== nd.status) {
      intentsChanged.push(`${id} ${nd.title}${od.status !== nd.status ? ` (status ${od.status} → ${nd.status})` : ""}`);
    }
    const key = (b: { step?: string; ref: string }) => `${b.step ?? ""}|${b.ref}`;
    const oldB = new Map(od.bindings.map((b) => [key(b), b.state]));
    const newB = new Map(nd.bindings.map((b) => [key(b), b]));
    for (const [k, b] of newB) {
      const was = oldB.get(k);
      if (was !== b.state) bindings.push(compact({ doc: id, step: b.step, ref: b.ref, was: was ?? "(new)", now: b.state }));
    }
    for (const [k, was] of oldB) {
      if (!newB.has(k)) {
        const [step, ref] = k.split("|");
        bindings.push(compact({ doc: id, step: step || undefined, ref, was, now: "(removed)" }));
      }
    }
  }

  // Subsystems.
  const fp = (s: SubsystemsManifest["subsystems"][number]) => JSON.stringify([s.name, s.purpose, s.owns, s.notOwns, s.dirs, s.invariants, s.related]);
  const oldSubs = new Map((before.subsystems?.subsystems ?? []).map((s) => [s.id, s]));
  const newSubs = new Map((after.subsystems?.subsystems ?? []).map((s) => [s.id, s]));
  const subsAdded = [...newSubs.keys()].filter((id) => !oldSubs.has(id));
  const subsRemoved = [...oldSubs.keys()].filter((id) => !newSubs.has(id));
  const subsChanged = [...newSubs.entries()].filter(([id, s]) => oldSubs.has(id) && fp(oldSubs.get(id)!) !== fp(s)).map(([id]) => id);

  const section = <T>(list: T[]): unknown => {
    const c = cap(list, max);
    return c.truncated ? { items: c.items, truncated: c.truncated } : c.items;
  };
  const summary = {
    filesAdded: filesAdded.length,
    filesRemoved: filesRemoved.length,
    filesChanged: filesChanged.length,
    filesDocsChanged: docsChanged.length,
    symbolsAdded: symAdded.length,
    symbolsRemoved: symRemoved.length,
    symbolsChanged: symChanged.length,
    symbolsDocsChanged: symDocsChanged.length,
    intentsAdded: intentsAdded.length,
    intentsRemoved: intentsRemoved.length,
    intentsChanged: intentsChanged.length,
    bindingsChanged: bindings.length,
    subsystemsChanged: subsAdded.length + subsRemoved.length + subsChanged.length,
  };
  return compact({
    summary,
    files: compact({ added: section(filesAdded), removed: section(filesRemoved), changed: section(filesChanged), docsChanged: section(docsChanged) } as Record<string, unknown>),
    symbols: compact({
      added: section(symAdded.map((id) => symbolRow(newSyms.get(id)!, detail))),
      removed: section(symRemoved.map((id) => (detail === "brief" ? id : symbolRow(oldSyms.get(id)!, detail)))),
      changed: section(symChanged),
      docsChanged: section(symDocsChanged),
    } as Record<string, unknown>),
    intents: compact({ added: intentsAdded, removed: intentsRemoved, changed: intentsChanged } as Record<string, unknown>),
    bindings: section(bindings),
    subsystems: compact({ added: subsAdded, removed: subsRemoved, changed: subsChanged } as Record<string, unknown>),
  });
}

function versionRef(v: DocVersionEntry) {
  return compact({ version: v.version, commit: v.commit?.slice(0, 12), generatedAt: v.generatedAt });
}

/** Resolve `since` (a version number, `v12`, or a commit-sha prefix) to a journal entry. */
export function resolveSince(versions: DocVersionEntry[], since: string | number): DocVersionEntry | undefined {
  const text = String(since).trim();
  const current = versions[0]?.version ?? 0;
  const m = /^v?(\d+)$/i.exec(text);
  if (m && Number(m[1]) <= current && (text.length < 7 || /^v/i.test(text))) {
    return versions.find((v) => v.version === Number(m[1]));
  }
  if (text.length < 4) return undefined;
  const lower = text.toLowerCase();
  // Newest first: a commit rebuilt into several versions resolves to the latest.
  return versions.find((v) => v.commit?.toLowerCase().startsWith(lower));
}

/** `what_changed_since`. */
export function whatChangedSince(
  store: ManifestStore,
  args: { repo: string; since: string | number; detail?: Detail },
): ToolResult {
  const detail = detailOf(args.detail);
  const repo = store.getRepo(args.repo);
  if (!repo) return { error: `No repo "${args.repo}".` };
  const versions = store.getVersions(args.repo)?.versions ?? [];
  const current = versions[0];
  if (!current) return { error: `No version journal for "${args.repo}" — rebuild it with a current server.` };
  const known = versions.slice(0, 10).map(versionRef);
  const target = resolveSince(versions, args.since);
  if (!target) {
    return { error: `No documentation version matches "${args.since}" (a version number or a commit prefix of ≥ 4 chars).`, current: versionRef(current), versions: known };
  }
  if (target.version === current.version) {
    return {
      repo: args.repo,
      since: versionRef(target),
      current: versionRef(current),
      unchanged: true,
      note: "The published docs have not changed since then — what you know is current.",
    };
  }
  const archive = store.loadArchive(args.repo, target.version);
  if (!archive) {
    const archived = versions.filter((v) => v.archived).map(versionRef);
    return {
      error: `Version ${target.version} is no longer archived — only the newest versions keep their content. Re-read what you need, or diff from the oldest archived version (a superset of the changes).`,
      current: versionRef(current),
      archived,
    };
  }
  return {
    repo: args.repo,
    since: versionRef(target),
    current: versionRef(current),
    ...diffStates(archive, { model: repo.model, product: repo.product, subsystems: repo.subsystems }, detail),
    next: "Fetch only what you need: get_function_doc / get_file_doc on the changed ids, detail=brief first.",
  };
}
