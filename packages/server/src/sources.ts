import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  SCHEMA_VERSION,
  hashContent,
  type DocModel,
  type SourceFileEntry,
  type SourcesManifest,
} from "@necronomidoc/docmodel";
import { paths } from "@necronomidoc/mcp";

/**
 * Source files above this size are not snapshotted — the viewer targets code
 * files, not bundled assets or generated blobs.
 */
export const MAX_SOURCE_FILE_BYTES = 512 * 1024;

/**
 * Snapshot the documented source files next to the manifests so the site's
 * source viewer can serve them (decision 0020). Only files the doc model
 * actually documents are copied — never the whole checkout — so the published
 * tree exposes exactly what the docs already describe. Prose/spec formats
 * (`markdown`, `openapi`) carry their text in `DocFile.content` and are
 * skipped here.
 *
 * `repoDir` is absent for pre-extracted IR (`POST /api/ir`): there is no
 * checkout to snapshot from, so the manifest lists no files and the site
 * hides its "View source" button.
 */
export function snapshotSources(
  model: DocModel,
  destDir: string,
  repoDir?: string,
): SourcesManifest {
  const files: SourceFileEntry[] = [];
  if (repoDir) {
    const root = resolve(repoDir);
    const sourcesDir = paths.sourcesDir(destDir);
    for (const file of model.files) {
      if (file.format !== "source") continue;
      // Paths come from adapters over this same checkout, but resolve-check
      // anyway so a hostile model can never read outside the repo dir.
      const abs = resolve(root, file.path);
      if (abs !== root && !abs.startsWith(root + sep)) continue;
      let content: Buffer;
      try {
        if (statSync(abs).size > MAX_SOURCE_FILE_BYTES) continue;
        content = readFileSync(abs);
      } catch {
        continue; // unreadable/vanished files just don't get a snapshot
      }
      if (content.includes(0)) continue; // binary despite a source extension
      const dest = join(sourcesDir, file.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content);
      files.push({
        path: file.path,
        size: content.byteLength,
        contentHash: hashContent(content.toString("utf8")),
      });
    }
  }
  const manifest: SourcesManifest = {
    schemaVersion: SCHEMA_VERSION,
    repo: model.repo.slug,
    files,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(paths.sources(destDir), JSON.stringify(manifest, null, 2));
  return manifest;
}
