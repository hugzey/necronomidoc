import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readSourceRegistry,
  safeReadSourceRegistry,
  sourceRegistryPath,
  upsertSourceRepo,
} from "./registry.js";

describe("source registry", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "necro-registry-"));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it("rejects ids that are not slug-stable", () => {
    // '.' and '_' would publish docs under a different slug than the id,
    // breaking purge and status lookups.
    for (const id of ["my.repo", "my_repo", "My-Repo", "-repo", "a--b"]) {
      expect(() => upsertSourceRepo(dataDir, { id, provider: "generic", url: "/x" })).toThrow();
    }
    expect(() =>
      upsertSourceRepo(dataDir, { id: "my-repo", provider: "generic", url: "/x" }),
    ).not.toThrow();
  });

  it("serves an empty registry from a corrupt file instead of throwing", () => {
    writeFileSync(sourceRegistryPath(dataDir), "{ not json");
    expect(safeReadSourceRegistry(dataDir).repos).toEqual([]);
    expect(() => readSourceRegistry(dataDir)).toThrow(); // mutations stay strict
  });

  it("does not clobber a corrupt registry on upsert", () => {
    writeFileSync(sourceRegistryPath(dataDir), "{ not json");
    expect(() =>
      upsertSourceRepo(dataDir, { id: "new-repo", provider: "generic", url: "/x" }),
    ).toThrow();
  });
});
