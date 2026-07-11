import { describe, expect, it } from "vitest";
import type { DocModel, EnrichmentOverlay } from "@necronomidoc/docmodel";
import { mergeEnrichment } from "../merge.js";
import { computeEnrichmentReport } from "../staleness.js";
import { planEnrichment, runLlmEnrichment } from "./writer.js";
import type { LlmClient, LlmCompleteRequest } from "./client.js";

/** A deterministic fake: echoes every requested symbol id with a summary. */
function fakeClient(overrides: Partial<LlmClient> = {}): LlmClient & { calls: LlmCompleteRequest[] } {
  const calls: LlmCompleteRequest[] = [];
  return {
    model: "fake-model",
    calls,
    async complete(request) {
      calls.push(request);
      const ids = [...request.prompt.matchAll(/- id: (\S+)/g)].map((m) => m[1]!);
      return {
        text: JSON.stringify({
          file: { summary: "LLM file summary.", purpose: "LLM purpose." },
          symbols: ids.map((id) => ({ id, summary: `LLM summary for ${id}.` })),
        }),
        inputTokens: 100,
        outputTokens: 50,
      };
    },
    ...overrides,
  };
}

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
          {
            id: "demo:src/a.ts#beta",
            name: "beta",
            kind: "function",
            exported: false,
            location: { path: "src/a.ts", line: 5 },
            contentHash: "hash-beta",
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
      {
        id: "demo:README.md",
        path: "README.md",
        contentHash: "hash-md",
        format: "markdown",
        title: "Demo",
        content: "# Demo",
        imports: [],
        exports: [],
        symbols: [],
      },
    ],
  };
}

const readSource = () => "export function alpha() {}\nfunction beta() {}";
const now = () => "2026-07-11T00:00:00.000Z";

describe("LLM overlay writer", () => {
  it("covers every source file and symbol in one run", async () => {
    const client = fakeClient();
    const { overlays, report } = await runLlmEnrichment(sampleModel(), {
      client,
      overlays: new Map(),
      readSource,
      now,
    });
    // 2 file summaries + 2 symbol summaries; markdown file excluded.
    expect(overlays.map((o) => o.targetId).sort()).toEqual([
      "demo:src/a.ts",
      "demo:src/a.ts#alpha",
      "demo:src/a.ts#beta",
      "demo:src/b.ts",
    ]);
    expect(overlays.every((o) => o.provenance === "llm")).toBe(true);
    expect(overlays.every((o) => o.sourceContentHash)).toBe(true);
    expect(report.calls).toBe(2); // one batched call per file

    // After merging, everything carries an llm summary (acceptance criterion 1).
    const merged = mergeEnrichment(sampleModel(), {
      overlays: new Map(overlays.map((o) => [o.targetId, o])),
    });
    const enriched = computeEnrichmentReport(merged, now);
    expect(enriched.totals.llm).toBe(4);
    expect(enriched.totals.stale).toBe(0);
  });

  it("makes zero calls when re-run with fresh llm overlays (hash cache)", async () => {
    const first = await runLlmEnrichment(sampleModel(), {
      client: fakeClient(),
      overlays: new Map(),
      readSource,
      now,
    });
    const cache = new Map(first.overlays.map((o) => [o.targetId, o]));
    const client = fakeClient();
    const second = await runLlmEnrichment(sampleModel(), {
      client,
      overlays: cache,
      readSource,
      now,
    });
    expect(client.calls.length).toBe(0);
    expect(second.report.skippedFresh).toBe(4);
    expect(second.overlays).toEqual([]);
  });

  it("re-summarizes a target whose hash changed, leaving fresh ones cached", async () => {
    const first = await runLlmEnrichment(sampleModel(), {
      client: fakeClient(),
      overlays: new Map(),
      readSource,
      now,
    });
    const cache = new Map(first.overlays.map((o) => [o.targetId, o]));
    const model = sampleModel();
    model.files[0]!.symbols[0]!.contentHash = "hash-alpha-v2"; // alpha changed
    const client = fakeClient();
    const { overlays } = await runLlmEnrichment(model, {
      client,
      overlays: cache,
      readSource,
      now,
    });
    expect(client.calls.length).toBe(1);
    expect(overlays.map((o) => o.targetId)).toEqual(["demo:src/a.ts#alpha"]);
  });

  it("never targets human overlays, even stale ones", async () => {
    const human: EnrichmentOverlay = {
      targetId: "demo:src/a.ts#alpha",
      summary: "Curated by a person.",
      provenance: "human",
      sourceContentHash: "old-hash", // stale on purpose
    };
    const client = fakeClient();
    const { overlays, report } = await runLlmEnrichment(sampleModel(), {
      client,
      overlays: new Map([[human.targetId, human]]),
      readSource,
      now,
    });
    expect(report.skippedHuman).toBe(1);
    expect(overlays.some((o) => o.targetId === human.targetId)).toBe(false);

    // And the merged model flags it stale without replacing it (criterion 2).
    const merged = mergeEnrichment(sampleModel(), {
      overlays: new Map([[human.targetId, human]]),
    });
    const alpha = merged.files[0]!.symbols[0]!;
    expect(alpha.enrichment?.summary).toBe("Curated by a person.");
    expect(alpha.enrichment?.provenance).toBe("human");
    expect(alpha.enrichment?.stale).toBe(true);
  });

  it("dry-run plans without calling the model", async () => {
    const client = fakeClient();
    const { overlays, report } = await runLlmEnrichment(sampleModel(), {
      client,
      overlays: new Map(),
      readSource,
      dryRun: true,
      now,
    });
    expect(client.calls.length).toBe(0);
    expect(overlays).toEqual([]);
    expect(report.dryRun).toBe(true);
    expect(report.plannedFiles).toBe(2);
    expect(report.plannedSymbolSummaries).toBe(2);
  });

  it("aborts gracefully at the token budget, keeping earlier overlays", async () => {
    const client = fakeClient();
    const { overlays, report } = await runLlmEnrichment(sampleModel(), {
      client,
      overlays: new Map(),
      readSource,
      maxTokens: 149, // first call spends 150 (100 in + 50 out) → second is skipped
      now,
    });
    expect(report.calls).toBe(1);
    expect(report.aborted).toBe(true);
    expect(overlays.length).toBeGreaterThan(0);
  });

  it("caps the number of files per run", () => {
    const plan = planEnrichment(sampleModel(), new Map(), 1);
    expect(plan.work.length).toBe(1);
    expect(plan.filesOverCap).toBe(1);
  });

  it("records a failure and continues when the model returns junk", async () => {
    let first = true;
    const client = fakeClient({
      async complete(request) {
        if (first) {
          first = false;
          return { text: "not json", inputTokens: 10, outputTokens: 5 };
        }
        const ids = [...request.prompt.matchAll(/- id: (\S+)/g)].map((m) => m[1]!);
        return {
          text: JSON.stringify({
            file: { summary: "ok" },
            symbols: ids.map((id) => ({ id, summary: "ok" })),
          }),
          inputTokens: 10,
          outputTokens: 5,
        };
      },
    });
    const { overlays, report } = await runLlmEnrichment(sampleModel(), {
      client,
      overlays: new Map(),
      readSource,
      now,
    });
    expect(report.failures.length).toBe(1);
    expect(overlays.some((o) => o.targetId === "demo:src/b.ts")).toBe(true);
  });
});
