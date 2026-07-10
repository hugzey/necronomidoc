import type { AttachedEnrichment, DocFile, DocSymbolShape } from "@necronomidoc/docmodel";

/**
 * The heuristic producer derives a one-line purpose from what the adapter
 * already extracted: existing doc comments first (decision 0004 — "existing
 * comments" is a heuristic input), then names, directory structure and export
 * shapes. It is the always-present fallback beneath human/LLM overlays.
 */

function dirLabel(path: string): string | undefined {
  const parts = path.split("/");
  const dir = parts[parts.length - 2];
  if (!dir) return undefined;
  const map: Record<string, string> = {
    hooks: "React hooks",
    components: "React components",
    pages: "page components",
    utils: "utility helpers",
    lib: "library code",
    api: "API/client code",
    services: "service-layer code",
    store: "state management",
    context: "React context",
    types: "type definitions",
  };
  return map[dir];
}

function kindPhrase(kind: string, plural = false): string {
  const map: Record<string, [string, string]> = {
    component: ["component", "components"],
    hook: ["hook", "hooks"],
    function: ["function", "functions"],
    class: ["class", "classes"],
    interface: ["interface", "interfaces"],
    type: ["type", "types"],
    enum: ["enum", "enums"],
    variable: ["value", "values"],
    endpoint: ["endpoint", "endpoints"],
  };
  const entry = map[kind] ?? ["symbol", "symbols"];
  return plural ? entry[1] : entry[0];
}

/** Heuristic enrichment for a single symbol. */
export function heuristicForSymbol(symbol: DocSymbolShape): AttachedEnrichment {
  if (symbol.doc?.summary) {
    return { summary: symbol.doc.summary, provenance: "heuristic", stale: false };
  }
  const noun = kindPhrase(symbol.kind);
  let summary = `${capitalize(noun)} \`${symbol.name}\`.`;
  if (symbol.kind === "component") {
    const propCount = symbol.props?.length ?? 0;
    summary = propCount
      ? `React component \`${symbol.name}\` (${propCount} prop${propCount === 1 ? "" : "s"}).`
      : `React component \`${symbol.name}\`.`;
  } else if (symbol.kind === "hook") {
    summary = `React hook \`${symbol.name}\`.`;
  }
  return { summary, provenance: "heuristic", stale: false };
}

/** Heuristic enrichment for a whole file, from its symbols and path. */
export function heuristicForFile(file: DocFile): AttachedEnrichment {
  if (file.moduleDoc?.summary) {
    return { summary: file.moduleDoc.summary, provenance: "heuristic", stale: false };
  }
  const exported = file.symbols.filter((s) => s.exported);
  const pool = exported.length ? exported : file.symbols;

  // Group by kind for a compact "defines X and Y" phrasing.
  const byKind = new Map<string, string[]>();
  for (const s of pool) {
    const list = byKind.get(s.kind) ?? [];
    list.push(s.name);
    byKind.set(s.kind, list);
  }

  const context = dirLabel(file.path);
  if (byKind.size === 0) {
    return {
      summary: context ? `Module of ${context}.` : `Module \`${file.path}\`.`,
      provenance: "heuristic",
      stale: false,
    };
  }

  const clauses: string[] = [];
  for (const [kind, names] of byKind) {
    const shown = names.slice(0, 3);
    const label = kindPhrase(kind, names.length > 1);
    const list = shown.map((n) => `\`${n}\``).join(", ");
    const more = names.length > shown.length ? `, +${names.length - shown.length} more` : "";
    clauses.push(`${label} ${list}${more}`);
  }
  const prefix = context ? `${capitalize(context)}. Defines ` : "Defines ";
  return {
    summary: `${prefix}${clauses.join("; ")}.`,
    provenance: "heuristic",
    stale: false,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
