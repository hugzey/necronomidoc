import { describe, expect, it } from "vitest";
import type { DocFile } from "@necronomidoc/docmodel";
import type { ManifestStore } from "./store.js";
import { tools } from "./tools.js";

function endpoint(id: string, name: string, tag: string, summary: string): DocFile["symbols"][number] {
  return {
    id,
    name,
    kind: "endpoint",
    exported: true,
    signature: name,
    location: { path: "openapi.yaml", line: 1 },
    doc: { summary, params: [], examples: [], tags: [{ tag: "tag", text: tag }] },
    contentHash: "x",
  };
}

const specFile: DocFile = {
  id: "api:openapi.yaml",
  path: "openapi.yaml",
  contentHash: "x",
  format: "openapi",
  title: "Sample Users API",
  content: "{}",
  imports: [],
  exports: [],
  symbols: [
    endpoint("api:openapi.yaml#get__users", "GET /users", "users", "List users"),
    endpoint("api:openapi.yaml#post__users", "POST /users", "users", "Create a user"),
    endpoint("api:openapi.yaml#get__health", "GET /health", "health", "Health check"),
  ],
};

const store = {
  getFile: (repo: string, path: string) =>
    repo === "api" && path === "openapi.yaml" ? specFile : undefined,
} as unknown as ManifestStore;

describe("get_file_doc on an OpenAPI spec", () => {
  it("lists operations grouped by tag", () => {
    const result = tools.get_file_doc(store, { repo: "api", path: "openapi.yaml" });
    expect(result["format"]).toBe("openapi");
    expect(result["title"]).toBe("Sample Users API");
    const groups = result["endpointsByTag"] as { tag: string; endpoints: { endpoint: string }[] }[];
    expect(groups.map((g) => g.tag)).toEqual(["users", "health"]);
    expect(groups[0]!.endpoints.map((e) => e.endpoint)).toEqual(["GET /users", "POST /users"]);
    // Neither the raw bundled spec nor a duplicate symbol digest is echoed.
    expect(result["content"]).toBeUndefined();
    expect(result["symbols"]).toBeUndefined();
    expect(result["endpointsTruncated"]).toBeUndefined();
  });
});
