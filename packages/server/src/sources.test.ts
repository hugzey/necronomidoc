import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, hashContent, type DocModel, type SourcesManifest } from "@necronomidoc/docmodel";
import { createApp, type App } from "./app.js";
import { buildRepo } from "./build.js";
import { loadConfig } from "./config.js";
import { MAX_SOURCE_FILE_BYTES, snapshotSources } from "./sources.js";

const fixture = fileURLToPath(new URL("../../../fixtures/sample-react-app", import.meta.url));

function modelWith(paths: string[], format: "source" | "markdown" = "source"): DocModel {
  return {
    schemaVersion: SCHEMA_VERSION,
    repo: { name: "t", slug: "t" },
    files: paths.map((path) => ({
      id: `t:${path}`,
      path,
      contentHash: "x",
      format,
      imports: [],
      exports: [],
      symbols: [],
    })),
  };
}

describe("snapshotSources", () => {
  let repoDir: string;
  let destDir: string;

  beforeAll(() => {
    repoDir = mkdtempSync(join(tmpdir(), "necro-src-repo-"));
    destDir = mkdtempSync(join(tmpdir(), "necro-src-dest-"));
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(repoDir, "big.ts"), "x".repeat(MAX_SOURCE_FILE_BYTES + 1));
    writeFileSync(join(repoDir, "bin.ts"), Buffer.from([0x65, 0x00, 0x66]));
  });

  afterAll(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(destDir, { recursive: true, force: true });
  });

  it("copies documented source files and indexes them", () => {
    const manifest = snapshotSources(modelWith(["src/a.ts"]), destDir, repoDir);
    expect(manifest.files).toEqual([
      {
        path: "src/a.ts",
        size: 20,
        contentHash: hashContent("export const a = 1;\n"),
      },
    ]);
    expect(readFileSync(join(destDir, "sources", "src", "a.ts"), "utf8")).toBe(
      "export const a = 1;\n",
    );
    const written = JSON.parse(readFileSync(join(destDir, "sources.json"), "utf8"));
    expect(written.files).toHaveLength(1);
  });

  it("skips oversized files, binary content, prose formats, and missing files", () => {
    const manifest = snapshotSources(
      {
        ...modelWith(["big.ts", "bin.ts", "gone.ts"]),
        files: [
          ...modelWith(["big.ts", "bin.ts", "gone.ts"]).files,
          ...modelWith(["src/a.ts"], "markdown").files,
        ],
      },
      destDir,
      repoDir,
    );
    expect(manifest.files).toEqual([]);
  });

  it("refuses paths that resolve outside the repo dir", () => {
    const manifest = snapshotSources(modelWith(["../escape.ts", "/etc/passwd"]), destDir, repoDir);
    expect(manifest.files).toEqual([]);
  });

  it("publishes an empty manifest when there is no repo dir (external IR)", () => {
    const manifest = snapshotSources(modelWith(["src/a.ts"]), destDir, undefined);
    expect(manifest.files).toEqual([]);
  });
});

describe("source snapshots over HTTP", () => {
  let dataDir: string;
  let app: App;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "necro-src-http-"));
    await buildRepo({ dataDir, target: fixture, name: "sample-react-app" });
    app = createApp(loadConfig({ dataDir, siteDir: join(dataDir, "no-site") }));
  });

  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  it("serves sources.json listing the fixture's source files", async () => {
    const res = await app.fetch(new Request("http://x/data/repos/sample-react-app/sources.json"));
    expect(res.status).toBe(200);
    const manifest = (await res.json()) as SourcesManifest;
    expect(manifest.files.map((f) => f.path)).toContain("src/utils/format.ts");
  });

  it("serves snapshot files as plain text", async () => {
    const res = await app.fetch(
      new Request("http://x/data/repos/sample-react-app/sources/src/utils/format.ts"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toContain("formatCurrency");
  });

  it("still refuses traversal out of the repos tree", async () => {
    const res = await app.fetch(
      new Request("http://x/data/repos/sample-react-app/sources/..%2F..%2F..%2Fmeta.json"),
    );
    expect(res.status).toBe(404);
  });
});

describe("source snapshots across rebuilds", () => {
  it("drops snapshots for files that disappear from the model", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "necro-src-rebuild-"));
    const work = mkdtempSync(join(tmpdir(), "necro-src-work-"));
    try {
      cpSync(fixture, work, { recursive: true });
      await buildRepo({ dataDir, target: work, name: "sample" });
      const first = JSON.parse(
        readFileSync(join(dataDir, "repos", "sample", "sources.json"), "utf8"),
      ) as SourcesManifest;
      expect(first.files.map((f) => f.path)).toContain("src/utils/format.ts");

      rmSync(join(work, "src", "utils", "format.ts"));
      await buildRepo({ dataDir, target: work, name: "sample" });
      const second = JSON.parse(
        readFileSync(join(dataDir, "repos", "sample", "sources.json"), "utf8"),
      ) as SourcesManifest;
      expect(second.files.map((f) => f.path)).not.toContain("src/utils/format.ts");
      // The atomic swap replaced the whole dir — no stale snapshot lingers.
      expect(() =>
        readFileSync(join(dataDir, "repos", "sample", "sources", "src", "utils", "format.ts")),
      ).toThrow();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
