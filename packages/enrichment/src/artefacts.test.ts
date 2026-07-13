import { describe, expect, it } from "vitest";
import type { DocModel } from "@necronomidoc/docmodel";
import type { LlmClient, LlmCompleteRequest } from "./llm/client.js";
import {
  applyArtefactResults,
  assembleArtefactMarkdown,
  assembleFilledTemplate,
  buildArtefactTaskFile,
  fillFromResponse,
  generateArtefactFills,
  headingSections,
  parseTemplate,
  sectionsFromPlanResponse,
  type ScopeInput,
} from "./index.js";

const input: ScopeInput = {
  model: {
    schemaVersion: 1,
    repo: { name: "demo", slug: "demo" },
    files: [
      {
        id: "demo:src/a.ts",
        path: "src/a.ts",
        contentHash: "h",
        format: "source",
        imports: [],
        exports: [],
        symbols: [],
      },
    ],
  } satisfies DocModel,
};

describe("parseTemplate", () => {
  it("finds curly and diamond placeholders and preserves surrounding text", () => {
    const parsed = parseTemplate(
      "Intro {{summarize the repo}} middle <Describe the main modules here> end.",
    );
    expect(parsed.mode).toBe("placeholders");
    expect(parsed.placeholders.map((p) => p.instruction)).toEqual([
      "summarize the repo",
      "Describe the main modules here",
    ]);
    expect(parsed.placeholders.map((p) => p.id)).toEqual(["ph-1", "ph-2"]);
    // Reassembling with no fills reproduces the template byte-for-byte.
    expect(assembleFilledTemplate(parsed, new Map())).toBe(
      "Intro {{summarize the repo}} middle <Describe the main modules here> end.",
    );
  });

  it("does not mistake markup or single words for diamond placeholders", () => {
    const parsed = parseTemplate(
      'Use <strong>bold</strong>, generics like Map<string>, tags <a href="x">y</a>, and <urls>.',
    );
    expect(parsed.mode).toBe("sections");
    expect(parsed.placeholders).toHaveLength(0);
  });

  it("still finds a curly marker inside rejected markup", () => {
    // The <a …> match is rejected as markup; the {{…}} inside it must not be
    // swallowed with it.
    const parsed = parseTemplate('See <a href="{{link to the docs}}">docs</a>.');
    expect(parsed.placeholders.map((p) => p.instruction)).toEqual(["link to the docs"]);
    expect(assembleFilledTemplate(parsed, new Map([["ph-1", "https://x"]]))).toBe(
      'See <a href="https://x">docs</a>.',
    );
  });

  it("supports multi-line curly placeholders", () => {
    const parsed = parseTemplate("A {{write a table\nof endpoints}} B");
    expect(parsed.placeholders[0]!.instruction).toBe("write a table\nof endpoints");
  });

  it("falls back to sections mode when no markers exist", () => {
    expect(parseTemplate("# Title\n\nJust prose.").mode).toBe("sections");
  });
});

describe("assembleFilledTemplate", () => {
  it("splices fills in place and leaves unfilled markers visible", () => {
    const parsed = parseTemplate("a {{x}} b {{y}} c");
    const out = assembleFilledTemplate(parsed, new Map([["ph-1", "ONE"]]));
    expect(out).toBe("a ONE b {{y}} c");
  });
});

describe("headingSections", () => {
  it("derives one section per markdown heading, ignoring code fences", () => {
    const sections = headingSections(
      "# Title\n\n## Alpha\ntext\n\n```bash\n# not a heading\n```\n\n## Beta\n",
    );
    expect(sections.map((s) => s.heading)).toEqual(["Title", "Alpha", "Beta"]);
    expect(sections.map((s) => s.id)).toEqual(["section-1", "section-2", "section-3"]);
  });

  it("returns a single whole-document section for heading-less templates", () => {
    const sections = headingSections("just a note about what the doc should be");
    expect(sections).toHaveLength(1);
    expect(sections[0]!.id).toBe("section-1");
  });
});

describe("response parsing", () => {
  it("parses fill and plan responses, throwing on malformed JSON", () => {
    expect(fillFromResponse(JSON.stringify({ content: "hello" }))).toBe("hello");
    expect(() => fillFromResponse("nope")).toThrow();
    const sections = sectionsFromPlanResponse(
      JSON.stringify({ sections: [{ heading: "H", instruction: "i" }] }),
    );
    expect(sections).toEqual([{ id: "section-1", heading: "H", instruction: "i" }]);
  });
});

function clientReturning(fn: (request: LlmCompleteRequest) => string): LlmClient {
  return {
    model: "fake",
    complete: async (request) => ({ text: fn(request), inputTokens: 5, outputTokens: 5 }),
  };
}

describe("generateArtefactFills", () => {
  it("placeholders mode: one call per placeholder, no plan call", async () => {
    let calls = 0;
    const client = clientReturning(() => {
      calls++;
      return JSON.stringify({ content: `fill-${calls}` });
    });
    const run = await generateArtefactFills(
      [input],
      "Intro {{a}} and <Describe the setup steps> done",
      "doc.md",
      client,
    );
    expect(run.plan.mode).toBe("placeholders");
    expect(run.calls).toBe(2);
    expect(assembleArtefactMarkdown(run.plan, run.fills)).toBe("Intro fill-1 and fill-2 done");
  });

  it("sections mode: plans first, then writes each planned section", async () => {
    const client = clientReturning((request) =>
      request.prompt.includes("Plan how to write")
        ? JSON.stringify({
            sections: [
              { heading: "One", instruction: "write one" },
              { heading: "Two", instruction: "write two" },
            ],
          })
        : JSON.stringify({ content: `## section from ${request.prompt.includes('"One"') ? "One" : "Two"}` }),
    );
    const run = await generateArtefactFills([input], "# Doc\n\nProse only.", "doc.md", client);
    expect(run.plan.mode).toBe("sections");
    expect(run.calls).toBe(3); // 1 plan + 2 fills
    expect(assembleArtefactMarkdown(run.plan, run.fills)).toBe(
      "## section from One\n\n## section from Two\n",
    );
  });

  it("stops at the token budget and flags the run as aborted", async () => {
    const client = clientReturning(() => JSON.stringify({ content: "x" }));
    const run = await generateArtefactFills(
      [input],
      "{{a}} {{b}} {{c}}",
      "doc.md",
      client,
      { maxTokens: 10 }, // one call costs 10 → only the first fill lands
    );
    expect(run.fills.size).toBe(1);
    expect(run.aborted).toBe(true);
  });

  it("records a failure (not a crash) when one fill returns bad JSON", async () => {
    let calls = 0;
    const client = clientReturning(() => (++calls === 1 ? "garbage" : JSON.stringify({ content: "ok" })));
    const run = await generateArtefactFills([input], "{{a}} {{b}}", "doc.md", client);
    expect(run.failures.map((f) => f.id)).toEqual(["ph-1"]);
    expect(run.fills.get("ph-2")).toBe("ok");
  });
});

describe("agent-mode task export/import", () => {
  it("round-trips placeholders mode", () => {
    const taskFile = buildArtefactTaskFile([input], "Intro {{a}} end", {
      name: "doc.md",
      format: "markdown",
      scope: "repo",
      now: () => "2026-01-01T00:00:00Z",
    });
    expect(taskFile.mode).toBe("placeholders");
    expect(taskFile.tasks.map((t) => t.id)).toEqual(["ph-1"]);

    const applied = applyArtefactResults(taskFile, {
      formatVersion: 1,
      results: [{ id: "ph-1", output: { content: "REPLACED" } }],
    });
    expect(applied.fills.get("ph-1")).toBe("REPLACED");
    expect(applied.missingTasks).toHaveLength(0);
  });

  it("sections mode export uses the heading-derived plan", () => {
    const taskFile = buildArtefactTaskFile([input], "# T\n\n## A\n\n## B\n", {
      name: "doc.md",
      format: "markdown",
      scope: "repo",
    });
    expect(taskFile.mode).toBe("sections");
    expect(taskFile.sections!.map((s) => s.heading)).toEqual(["T", "A", "B"]);
    expect(taskFile.tasks).toHaveLength(3);
  });

  it("flags unmatched, duplicate, and missing results", () => {
    const taskFile = buildArtefactTaskFile([input], "{{a}} {{b}}", {
      name: "doc.md",
      format: "markdown",
      scope: "repo",
    });
    const applied = applyArtefactResults(taskFile, {
      formatVersion: 1,
      results: [
        { id: "ph-1", output: { content: "one" } },
        { id: "ph-1", output: { content: "dupe" } },
        { id: "ghost", output: { content: "x" } },
      ],
    });
    expect(applied.applied).toBe(1);
    expect(applied.unmatchedResults).toEqual(["ph-1", "ghost"]);
    expect(applied.missingTasks).toEqual(["ph-2"]);
  });
});
