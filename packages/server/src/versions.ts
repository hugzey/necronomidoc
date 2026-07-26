import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
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

/** Metadata entries kept per repo — a browsable history. */
export const VERSIONS_KEEP = 50;

/**
 * How many versions keep their full published content (doc model + source
 * snapshots + core docs) archived for preview. Full source copies are heavy,
 * so this is a smaller window than the metadata journal — older versions keep
 * their metadata but become non-previewable.
 */
export const ARCHIVE_KEEP = 10;

/** Per-version manifests copied into the archive (small; the bulk is sources/). */
const ARCHIVED_MANIFESTS = ["docmodel.json", "coredocs.json", "subsystems.json", "sources.json"];

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
    // Same docs state reproduced. Refresh the build provenance to the run
    // that just verified it (a new commit can rebuild identical docs) so the
    // drawer never presents a stale commit as the current build's origin;
    // `generatedAt` keeps when this state first appeared.
    const touched: DocVersionEntry = {
      ...current,
      commit: model.repo.commit ?? current.commit,
      ref: model.repo.ref ?? current.ref,
      trigger: info.trigger ?? current.trigger,
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
    // Stamped for real by stageVersionArchives once the archive is written.
    archived: false,
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    repo: model.repo.slug,
    versions: [entry, ...prev.versions].slice(0, VERSIONS_KEEP),
  };
}

/**
 * Archive the published content per version so past versions can be previewed
 * (decision 0021). Runs inside the atomic swap's staging step, before the
 * rename dance, so `finalDir` still holds the previous publish:
 *
 * 1. carry the previous archives forward into the tmp dir (the swap replaces
 *    the whole repo dir, so anything not re-staged is lost);
 * 2. archive the current build's content under `versions/<N>/` if it's a new
 *    version (an unchanged rebuild reuses the carried-forward copy);
 * 3. prune to the newest `ARCHIVE_KEEP` versions;
 * 4. stamp each journal entry's `archived` flag from what actually remains.
 *
 * Mutates `versions.versions[*].archived`; the caller writes the journal after.
 */
export function stageVersionArchives(
  tmpDir: string,
  finalDir: string,
  versions: VersionsManifest,
): void {
  const tmpArchiveRoot = paths.versionArchiveRoot(tmpDir);

  // 1. Carry forward existing archives (a cheap-ish copy, bounded by the cap).
  const prevArchiveRoot = paths.versionArchiveRoot(finalDir);
  if (existsSync(prevArchiveRoot)) {
    for (const name of readdirSync(prevArchiveRoot)) {
      if (!/^\d+$/.test(name)) continue;
      cpSync(join(prevArchiveRoot, name), join(tmpArchiveRoot, name), { recursive: true });
    }
  }

  // 2. Archive the current version's content if it isn't already present
  //    (unchanged rebuilds keep the same version number and reuse the copy).
  const current = versions.versions[0];
  if (current) {
    const dest = paths.versionArchiveDir(tmpDir, current.version);
    if (!existsSync(dest)) {
      mkdirSync(dest, { recursive: true });
      for (const name of ARCHIVED_MANIFESTS) {
        const src = join(tmpDir, name);
        if (existsSync(src)) copyFileSync(src, join(dest, name));
      }
      const srcSources = paths.sourcesDir(tmpDir);
      if (existsSync(srcSources)) {
        cpSync(srcSources, paths.sourcesDir(dest), { recursive: true });
      }
    }
  }

  // 3. Prune to the newest ARCHIVE_KEEP versions the journal still lists.
  const keep = new Set(versions.versions.slice(0, ARCHIVE_KEEP).map((v) => v.version));
  if (existsSync(tmpArchiveRoot)) {
    for (const name of readdirSync(tmpArchiveRoot)) {
      if (!keep.has(Number(name))) {
        rmSync(join(tmpArchiveRoot, name), { recursive: true, force: true });
      }
    }
  }

  // 4. Stamp `archived` from what actually remains on disk.
  const present = new Set(
    existsSync(tmpArchiveRoot)
      ? readdirSync(tmpArchiveRoot).filter((n) => /^\d+$/.test(n)).map(Number)
      : [],
  );
  for (const v of versions.versions) v.archived = present.has(v.version);
}

/** Write the journal into a (staged) repo manifest dir. */
export function writeVersions(repoManifestDir: string, manifest: VersionsManifest): void {
  writeFileSync(paths.versions(repoManifestDir), JSON.stringify(manifest, null, 2));
}
