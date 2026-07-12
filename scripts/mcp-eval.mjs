#!/usr/bin/env node
/**
 * MCP quality harness (slice 3 §4): score the documentation tools on a set of
 * "does something like X already exist?" questions with known answers.
 *
 * Usage:
 *   node scripts/mcp-eval.mjs [repo-path] [questions.json]
 *
 * Defaults to the bundled fixture + its built-in question set. A questions
 * file is a JSON array of { "query": "...", "expect": "substring-of-hit-id",
 * "k": 3 } entries — a question passes when a hit whose id contains `expect`
 * ranks in the top k results of search_docs.
 *
 * Run `npm run build` first (uses the compiled packages).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRepo } from "@necronomidoc/server";
import { ManifestStore, tools } from "@necronomidoc/mcp";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoPath = resolve(process.argv[2] ?? join(here, "..", "fixtures", "sample-react-app"));

/** Built-in questions with known answers against the bundled fixture. */
const DEFAULT_QUESTIONS = [
  { query: "counter hook increment state", expect: "#useCounter", k: 3 },
  { query: "format currency", expect: "#formatCurrency", k: 3 },
  { query: "format a date", expect: "#formatDate", k: 3 },
  { query: "button component", expect: "#Button", k: 3 },
  { query: "pure framework-free helpers", expect: ":subsystem:", k: 5 },
  { query: "where does counter state live", expect: "useCounter", k: 5 },
];

const questions = process.argv[3]
  ? JSON.parse(readFileSync(resolve(process.argv[3]), "utf8"))
  : DEFAULT_QUESTIONS;

const dataDir = mkdtempSync(join(tmpdir(), "necro-mcp-eval-"));
try {
  const { entry } = await buildRepo({ dataDir, target: repoPath });
  console.log(`Built ${entry.name}: ${entry.fileCount} files, ${entry.symbolCount} symbols\n`);

  const store = new ManifestStore(dataDir);
  store.reload();

  let passed = 0;
  for (const q of questions) {
    const k = q.k ?? 3;
    const { hits } = tools.search_docs(store, { query: q.query, repo: q.repo });
    const rank = hits.findIndex((h) => h.id.includes(q.expect));
    const ok = rank !== -1 && rank < k;
    if (ok) passed++;
    const shown = rank === -1 ? "miss" : `rank ${rank + 1}`;
    console.log(`${ok ? "✓" : "✗"} [${shown}@${k}] "${q.query}" → expect id ~ "${q.expect}"`);
    if (!ok) {
      for (const h of hits.slice(0, k)) console.log(`    got: ${h.id} (${h.name})`);
    }
  }
  console.log(`\n${passed}/${questions.length} questions answered in the top k.`);
  process.exitCode = passed === questions.length ? 0 : 1;
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
