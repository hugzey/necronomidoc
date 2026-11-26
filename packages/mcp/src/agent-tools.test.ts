import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DocModel, DocVersionEntry, SessionDoc } from "@necronomidoc/docmodel";
import { parseUnifiedDiff } from "./change.js";
import { diffStates, resolveSince } from "./changes.js";
import { pathToOutcome, sessionCheckSkeleton } from "./checks.js";
import { estimateTokens, oneLine } from "./detail.js";
import { canon } from "./duplicates.js";
import { MissLog, aggregateMisses, readMisses } from "./misses.js";
import { contentTerms, isTestOrFixturePath, pickBestAnswer, prepareQuery, rankHits } from "./ranking.js";
import type { SearchHit } from "./store.js";
import { trustScore } from "./trust.js";

const hit = (over: Partial<SearchHit>): SearchHit => ({
  id: "r:a.ts",
  type: "file",
  repo: "r",
  path: "a.ts",
  name: "a.ts",
  score: 1,
  matchedTerms: [],
  ...over,
});

describe("code-aware ranking", () => {
  it("drops filler words but keeps task verbs out of the coverage requirement", () => {
    expect(contentTerms("how do I add price formatting to the CartPage")).toEqual(["price", "formatting", "cartpage"]);
    expect(prepareQuery("where does counter state live").text).toBe("counter state live");
  });

  it("expands curated synonyms and credits them as covering the term", () => {
    const prepared = prepareQuery("currency helper", { currency: ["formatMoney"] });
    expect(prepared.text).toBe("currency helper formatMoney");
    const ranked = rankHits([hit({ id: "r:m.ts#formatMoney", type: "symbol", name: "formatMoney", matchedTerms: ["formatmoney", "helper"] })], "currency helper", prepared, { exported: () => true });
    expect(ranked[0]!.coverage).toBe(1);
  });

  it("boosts exported symbols, penalises tests/fixtures, and collapses a file with its symbols", () => {
    const prepared = prepareQuery("format date");
    const raw = [
      hit({ id: "r:src/f.ts", type: "file", path: "src/f.ts", name: "f.ts", score: 10, matchedTerms: ["format", "date"], summary: "Formatting." }),
      hit({ id: "r:src/f.ts#formatDate", type: "symbol", path: "src/f.ts", name: "formatDate", score: 9, matchedTerms: ["format", "date"] }),
      hit({ id: "r:src/f.ts#pad", type: "symbol", path: "src/f.ts", name: "pad", score: 3, matchedTerms: ["format"] }),
      hit({ id: "r:tests/f.test.ts#formatDate", type: "symbol", path: "tests/f.test.ts", name: "formatDate", score: 12, matchedTerms: ["format", "date"] }),
    ];
    const ranked = rankHits(raw, "format date", prepared, { exported: (id) => !id.includes("pad") });
    expect(ranked.map((h) => h.id)).toEqual(["r:src/f.ts#formatDate", "r:tests/f.test.ts#formatDate"]);
    expect(ranked[0]!.matches).toEqual([{ id: "r:src/f.ts#pad", name: "pad", kind: undefined }]);
    expect(ranked[0]!.fileSummary).toBe("Formatting.");
    expect(isTestOrFixturePath("fixtures/app/x.ts")).toBe(true);
    expect(isTestOrFixturePath("src/x.ts")).toBe(false);
  });

  it("names a best answer only when the ranking is decisive", () => {
    const prepared = prepareQuery("format date");
    const decisive = rankHits(
      [
        hit({ id: "r:a#formatDate", type: "symbol", name: "formatDate", score: 10, matchedTerms: ["format", "date"] }),
        hit({ id: "r:b", path: "b.ts", name: "b.ts", score: 2, matchedTerms: ["date"] }),
      ],
      "format date",
      prepared,
      { exported: () => true },
    );
    expect(pickBestAnswer(decisive, "format date")?.confidence).toBe("high");
    const close = rankHits(
      [
        hit({ id: "r:a#formatDay", type: "symbol", path: "a.ts", name: "formatDay", score: 10, matchedTerms: ["format", "date"] }),
        hit({ id: "r:b#formatTime", type: "symbol", path: "b.ts", name: "formatTime", score: 9.5, matchedTerms: ["format", "date"] }),
      ],
      "format date",
      prepared,
      { exported: () => true },
    );
    expect(pickBestAnswer(close, "format date")).toBeUndefined();
    expect(pickBestAnswer(close, "formatDay")?.reason).toBe("exact name match");
  });
});

describe("trust score", () => {
  it("combines provenance, staleness, binding drift and tests", () => {
    expect(trustScore({ provenance: "human", tested: true })).toMatchObject({ score: 1, level: "high" });
    expect(trustScore({ provenance: "human", stale: true })).toMatchObject({ score: 0.55, level: "medium" });
    expect(trustScore({ provenance: "llm", bindings: ["ok", "broken"] })).toMatchObject({ score: 0.45, level: "low" });
    expect(trustScore({ provenance: "heuristic", documented: true }).why).toContain("from doc comment");
  });
});

describe("detail helpers", () => {
  it("keeps the first sentence and estimates tokens", () => {
    expect(oneLine("Formats money. Uses Intl under the hood.")).toBe("Formats money.");
    expect(estimateTokens({ a: "x".repeat(40) })).toBe(12); // 48 chars of JSON
  });

  it("canonicalises synonym verbs and nouns for duplicate detection", () => {
    expect(canon("fetching")).toBe(canon("load"));
    expect(canon("currency")).toBe(canon("money"));
    expect(canon("users")).toBe("user");
  });
});

describe("unified diff parsing", () => {
  it("collects old-side ranges, added lines and new/deleted files", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,3 +10,4 @@ export function a() {",
      " keep",
      "-old",
      "+new one",
      "+another",
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,1 @@",
      "+export const x = 1;",
      "diff --git a/src/gone.ts b/src/gone.ts",
      "deleted file mode 100644",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-a",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/new.ts", "src/gone.ts"]);
    expect(files[0]).toMatchObject({ ranges: [[10, 12]], added: ["new one", "another"], isNew: false });
    expect(files[1]).toMatchObject({ isNew: true, added: ["export const x = 1;"] });
    expect(files[2]).toMatchObject({ isDeleted: true });
  });
});

const model = (files: { path: string; hash: string; symbols?: { name: string; hash: string; sig?: string }[]; summary?: string }[]): DocModel => ({
  schemaVersion: 1,
  repo: { name: "r", slug: "r" },
  files: files.map((f) => ({
    id: `r:${f.path}`,
    path: f.path,
    contentHash: f.hash,
    format: "source",
    imports: [],
    exports: [],
    enrichment: f.summary ? { summary: f.summary, provenance: "human", stale: false } : undefined,
    symbols: (f.symbols ?? []).map((s) => ({
      id: `r:${f.path}#${s.name}`,
      name: s.name,
      kind: "function",
      exported: true,
      signature: s.sig,
      location: { path: f.path, line: 1 },
      contentHash: s.hash,
    })),
  })),
});

describe("what changed since", () => {
  it("diffs files, symbols (with old signatures) and doc-only changes", () => {
    const before = model([
      { path: "a.ts", hash: "1", symbols: [{ name: "f", hash: "f1", sig: "f(a)" }, { name: "g", hash: "g1" }] },
      { path: "b.ts", hash: "1", summary: "old" },
      { path: "gone.ts", hash: "1" },
    ]);
    const after = model([
      { path: "a.ts", hash: "2", symbols: [{ name: "f", hash: "f2", sig: "f(a, b)" }, { name: "h", hash: "h1" }] },
      { path: "b.ts", hash: "1", summary: "new" },
      { path: "new.ts", hash: "1" },
    ]);
    const d = diffStates({ model: before }, { model: after }) as Record<string, Record<string, unknown>>;
    expect(d["summary"]).toMatchObject({ filesAdded: 1, filesRemoved: 1, filesChanged: 1, filesDocsChanged: 1, symbolsAdded: 1, symbolsRemoved: 1, symbolsChanged: 1 });
    expect(d["files"]).toMatchObject({ added: ["new.ts"], removed: ["gone.ts"], changed: ["a.ts"], docsChanged: ["b.ts"] });
    expect((d["symbols"]!["changed"] as { signatureWas?: string }[])[0]!.signatureWas).toBe("f(a)");
  });

  it("resolves versions and commit prefixes, newest first", () => {
    const v = (version: number, commit?: string): DocVersionEntry => ({ version, generatedAt: "t", docsHash: "h", contentHash: "c", commit, fileCount: 0, symbolCount: 0, rebuilds: 0, archived: true });
    const versions = [v(3, "abcdef1234"), v(2, "abcdef1234"), v(1, "0123456789")];
    expect(resolveSince(versions, 2)?.version).toBe(2);
    expect(resolveSince(versions, "v1")?.version).toBe(1);
    expect(resolveSince(versions, "abcdef")?.version).toBe(3);
    expect(resolveSince(versions, "0123")?.version).toBe(1);
    expect(resolveSince(versions, "zz")).toBeUndefined();
  });
});

const session: SessionDoc = {
  type: "session",
  id: "SES-002",
  title: "Agent finds a helper",
  status: "accepted",
  tags: [],
  persona: "PER-1",
  job: "JOB-1",
  intent: "Is there already a currency formatter?",
  entry: { channel: "mcp", preconditions: [] },
  steps: [
    { id: "S1", actor: "agent", action: "Searches", surface: "`search_docs`", expects: "a hit", code: [], branches: [{ when: "nothing found", goto: "S3" }] },
    { id: "S2", actor: "agent", action: "Reads the signature", surface: "`get_function_doc`", code: [], outcome: "OUT-1", branches: [] },
    { id: "S3", actor: "agent", action: "Gives up", code: [], outcome: "OUT-2", branches: [] },
  ],
  outcomes: [
    { id: "OUT-1", kind: "fulfilled", title: "Reuses the helper", criteria: ["no new function written"] },
    { id: "OUT-2", kind: "abandoned", title: "Writes a duplicate", criteria: [] },
  ],
  stories: [],
  metrics: [],
  path: "docs/product/sessions/SES-002-x.md",
  provenance: "repo",
  stale: false,
  docHash: "h",
  body: "",
  acceptance: [],
  requirements: [],
  bindings: [],
  diagrams: {},
  referencedBy: [],
  tests: [],
};

describe("executable session checks", () => {
  it("finds the step path to each outcome, through branches", () => {
    expect(pathToOutcome(session, "OUT-1")!.steps.map((s) => s.id)).toEqual(["S1", "S2"]);
    const viaBranch = pathToOutcome(session, "OUT-2")!;
    expect(viaBranch.steps.map((s) => s.id)).toEqual(["S1", "S3"]);
    expect(viaBranch.via).toEqual(["S1: nothing found"]);
  });

  it("generates an MCP-call skeleton whose skipped tests cite each outcome", () => {
    const file = sessionCheckSkeleton(session);
    expect(file.framework).toBe("mcp");
    expect(file.path).toBe("tests/product/ses-002.check.test.ts");
    expect(file.outcomes).toEqual(["SES-2.OUT-1", "SES-2.OUT-2"]);
    expect(file.content).toContain('it.skip("[SES-002.OUT-1] Reuses the helper (fulfilled)"');
    expect(file.content).toContain('await call("search_docs"');
    expect(file.content).toContain('await call("get_function_doc"');
    expect(file.content).toContain("// - no new function written");
  });

  it("uses Playwright for web sessions", () => {
    const web = sessionCheckSkeleton({ ...session, entry: { channel: "web", preconditions: [] } });
    expect(web.framework).toBe("playwright");
    expect(web.content).toContain('import { expect, test } from "@playwright/test";');
    expect(web.content).toContain("test.fixme(");
  });
});

describe("miss log", () => {
  it("records misses per privacy mode and aggregates them", () => {
    const dir = mkdtempSync(join(tmpdir(), "necro-miss-"));
    try {
      const file = join(dir, "misses.jsonl");
      const full = new MissLog(file, "full");
      full.record({ tool: "search_docs", repo: "r", query: "Currency  Helper", hits: 0 });
      full.record({ tool: "get_context_for_task", repo: "r", query: "currency helper", hits: 2 });
      new MissLog(file, "hashed").record({ tool: "search_docs", repo: "r", query: "secret thing", hits: 0 });
      new MissLog(file, "off").record({ tool: "search_docs", repo: "r", query: "ignored", hits: 0 });
      const records = readMisses(file);
      expect(records).toHaveLength(3);
      expect(records[2]!.query).toBeUndefined();
      expect(JSON.stringify(records)).not.toContain("secret");
      const agg = aggregateMisses(records, "r");
      expect(agg[0]).toMatchObject({ query: "currency helper", count: 2, hashed: false, tools: ["search_docs", "get_context_for_task"] });
      expect(agg[1]!.hashed).toBe(true);
      expect(aggregateMisses(records, "other")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
