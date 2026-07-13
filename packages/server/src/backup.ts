import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sourceRegistryPath } from "./ingest/registry.js";

/**
 * Export the *curation* state (slice 6 backup/restore): the source registry and
 * the human/LLM enrichment overlays. These are the inputs a team hand-maintains
 * — everything else in the data dir (clones, built manifests, build logs) is
 * regenerated from a rebuild. Exporting just this makes it small enough to
 * commit to a git repo for versioned, reviewable curation.
 *
 * (Full disaster-recovery is snapshotting the whole `dataDir` — documented in
 * the ops guide; this is the lighter, git-friendly slice of it.)
 */
export interface ExportResult {
  outDir: string;
  registryCopied: boolean;
  enrichmentCopied: boolean;
}

export function exportState(dataDir: string, outDir: string): ExportResult {
  mkdirSync(outDir, { recursive: true });

  // Keep the on-disk name (`repos.json`) so a restore is a plain copy-back.
  const registrySrc = sourceRegistryPath(dataDir);
  const registryCopied = existsSync(registrySrc);
  if (registryCopied) cpSync(registrySrc, join(outDir, "repos.json"));

  const enrichmentSrc = join(dataDir, "enrichment");
  const enrichmentCopied = existsSync(enrichmentSrc);
  if (enrichmentCopied) {
    cpSync(enrichmentSrc, join(outDir, "enrichment"), { recursive: true });
  }

  // A README makes the export self-describing when it lands in a git repo.
  writeFileSync(
    join(outDir, "README.md"),
    [
      "# necronomidoc curation export",
      "",
      "Versioned backup of curation state produced by `necronomidoc export`:",
      "",
      "- `repos.json` — registered source repos.",
      "- `enrichment/<repo>/` — human (`*.yaml`) and LLM (`*.llm.json`) overlays.",
      "",
      "Restore by copying these back into the server's data dir and rebuilding.",
      "This is *not* a full backup — clones and built manifests regenerate on",
      "rebuild. For disaster recovery snapshot the entire data dir instead.",
      "",
    ].join("\n"),
  );

  return { outDir, registryCopied, enrichmentCopied };
}
