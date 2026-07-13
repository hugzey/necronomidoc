import type { DocFile, DocModel, DocSymbolShape } from "./api.js";

/**
 * Cross-reference resolution: map symbol names and import specifiers to site
 * URLs so documentation text can hyperlink to the thing it mentions.
 */

/** Href to a file page, optionally anchored at a symbol. */
export function fileHref(slug: string, path: string, anchor?: string): string {
  return `/r/${slug}/f/${path}${anchor ? `#${anchor}` : ""}`;
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

export interface SymbolIndex {
  /** Best repo-wide target per symbol name (exported symbols win). */
  byName: Map<string, { path: string; anchor: string }>;
  /** Per-file: symbol name -> anchor, including non-exported symbols. */
  perFile: Map<string, Map<string, string>>;
}

export function buildSymbolIndex(model: DocModel): SymbolIndex {
  const byName = new Map<string, { path: string; anchor: string; exported: boolean }>();
  const perFile = new Map<string, Map<string, string>>();

  for (const file of model.files) {
    const anchors = new Map<string, string>();
    const walk = (symbols: DocSymbolShape[]): void => {
      for (const s of symbols) {
        const anchor = anchorForSymbol(s.kind, s.name);
        anchors.set(s.name, anchor);
        const existing = byName.get(s.name);
        if (!existing || (s.exported && !existing.exported)) {
          byName.set(s.name, { path: file.path, anchor, exported: s.exported });
        }
        if (s.members) walk(s.members);
      }
    };
    walk(file.symbols);
    perFile.set(file.path, anchors);
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
    const local = currentPath ? index.perFile.get(currentPath)?.get(name) : undefined;
    if (local !== undefined) return fileHref(slug, currentPath!, local);
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
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return undefined;
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
