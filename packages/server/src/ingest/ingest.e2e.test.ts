import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "../app.js";
import { loadConfig } from "../config.js";
import { upsertSourceRepo } from "./registry.js";

const fixture = fileURLToPath(new URL("../../../../fixtures/sample-react-app", import.meta.url));

const SECRET = "e2e-hook-secret";

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=e2e@test", "-c", "user.name=e2e", ...args],
    { cwd, stdio: "pipe", encoding: "utf8" },
  ).trim();
}

function githubPush(url: string, ref: string, sha: string): string {
  return JSON.stringify({ ref, after: sha, repository: { clone_url: url } });
}

function signed(body: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-github-event": "push",
    "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
  };
}

describe("automated ingestion end-to-end", () => {
  let dataDir: string;
  let srcDir: string;
  let srcUrl: string;
  let app: App;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "necro-e2e-data-"));
    srcDir = mkdtempSync(join(tmpdir(), "necro-e2e-src-"));
    srcUrl = `file://${srcDir}`;

    // A real git repo to pull from, exercising the clone/fetch path.
    cpSync(fixture, srcDir, { recursive: true });
    git(srcDir, "init", "-b", "main");
    git(srcDir, "add", "-A");
    git(srcDir, "commit", "-m", "initial");

    process.env.E2E_HOOK_SECRET = SECRET;
    upsertSourceRepo(dataDir, {
      id: "e2e-repo",
      provider: "github",
      url: srcUrl,
      branch: "main",
      secretEnv: "E2E_HOOK_SECRET",
    });

    app = createApp(
      loadConfig({
        dataDir,
        siteDir: join(dataDir, "no-site"),
        token: "admin-token",
        debounceMs: 20,
      }),
    );
  });

  afterAll(() => {
    app.queue.stop();
    delete process.env.E2E_HOOK_SECRET;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  const post = (path: string, body: string, headers: Record<string, string>) =>
    app.fetch(new Request(`http://x${path}`, { method: "POST", body, headers }));

  const statusJson = async (auth?: string) => {
    const res = await app.fetch(
      new Request("http://x/api/status", {
        headers: auth ? { authorization: auth } : {},
      }),
    );
    return (await res.json()) as {
      repos: { slug: string }[];
      sources: {
        id: string;
        lastBuild?: { result: string; commitSha?: string; error?: string; logTail?: string };
      }[];
      queue: { depth: number };
    };
  };

  it("builds docs from a signed push webhook, no manual step", async () => {
    const sha = git(srcDir, "rev-parse", "HEAD");
    const body = githubPush(srcUrl, "refs/heads/main", sha);
    const res = await post("/hooks/github", body, signed(body));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: true, repoId: "e2e-repo" });

    await app.queue.drain();

    const status = await statusJson();
    const source = status.sources.find((s) => s.id === "e2e-repo");
    expect(source?.lastBuild).toMatchObject({ result: "ok", commitSha: sha });
    expect(status.repos.map((r) => r.slug)).toContain("e2e-repo");
    // Manifests are on disk and hot-loaded into the MCP store.
    expect(existsSync(join(dataDir, "repos", "e2e-repo", "docmodel.json"))).toBe(true);
    expect(app.store.getRepo("e2e-repo")).toBeDefined();
  }, 60_000);

  it("picks up a new commit on the next push (fetch + reset path)", async () => {
    writeFileSync(
      join(srcDir, "src", "shiny.ts"),
      "/** A brand new module. */\nexport const shiny = 42;\n",
    );
    git(srcDir, "add", "-A");
    git(srcDir, "commit", "-m", "add shiny");
    const sha = git(srcDir, "rev-parse", "HEAD");

    const body = githubPush(srcUrl, "refs/heads/main", sha);
    await post("/hooks/github", body, signed(body));
    await app.queue.drain();

    const model = JSON.parse(
      readFileSync(join(dataDir, "repos", "e2e-repo", "docmodel.json"), "utf8"),
    ) as { files: { path: string }[]; repo: { commit?: string } };
    expect(model.files.map((f) => f.path)).toContain("src/shiny.ts");
    expect(model.repo.commit).toBe(sha);
  }, 60_000);

  it("rejects forged webhooks and leaves the queue untouched", async () => {
    const body = githubPush(srcUrl, "refs/heads/main", "deadbeef");
    const res = await post("/hooks/github", body, {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "forged").update(body).digest("hex")}`,
    });
    expect(res.status).toBe(401);
    expect((await statusJson()).queue.depth).toBe(0);
  });

  it("ignores pushes to untracked branches with a 202", async () => {
    const body = githubPush(srcUrl, "refs/heads/feature/x", "deadbeef");
    const res = await post("/hooks/github", body, signed(body));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: false });
  });

  it("queues a registered repo via authenticated REST", async () => {
    const res = await post("/api/build", JSON.stringify({ repoId: "e2e-repo" }), {
      "content-type": "application/json",
      authorization: "Bearer admin-token",
    });
    expect(res.status).toBe(202);
    await app.queue.drain();
    expect((await statusJson()).sources[0]?.lastBuild?.result).toBe("ok");
  }, 60_000);

  it("rejects REST triggers with a bad token before revealing anything", async () => {
    const res = await post("/api/build", JSON.stringify({ repoId: "e2e-repo" }), {
      "content-type": "application/json",
      authorization: "Bearer wrong",
    });
    expect(res.status).toBe(401);
  });

  it("keeps serving the last good docs when a build fails, with detail behind the token", async () => {
    const before = readFileSync(join(dataDir, "repos", "e2e-repo", "docmodel.json"), "utf8");

    // Break the source: point the registry at a URL that cannot be fetched.
    upsertSourceRepo(dataDir, {
      id: "e2e-repo",
      provider: "github",
      url: "file:///nonexistent/nowhere",
      branch: "main",
      secretEnv: "E2E_HOOK_SECRET",
    });
    const res = await post("/api/build", JSON.stringify({ repoId: "e2e-repo" }), {
      "content-type": "application/json",
      authorization: "Bearer admin-token",
    });
    expect(res.status).toBe(202);
    await app.queue.drain();

    const anonymous = await statusJson();
    const failed = anonymous.sources.find((s) => s.id === "e2e-repo")?.lastBuild;
    expect(failed?.result).toBe("error");
    expect(failed?.logTail).toBeUndefined(); // detail requires the admin token

    const admin = await statusJson("Bearer admin-token");
    expect(admin.sources.find((s) => s.id === "e2e-repo")?.lastBuild?.logTail).toBeTruthy();

    // The previous docs are untouched.
    const after = readFileSync(join(dataDir, "repos", "e2e-repo", "docmodel.json"), "utf8");
    expect(after).toBe(before);
  }, 60_000);
});
