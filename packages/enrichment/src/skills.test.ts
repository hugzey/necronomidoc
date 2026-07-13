import { describe, expect, it } from "vitest";
import type { DocModel } from "@necronomidoc/docmodel";
import type { LlmClient } from "./llm/client.js";
import {
  applySkillResults,
  buildSkillTaskFile,
  generateSkillSet,
  renderSkillMd,
  scopeContext,
  skillSetIdFor,
  skillsFromResponse,
  type ScopeInput,
} from "./skills.js";

function modelFor(slug: string): DocModel {
  return {
    schemaVersion: 1,
    repo: { name: slug, slug },
    files: [
      {
        id: `${slug}:src/index.ts`,
        path: "src/index.ts",
        contentHash: "h-1",
        format: "source",
        imports: [],
        exports: [],
        symbols: [],
        enrichment: { summary: "Entry point.", provenance: "llm", stale: false },
      },
    ],
  };
}

function inputFor(slug: string): ScopeInput {
  return {
    model: modelFor(slug),
    coreDocs: [
      {
        kind: "overview",
        title: "Overview",
        content: `# Overview of ${slug}\n\nWhat it does.`,
        provenance: "heuristic",
        stale: false,
      },
    ],
    subsystems: [
      {
        id: "core",
        name: "core",
        purpose: "The core.",
        owns: ["parsing"],
        notOwns: [],
        entryPoints: [],
        related: [],
        dirs: ["src"],
        provenance: "heuristic",
      },
    ],
  };
}

describe("skillSetIdFor", () => {
  it("maps scopes to stable ids", () => {
    expect(skillSetIdFor("global", ["b", "a"])).toBe("global");
    expect(skillSetIdFor("repo", ["widgets"])).toBe("widgets");
    expect(skillSetIdFor("multi", ["b", "a"])).toBe("a+b");
  });

  it("hashes over-long multi ids into a bounded directory name", () => {
    const slugs = Array.from({ length: 12 }, (_, i) => `repository-number-${i}`);
    const id = skillSetIdFor("multi", slugs);
    expect(id.length).toBeLessThanOrEqual(80);
    expect(id).toContain("11-more-");
    // Stable across calls and input order.
    expect(skillSetIdFor("multi", [...slugs].reverse())).toBe(id);
  });
});

describe("scopeContext", () => {
  it("includes each repo's core docs, subsystems, and file summaries", () => {
    const context = scopeContext([inputFor("alpha"), inputFor("beta")]);
    expect(context).toContain("Repository: alpha (slug: alpha)");
    expect(context).toContain("Repository: beta (slug: beta)");
    expect(context).toContain("Overview of alpha");
    expect(context).toContain("core: The core. — owns: parsing");
    expect(context).toContain("src/index.ts — Entry point.");
  });
});

describe("skillsFromResponse", () => {
  it("slugifies names into unique folder-safe ids and filters unknown repos", () => {
    const skills = skillsFromResponse(
      JSON.stringify({
        skills: [
          { name: "Add a Feature", description: "d", body: "b", repos: ["alpha", "made-up"] },
          { name: "add a feature", description: "d2", body: "b2" },
        ],
      }),
      ["alpha"],
    );
    expect(skills.map((s) => s.id)).toEqual(["add-a-feature", "add-a-feature-2"]);
    expect(skills[0]!.repos).toEqual(["alpha"]);
    // Single-repo scope: a skill claiming nothing still belongs to that repo.
    expect(skills[1]!.repos).toEqual(["alpha"]);
  });

  it("throws on malformed JSON", () => {
    expect(() => skillsFromResponse("not json", [])).toThrow();
  });
});

describe("renderSkillMd", () => {
  it("renders frontmatter with YAML-safe quoting and a title heading", () => {
    const md = renderSkillMd({
      id: "review-prs",
      name: "review-prs",
      description: 'Use when "reviewing" PRs.',
      body: "Do the thing.",
      repos: [],
    });
    expect(md).toContain('name: "review-prs"');
    expect(md).toContain('description: "Use when \\"reviewing\\" PRs."');
    expect(md).toContain("# review-prs");
    expect(md.startsWith("---\n")).toBe(true);
  });

  it("keeps a body that already starts with a heading", () => {
    const md = renderSkillMd({
      id: "x",
      name: "x",
      description: "d",
      body: "# Custom title\n\nBody.",
      repos: [],
    });
    expect(md).not.toContain("# x");
    expect(md).toContain("# Custom title");
  });
});

describe("generateSkillSet", () => {
  it("sends one completion built from the scope context", async () => {
    const prompts: string[] = [];
    const client: LlmClient = {
      model: "fake",
      complete: async (request) => {
        prompts.push(request.prompt);
        return {
          text: JSON.stringify({
            skills: [{ name: "navigate", description: "d", body: "b", repos: ["alpha"] }],
          }),
          inputTokens: 10,
          outputTokens: 20,
        };
      },
    };
    const result = await generateSkillSet([inputFor("alpha")], "repo", client);
    expect(result.calls).toBe(1);
    expect(result.skills).toHaveLength(1);
    expect(prompts[0]).toContain("Repository: alpha");
  });
});

describe("agent-mode task export/import", () => {
  it("round-trips: the task prompt matches the live prompt, results apply", () => {
    const inputs = [inputFor("alpha")];
    const taskFile = buildSkillTaskFile(inputs, "repo", {
      setId: "alpha",
      sourceHashes: { alpha: "hash-1" },
      now: () => "2026-01-01T00:00:00Z",
    });
    expect(taskFile.tasks).toHaveLength(1);
    expect(taskFile.tasks[0]!.request.prompt).toContain("Repository: alpha");

    const applied = applySkillResults(taskFile, {
      formatVersion: 1,
      setId: "alpha",
      model: "agent-model",
      results: [
        {
          id: "skills",
          output: { skills: [{ name: "do-it", description: "d", body: "b" }] },
        },
      ],
    });
    expect(applied.skills.map((s) => s.id)).toEqual(["do-it"]);
    expect(applied.model).toBe("agent-model");
    expect(applied.failures).toHaveLength(0);
  });

  it("rejects a results file for a different set id", () => {
    const taskFile = buildSkillTaskFile([inputFor("alpha")], "repo", {
      setId: "alpha",
      sourceHashes: {},
    });
    expect(() =>
      applySkillResults(taskFile, { formatVersion: 1, setId: "other", results: [] }),
    ).toThrow(/other/);
  });

  it("reports a missing skills result as a failure, not a crash", () => {
    const taskFile = buildSkillTaskFile([inputFor("alpha")], "repo", {
      setId: "alpha",
      sourceHashes: {},
    });
    const applied = applySkillResults(taskFile, { formatVersion: 1, results: [] });
    expect(applied.skills).toHaveLength(0);
    expect(applied.failures[0]!.id).toBe("skills");
  });
});
