import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient } from "@necronomidoc/enrichment";
import { buildRepo } from "./build.js";
import { resolveScope, ScopeError } from "./scope.js";
import {
  exportSkillTasks,
  generateSkills,
  importSkillResults,
  readSkillSet,
  readSkillSetIndex,
  skillSetZip,
  writeSkillFolders,
} from "./skills.js";

const fixture = fileURLToPath(new URL("../../../fixtures/sample-react-app", import.meta.url));

function fakeClient(skills: unknown[]): LlmClient & { calls: number } {
  const client = {
    model: "fake-model",
    calls: 0,
    complete: async () => {
      client.calls++;
      return { text: JSON.stringify({ skills }), inputTokens: 10, outputTokens: 20 };
    },
  };
  return client;
}

describe("skills pipeline over published docs", () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "necro-skills-"));
    await buildRepo({ dataDir, target: fixture, name: "sample-react-app" });
  });

  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  it("resolveScope loads published repos and rejects unknown slugs", () => {
    const scope = resolveScope(dataDir, { repos: ["sample-react-app"] });
    expect(scope.scope).toBe("repo");
    expect(scope.inputs[0]!.coreDocs?.length).toBe(4);
    expect(scope.sourceHashes["sample-react-app"]).toMatch(/^[0-9a-f]{16}$/);
    expect(() => resolveScope(dataDir, { repos: ["nope"] })).toThrow(ScopeError);
    expect(() => resolveScope(dataDir, {})).toThrow(/No scope/);
  });

  it("generates, persists, and caches a skill set", async () => {
    const client = fakeClient([
      { name: "Navigate the App", description: "d", body: "steps", repos: ["sample-react-app"] },
    ]);
    const first = await generateSkills({ dataDir, all: true, client });
    expect(first.cached).toBe(false);
    expect(first.skillsWritten).toBe(1);
    expect(client.calls).toBe(1);

    // Persisted artifacts: manifest, SKILL.md folder, index entry.
    const set = readSkillSet(dataDir, "global")!;
    expect(set.skills[0]!.id).toBe("navigate-the-app");
    expect(
      readFileSync(join(dataDir, "skills", "global", "navigate-the-app", "SKILL.md"), "utf8"),
    ).toContain("description:");
    expect(readSkillSetIndex(dataDir).sets.map((s) => s.id)).toEqual(["global"]);

    // Unchanged docs → cached, no second call; --force regenerates.
    const second = await generateSkills({ dataDir, all: true, client });
    expect(second.cached).toBe(true);
    expect(client.calls).toBe(1);
    const forced = await generateSkills({ dataDir, all: true, force: true, client });
    expect(forced.cached).toBe(false);
    expect(client.calls).toBe(2);
  });

  it("dry run reports without calling the client or writing", async () => {
    const client = fakeClient([]);
    const result = await generateSkills({ dataDir, repos: ["sample-react-app"], dryRun: true, client });
    expect(result.setId).toBe("sample-react-app");
    expect(client.calls).toBe(0);
    expect(readSkillSet(dataDir, "sample-react-app")).toBeUndefined();
  });

  it("zips and copies a set's SKILL.md folders", async () => {
    const zip = await skillSetZip(dataDir, "global");
    expect(zip!.length).toBeGreaterThan(0);
    expect(await skillSetZip(dataDir, "missing")).toBeUndefined();

    const outDir = join(dataDir, "out-skills");
    expect(writeSkillFolders(dataDir, "global", outDir)).toBe(1);
    expect(existsSync(join(outDir, "navigate-the-app", "SKILL.md"))).toBe(true);
  });

  it("agent-mode export/import round-trips through files", () => {
    const tasksFile = join(dataDir, "tasks.json");
    const exported = exportSkillTasks({ dataDir, repos: ["sample-react-app"], outFile: tasksFile });
    expect(exported.setId).toBe("sample-react-app");

    const resultsFile = join(dataDir, "results.json");
    writeFileSync(
      resultsFile,
      JSON.stringify({
        formatVersion: 1,
        model: "agent",
        results: [
          { id: "skills", output: { skills: [{ name: "imported", description: "d", body: "b" }] } },
        ],
      }),
    );
    const imported = importSkillResults({ dataDir, resultsFile, tasksFile });
    expect(imported.skillsWritten).toBe(1);
    const set = readSkillSet(dataDir, "sample-react-app")!;
    expect(set.model).toBe("agent");
    // Hashes stamped from export time drive the cache on the next run.
    expect(Object.keys(set.sourceHashes)).toEqual(["sample-react-app"]);
  });
});
