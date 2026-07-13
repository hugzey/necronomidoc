import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DocFile, DocModel } from "@necronomidoc/docmodel";
import { OpenApiAdapter, extractSpecFile, sniffSpec } from "./openapiAdapter.js";

const FIXTURE = resolve(__dirname, "../../../fixtures/sample-api");
const adapter = new OpenApiAdapter();

const tempDirs: string[] = [];
function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "adapter-openapi-test-"));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("sniffSpec", () => {
  it("recognizes OpenAPI 3 in YAML and JSON heads", () => {
    expect(sniffSpec("openapi: 3.1.0\ninfo:")).toBe("openapi3");
    expect(sniffSpec('{\n  "openapi": "3.0.3",')).toBe("openapi3");
    expect(sniffSpec('swagger: "2.0"')).toBe("swagger2");
    expect(sniffSpec('{"name": "not-a-spec", "version": "3.0.0"}')).toBeUndefined();
  });
});

describe("OpenApiAdapter on the sample-api fixture", () => {
  it("detects the spec", async () => {
    const match = await adapter.detect(FIXTURE);
    expect(match).not.toBeNull();
    expect(match!.reason).toContain("openapi.yaml");
  });

  it("extracts a schema-valid model with one endpoint symbol per operation", async () => {
    const model = await adapter.extract(FIXTURE, { repoName: "sample-api" });
    expect(() => DocModel.parse(model)).not.toThrow();
    expect(model.files).toHaveLength(1);

    const file = model.files[0]!;
    expect(file.format).toBe("openapi");
    expect(file.title).toBe("Sample Users API");
    expect(file.symbols.map((s) => s.name)).toEqual([
      "GET /users",
      "POST /users",
      "GET /users/{id}",
      "DELETE /users/{id}",
      "GET /health",
    ]);
    expect(file.symbols.every((s) => s.kind === "endpoint" && s.exported)).toBe(true);
  });

  it("gives operations stable ids, docs, params, and responses", async () => {
    const file = (await extractSpecFile("sample-api", FIXTURE, "openapi.yaml"))!;
    const getUser = file.symbols.find((s) => s.name === "GET /users/{id}")!;
    expect(getUser.id).toBe("sample-api:openapi.yaml#get__users__id_");
    expect(getUser.doc?.summary).toBe("Get a user");
    // Path-level `id` parameter is inherited by the operation.
    expect(getUser.doc?.params.map((p) => p.name)).toContain("id");
    expect(getUser.doc?.params.find((p) => p.name === "id")?.type).toBe("string (path)");
    expect(getUser.doc?.returns).toContain("200 — The user.");
    expect(getUser.doc?.returns).toContain("404 — No such user.");
    expect(getUser.doc?.tags).toContainEqual({ tag: "tag", text: "users" });
    expect(getUser.doc?.tags).toContainEqual({ tag: "operationId", text: "getUser" });

    const createUser = file.symbols.find((s) => s.name === "POST /users")!;
    expect(createUser.doc?.tags).toContainEqual({
      tag: "requestBody",
      text: "application/json: NewUser (required)",
    });

    const deleteUser = file.symbols.find((s) => s.name === "DELETE /users/{id}")!;
    expect(deleteUser.doc?.deprecated).toBeTruthy();
  });

  it("locates operations at their line in the raw spec", async () => {
    const file = (await extractSpecFile("sample-api", FIXTURE, "openapi.yaml"))!;
    const listUsers = file.symbols.find((s) => s.name === "GET /users")!;
    const createUser = file.symbols.find((s) => s.name === "POST /users")!;
    expect(listUsers.location.line).toBeGreaterThan(1);
    expect(createUser.location.line).toBeGreaterThan(listUsers.location.line);
  });

  it("bundles the spec into JSON content with refs kept internal", async () => {
    const file = (await extractSpecFile("sample-api", FIXTURE, "openapi.yaml"))!;
    const spec = JSON.parse(file.content!) as {
      info: { title: string };
      components: { schemas: Record<string, unknown> };
    };
    expect(spec.info.title).toBe("Sample Users API");
    // The self-referential User.manager schema survives as an internal $ref.
    expect(JSON.stringify(spec.components.schemas["User"])).toContain("#/components/schemas/User");
  });
});

describe("failure modes publish an explanatory page instead of failing", () => {
  it("rejects Swagger 2.0 with a clear message", async () => {
    const dir = tempRepo({
      "swagger.yaml": 'swagger: "2.0"\ninfo: { title: Old, version: "1" }\npaths: {}\n',
    });
    const file = (await extractSpecFile("repo", dir, "swagger.yaml"))!;
    expect(() => DocFile.parse(file)).not.toThrow();
    expect(file.symbols).toHaveLength(0);
    expect(file.content).toBeUndefined();
    expect(file.moduleDoc?.summary).toContain("Swagger 2.0");
  });

  it("surfaces validation errors for a broken, spec-named OpenAPI 3 file", async () => {
    const dir = tempRepo({
      "openapi.yaml": "openapi: 3.0.3\ninfo:\n  title: Broken\npaths: {}\n",
    });
    const file = (await extractSpecFile("repo", dir, "openapi.yaml"))!;
    expect(file.symbols).toHaveLength(0);
    expect(file.moduleDoc?.summary).toMatch(/version/i);
  });

  it("ignores non-spec json/yaml files entirely", async () => {
    const dir = tempRepo({ "package.json": '{"name": "x", "version": "3.0.0"}' });
    expect(await adapter.detect(dir)).toBeNull();
  });

  it("silently drops sniff-only false positives instead of publishing error pages", async () => {
    // A package.json pinning a dependency literally named "openapi" trips the
    // content sniff but is not a spec — it must not become a broken API page.
    const dir = tempRepo({
      "package.json": '{"name": "x", "dependencies": {"openapi": "3.0.0"}}',
    });
    const model = await adapter.extract(dir, { repoName: "repo" });
    expect(model.files).toHaveLength(0);
  });
});

describe("endpoint id stability", () => {
  it("disambiguates operations whose paths slug to the same anchor", async () => {
    const dir = tempRepo({
      "openapi.yaml": [
        "openapi: 3.0.3",
        'info: { title: Clash, version: "1" }',
        "paths:",
        "  /a-b:",
        "    get:",
        '      responses: { "200": { description: ok } }',
        "  /a.b:",
        "    get:",
        '      responses: { "200": { description: ok } }',
        "",
      ].join("\n"),
    });
    const file = (await extractSpecFile("repo", dir, "openapi.yaml"))!;
    const ids = file.symbols.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["repo:openapi.yaml#get__a_b", "repo:openapi.yaml#get__a_b~1"]);
  });
});
