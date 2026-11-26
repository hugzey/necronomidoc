import type { DocFile, DocSymbolShape } from "@necronomidoc/docmodel";
import type { ManifestStore } from "./store.js";

/**
 * Detail levels shared by every tool (decision 0024):
 *
 *   brief   id, name, one-line purpose and signature — enough to choose a hit
 *   normal  the established default shape (+ trust and invariants)
 *   full    everything: doc comments, props, real call sites, members
 *
 * Agents list cheaply at `brief` and fetch `full` only for the one hit they pick.
 */
export type Detail = "brief" | "normal" | "full";

export const DETAILS = ["brief", "normal", "full"] as const;

export function detailOf(value: unknown): Detail {
  return value === "brief" || value === "full" ? value : "normal";
}

/** First sentence of a description, bounded — the "one-line purpose". */
export function oneLine(text: string | undefined, max = 160): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

/** Rough token estimate for a JSON payload (≈ 4 chars per token). */
export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? null).length / 4);
}

/** Drop undefined / empty-array fields so brief answers stay brief. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

export function symbolSummary(s: DocSymbolShape): string | undefined {
  return s.enrichment?.summary ?? s.doc?.summary;
}

/** A symbol at the requested detail level. `path` is the file it lives in. */
export function symbolView(
  store: ManifestStore,
  repo: string,
  path: string,
  s: DocSymbolShape,
  detail: Detail,
): Record<string, unknown> {
  if (detail === "brief") {
    return compact({
      id: s.id,
      name: s.name,
      kind: s.kind,
      signature: s.signature,
      purpose: oneLine(symbolSummary(s)),
    });
  }
  const trust = store.trustFor(repo, path, s);
  const invariants = store.invariantsFor(repo, path, s);
  const normal = {
    id: s.id,
    name: s.name,
    kind: s.kind,
    exported: s.exported,
    line: s.location.line,
    signature: s.signature,
    summary: symbolSummary(s),
    provenance: s.enrichment?.provenance,
    stale: s.enrichment?.stale ?? false,
    trust,
    ...(invariants.length > 0 ? { invariants } : {}),
  };
  if (detail === "normal") return normal;
  const usages = store.getAgent(repo)?.usages[s.id];
  return compact({
    ...normal,
    purpose: s.enrichment?.purpose,
    scope: s.enrichment?.scope,
    notes: s.enrichment?.notes,
    doc: s.doc,
    props: s.props,
    usages,
    members: s.members?.map((m) => symbolView(store, repo, path, m, "brief")),
  });
}

/** A file's one-line row at the requested detail level (lists, search, context). */
export function fileRow(store: ManifestStore, repo: string, f: DocFile, detail: Detail): Record<string, unknown> {
  if (detail === "brief") return compact({ path: f.path, purpose: oneLine(f.enrichment?.summary) });
  return compact({
    path: f.path,
    purpose: f.enrichment?.summary,
    provenance: f.enrichment?.provenance,
    stale: f.enrichment?.stale ?? false,
    symbols: f.symbols.length,
    ...(detail === "full" ? { trust: store.trustFor(repo, f.path), exports: f.exports } : {}),
  });
}
