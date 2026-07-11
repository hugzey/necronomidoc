import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DocModel, SubsystemsManifest, type EnrichmentOverlay } from "@necronomidoc/docmodel";
import type { LlmClient, LlmCompleteRequest } from "@necronomidoc/enrichment";
import { ManifestStore, paths, readRegistry, tools } from "@necronomidoc/mcp";
import { enrichRepo, reviewStale } from "./enrich.js";

const fixture = fileURLToPath(new URL("../../../fixtures/sample-react-app", import.meta.url));

function fakeClient(): LlmClient & { calls: LlmCompleteRequest[] } {
  const calls: LlmCompleteRequest[] = [];
  return {
    model: "fake-model",
    calls,
    async complete(request) {
      calls.push(request);
      const ids = [...request.prompt.matchAll(/- id: (\S+)/g)].map((m) => m[1]!);
      return {
        text: JSON.stringify({
          file: { summary: "LLM-written file summary.", purpose: "LLM-written purpose." },
          symbols: ids.map((id) => ({ id, summary: `LLM summary for ${id.split("#").pop()}.` })),
        }),
        inputTokens: 100,
        outputTokens: 40,
      };
    },
  };
}

describe("enrich pipeline over the sample fixture", () => {
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "necro-enrich-e2e-"));
  });
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("one enrich run gives every source file and symbol a summary", async () => {
    const client = fakeClient();
    const result = await enrichRepo({ dataDir, target: fixture, client });
    expect(result.slug).toBe("sample-react-app");
    expect(result.report.calls).toBeGreaterThan(0);
    expect(result.report.overlaysWritten).toBeGreaterThan(0);
    // Human-curated targets were skipped, never rewritten.
    expect(result.report.skippedHuman).toBe(2);

    // Overlays persisted server-side for future rebuilds.
    const llmFile = join(dataDir, "enrichment", "sample-react-app", "llm.json");
    expect(existsSync(llmFile)).toBe(true);

    // Published model: every source file/symbol now has a summary, and the
    // human overlays survived (acceptance criteria 1 + 2).
    const model = DocModel.parse(
      JSON.parse(readFileSync(paths.docmodel(paths.repoDir(dataDir, result.slug)), "utf8")),
    );
    for (const file of model.files) {
      expect(file.enrichment?.summary, file.path).toBeTruthy();
      for (const symbol of file.symbols) {
        expect(symbol.enrichment?.summary, symbol.id).toBeTruthy();
      }
    }
    const format = model.files.find((f) => f.path === "src/utils/format.ts")!;
    expect(format.enrichment?.provenance).toBe("human");
    expect(format.enrichment?.summary).toBe("The one place formatting helpers live.");

    // Registry carries the enrichment coverage counts.
    const entry = readRegistry(dataDir).repos.find((r) => r.slug === result.slug)!;
    expect(entry.enrichment).toBeDefined();
    expect(entry.enrichment!.llm).toBeGreaterThan(0);
    expect(entry.enrichment!.human).toBe(2);
  });

  it("re-running on unchanged code makes zero LLM calls", async () => {
    const client = fakeClient();
    const result = await enrichRepo({ dataDir, target: fixture, client });
    expect(client.calls.length).toBe(0);
    expect(result.report.skippedFresh).toBeGreaterThan(0);
  });

  it("publishes the human-curated subsystem map and serves boundaries over MCP", () => {
    const manifest = SubsystemsManifest.parse(
      JSON.parse(
        readFileSync(paths.subsystems(paths.repoDir(dataDir, "sample-react-app")), "utf8"),
      ),
    );
    expect(manifest.subsystems.map((s) => s.id).sort()).toEqual(["state", "ui", "utils"]);
    expect(manifest.subsystems.every((s) => s.provenance === "human")).toBe(true);

    const store = new ManifestStore(dataDir);
    store.reload();

    // "Where does counter state live and what shouldn't go in it?"
    const overview = tools.get_subsystem_overview(store, { repo: "sample-react-app" }) as {
      curated: boolean;
      subsystems: {
        id: string;
        purpose: string;
        doesNotOwn: string[];
        entryPoints: string[];
        files: { path: string }[];
      }[];
    };
    expect(overview.curated).toBe(true);
    const state = overview.subsystems.find((s) => s.id === "state")!;
    expect(state.doesNotOwn).toContain("persistence (nothing here survives a reload)");
    expect(state.entryPoints).toContain("src/hooks/useCounter.ts");
    expect(state.files.map((f) => f.path)).toContain("src/hooks/useCounter.ts");
  });

  it("MCP quality: 'does X already exist?' questions surface the right code", () => {
    const store = new ManifestStore(dataDir);
    store.reload();
    const ask = (query: string) =>
      (tools.search_docs(store, { query }) as { hits: { id: string; name: string }[] }).hits;

    // A counter hook already exists — the canonical one must rank in the top 3.
    const counter = ask("counter hook increment state");
    expect(counter.slice(0, 3).some((h) => h.name === "useCounter")).toBe(true);

    // Currency formatting already exists.
    const currency = ask("format currency");
    expect(currency.slice(0, 3).some((h) => h.name === "formatCurrency")).toBe(true);

    // Subsystem overviews are searchable too.
    const subsystem = ask("pure framework-free helpers");
    expect(subsystem.some((h) => h.id.includes(":subsystem:"))).toBe(true);
  });

  it("dry-run reports the plan without publishing or calling the model", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "necro-enrich-dry-"));
    try {
      const client = fakeClient();
      const result = await enrichRepo({ dataDir: scratch, target: fixture, client, dryRun: true });
      expect(client.calls.length).toBe(0);
      expect(result.published).toBe(false);
      expect(result.report.plannedFiles).toBeGreaterThan(0);
      expect(existsSync(paths.repoDir(scratch, "sample-react-app"))).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("review-stale reports cleanly when nothing is stale", async () => {
    const review = await reviewStale({ dataDir, target: fixture });
    expect(review).toContain("No stale overlays");
  });
});
