import type { DocFile, DocModel, DocSymbolShape } from "./api.js";

/**
 * Cross-reference resolution: map symbol names and import specifiers to site
 * URLs so documentation text can hyperlink to the thing it mentions.
 */

/** Href to a file page, optionally anchored at a symbol. */
export function fileHref(slug: string, path: string, anchor?: string): string {
  return `/r/${slug}/f/${path}${anchor ? `#${anchor}` : ""}`;
}

export interface SymbolIndex {
  /** Best repo-wide target per symbol name (exported symbols win). */
  byName: Map<string, { path: string; anchor: string }>;
  /** Per-file: symbol name -> anchor, including non-exported symbols. */
  perFile: Map<string, Set<string>>;
}

export function buildSymbolIndex(model: DocModel): SymbolIndex {
  const byName = new Map<string, { path: string; anchor: string; exported: boolean }>();
  const perFile = new Map<string, Set<string>>();

  for (const file of model.files) {
    const names = new Set<string>();
    const walk = (symbols: DocSymbolShape[]): void => {
      for (const s of symbols) {
        names.add(s.name);
        const existing = byName.get(s.name);
        if (!existing || (s.exported && !existing.exported)) {
          byName.set(s.name, { path: file.path, anchor: s.name, exported: s.exported });
        }
        if (s.members) walk(s.members);
      }
    };
    walk(file.symbols);
    perFile.set(file.path, names);
  }

  return {
    byName: new Map([...byName].map(([k, v]) => [k, { path: v.path, anchor: v.anchor }])),
    perFile,
  };
}

/** A resolver turns a bare symbol name into an href (or nothing). */
export type SymbolResolver = (name: string) => string | undefined;

/**
 * Make a resolver for a repo; when `currentPath` is set, symbols in that file
 * win over same-named symbols elsewhere.
 */
export function makeResolver(
  slug: string,
  index: SymbolIndex,
  currentPath?: string,
): SymbolResolver {
  return (name) => {
    if (currentPath && index.perFile.get(currentPath)?.has(name)) {
      return fileHref(slug, currentPath, name);
    }
    const target = index.byName.get(name);
    return target ? fileHref(slug, target.path, target.anchor) : undefined;
  };
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

function normalizeSegments(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/**
 * Resolve a relative import specifier from one documented file to another
 * (TS-style: `./x.js` may mean `x.ts`/`x.tsx` on disk).
 */
export function resolveImport(
  fromPath: string,
  specifier: string,
  files: Pick<DocFile, "path">[],
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const known = new Set(files.map((f) => f.path));
  const base = normalizeSegments(`${dirname(fromPath)}/${specifier}`);
  const candidates = [
    base,
    base.replace(/\.jsx?$/, ".ts"),
    base.replace(/\.jsx?$/, ".tsx"),
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ];
  return candidates.find((c) => known.has(c));
}
