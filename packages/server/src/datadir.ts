import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_VERSION } from "@necronomidoc/docmodel";

/**
 * Data-dir upgrade guard (slice 6 operability): the entire persisted state is
 * `dataDir`, stamped with the schema version that wrote it. On startup we
 * refuse to serve a dir written by a *newer* schema than this binary
 * understands — silently serving data we can't parse is worse than a clear
 * error telling the operator to upgrade the image (acceptance criterion 3
 * expects backup/restore to be explicit, not lossy).
 */
export const DATA_DIR_META = "meta.json";

export interface DataDirMeta {
  schemaVersion: number;
  /** ISO timestamp the dir was first stamped; informational. */
  createdAt?: string;
}

export function dataDirMetaPath(dataDir: string): string {
  return join(dataDir, DATA_DIR_META);
}

export function readDataDirMeta(dataDir: string): DataDirMeta | undefined {
  const path = dataDirMetaPath(dataDir);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DataDirMeta;
    if (typeof parsed.schemaVersion === "number") return parsed;
  } catch {
    /* fall through to undefined — treated as unstamped */
  }
  return undefined;
}

export class DataDirVersionError extends Error {}

/**
 * Ensure the data dir is compatible and stamped. Returns the effective meta.
 *
 * - unstamped (fresh dir, or one from before this guard) → stamp it at the
 *   current version and continue;
 * - same version → continue;
 * - newer version → throw (operator must upgrade the binary/image).
 *
 * `now` is injectable so callers/tests stay deterministic.
 */
export function ensureDataDirVersion(
  dataDir: string,
  now: () => string = () => new Date().toISOString(),
): DataDirMeta {
  const existing = readDataDirMeta(dataDir);
  if (existing) {
    if (existing.schemaVersion > SCHEMA_VERSION) {
      throw new DataDirVersionError(
        `Data dir "${dataDir}" was written by schema v${existing.schemaVersion}, ` +
          `but this build only understands v${SCHEMA_VERSION}. Upgrade necronomidoc to serve it.`,
      );
    }
    // Older versions would migrate here; v1 is the only version so far.
    return existing;
  }
  const meta: DataDirMeta = { schemaVersion: SCHEMA_VERSION, createdAt: now() };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(dataDirMetaPath(dataDir), JSON.stringify(meta, null, 2) + "\n");
  return meta;
}
