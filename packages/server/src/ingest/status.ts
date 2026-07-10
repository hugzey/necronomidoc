import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** One finished build attempt (success or failure). */
export const BuildRecord = z.object({
  repoId: z.string(),
  ref: z.string(),
  commitSha: z.string().optional(),
  /** Which trigger path started it. */
  trigger: z.string(),
  startedAt: z.string(),
  durationMs: z.number().int().nonnegative(),
  result: z.enum(["ok", "error"]),
  /** Failure summary; safe to show without the admin token. */
  error: z.string().optional(),
  /** Tail of the failure detail — only served behind the admin token. */
  logTail: z.string().optional(),
  fileCount: z.number().int().nonnegative().optional(),
  symbolCount: z.number().int().nonnegative().optional(),
});
export type BuildRecord = z.infer<typeof BuildRecord>;

export const BuildStatusFile = z.object({
  schemaVersion: z.literal(1),
  /** repoId → build history, newest first, capped. */
  builds: z.record(z.array(BuildRecord)).default({}),
});
export type BuildStatusFile = z.infer<typeof BuildStatusFile>;

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

export function lastBuild(dataDir: string, repoId: string): BuildRecord | undefined {
  return readBuildStatus(dataDir).builds[repoId]?.[0];
}
