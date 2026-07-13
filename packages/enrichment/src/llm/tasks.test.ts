import { describe, expect, it } from "vitest";
import type { DocModel, EnrichmentOverlay } from "@necronomidoc/docmodel";
import {
  applyEnrichmentResults,
  buildEnrichmentTaskFile,
  EnrichmentTaskFile,
  type EnrichmentResultsFile,
} from "./tasks.js";

function sampleModel(): DocModel {
  return {
    schemaVersion: 1,
    repo: { name: "demo", slug: "demo" },
    files: [
      {
        id: "demo:src/a.ts",
        path: "src/a.ts",
        contentHash: "hash-a",
        format: "source",
        imports: [],
        exports: ["alpha"],
        symbols: [
          {
            id: "demo:src/a.ts#alpha",
            name: "alpha",
            kind: "function",
            exported: true,
            location: { path: "src/a.ts", line: 1 },
            contentHash: "hash-alpha",
          },
        ],
      },
      {
        id: "demo:src/b.ts",
        path: "src/b.ts",
        contentHash: "hash-b",
        format: "source",
        imports: [],
        exports: [],
        symbols: [],
      },
    ],
  };
}

const NOW = () => "2026-07-13T00:00:00.000Z";

function exportTasks(overlays = new Map<string, EnrichmentOverlay>()) {
  return buildEnrichmentTaskFile(sampleModel(), {
    overlays,
    readSource: (path) => `// source of ${path}`,
    coreDocKinds: ["overview"],
    subsystems: true,
    now: NOW,
  });
}

describe("buildEnrichmentTaskFile", () => {
  it("packages one task per planned file plus core-doc and subsystem tasks", () => {
    const { taskFile, plan } = exportTasks();
    expect(plan.work).toHaveLength(2);
    expect(taskFile.tasks.map((t) => t.id)).toEqual([
      "file:src/a.ts",
      "file:src/b.ts",
      "core-doc:overview",
      "subsystems",
    ]);
    // The round-trippable contract: parses under its own zod schema.
    expect(() => EnrichmentTaskFile.parse(JSON.parse(JSON.stringify(taskFile)))).not.toThrow();

    const fileTask = taskFile.tasks[0]!;
    expect(fileTask.request.prompt).toContain("File: src/a.ts");
    expect(fileTask.request.prompt).toContain("// source of src/a.ts");
    expect(fileTask.request.jsonSchema).toBeDefined();
    expect(fileTask.target).toEqual({
      fileId: "demo:src/a.ts",
      fileContentHash: "hash-a",
      enrichFile: true,
      symbols: [{ id: "demo:src/a.ts#alpha", contentHash: "hash-alpha" }],
    });
    expect(taskFile.instructions).toContain("--import-results");
  });

  it("respects the human-curation and hash-cache skips, like a live run", () => {
    const overlays = new Map<string, EnrichmentOverlay>([
      [
        "demo:src/a.ts",
        {
          targetId: "demo:src/a.ts",
          summary: "Curated.",
          provenance: "human",
          updatedAt: NOW(),
        },
      ],
      [
        "demo:src/a.ts#alpha",
        {
          targetId: "demo:src/a.ts#alpha",
          summary: "Curated too.",
          provenance: "human",
          updatedAt: NOW(),
        },
      ],
    ]);
    const { taskFile, plan } = exportTasks(overlays);
    expect(plan.skippedHuman).toBe(2);
    expect(taskFile.tasks.filter((t) => t.kind === "file-summary").map((t) => t.id)).toEqual([
      "file:src/b.ts",
    ]);
  });
});

describe("applyEnrichmentResults", () => {
  it("turns agent results into overlays, core docs, and subsystems", () => {
    const { taskFile } = exportTasks();
    const results: EnrichmentResultsFile = {
      formatVersion: 1,
      repo: "demo",
      model: "my-agent",
      results: [
        {
          id: "file:src/a.ts",
          output: {
            file: { summary: "File A.", purpose: "Purpose A." },
            symbols: [
              { id: "demo:src/a.ts#alpha", summary: "Alpha." },
              { id: "demo:src/a.ts#invented", summary: "Hallucinated." },
            ],
          },
        },
        // A JSON-encoded string is accepted too — agents do both.
        {
          id: "file:src/b.ts",
          output: JSON.stringify({ file: { summary: "File B." }, symbols: [] }),
        },
        { id: "core-doc:overview", output: { title: "Overview", content: "# Overview\n\nBody." } },
        {
          id: "subsystems",
          output: { subsystems: [{ name: "Core", purpose: "Everything.", dirs: ["src"] }] },
        },
      ],
    };

    const applied = applyEnrichmentResults(taskFile, results, { now: NOW });
    expect(applied.applied).toBe(4);
    expect(applied.failures).toEqual([]);
    expect(applied.missingTasks).toEqual([]);
    expect(applied.unmatchedResults).toEqual([]);

    expect(applied.overlays).toHaveLength(3);
    const byId = new Map(applied.overlays.map((o) => [o.targetId, o]));
    expect(byId.get("demo:src/a.ts")).toMatchObject({
      summary: "File A.",
      purpose: "Purpose A.",
      provenance: "llm",
      sourceContentHash: "hash-a",
    });
    expect(byId.get("demo:src/a.ts#alpha")!.sourceContentHash).toBe("hash-alpha");
    expect(byId.has("demo:src/a.ts#invented")).toBe(false); // dropped, same as live runs

    expect(applied.coreDocs[0]).toMatchObject({
      kind: "overview",
      title: "Overview",
      model: "my-agent",
    });
    expect(applied.coreDocs[0]!.sourceRepoHash).toBeTruthy();
    expect(applied.subsystems![0]).toMatchObject({ id: "core", provenance: "llm" });
  });

  it("reports unmatched, duplicate, missing, and malformed results without dying", () => {
    const { taskFile } = exportTasks();
    const applied = applyEnrichmentResults(
      taskFile,
      {
        formatVersion: 1,
        results: [
          { id: "file:src/a.ts", output: { wrong: "shape" } },
          { id: "file:src/a.ts", output: { also: "duplicate" } },
          { id: "file:nope.ts", output: {} },
        ],
      },
      { now: NOW },
    );
    expect(applied.applied).toBe(0);
    expect(applied.failures.map((f) => f.id)).toEqual(["file:src/a.ts"]);
    expect(applied.unmatchedResults).toEqual(["file:src/a.ts", "file:nope.ts"]);
    expect(applied.missingTasks).toEqual(["file:src/b.ts", "core-doc:overview", "subsystems"]);
  });
});
