import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoContentHash, type DocModel } from "@necronomidoc/docmodel";
import {
  LLM_CORE_DOCS_FILE,
  buildCoreDocs,
  collectExternalPackages,
  generateCoreDocs,
  heuristicCoreDoc,
  planCoreDocs,
} from "./coredocs.js";
import type { LlmClient, LlmCompleteRequest } from "./llm/client.js";

function file(path: string, imports: string[] = []): DocModel["files"][number] {
  return {
    id: `demo:${path}`,
    path,
    contentHash: `h-${path}`,
    format: "source",
    imports: imports.map((m) => ({ moduleSpecifier: m, names: [], isTypeOnly: false })),
    exports: [],
    symbols: [],
  };
}

const model: DocModel = {
  schemaVersion: 1,
  repo: { name: "demo", slug: "demo" },
  files: [
    file("src/components/App.tsx", ["react", "../hooks/useCounter"]),
    file("src/hooks/useCounter.ts", ["react"]),
    file("src/utils/format.ts", ["date-fns"]),
  ],
};

describe("heuristic core docs", () => {
  it("always produces all four docs with the heuristic floor", () => {
    const manifest = buildCoreDocs(model);
    expect(manifest.docs.map((d) => d.kind)).toEqual([
      "overview",
      "conventions",
      "packages",
      "architecture",
    ]);
    expect(manifest.docs.every((d) => d.provenance === "heuristic")).toBe(true);
  });

  it("packages doc lists third-party imports with usage sites", () => {
    const packages = collectExternalPackages(model);
    expect([...packages.keys()]).toEqual(["react", "date-fns"]);
    expect(packages.get("react")!.files).toHaveLength(2);

    const doc = heuristicCoreDoc(model, "packages");
    expect(doc.content).toContain("`react`");
    expect(doc.content).toContain("`date-fns`");
    expect(doc.content).toContain("src/utils/format.ts");
  });

  it("architecture doc carries a mermaid module diagram with import edges", () => {
    const doc = heuristicCoreDoc(model, "architecture");
    expect(doc.content).toContain("```mermaid");
    expect(doc.content).toContain("graph LR");
    expect(doc.content).toContain('"src/components (1)"');
    // App.tsx imports ../hooks/useCounter → components depends on hooks.
    expect(doc.content).toMatch(/m\d+ --> m\d+/);
  });
});

describe("core doc precedence", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "necro-coredocs-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves repo > override > llm > heuristic, per doc", () => {
    const repoDocsDir = join(dir, "repo-docs");
    const overrideDir = join(dir, "override-docs");
    const llmDir = join(dir, "llm");
    mkdirSync(repoDocsDir, { recursive: true });
    mkdirSync(overrideDir, { recursive: true });
    mkdirSync(llmDir, { recursive: true });

    writeFileSync(join(repoDocsDir, "overview.md"), "# The Demo Project\n\nRepo-provided overview.");
    writeFileSync(join(overrideDir, "overview.md"), "# Shadowed\n\nMust lose to the repo file.");
    writeFileSync(join(overrideDir, "conventions.md"), "# House rules\n\nOverride conventions.");
    const hash = repoContentHash(model.files);
    writeFileSync(
      join(llmDir, LLM_CORE_DOCS_FILE),
      JSON.stringify([
        { kind: "packages", title: "Packages", content: "LLM packages doc.", sourceRepoHash: hash },
        { kind: "conventions", title: "Conventions", content: "Must lose to override.", sourceRepoHash: hash },
      ]),
    );

    const manifest = buildCoreDocs(model, { repoDocsDir, overrideDir, llmDir });
    const byKind = new Map(manifest.docs.map((d) => [d.kind, d]));
    expect(byKind.get("overview")!.provenance).toBe("repo");
    expect(byKind.get("overview")!.title).toBe("The Demo Project");
    expect(byKind.get("conventions")!.provenance).toBe("override");
    expect(byKind.get("conventions")!.content).toContain("Override conventions");
    expect(byKind.get("packages")!.provenance).toBe("llm");
    expect(byKind.get("packages")!.stale).toBe(false);
    expect(byKind.get("architecture")!.provenance).toBe("heuristic");
  });

  it("flags llm docs stale when the repo hash moved on, and plans regeneration", () => {
    const llmDir = join(dir, "llm-stale");
    mkdirSync(llmDir, { recursive: true });
    writeFileSync(
      join(llmDir, LLM_CORE_DOCS_FILE),
      JSON.stringify([
        { kind: "overview", title: "Old", content: "Written for older code.", sourceRepoHash: "outdated" },
      ]),
    );

    const manifest = buildCoreDocs(model, { llmDir });
    const overview = manifest.docs.find((d) => d.kind === "overview")!;
    expect(overview.provenance).toBe("llm"); // stale content still beats the floor
    expect(overview.stale).toBe(true);

    const plan = planCoreDocs(model, { llmDir });
    expect(plan.needed).toContain("overview");
  });

  it("skips curated kinds and fresh cache entries in the plan", () => {
    const repoDocsDir = join(dir, "plan-repo");
    const llmDir = join(dir, "plan-llm");
    mkdirSync(repoDocsDir, { recursive: true });
    mkdirSync(llmDir, { recursive: true });
    writeFileSync(join(repoDocsDir, "architecture.md"), "# Arch\n\nCurated.");
    writeFileSync(
      join(llmDir, LLM_CORE_DOCS_FILE),
      JSON.stringify([
        {
          kind: "overview",
          title: "Overview",
          content: "Fresh.",
          sourceRepoHash: repoContentHash(model.files),
        },
      ]),
    );

    const plan = planCoreDocs(model, { repoDocsDir, llmDir });
    expect(plan.curated).toEqual(["architecture"]);
    expect(plan.fresh).toEqual(["overview"]);
    expect(plan.needed.sort()).toEqual(["conventions", "packages"]);
  });
});

describe("LLM core doc writer", () => {
  it("writes one doc per requested kind, stamped with the repo hash", async () => {
    const calls: LlmCompleteRequest[] = [];
    const client: LlmClient = {
      model: "fake",
      async complete(request) {
        calls.push(request);
        return {
          text: JSON.stringify({ title: "Doc", content: "# Doc\n\nbody" }),
          inputTokens: 10,
          outputTokens: 5,
        };
      },
    };
    const result = await generateCoreDocs(model, client, ["overview", "architecture"]);
    expect(result.calls).toBe(2);
    expect(result.docs.map((d) => d.kind)).toEqual(["overview", "architecture"]);
    expect(result.docs.every((d) => d.sourceRepoHash === repoContentHash(model.files))).toBe(true);
    // The architecture prompt demands a mermaid diagram.
    expect(calls[1]!.prompt).toContain("mermaid");
    // Grounding data rides along in every prompt.
    expect(calls[0]!.prompt).toContain("react");
    expect(calls[0]!.prompt).toContain("src/hooks/useCounter.ts");
  });

  it("collects per-doc failures without aborting the batch", async () => {
    let call = 0;
    const client: LlmClient = {
      model: "fake",
      async complete() {
        if (call++ === 0) throw new Error("boom");
        return {
          text: JSON.stringify({ title: "OK", content: "# ok" }),
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    };
    const result = await generateCoreDocs(model, client, ["overview", "conventions"]);
    expect(result.failures).toEqual([{ kind: "overview", error: "boom" }]);
    expect(result.docs.map((d) => d.kind)).toEqual(["conventions"]);
  });
});
