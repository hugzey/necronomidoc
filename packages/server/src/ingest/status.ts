import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BuildRecord, BuildStatusFile } from "@necronomidoc/docmodel";

// The schemas live in docmodel so the site types the same wire shapes.
export { BuildRecord, BuildStatusFile };

const HISTORY_KEEP = 20;

export function buildStatusPath(dataDir: string): string {
  return join(dataDir, "status.json");
}

export function readBuildStatus(dataDir: string): BuildStatusFile {
  const file = buildStatusPath(dataDir);
  if (!existsSync(file)) return { schemaVersion: 1, builds: {} };
  try {
    return BuildStatusFile.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return { schemaVersion: 1, builds: {} }; // corrupt history is not worth crashing over
  }
}

export function recordBuild(dataDir: string, record: BuildRecord): void {
  mkdirSync(dataDir, { recursive: true });
  const status = readBuildStatus(dataDir);
  const history = [record, ...(status.builds[record.repoId] ?? [])].slice(0, HISTORY_KEEP);
  status.builds[record.repoId] = history;
  writeFileSync(buildStatusPath(dataDir), JSON.stringify(status, null, 2) + "\n");
}
