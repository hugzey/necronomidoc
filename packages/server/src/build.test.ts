import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractRepoModel } from "./build.js";

const FIXTURE = resolve(__dirname, "../../../fixtures/sample-api");

describe("extractRepoModel on a mixed TS + OpenAPI repo", () => {
  it("runs every matching adapter and merges files under one model", async () => {
    const { model, adapter } = await extractRepoModel(FIXTURE, { repoName: "sample-api" });
    expect(adapter).toBe("typescript+openapi+markdown");

    const byPath = new Map(model.files.map((f) => [f.path, f]));
    expect(byPath.get("src/client.ts")?.format).toBe("source");
    expect(byPath.get("openapi.yaml")?.format).toBe("openapi");
    expect(byPath.get("README.md")?.format).toBe("markdown");

    // Code symbols and endpoints are cross-searchable peers in one model.
    const kinds = new Set(model.files.flatMap((f) => f.symbols.map((s) => s.kind)));
    expect(kinds.has("function")).toBe(true);
    expect(kinds.has("endpoint")).toBe(true);
  });
});
