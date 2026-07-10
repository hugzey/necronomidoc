/**
 * Stable identity for repos, files, and symbols. IDs are the join key across
 * enrichment overlays, site URLs, search, and MCP tools, so they must be
 * deterministic and stable across builds of unchanged code.
 */

/** Turn an arbitrary repo name/url into a filesystem- and URL-safe slug. */
export function slugify(input: string): string {
  const base = input
    .replace(/\.git$/i, "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() ?? input;
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "repo"
  );
}

/** Normalize a path to forward slashes with no leading "./". */
export function normalizePath(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** `slug:relative/path.ts` */
export function makeFileId(repoSlug: string, relPath: string): string {
  return `${repoSlug}:${normalizePath(relPath)}`;
}

/**
 * `slug:relative/path.ts#Symbol.member`. `symbolPath` is dotted for nested
 * members; `disambiguator` (e.g. an overload index) is appended as `~n`.
 */
export function makeSymbolId(
  repoSlug: string,
  relPath: string,
  symbolPath: string,
  disambiguator?: number,
): string {
  const suffix = disambiguator !== undefined ? `~${disambiguator}` : "";
  return `${makeFileId(repoSlug, relPath)}#${symbolPath}${suffix}`;
}

/** Extract the file id portion of a symbol id. */
export function fileIdOfSymbol(symbolId: string): string {
  const hash = symbolId.indexOf("#");
  return hash === -1 ? symbolId : symbolId.slice(0, hash);
}
