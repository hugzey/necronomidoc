import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * A source repo the server watches and documents (decision 0001). Credentials
 * are referenced by *environment variable name* — the secret itself never
 * lands in this file, in logs, or in any manifest.
 */
export const SourceRepo = z.object({
  /** Stable identifier; doubles as the docs slug and the clone dir name. */
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, "id must be a lowercase slug"),
  /** Display name (defaults to id). */
  name: z.string().optional(),
  /** Which trigger path fires builds for this repo. */
  provider: z.enum(["github", "ado", "generic"]),
  /** Clone URL (https/ssh) or a local directory path. */
  url: z.string(),
  /** The tracked branch; pushes to other refs are ignored. */
  branch: z.string().default("main"),
  /** Env var holding the webhook secret (GitHub HMAC key / ADO basic-auth credential). */
  secretEnv: z.string().optional(),
  /** Env var holding the git credential (PAT) used to clone/fetch. */
  tokenEnv: z.string().optional(),
  /** Env var holding a bearer token scoped to triggering THIS repo via REST. */
  apiTokenEnv: z.string().optional(),
  /** Disabled repos keep serving their last docs but accept no triggers. */
  enabled: z.boolean().default(true),
});
export type SourceRepo = z.infer<typeof SourceRepo>;

export const SourceRegistry = z.object({
  schemaVersion: z.literal(1),
  repos: z.array(SourceRepo).default([]),
});
export type SourceRegistry = z.infer<typeof SourceRegistry>;

/** `repos.json` — the watched-source registry. (`registry.json` is the *built docs* manifest.) */
export function sourceRegistryPath(dataDir: string): string {
  return join(dataDir, "repos.json");
}

export function readSourceRegistry(dataDir: string): SourceRegistry {
  const file = sourceRegistryPath(dataDir);
  if (!existsSync(file)) return { schemaVersion: 1, repos: [] };
  return SourceRegistry.parse(JSON.parse(readFileSync(file, "utf8")));
}

export function writeSourceRegistry(dataDir: string, registry: SourceRegistry): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(sourceRegistryPath(dataDir), JSON.stringify(registry, null, 2) + "\n");
}

export function getSourceRepo(dataDir: string, id: string): SourceRepo | undefined {
  return readSourceRegistry(dataDir).repos.find((r) => r.id === id);
}

/** Add or replace a repo entry. Returns the stored (validated) entry. */
export function upsertSourceRepo(dataDir: string, repo: unknown): SourceRepo {
  const parsed = SourceRepo.parse(repo);
  const registry = readSourceRegistry(dataDir);
  const others = registry.repos.filter((r) => r.id !== parsed.id);
  writeSourceRegistry(dataDir, {
    schemaVersion: 1,
    repos: [...others, parsed].sort((a, b) => a.id.localeCompare(b.id)),
  });
  return parsed;
}

/** Remove a repo entry. Returns true if it existed. */
export function removeSourceRepo(dataDir: string, id: string): boolean {
  const registry = readSourceRegistry(dataDir);
  const next = registry.repos.filter((r) => r.id !== id);
  if (next.length === registry.repos.length) return false;
  writeSourceRegistry(dataDir, { schemaVersion: 1, repos: next });
  return true;
}
