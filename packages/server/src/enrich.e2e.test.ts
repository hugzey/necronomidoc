import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CoreDocsManifest,
  DocModel,
  SubsystemsManifest,
  type EnrichmentOverlay,
} from "@necronomidoc/docmodel";
import {
  EnrichmentTaskFile,
  type EnrichmentResultsFile,
  type LlmClient,
  type LlmCompleteRequest,
} from "@necronomidoc/enrichment";
import { ManifestStore, paths, readRegistry, tools } from "@necronomidoc/mcp";
import { enrichRepo, exportEnrichTasks, importEnrichResults, reviewStale } from "./enrich.js";

const fixture = fileURLToPath(new URL("../../../fixtures/sample-react-app", import.meta.url));

function fakeClient(): LlmClient & { calls: LlmCompleteRequest[] } {
  const calls: LlmCompleteRequest[] = [];
  return {
    model: "fake-model",
    calls,
    async complete(request) {
      calls.push(request);
      // Core-doc requests ask for {title, content}; overlay requests for
      // {file, symbols}. Tell them apart by the requested schema.
      const schema = request.jsonSchema as { properties?: Record<string, unknown> } | undefined;
      if (schema?.properties && "title" in schema.properties) {
        return {
          text: JSON.stringify({
            title: "Generated core doc",
            content: "# Generated core doc\n\n```mermaid\ngraph LR\n  a --> b\n```\n\nLLM-written body.",
          }),
          inputTokens: 100,
          outputTokens: 40,
        };
      }
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
    // Core docs are hash-cached too: nothing to write on an unchanged repo.
    expect(result.coreDocs!.planned).toEqual([]);
    expect(result.coreDocs!.fresh).toBe(3);
  });

  it("publishes core docs with per-doc precedence: repo file wins, llm fills the gaps", () => {
    const manifest = CoreDocsManifest.parse(
      JSON.parse(readFileSync(paths.coreDocs(paths.repoDir(dataDir, "sample-react-app")), "utf8")),
    );
    const byKind = new Map(manifest.docs.map((d) => [d.kind, d]));
    expect(manifest.docs).toHaveLength(4);

    // The fixture ships .necronomidoc/docs/architecture.md — repo tier wins.
    expect(byKind.get("architecture")!.provenance).toBe("repo");
    expect(byKind.get("architecture")!.content).toContain("```mermaid");

    // The other three had no curated source, so the enrich run wrote them.
    for (const kind of ["overview", "conventions", "packages"] as const) {
      expect(byKind.get(kind)!.provenance, kind).toBe("llm");
      expect(byKind.get(kind)!.stale, kind).toBe(false);
    }

    // Served over MCP with provenance, and indexed by search.
    const store = new ManifestStore(dataDir);
    store.reload();
    const doc = tools.get_core_doc(store, { repo: "sample-react-app", doc: "architecture" });
    expect(doc["provenance"]).toBe("repo");
    expect(String(doc["content"])).toContain("graph TD");
    const hits = (
      tools.search_docs(store, { query: "sample app architecture" }) as {
        hits: { id: string }[];
      }
    ).hits;
    expect(hits.some((h) => h.id.includes(":coredoc:"))).toBe(true);
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
      expect(result.coreDocs!.planned).toEqual(["overview", "conventions", "packages"]);
      expect(existsSync(paths.repoDir(scratch, "sample-react-app"))).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("review-stale reports cleanly when nothing is stale", async () => {
    const review = await reviewStale({ dataDir, target: fixture });
    expect(review).toContain("No stale overlays");
  });

  it("dry-run works without any provider configured (agent-mode users have no keys)", async () => {
    for (const name of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "AZURE_OPENAI_API_KEY",
      "AZURE_AI_API_KEY",
      "NECRONOMIDOC_LLM_PROVIDER",
      "NECRONOMIDOC_LLM_BASE_URL",
    ]) {
      vi.stubEnv(name, "");
    }
    try {
      const scratch = mkdtempSync(join(tmpdir(), "necro-enrich-nokey-"));
      try {
        const result = await enrichRepo({ dataDir: scratch, target: fixture, dryRun: true });
        expect(result.published).toBe(false);
        expect(result.report.plannedFiles).toBeGreaterThan(0);
        // A real run without configuration fails fast with the config hint.
        await expect(enrichRepo({ dataDir: scratch, target: fixture })).rejects.toThrow(
          /No LLM provider configured/,
        );
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("agent-mode enrichment: export tasks → complete offline → import results", () => {
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "necro-enrich-agent-"));
  });
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("round-trips: the imported results publish exactly like a live enrich run", async () => {
    const tasksPath = join(dataDir, "tasks.json");
    const exported = await exportEnrichTasks({
      dataDir,
      target: fixture,
      subsystems: true,
      outFile: tasksPath,
    });
    expect(exported.slug).toBe("sample-react-app");
    expect(exported.fileTasks).toBeGreaterThan(0);
    expect(exported.skippedHuman).toBe(2); // same plan as a live run
    // The fixture curates architecture.md; the other three kinds need tasks.
    expect(exported.coreDocTasks).toEqual(["overview", "conventions", "packages"]);

    const taskFile = EnrichmentTaskFile.parse(JSON.parse(readFileSync(tasksPath, "utf8")));
    expect(taskFile.instructions).toContain("--import-results");

    // Core-doc/subsystem prompts are built from the overlay-merged view, so
    // existing (here: human) summaries reach the agent just like a live run.
    const overviewTask = taskFile.tasks.find((t) => t.id === "core-doc:overview")!;
    expect(overviewTask.request.prompt).toContain("The one place formatting helpers live.");

    // Stand in for the coding agent: complete every task per its schema.
    const results: EnrichmentResultsFile = {
      formatVersion: 1,
      repo: taskFile.repo.slug,
      model: "test-agent",
      results: taskFile.tasks.map((task) => {
        if (task.kind === "file-summary") {
          return {
            id: task.id,
            output: {
              file: { summary: "Agent file summary.", purpose: "Agent purpose." },
              symbols: task.target!.symbols.map((s) => ({
                id: s.id,
                summary: `Agent summary for ${s.id.split("#").pop()}.`,
              })),
            },
          };
        }
        if (task.kind === "core-doc") {
          return {
            id: task.id,
            output: {
              title: `Agent ${task.coreDoc!.kind}`,
              content: `# Agent ${task.coreDoc!.kind}\n\nWritten offline.`,
            },
          };
        }
        return {
          id: task.id,
          output: {
            subsystems: [{ name: "App", purpose: "The whole sample app.", dirs: ["src"] }],
          },
        };
      }),
    };
    const resultsPath = join(dataDir, "results.json");
    writeFileSync(resultsPath, JSON.stringify(results));

    const imported = await importEnrichResults({
      dataDir,
      target: fixture,
      resultsFile: resultsPath,
      tasksFile: tasksPath,
    });
    expect(imported.slug).toBe("sample-react-app");
    expect(imported.failures).toEqual([]);
    expect(imported.missingTasks).toEqual([]);
    expect(imported.overlaysWritten).toBeGreaterThan(0);
    expect(imported.coreDocsWritten).toBe(3);
    expect(imported.subsystemsProposed).toBe(1);
    expect(imported.published).toBe(true);

    // Published like a live run: summaries everywhere, human curation intact.
    const model = DocModel.parse(
      JSON.parse(readFileSync(paths.docmodel(paths.repoDir(dataDir, imported.slug)), "utf8")),
    );
    for (const file of model.files.filter((f) => f.format === "source")) {
      expect(file.enrichment?.summary, file.path).toBeTruthy();
    }
    const format = model.files.find((f) => f.path === "src/utils/format.ts")!;
    expect(format.enrichment?.provenance).toBe("human");

    const coreDocs = CoreDocsManifest.parse(
      JSON.parse(readFileSync(paths.coreDocs(paths.repoDir(dataDir, imported.slug)), "utf8")),
    );
    const overview = coreDocs.docs.find((d) => d.kind === "overview")!;
    expect(overview.provenance).toBe("llm");
    expect(overview.stale).toBe(false); // repo unchanged since export → fresh
    expect(overview.content).toContain("Written offline.");
  });

  it("a second export on the imported state finds nothing left to do", async () => {
    const tasksPath = join(dataDir, "tasks-2.json");
    const exported = await exportEnrichTasks({ dataDir, target: fixture, outFile: tasksPath });
    expect(exported.fileTasks).toBe(0);
    expect(exported.coreDocTasks).toEqual([]);
    expect(exported.skippedFresh).toBeGreaterThan(0);
  });
});
