import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentManifest } from "@necronomidoc/docmodel";
import { ManifestStore, missLogPath, paths, tools } from "@necronomidoc/mcp";
import { createApp } from "./app.js";
import { buildRepo } from "./build.js";
import { loadConfig } from "./config.js";
import { ProposalStore, listProposals, reviewProposal } from "./proposals.js";

const fixture = fileURLToPath(new URL("../../../fixtures/sample-react-app", import.meta.url));
const SLUG = "app";

/** The fixture plus invariants, a test file and a second page-like pattern. */
function prepareRepo(dir: string): void {
  cpSync(fixture, dir, { recursive: true });
  const subsystems = join(dir, ".necronomidoc", "subsystems.yaml");
  writeFileSync(
    subsystems,
    readFileSync(subsystems, "utf8").replace(
      "    entryPoints:\n      - src/utils/format.ts",
      "    invariants:\n      - Every helper is pure — no I/O, no globals.\n    entryPoints:\n      - src/utils/format.ts",
    ),
  );
  const overlays = join(dir, ".necronomidoc", "enrichment", "overlays.yaml");
  writeFileSync(
    overlays,
    `${readFileSync(overlays, "utf8")}\n- targetId: "app:src/utils/format.ts#formatCurrency"\n  provenance: human\n  summary: "Format an amount of money as a localized currency string."\n  invariants:\n    - "Amounts are major units (dollars), never cents."\n`,
  );
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "tests", "format.test.ts"), 'import { formatCurrency } from "../src/utils/format";\nit("formats", () => formatCurrency(1));\n');
}

async function mcpCall(app: ReturnType<typeof createApp>, name: string, args: Record<string, unknown>, token?: string) {
  const res = await app.fetch(
    new Request("http://x/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const body = (await res.json()) as { result?: { content: { text: string }[] }; error?: { message: string } };
  if (!body.result) throw new Error(body.error?.message ?? "no result");
  return JSON.parse(body.result.content[0]!.text) as Record<string, unknown>;
}

describe("agent tools end to end (decision 0024)", () => {
  let dataDir: string;
  let work: string;
  let store: ManifestStore;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "necro-agent-e2e-"));
    work = mkdtempSync(join(tmpdir(), "necro-agent-repo-"));
    prepareRepo(work);
    await buildRepo({ dataDir, target: work, name: SLUG });
    store = new ManifestStore(dataDir);
    store.reload();
  });
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  it("publishes agent.json with usages and test-to-code bindings", () => {
    const agent = AgentManifest.parse(JSON.parse(readFileSync(paths.agent(paths.repoDir(dataDir, SLUG)), "utf8")));
    expect(agent.testsScanned).toBe(true);
    expect(agent.tests).toEqual([{ path: "tests/format.test.ts", cites: [], exercises: ["src/utils/format.ts"] }]);
    expect(agent.usages["app:src/hooks/useCounter.ts#useCounter"]![0]).toMatchObject({ path: "src/App.tsx" });
  });

  it("[STORY-005.AC-1] packs a task-scoped context bundle within the token budget", () => {
    const ctx = tools.get_context_for_task(store, { task: "format a price as currency for display", repo: SLUG }) as {
      used: number;
      budget: number;
      symbols: { name: string; invariants?: string[]; trust: { level: string } }[];
      subsystems: { id: string; invariants?: string[]; doesNotOwn?: string[] }[];
      tests?: string[];
    };
    expect(ctx.used).toBeLessThanOrEqual(ctx.budget);
    expect(ctx.symbols[0]!.name).toBe("formatCurrency");
    expect(ctx.symbols[0]!.trust.level).toBe("high");
    expect(ctx.symbols[0]!.invariants).toEqual([
      "Amounts are major units (dollars), never cents.",
      "(Utilities) Every helper is pure — no I/O, no globals.",
    ]);
    expect(ctx.subsystems[0]).toMatchObject({ id: "utils", doesNotOwn: ["React imports of any kind"] });
    expect(ctx.tests).toEqual(["tests/format.test.ts"]);

    const tiny = tools.get_context_for_task(store, { task: "format a price as currency for display", repo: SLUG, budget: 200 }) as {
      used: number;
      omitted?: Record<string, number>;
    };
    expect(tiny.used).toBeLessThanOrEqual(200);
    expect(tiny.omitted).toBeDefined();
  });

  it("ranks search for code, names a best answer, and shrinks at detail=brief", () => {
    const normal = tools.search_docs(store, { query: "currency formatting", repo: SLUG });
    const best = normal["bestAnswer"] as { name: string; signature: string; invariants: string[] };
    expect(best.name).toBe("formatCurrency");
    expect(best.signature).toContain("amount: number");
    expect(best.invariants.length).toBe(2);
    const brief = tools.search_docs(store, { query: "currency formatting", repo: SLUG, detail: "brief" });
    expect(JSON.stringify(brief.hits).length).toBeLessThan(JSON.stringify(normal.hits).length);

    const one = tools.get_file_doc(store, { repo: SLUG, path: "src/utils/format.ts", symbol: "formatDate", detail: "brief" }) as { symbols: { name: string }[] };
    expect(one.symbols.map((s) => s.name)).toEqual(["formatDate"]);
    const fn = tools.get_function_doc(store, { repo: SLUG, name: "useCounter" }) as { usages: { snippet: string }[] };
    expect(fn.usages[0]!.snippet).toContain("useCounter(0)");
  });

  it("[STORY-005.AC-2] [SES-004.OUT-2] guards against duplicates", () => {
    const dup = tools.is_this_a_duplicate(store, { repo: SLUG, name: "formatMoney", purpose: "format money amounts for display" }) as {
      verdict: string;
      candidates: { name: string }[];
    };
    expect(dup.verdict).toBe("likely-duplicate");
    expect(dup.candidates[0]!.name).toBe("formatCurrency");
  });

  it("[STORY-005.AC-3] gates a change: boundary violations, tests to run, invariants, stale docs, duplicates", () => {
    const diff = [
      "diff --git a/src/utils/format.ts b/src/utils/format.ts",
      "--- a/src/utils/format.ts",
      "+++ b/src/utils/format.ts",
      "@@ -11,3 +11,6 @@",
      '+import { useState } from "react";',
      "+export function formatMoney(amount: number): string {",
      "+  return String(amount);",
      "+}",
    ].join("\n");
    const result = tools.check_change(store, { repo: SLUG, diff }) as {
      verdict: string;
      testsToRun: { path: string; why: string[] }[];
      boundaryViolations: { message: string; statement?: string }[];
      invariants: string[];
      docsToUpdate?: { symbols: { id: string }[] };
      possibleDuplicates: { proposed: string; existing: string }[];
    };
    expect(result.verdict).toBe("review");
    expect(result.boundaryViolations[0]).toMatchObject({ statement: "React imports of any kind" });
    expect(result.testsToRun).toEqual([{ path: "tests/format.test.ts", why: ["imports src/utils/format.ts"] }]);
    expect(result.invariants).toContain("Amounts are major units (dollars), never cents.");
    expect(result.docsToUpdate!.symbols.map((s) => s.id)).toContain("app:src/utils/format.ts#formatCurrency");
    expect(result.possibleDuplicates[0]).toMatchObject({ proposed: "formatMoney", existing: "app:src/utils/format.ts#formatCurrency" });
  });

  it("[STORY-005.AC-4] answers what changed since an earlier version", async () => {
    const file = join(work, "src", "utils", "format.ts");
    writeFileSync(file, readFileSync(file, "utf8").replace("export function formatDate(date: Date): string {", "export function formatDate(date: Date, utc = true): string {"));
    await buildRepo({ dataDir, target: work, name: SLUG });
    store.reload();
    const result = tools.what_changed_since(store, { repo: SLUG, since: 1 }) as {
      current: { version: number };
      summary: Record<string, number>;
      symbols: { changed: { id: string; signatureWas?: string }[] };
    };
    expect(result.current.version).toBe(2);
    expect(result.summary["filesChanged"]).toBe(1);
    expect(result.symbols.changed.find((s) => s.id.endsWith("#formatDate"))?.signatureWas).toBe("formatDate(date: Date)");
    expect(tools.what_changed_since(store, { repo: SLUG, since: 2 })["unchanged"]).toBe(true);
  });

  it("[STORY-005.REQ-1] [STORY-005.REQ-2] lints agent-written docs and lands them as drafts a human accepts", async () => {
    const sink = new ProposalStore(dataDir, store);
    const bad = sink.proposeOverlay({ repo: SLUG, path: "src/utils/format.ts", symbol: "formatDate", summary: "TODO" });
    expect(bad["accepted"]).toBe(false);
    expect(listProposals(dataDir)).toHaveLength(0);

    const ok = sink.proposeOverlay({
      repo: SLUG,
      path: "src/utils/format.ts",
      symbol: "formatDate",
      invariants: ["Always UTC unless utc=false is passed."],
      rationale: "The new utc flag is easy to miss.",
      author: "test-agent",
    });
    expect(ok["accepted"]).toBe(true);
    const id = String(ok["id"]);
    // Nothing publishes until a human accepts it.
    store.reload();
    expect(store.getSymbolById("app:src/utils/format.ts#formatDate")!.enrichment?.invariants).toBeUndefined();

    const reviewed = reviewProposal(dataDir, id, "accept", { note: "lgtm", store });
    expect(reviewed.status).toBe("accepted");
    expect(existsSync(reviewed.writtenTo!)).toBe(true);
    await buildRepo({ dataDir, target: work, name: SLUG });
    store.reload();
    const enrichment = store.getSymbolById("app:src/utils/format.ts#formatDate")!.enrichment!;
    expect(enrichment.invariants).toEqual(["Always UTC unless utc=false is passed."]);
    expect(enrichment.provenance).toBe("human");
    // The heuristic doc-comment summary survives (only proposed fields changed).
    expect(enrichment.summary).toBe("Format a Date as `YYYY-MM-DD`.");
    expect(() => reviewProposal(dataDir, id, "reject")).toThrow(/already accepted/);

    const doc = sink.proposeProductDoc({
      repo: SLUG,
      content: "---\nid: STORY-010\ntitle: Format prices\nstatus: accepted\npersona: PER-404\nwant: prices formatted\nsoThat: I can read them\n---\n\n# Format prices\n",
    });
    expect(doc["accepted"]).toBe(false);
    expect(JSON.stringify(doc["findings"])).toContain("PER-404");
  });

  it("[SES-004.OUT-1] serves the tools over HTTP MCP: write-back needs the admin token; misses feed undocumented concepts", async () => {
    const token = "t0ken-for-tests";
    const app = createApp(loadConfig({ dataDir, siteDir: join(dataDir, "no-site"), token }));
    const denied = await mcpCall(app, "propose_overlay", { repo: SLUG, path: "src/App.tsx", summary: "Root shell." });
    expect(String(denied["error"])).toContain("admin bearer token");
    const allowed = await mcpCall(app, "propose_overlay", { repo: SLUG, path: "src/App.tsx", symbol: "App", summary: "Root shell wiring the counter to the buttons." }, token);
    expect(allowed["accepted"]).toBe(true);

    const miss = await mcpCall(app, "search_docs", { query: "kubernetes autoscaler", repo: SLUG });
    expect(miss["note"]).toBeDefined();
    expect(readFileSync(missLogPath(dataDir), "utf8")).toContain("kubernetes autoscaler");

    const list = await app.fetch(new Request("http://x/api/proposals?status=proposed", { headers: { authorization: `Bearer ${token}` } }));
    expect(((await list.json()) as { proposals: unknown[] }).proposals).toHaveLength(1);
    expect((await app.fetch(new Request("http://x/api/misses"))).status).toBe(401);

    await buildRepo({ dataDir, target: work, name: SLUG });
    const agent = AgentManifest.parse(JSON.parse(readFileSync(paths.agent(paths.repoDir(dataDir, SLUG)), "utf8")));
    expect(agent.undocumented.map((u) => u.query)).toContain("kubernetes autoscaler");
  });
});
