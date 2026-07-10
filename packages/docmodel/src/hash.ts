import { createHash } from "node:crypto";

/**
 * Content hash used for staleness detection and incremental rebuilds. Short
 * hex prefix of a sha256 — collision risk is negligible at repo scale and the
 * shorter string keeps manifests small.
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}
