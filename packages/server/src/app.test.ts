import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRepo } from "./build.js";
import { createApp, type App } from "./app.js";
import { loadConfig } from "./config.js";

const fixture = fileURLToPath(new URL("../../../fixtures/sample-react-app", import.meta.url));

describe("server app", () => {
  let dataDir: string;
  let app: App;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "necro-data-"));
    await buildRepo({ dataDir, target: fixture, name: "sample-react-app" });
    app = createApp(loadConfig({ dataDir, siteDir: join(dataDir, "no-site") }));
  });

  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  it("serves health", async () => {
    const res = await app.fetch(new Request("http://x/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("reports built repos on status", async () => {
    const res = await app.fetch(new Request("http://x/api/status"));
    const body = (await res.json()) as { repos: { slug: string }[] };
    expect(body.repos.map((r) => r.slug)).toContain("sample-react-app");
  });

  it("serves manifests under /data", async () => {
    const res = await app.fetch(new Request("http://x/data/registry.json"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repos: unknown[] };
    expect(body.repos.length).toBe(1);
  });

  it("answers an MCP tools/list over /mcp", async () => {
    const res = await app.fetch(
      new Request("http://x/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0.0" },
          },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("necronomidoc"); // serverInfo name in the initialize result
  });

  it("rejects an unauthorized build", async () => {
    const res = await app.fetch(
      new Request("http://x/api/build", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(403); // token disabled by default
  });
});
