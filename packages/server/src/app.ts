import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { Hono, type Context } from "hono";
import { slugify, type IngestStatusResponse } from "@necronomidoc/docmodel";
import { ManifestStore, handleMcpRequest } from "@necronomidoc/mcp";
import { buildRepo, looksLikeGitUrl } from "./build.js";
import type { NecronomidocConfig } from "./config.js";
import { fetchSource } from "./ingest/fetch.js";
import {
  authorizeRestTrigger,
  providers,
  verifyWebhook,
  type ProviderContext,
  type TriggerEvent,
  type TriggerResult,
} from "./ingest/providers.js";
import { BuildQueue } from "./ingest/queue.js";
import {
  getSourceRepo,
  safeReadSourceRegistry,
  sourceRegistryPath,
  type SourceRegistry,
  type SourceRepo,
} from "./ingest/registry.js";
import {
  buildStatusPath,
  readBuildStatus,
  type BuildRecord,
  type BuildStatusFile,
} from "./ingest/status.js";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

function contentType(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Resolve a request path under a root, refusing traversal outside it. */
function safeJoin(root: string, requestPath: string): string | null {
  const clean = normalize(decodeURIComponent(requestPath)).replace(/^(\.\.[/\\])+/, "");
  const full = resolve(root, "." + (clean.startsWith("/") ? clean : `/${clean}`));
  return full.startsWith(resolve(root)) ? full : null;
}

function fileResponse(absPath: string): Response | null {
  if (!existsSync(absPath) || !statSync(absPath).isFile()) return null;
  return new Response(readFileSync(absPath), {
    headers: { "content-type": contentType(absPath) },
  });
}

export interface App {
  fetch: (request: Request) => Response | Promise<Response>;
  store: ManifestStore;
  queue: BuildQueue;
}

/** Strip admin-only failure detail from a build record. */
function publicBuildRecord(record: BuildRecord): Omit<BuildRecord, "logTail"> {
  const { logTail: _logTail, ...rest } = record;
  return rest;
}

/**
 * Re-read a JSON state file only when its mtime changes. All in-process
 * writers go through the filesystem, and out-of-process writers (the CLI)
 * are covered by the mtime check — so serving paths stop paying a disk read
 * + schema parse per request (the site polls /api/status every 5s per tab).
 */
function mtimeCached<T>(path: string, read: () => T): () => T {
  let mtime = Number.NaN;
  let cached: T | undefined;
  return () => {
    const m = statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? -1;
    if (cached === undefined || m !== mtime) {
      cached = read();
      mtime = m;
    }
    return cached;
  };
}

/**
 * Build the portable server: static site + `/data` manifests + stateless
 * `/mcp` + ingestion (webhooks, REST trigger, build queue) and status APIs —
 * one Hono app, one process, fs-only state (decisions 0002 + 0008).
 */
export function createApp(config: NecronomidocConfig): App {
  const store = new ManifestStore(config.dataDir);
  store.reload();

  // The full pipeline for one registered repo: fetch → extract → enrich →
  // atomic publish. Only successful builds publish, so a failure leaves the
  // previous docs serving.
  const runBuild = async (repo: SourceRepo, event: TriggerEvent) => {
    const fetched = await fetchSource(repo, config.dataDir);
    const result = await buildRepo({
      dataDir: config.dataDir,
      target: fetched.dir,
      name: repo.id,
      adapterConfig: {
        repoUrl: looksLikeGitUrl(repo.url) ? repo.url : undefined,
        ref: event.ref,
        commit: fetched.commitSha,
      },
    });
    return {
      fileCount: result.entry.fileCount,
      symbolCount: result.entry.symbolCount,
      commitSha: fetched.commitSha,
    };
  };

  const queue = new BuildQueue({
    dataDir: config.dataDir,
    runBuild,
    onPublished: () => store.reload(), // hot-reload manifests into MCP + /data
    debounceMs: config.debounceMs,
    concurrency: config.buildConcurrency,
    buildTimeoutMs: config.buildTimeoutMs,
  });

  // State files re-read only when their mtime moves (the CLI edits them
  // out-of-process; everything else writes through these same paths).
  const cachedRegistry: () => SourceRegistry = mtimeCached(
    sourceRegistryPath(config.dataDir),
    () => safeReadSourceRegistry(config.dataDir),
  );
  const cachedStatus: () => BuildStatusFile = mtimeCached(buildStatusPath(config.dataDir), () =>
    readBuildStatus(config.dataDir),
  );

  const providerCtx = (): ProviderContext => ({
    repos: cachedRegistry().repos,
    env: process.env,
    sharedSecret: config.webhookSecret || undefined,
    now: () => new Date().toISOString(),
  });

  /** Constant-time global-token check (same code path as the REST trigger). */
  const isAdminRequest = (c: Context): boolean =>
    authorizeRestTrigger(
      { authorization: c.req.header("authorization") },
      { repos: [], env: process.env, now: () => "", globalToken: config.token || undefined },
    );

  // Verification happened in the provider; here we only queue and respond.
  // Accepted/ignored answer 202 immediately — no build work in the request
  // path. Rejections are logged with their reason (acceptance criterion 3).
  const respondToTrigger = (c: Context, result: TriggerResult): Response => {
    if (result.kind === "accepted") {
      const { coalesced } = queue.enqueue(result.event);
      return Response.json(
        { accepted: true, repoId: result.event.repoId, coalesced },
        { status: 202 },
      );
    }
    if (result.kind === "ignored") {
      return Response.json({ accepted: false, ignored: result.reason }, { status: 202 });
    }
    console.warn(`[ingest] rejected ${c.req.method} ${c.req.path}: ${result.reason}`);
    return Response.json({ error: result.reason }, { status: result.status });
  };

  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/api/status", (c) => {
    const isAdmin = isAdminRequest(c);
    const status = cachedStatus();
    const sources = cachedRegistry().repos.map((repo) => {
      const last = status.builds[repo.id]?.[0];
      return {
        id: repo.id,
        provider: repo.provider,
        branch: repo.branch,
        enabled: repo.enabled,
        lastBuild: last ? (isAdmin ? last : publicBuildRecord(last)) : undefined,
      };
    });
    const response: IngestStatusResponse = {
      dataDir: config.dataDir,
      repos: store.listRepos(),
      sources,
      queue: { depth: queue.depth(), items: queue.snapshot() },
    };
    return c.json(response);
  });

  // Provider webhooks (decision 0001): one route, one adapter per provider —
  // /hooks/github (HMAC-verified push), /hooks/ado (basic-auth git.push), and
  // any future adapter added to `providers` with no route changes.
  app.post("/hooks/:provider", async (c) => {
    const provider = providers[c.req.param("provider")];
    if (!provider) return c.notFound();
    const body = await c.req.text();
    const headers = { get: (name: string) => c.req.header(name) };
    return respondToTrigger(c, verifyWebhook(provider, body, headers, providerCtx()));
  });

  // Generic REST trigger: `{ repoId }` queues a registered repo (global or
  // per-repo scoped token). The slice-1 `{ path | repoUrl }` form still works
  // for ad-hoc builds and requires the global token.
  app.post("/api/build", async (c) => {
    // No credential at all → reject before even reading the body, so
    // unauthenticated probes cost nothing and can't feed us huge payloads.
    if (!c.req.header("authorization")) {
      if (!config.token) return c.json({ error: "Build endpoint disabled (no token set)." }, 403);
      return c.json({ error: "Unauthorized" }, 401);
    }

    let body: { repoId?: string; repoUrl?: string; path?: string; name?: string; ref?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (body.repoId) {
      const repo = getSourceRepo(config.dataDir, body.repoId);
      const authorized = authorizeRestTrigger(
        { authorization: c.req.header("authorization"), repo },
        { ...providerCtx(), globalToken: config.token || undefined },
      );
      if (!authorized) {
        console.warn(`[ingest] rejected POST /api/build for "${body.repoId}": bad or missing token`);
        return c.json({ error: "Unauthorized" }, 401);
      }
      if (!repo) return c.json({ error: `Unknown repoId "${body.repoId}"` }, 404);
      // Always the tracked branch: fetchSource checks out repo.branch, so a
      // caller-supplied ref would only mislabel docs it didn't change.
      const result: TriggerResult = repo.enabled
        ? {
            kind: "accepted",
            event: {
              repoId: repo.id,
              ref: repo.branch,
              provider: "generic",
              receivedAt: new Date().toISOString(),
            },
          }
        : { kind: "ignored", reason: `repo "${repo.id}" is disabled` };
      return respondToTrigger(c, result);
    }

    if (!config.token) return c.json({ error: "Build endpoint disabled (no token set)." }, 403);
    if (!isAdminRequest(c)) return c.json({ error: "Unauthorized" }, 401);
    const target = body.repoUrl ?? body.path;
    if (!target) return c.json({ error: "Provide { repoId | repoUrl | path }" }, 400);
    try {
      // Serialize against queued builds that would publish under the same
      // slug — ad-hoc and queued builds must never race the atomic swap.
      const slug = slugify(body.name ?? target);
      const result = await queue.withRepoLock(slug, () =>
        buildRepo({
          dataDir: config.dataDir,
          target,
          name: body.name,
          ref: body.ref,
        }),
      );
      store.reload(); // hot-reload manifests into the MCP handler
      return c.json({ ok: true, repo: result.entry, adapter: result.adapter });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // Stateless MCP endpoint (fetch-portable).
  app.all("/mcp", (c) => handleMcpRequest(store, c.req.raw));

  // Published manifests, consumed by the SPA and available to any client.
  // Deny-by-default allowlist: the data dir also holds clones of possibly
  // private repos, build logs (admin-gated on /api/status), and queue state —
  // none of which may be served unauthenticated.
  app.get("/data/*", (c) => {
    const rel = c.req.path.slice("/data/".length);
    const abs = safeJoin(config.dataDir, rel);
    if (abs) {
      // Allowlist on the *resolved* path so ../ tricks can't sidestep it.
      const allowed =
        abs === resolve(config.dataDir, "registry.json") ||
        abs.startsWith(resolve(config.dataDir, "repos") + sep);
      if (allowed) {
        const res = fileResponse(abs);
        if (res) return res;
      }
    }
    return c.notFound();
  });

  // Static site with SPA fallback to index.html.
  app.get("/*", (c) => {
    const abs = safeJoin(config.siteDir, c.req.path);
    if (abs) {
      const direct = fileResponse(abs);
      if (direct) return direct;
    }
    const indexHtml = join(config.siteDir, "index.html");
    const fallback = fileResponse(indexHtml);
    if (fallback) return fallback;
    return c.text(
      "necronomidoc server is running, but no built site was found.\n" +
        `Expected a built SPA at: ${config.siteDir}\n` +
        "Run `npm run build:site` (or `necronomidoc build <repo>` then rebuild the site).",
      200,
    );
  });

  return { fetch: app.fetch, store, queue };
}
