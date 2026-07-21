import type { DocFile, DocModel, DocSymbolShape } from "./api.js";

/**
 * Cross-reference resolution: map symbol names and import specifiers to site
 * URLs so documentation text can hyperlink to the thing it mentions.
 */

/** Href to a file page, optionally anchored at a symbol. `version` keeps a
 *  historical preview (`?docv=N`) sticky across navigation. */
export function fileHref(slug: string, path: string, anchor?: string, version?: number): string {
  const query = version ? `?docv=${version}` : "";
  return `/r/${slug}/f/${path}${query}${anchor ? `#${anchor}` : ""}`;
}

/**
 * Href to a file page with the source panel open, optionally focused on a
 * line (1-based) and anchored at a symbol's doc card. `source=1` is the
 * open-panel flag FileView reads from the query string; `version` keeps the
 * historical preview sticky.
 */
export function sourceHref(
  slug: string,
  path: string,
  line?: number,
  anchor?: string,
  version?: number,
): string {
  const params = new URLSearchParams({ source: "1" });
  if (line) params.set("line", String(line));
  if (version) params.set("docv", String(version));
  return `/r/${slug}/f/${path}?${params.toString()}${anchor ? `#${anchor}` : ""}`;
}

/**
 * The DOM anchor a symbol's card/heading renders with — must match how each
 * page renders ids: code symbols anchor by name (SymbolCard), markdown
 * sections by heading slug, endpoints by their operation slug (ApiReference).
 */
export function anchorForSymbol(kind: string | undefined, name: string): string {
  if (kind === "section") return slugifyAnchor(name);
  if (kind === "endpoint") return slugifyEndpointAnchor(name);
  return name;
}

/** Where a symbol's documentation card and declaration live. */
export interface SymbolTarget {
  path: string;
  anchor: string;
  /** 1-based declaration line, for the source viewer. */
  line: number;
}

export interface SymbolIndex {
  /** Best repo-wide target per symbol name (exported symbols win). */
  byName: Map<string, SymbolTarget>;
  /** Per-file: symbol name -> target, including non-exported symbols. */
  perFile: Map<string, Map<string, SymbolTarget>>;
}

export function buildSymbolIndex(model: DocModel): SymbolIndex {
  const byName = new Map<string, SymbolTarget & { exported: boolean }>();
  const perFile = new Map<string, Map<string, SymbolTarget>>();

  for (const file of model.files) {
    const targets = new Map<string, SymbolTarget>();
    const walk = (symbols: DocSymbolShape[]): void => {
      for (const s of symbols) {
        const target: SymbolTarget = {
          path: file.path,
          anchor: anchorForSymbol(s.kind, s.name),
          line: s.location.line,
        };
        targets.set(s.name, target);
        const existing = byName.get(s.name);
        if (!existing || (s.exported && !existing.exported)) {
          byName.set(s.name, { ...target, exported: s.exported });
        }
        if (s.members) walk(s.members);
      }
    };
    walk(file.symbols);
    perFile.set(file.path, targets);
  }

  return {
    byName: new Map(
      [...byName].map(([k, v]) => [k, { path: v.path, anchor: v.anchor, line: v.line }]),
    ),
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
  /** Keep cross-reference links inside a historical preview (`?docv=N`). */
  version?: number,
): SymbolResolver {
  const targets = makeTargetResolver(index, currentPath);
  return (name) => {
    const target = targets(name);
    return target ? fileHref(slug, target.path, target.anchor, version) : undefined;
  };
}

/** A target resolver returns where a bare symbol name is declared/documented. */
export type TargetResolver = (name: string) => SymbolTarget | undefined;

/**
 * Like {@link makeResolver} but returning the full target (path + anchor +
 * declaration line) — the source viewer links identifiers to the declaring
 * file with its code panel focused on that line.
 */
export function makeTargetResolver(index: SymbolIndex, currentPath?: string): TargetResolver {
  return (name) => {
    const local = currentPath ? index.perFile.get(currentPath)?.get(name) : undefined;
    return local ?? index.byName.get(name);
  };
}

/** Directory part of a slash-separated path ("" at the root). */
export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

/** Absolute/external href: has a scheme (https:, mailto:, …) or is protocol-relative. */
export function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

/** Collapse `.`/`..` segments in a relative path (never escapes the root). */
export function normalizeSegments(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/**
 * GitHub-style anchor slug for a markdown heading — MUST stay in sync with
 * `slugifyAnchor` in packages/docmodel/src/ids.ts (duplicated so the browser
 * bundle doesn't pull in zod via the docmodel package).
 */
export function slugifyAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

/**
 * Anchor slug for an OpenAPI operation (`GET /users/{id}` → `get__users__id_`)
 * — MUST stay in sync with `slugifyEndpointAnchor` in
 * packages/docmodel/src/ids.ts (duplicated for the same zod-free reason).
 */
export function slugifyEndpointAnchor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "_");
}

/**
 * Resolve a relative markdown link (`./guide.md`, `../api/README.md#auth`)
 * from one documented file to a site href. Returns undefined for external or
 * unresolvable links.
 */
export function resolveDocLink(
  slug: string,
  fromPath: string,
  href: string,
  files: Pick<DocFile, "path">[],
): string | undefined {
  if (isExternalHref(href)) return undefined;
  if (href.startsWith("#")) return undefined; // in-page anchor — leave as-is
  const [pathPart = "", fragment] = href.split("#");
  const known = new Set(files.map((f) => f.path));
  const base = normalizeSegments(
    pathPart.startsWith("/") ? pathPart.slice(1) : `${dirname(fromPath)}/${pathPart}`,
  );
  const target = [base, `${base}/README.md`, `${base}/index.md`].find((c) => known.has(c));
  return target ? fileHref(slug, target, fragment) : undefined;
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
