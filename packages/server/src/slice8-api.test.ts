import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "./app.js";
import { buildRepo } from "./build.js";
import { loadConfig } from "./config.js";
import { generateSkills } from "./skills.js";

const fixture = fileURLToPath(new URL("../../../fixtures/sample-react-app", import.meta.url));
const TOKEN = "test-token-for-slice8-routes";

describe("skills + artefacts API routes", () => {
  let dataDir: string;
  let app: App;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "necro-api8-"));
    await buildRepo({ dataDir, target: fixture, name: "sample-react-app" });
    await generateSkills({
      dataDir,
      all: true,
      client: {
        model: "fake",
        complete: async () => ({
          text: JSON.stringify({ skills: [{ name: "nav", description: "d", body: "b" }] }),
          inputTokens: 1,
          outputTokens: 1,
        }),
      },
    });
    app = createApp(loadConfig({ dataDir, siteDir: join(dataDir, "no-site"), token: TOKEN }));
  });

  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  it("lists and serves generated skill sets", async () => {
    const index = (await (await app.fetch(new Request("http://x/api/skills"))).json()) as {
      sets: { id: string }[];
    };
    expect(index.sets.map((s) => s.id)).toEqual(["global"]);

    const set = await app.fetch(new Request("http://x/api/skills/global"));
    expect(set.status).toBe(200);
    const zip = await app.fetch(new Request("http://x/api/skills/global/download"));
    expect(zip.status).toBe(200);
    expect(zip.headers.get("content-type")).toBe("application/zip");
  });

  it("rejects ids that could traverse the data dir", async () => {
    const res = await app.fetch(new Request("http://x/api/skills/..%2F..%2Fregistry.json"));
    expect(res.status).toBe(404);
  });

  it("gates generation behind the admin token", async () => {
    const anonymous = await app.fetch(
      new Request("http://x/api/skills/generate", { method: "POST", body: "{}" }),
    );
    expect(anonymous.status).toBe(401);
  });

  it("maps scope errors to 400 without calling any LLM", async () => {
    const res = await app.fetch(
      new Request("http://x/api/skills/generate", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ repos: ["no-such-repo"] }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("no-such-repo");
  });

  it("accepts a multipart artefact upload but 400s an unknown scope", async () => {
    const form = new FormData();
    form.set("template", new File(["# T\n\n{{fill me in}}\n"], "t.md", { type: "text/markdown" }));
    form.set("repos", "no-such-repo");
    const res = await app.fetch(
      new Request("http://x/api/artefacts/generate", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: form,
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("no-such-repo");
  });

  it("404s missing artefacts and rejects traversal in artefact ids", async () => {
    expect((await app.fetch(new Request("http://x/api/artefacts/nope-123"))).status).toBe(404);
    expect(
      (await app.fetch(new Request("http://x/api/artefacts/..%2Fskills/output"))).status,
    ).toBe(404);
    const index = (await (await app.fetch(new Request("http://x/api/artefacts"))).json()) as {
      artefacts: unknown[];
    };
    expect(index.artefacts).toEqual([]);
  });
});
