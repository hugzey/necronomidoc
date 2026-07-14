import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  type DocModel,
  type VersionsManifest,
} from "@necronomidoc/docmodel";
import { buildRepo } from "./build.js";
import { appendVersion, computeDocsHash, VERSIONS_KEEP } from "./versions.js";

const fixture = fileURLToPath(new URL("../../../fixtures/sample-react-app", import.meta.url));

function model(overrides: Partial<DocModel> = {}): DocModel {
  return {
    schemaVersion: SCHEMA_VERSION,
    repo: { name: "t", slug: "t", commit: "abc123" },
    files: [],
    generatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const empty: VersionsManifest = { schemaVersion: SCHEMA_VERSION, repo: "t", versions: [] };
const info = { fileCount: 0, symbolCount: 0 };

describe("computeDocsHash", () => {
  it("ignores volatile fields so unchanged content hashes identically", () => {
    const a = model({ generatedAt: "2026-01-01T00:00:00.000Z" });
    const b = model({
      generatedAt: "2026-06-01T00:00:00.000Z",
      repo: { name: "t", slug: "t", commit: "different" },
    });
    expect(computeDocsHash(a)).toBe(computeDocsHash(b));
  });

  it("changes when file content changes", () => {
    const a = model();
    const b = model({
      files: [
        {
          id: "t:x.ts",
          path: "x.ts",
          contentHash: "h",
          format: "source",
          imports: [],
          exports: [],
          symbols: [],
        },
      ],
    });
    expect(computeDocsHash(a)).not.toBe(computeDocsHash(b));
  });
});

describe("appendVersion", () => {
  it("starts the journal at version 1", () => {
    const next = appendVersion(empty, model(), "hash-a", info, "2026-01-02T00:00:00.000Z");
    expect(next.versions).toHaveLength(1);
    expect(next.versions[0]).toMatchObject({
      version: 1,
      docsHash: "hash-a",
      commit: "abc123",
      rebuilds: 0,
    });
  });

  it("records an unchanged rebuild on the current entry instead of a new version", () => {
    const v1 = appendVersion(empty, model(), "hash-a", info, "2026-01-02T00:00:00.000Z");
    const next = appendVersion(v1, model(), "hash-a", info, "2026-01-03T00:00:00.000Z");
    expect(next.versions).toHaveLength(1);
    expect(next.versions[0]).toMatchObject({
      version: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      rebuilds: 1,
      lastRebuiltAt: "2026-01-03T00:00:00.000Z",
    });
  });

  it("prepends a new version when the docs state changes", () => {
    const v1 = appendVersion(empty, model(), "hash-a", info, "2026-01-02T00:00:00.000Z");
    const next = appendVersion(v1, model(), "hash-b", info, "2026-01-03T00:00:00.000Z");
    expect(next.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(next.versions[0]!.docsHash).toBe("hash-b");
  });

  it("caps the journal length", () => {
    let manifest = empty;
    for (let i = 0; i < VERSIONS_KEEP + 5; i++) {
      manifest = appendVersion(manifest, model(), `hash-${i}`, info);
    }
    expect(manifest.versions).toHaveLength(VERSIONS_KEEP);
    expect(manifest.versions[0]!.version).toBe(VERSIONS_KEEP + 5);
  });
});

describe("version journal across real builds", () => {
  it("bumps the version only when the docs actually change", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "necro-ver-data-"));
    const work = mkdtempSync(join(tmpdir(), "necro-ver-work-"));
    try {
      cpSync(fixture, work, { recursive: true });
      const read = (): VersionsManifest =>
        JSON.parse(readFileSync(join(dataDir, "repos", "sample", "versions.json"), "utf8"));

      await buildRepo({ dataDir, target: work, name: "sample" });
      expect(read().versions).toMatchObject([{ version: 1, trigger: "cli", rebuilds: 0 }]);

      // Rebuild with nothing changed: same version, one rebuild recorded.
      await buildRepo({ dataDir, target: work, name: "sample" });
      expect(read().versions).toMatchObject([{ version: 1, rebuilds: 1 }]);

      // Change the code: version 2 on top, version 1 retained below.
      writeFileSync(
        join(work, "src", "extra.ts"),
        "/** Extra. */\nexport const extra = 1;\n",
      );
      await buildRepo({ dataDir, target: work, name: "sample", trigger: "github" });
      const after = read();
      expect(after.versions.map((v) => v.version)).toEqual([2, 1]);
      expect(after.versions[0]).toMatchObject({ trigger: "github", rebuilds: 0 });
      expect(after.versions[0]!.docsHash).not.toBe(after.versions[1]!.docsHash);
      expect(after.versions[0]!.enrichment).toBeDefined();
      expect(after.versions[0]!.sourceFileCount).toBeGreaterThan(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);
});
