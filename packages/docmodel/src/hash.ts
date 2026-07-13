import { createHash } from "node:crypto";

/**
 * Content hash used for staleness detection and incremental rebuilds. Short
 * hex prefix of a sha256 — collision risk is negligible at repo scale and the
 * shorter string keeps manifests small.
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

/**
 * A whole-repo content hash: stable digest of every file's path + content
 * hash. Used by repo-scoped artifacts (LLM core docs) the way per-target
 * `sourceContentHash` is used by overlays — regenerate only when it changes.
 * Enrichment merging doesn't touch paths or content hashes, so the value is
 * identical for a raw and a merged model.
 */
export function repoContentHash(files: { path: string; contentHash: string }[]): string {
  const lines = files
    .map((f) => `${f.path}:${f.contentHash}`)
    .sort()
    .join("\n");
  return hashContent(lines);
}
