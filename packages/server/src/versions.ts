import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  SCHEMA_VERSION,
  VersionsManifest,
  hashContent,
  repoContentHash,
  type CoreDocsManifest,
  type DocModel,
  type DocVersionEntry,
  type EnrichmentTotals,
  type SubsystemsManifest,
} from "@necronomidoc/docmodel";
import { paths } from "@necronomidoc/mcp";

/**
 * The documentation version journal (decision 0021): every publish either
 * appends a new version (the documentation state changed) or records a
 * rebuild on the current one (same state reproduced). Kept alongside the
 * other per-repo manifests and served at `/data/repos/<slug>/versions.json`.
 */

/** Versions kept per repo — a browsable history, not a full archive. */
export const VERSIONS_KEEP = 50;

/**
 * Hash of the published documentation state: the merged files (facts +
 * enrichment) plus the derived subsystems and core docs — everything a reader
 * sees. Volatile fields (timestamps, commit/ref identity) are excluded so a
 * rebuild of unchanged content hashes identically regardless of when or from
 * which commit it ran.
 */
export function computeDocsHash(
  model: DocModel,
  subsystems?: SubsystemsManifest,
  coreDocs?: CoreDocsManifest,
): string {
  return hashContent(
    JSON.stringify({
      files: model.files,
      subsystems: subsystems?.subsystems,
      coreDocs: coreDocs?.docs.map((d) => ({
        kind: d.kind,
        title: d.title,
        content: d.content,
        provenance: d.provenance,
      })),
    }),
  );
}

/** What a publish knows about itself, recorded into the version entry. */
export interface VersionBuildInfo {
  trigger?: string;
  adapter?: string;
  /** Where the source came from: repo URL or local path. */
  source?: string;
  enrichment?: EnrichmentTotals;
  sourceFileCount?: number;
  fileCount: number;
  symbolCount: number;
}

/** Read a repo's published version journal (empty when none exists yet). */
export function readVersions(dataDir: string, slug: string): VersionsManifest {
  const file = paths.versions(paths.repoDir(dataDir, slug));
  if (!existsSync(file)) return { schemaVersion: SCHEMA_VERSION, repo: slug, versions: [] };
  try {
    return VersionsManifest.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    // A corrupt/foreign journal is not worth failing a publish over — restart
    // the history rather than block the docs from updating.
    return { schemaVersion: SCHEMA_VERSION, repo: slug, versions: [] };
  }
}

/**
 * Fold one publish into the journal. Same `docsHash` as the current version →
 * touch `lastRebuiltAt`/`rebuilds`; otherwise prepend the next version.
 * Pure — callers write the result where they need it.
 */
export function appendVersion(
  prev: VersionsManifest,
  model: DocModel,
  docsHash: string,
  info: VersionBuildInfo,
  now: string = new Date().toISOString(),
): VersionsManifest {
  const [current, ...rest] = prev.versions;
  if (current && current.docsHash === docsHash) {
    const touched: DocVersionEntry = {
      ...current,
      lastRebuiltAt: now,
      rebuilds: current.rebuilds + 1,
    };
    return { ...prev, repo: model.repo.slug, versions: [touched, ...rest] };
  }
  const entry: DocVersionEntry = {
    version: (current?.version ?? 0) + 1,
    generatedAt: model.generatedAt ?? now,
    docsHash,
    contentHash: repoContentHash(model.files),
    commit: model.repo.commit,
    ref: model.repo.ref,
    source: info.source ?? model.repo.url,
    trigger: info.trigger,
    adapter: info.adapter,
    fileCount: info.fileCount,
    symbolCount: info.symbolCount,
    enrichment: info.enrichment,
    sourceFileCount: info.sourceFileCount,
    rebuilds: 0,
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    repo: model.repo.slug,
    versions: [entry, ...prev.versions].slice(0, VERSIONS_KEEP),
  };
}

/** Write the journal into a (staged) repo manifest dir. */
export function writeVersions(repoManifestDir: string, manifest: VersionsManifest): void {
  writeFileSync(paths.versions(repoManifestDir), JSON.stringify(manifest, null, 2));
}
