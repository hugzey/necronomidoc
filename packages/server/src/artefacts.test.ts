import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient } from "@necronomidoc/enrichment";
import {
  artefactFilePath,
  exportArtefactTasks,
  generateArtefact,
  importArtefactResults,
  readArtefactIndex,
  readArtefactRecord,
} from "./artefacts.js";
import { buildRepo } from "./build.js";

const fixture = fileURLToPath(new URL("../../../fixtures/sample-react-app", import.meta.url));

const fillClient: LlmClient = {
  model: "fake-model",
  complete: async (request) => ({
    text: request.prompt.includes("Plan how to write")
      ? JSON.stringify({ sections: [{ heading: "Only", instruction: "write it" }] })
      : JSON.stringify({ content: "GENERATED" }),
    inputTokens: 5,
    outputTokens: 5,
  }),
};

describe("artefact pipeline over published docs", () => {
  let dataDir: string;
  let templatePath: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "necro-artefacts-"));
    await buildRepo({ dataDir, target: fixture, name: "sample-react-app" });
    templatePath = join(dataDir, "template.md");
    writeFileSync(templatePath, "# Report\n\nSummary: {{summarize}}\n\nKept text.\n");
  });

  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  it("fills a markdown template, persists it, and indexes it", async () => {
    const result = await generateArtefact({
      dataDir,
      templatePath,
      repos: ["sample-react-app"],
      client: fillClient,
    });
    expect(result.mode).toBe("placeholders");
    expect(result.filled).toBe(1);
    const record = result.record!;
    expect(record.scope).toBe("repo");
    expect(readFileSync(result.outputPath!, "utf8")).toBe(
      "# Report\n\nSummary: GENERATED\n\nKept text.\n",
    );
    // Record, template copy, and index entry all round-trip from disk.
    expect(readArtefactRecord(dataDir, record.id)!.name).toBe("template.md");
    expect(readFileSync(artefactFilePath(dataDir, record.id, "template")!, "utf8")).toContain(
      "{{summarize}}",
    );
    expect(readArtefactIndex(dataDir).artefacts[0]!.id).toBe(record.id);
  });

  it("dry run reports the plan without calling or writing", async () => {
    const before = readArtefactIndex(dataDir).artefacts.length;
    const result = await generateArtefact({
      dataDir,
      templatePath,
      all: true,
      dryRun: true,
      client: fillClient,
    });
    expect(result.mode).toBe("placeholders");
    expect(result.tasks).toBe(1);
    expect(result.record).toBeUndefined();
    expect(readArtefactIndex(dataDir).artefacts.length).toBe(before);
  });

  it("sections mode plans then writes sections", async () => {
    const proseTemplate = join(dataDir, "prose.md");
    writeFileSync(proseTemplate, "# Prose doc\n\nNo markers here.\n");
    const result = await generateArtefact({
      dataDir,
      templatePath: proseTemplate,
      all: true,
      client: fillClient,
    });
    expect(result.mode).toBe("sections");
    expect(readFileSync(result.outputPath!, "utf8")).toBe("GENERATED\n");
  });

  it("rejects unsupported template extensions", async () => {
    const bad = join(dataDir, "template.pdf");
    writeFileSync(bad, "%PDF");
    await expect(
      generateArtefact({ dataDir, templatePath: bad, all: true, client: fillClient }),
    ).rejects.toThrow(/Unsupported template/);
  });

  it("agent-mode export/import round-trips through files", async () => {
    const tasksFile = join(dataDir, "art-tasks.json");
    const exported = await exportArtefactTasks({
      dataDir,
      templatePath,
      repos: ["sample-react-app"],
      outFile: tasksFile,
    });
    expect(exported.mode).toBe("placeholders");
    expect(exported.tasks).toBe(1);

    const resultsFile = join(dataDir, "art-results.json");
    writeFileSync(
      resultsFile,
      JSON.stringify({
        formatVersion: 1,
        model: "agent",
        results: [{ id: "ph-1", output: { content: "FROM-AGENT" } }],
      }),
    );
    const imported = await importArtefactResults({ dataDir, resultsFile, tasksFile });
    expect(imported.applied).toBe(1);
    expect(readFileSync(imported.outputPath, "utf8")).toContain("Summary: FROM-AGENT");
    expect(imported.record.model).toBe("agent");
  });
});
