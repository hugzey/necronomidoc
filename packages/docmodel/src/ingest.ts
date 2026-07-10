import { z } from "zod";
import type { RegistryEntry } from "./schema.js";

/**
 * Ingestion status wire types (slice 2). They live in docmodel — the shared
 * boundary — so the server that writes them and the site that renders them
 * type the same shape, like every other manifest.
 */

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

/** One queued trigger as shown on the status surface. */
export interface IngestQueueItemView {
  repoId: string;
  provider: string;
  state: string;
  receivedAt: string;
}

/** One registered source repo's row on the status surface. */
export interface IngestSourceStatus {
  id: string;
  provider: string;
  branch: string;
  enabled: boolean;
  /** `logTail` is stripped unless the request carries the admin token. */
  lastBuild?: BuildRecord;
}

/** The `GET /api/status` response body. */
export interface IngestStatusResponse {
  dataDir: string;
  repos: RegistryEntry[];
  sources: IngestSourceStatus[];
  queue: { depth: number; items: IngestQueueItemView[] };
}
