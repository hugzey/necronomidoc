import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { UndocumentedConcept } from "@necronomidoc/docmodel";

/**
 * Learning from agent misses (decision 0024): MCP queries that returned
 * nothing useful are appended to `data/telemetry/mcp-misses.jsonl` so the
 * docs can improve where agents actually struggle — surfaced as
 * "undocumented concepts" in `agent.json`, by `necronomidoc misses`, and as
 * candidate search synonyms.
 *
 * Privacy modes (`DOCS_MISS_LOG`): `full` records the query text; `hashed`
 * records only a SHA-256 of the normalized query (repeat misses still
 * aggregate, but no content is stored); `off` records nothing.
 */

export type MissLogMode = "full" | "hashed" | "off";

export interface MissRecord {
  at: string;
  tool: string;
  repo?: string;
  /** The normalized query (mode `full`). */
  query?: string;
  /** SHA-256 (hex, first 16) of the normalized query (mode `hashed`). */
  hash?: string;
  hits: number;
  topScore?: number;
}

/** Rotate the log past this size (one `.1` generation kept). */
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_QUERY_CHARS = 300;

export function missLogPath(dataDir: string): string {
  return join(dataDir, "telemetry", "mcp-misses.jsonl");
}

export function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
}

export function hashQuery(query: string): string {
  return createHash("sha256").update(normalizeQuery(query)).digest("hex").slice(0, 16);
}

/** Append-only recorder of MCP misses. Never throws into a request. */
export class MissLog {
  constructor(
    private readonly file: string,
    readonly mode: MissLogMode = "full",
  ) {}

  record(entry: { tool: string; repo?: string; query: string; hits: number; topScore?: number }): void {
    if (this.mode === "off") return;
    const query = normalizeQuery(entry.query);
    if (!query) return;
    const rec: MissRecord = {
      at: new Date().toISOString(),
      tool: entry.tool,
      repo: entry.repo,
      ...(this.mode === "full" ? { query } : { hash: hashQuery(query) }),
      hits: entry.hits,
      topScore: entry.topScore === undefined ? undefined : Math.round(entry.topScore * 100) / 100,
    };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      if (existsSync(this.file) && statSync(this.file).size > MAX_LOG_BYTES) {
        renameSync(this.file, `${this.file}.1`);
      }
      appendFileSync(this.file, `${JSON.stringify(rec)}\n`);
    } catch {
      // Telemetry must never fail an agent's request.
    }
  }
}

/** Read every miss record (current log + one rotated generation). Tolerates bad lines. */
export function readMisses(file: string): MissRecord[] {
  const out: MissRecord[] = [];
  for (const path of [`${file}.1`, file]) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as MissRecord;
        if (rec && typeof rec.tool === "string") out.push(rec);
      } catch {
        // skip a torn line
      }
    }
  }
  return out;
}

/**
 * Aggregate misses into undocumented concepts, most frequent first. `repo`
 * keeps records for that repo plus repo-less (cross-repo) queries.
 */
export function aggregateMisses(records: MissRecord[], repo?: string, limit = 50): UndocumentedConcept[] {
  const byKey = new Map<string, UndocumentedConcept & { tools: string[] }>();
  for (const rec of records) {
    if (repo && rec.repo && rec.repo !== repo) continue;
    const key = rec.query ?? rec.hash;
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) {
      existing.count++;
      if (!existing.tools.includes(rec.tool)) existing.tools.push(rec.tool);
      if (rec.at > existing.lastSeen) existing.lastSeen = rec.at;
    } else {
      byKey.set(key, { query: key, hashed: rec.query === undefined, count: 1, tools: [rec.tool], lastSeen: rec.at });
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen))
    .slice(0, limit);
}
