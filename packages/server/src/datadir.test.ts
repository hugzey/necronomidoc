import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "@necronomidoc/docmodel";
import { exportState } from "./backup.js";
import { dataDirMetaPath, DataDirVersionError, ensureDataDirVersion } from "./datadir.js";

describe("data dir version guard", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "necro-meta-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("stamps a fresh dir at the current version", () => {
    const meta = ensureDataDirVersion(dir, () => "2026-01-01T00:00:00Z");
    expect(meta.schemaVersion).toBe(SCHEMA_VERSION);
    const onDisk = JSON.parse(readFileSync(dataDirMetaPath(dir), "utf8"));
    expect(onDisk).toEqual({ schemaVersion: SCHEMA_VERSION, createdAt: "2026-01-01T00:00:00Z" });
  });

  it("accepts a dir stamped at the same version without rewriting createdAt", () => {
    writeFileSync(dataDirMetaPath(dir), JSON.stringify({ schemaVersion: SCHEMA_VERSION, createdAt: "x" }));
    expect(ensureDataDirVersion(dir).createdAt).toBe("x");
  });

  it("refuses a dir written by a newer schema", () => {
    writeFileSync(dataDirMetaPath(dir), JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1 }));
    expect(() => ensureDataDirVersion(dir)).toThrow(DataDirVersionError);
  });

  it("treats corrupt meta as unstamped and restamps", () => {
    writeFileSync(dataDirMetaPath(dir), "not json");
    expect(ensureDataDirVersion(dir).schemaVersion).toBe(SCHEMA_VERSION);
  });
});

describe("export (curation backup)", () => {
  let dataDir: string;
  let outDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "necro-exp-data-"));
    outDir = mkdtempSync(join(tmpdir(), "necro-exp-out-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  it("copies the registry and enrichment overlays", () => {
    writeFileSync(join(dataDir, "repos.json"), JSON.stringify({ schemaVersion: 1, repos: [] }));
    mkdirSync(join(dataDir, "enrichment", "widgets"), { recursive: true });
    writeFileSync(join(dataDir, "enrichment", "widgets", "llm.json"), "{}");

    const result = exportState(dataDir, outDir);
    expect(result.registryCopied).toBe(true);
    expect(readFileSync(join(outDir, "repos.json"), "utf8")).toContain('"repos"');
    expect(result.enrichmentCopied).toBe(true);
    expect(readFileSync(join(outDir, "enrichment", "widgets", "llm.json"), "utf8")).toBe("{}");
    expect(readFileSync(join(outDir, "README.md"), "utf8")).toContain("necronomidoc curation export");
  });

  it("succeeds on an empty data dir (nothing to copy)", () => {
    const result = exportState(dataDir, outDir);
    expect(result.registryCopied).toBe(false);
    expect(result.enrichmentCopied).toBe(false);
  });
});
