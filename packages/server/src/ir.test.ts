import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  hashContent,
  makeFileId,
  makeSymbolId,
  type DocModel,
} from "@necronomidoc/docmodel";
import { createApp, type App } from "./app.js";
import { loadConfig } from "./config.js";

const TOKEN = "test-token";

/** A minimal, valid, hand-built model — what an arbitrary-language CI would POST. */
function externalModel(): DocModel {
  const path = "lib/rocket.rs";
  return {
    schemaVersion: SCHEMA_VERSION,
    repo: { name: "rusty", slug: "rusty", ref: "main", commit: "abc1234" },
    files: [
      {
        id: makeFileId("rusty", path),
        path,
        contentHash: hashContent("fn launch() {}"),
        format: "source",
        imports: [],
        exports: ["launch"],
        symbols: [
          {
            id: makeSymbolId("rusty", path, "launch"),
            name: "launch",
            kind: "function",
            exported: true,
            signature: "fn launch() -> Result<(), Error>",
            location: { path, line: 3 },
            doc: { summary: "Launch the rocket.", params: [], examples: [], tags: [] },
            contentHash: hashContent("fn launch"),
          },
        ],
      },
    ],
    generatedAt: new Date().toISOString(),
  };
}

function postIr(app: App, body: unknown, token?: string): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request("http://x/api/ir", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    ),
  );
}

describe("POST /api/ir (pre-extracted DocModel from external CI)", () => {
  let dataDir: string;
  let app: App;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "necro-ir-"));
    app = createApp(loadConfig({ dataDir, siteDir: join(dataDir, "no-site"), token: TOKEN }));
  });
  afterAll(() => {
    app.queue.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("rejects unauthenticated and wrongly-authenticated posts", async () => {
    expect((await postIr(app, externalModel())).status).toBe(401);
    expect((await postIr(app, externalModel(), "wrong")).status).toBe(401);
  });

  it("rejects invalid DocModel JSON with actionable issues", async () => {
    const res = await postIr(app, { schemaVersion: 1, repo: { name: "x" } }, TOKEN);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: string[] };
    expect(body.error).toBe("Invalid DocModel");
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("rejects a non-slug repo slug", async () => {
    const model = externalModel();
    model.repo.slug = "Not A Slug";
    const res = await postIr(app, model, TOKEN);
    expect(res.status).toBe(400);
  });

  it("publishes a valid model end-to-end: registry, manifests, MCP, status", async () => {
    const res = await postIr(app, externalModel(), TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; repo: { slug: string; symbolCount: number }; adapter: string };
    expect(body.ok).toBe(true);
    expect(body.adapter).toBe("external-ir");
    expect(body.repo.slug).toBe("rusty");
    expect(body.repo.symbolCount).toBe(1);

    // Served like any adapter-built repo: docs registry…
    const registry = await app.fetch(new Request("http://x/data/registry.json"));
    const reg = (await registry.json()) as { repos: { slug: string }[] };
    expect(reg.repos.map((r) => r.slug)).toContain("rusty");

    // …manifests…
    const manifest = await app.fetch(new Request("http://x/data/repos/rusty/docmodel.json"));
    expect(manifest.status).toBe(200);
    const model = (await manifest.json()) as DocModel;
    expect(model.files[0]!.symbols[0]!.name).toBe("launch");

    // …and the build status surface records the external build.
    const status = await app.fetch(new Request("http://x/api/status"));
    const statusBody = (await status.json()) as {
      sources: unknown[];
      repos: { slug: string }[];
    };
    expect(statusBody.repos.map((r) => r.slug)).toContain("rusty");
  });

  it("re-publishing replaces the docs atomically (idempotent updates)", async () => {
    const updated = externalModel();
    updated.files[0]!.symbols[0]!.doc!.summary = "Launch the rocket, safely.";
    const res = await postIr(app, updated, TOKEN);
    expect(res.status).toBe(200);
    const manifest = await app.fetch(new Request("http://x/data/repos/rusty/docmodel.json"));
    const model = (await manifest.json()) as DocModel;
    expect(model.files[0]!.symbols[0]!.doc!.summary).toBe("Launch the rocket, safely.");
  });

  it("stays disabled when no token is configured", async () => {
    const bare = createApp(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "necro-ir2-")), siteDir: "x", token: "" }));
    const res = await postIr(bare, externalModel());
    expect(res.status).toBe(403);
    bare.queue.stop();
  });
});
