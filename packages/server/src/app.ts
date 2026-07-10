import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { Hono } from "hono";
import { ManifestStore, handleMcpRequest } from "@necronomidoc/mcp";
import { buildRepo } from "./build.js";
import type { NecronomidocConfig } from "./config.js";

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
}

/**
 * Build the portable server: static site + `/data` manifests + stateless
 * `/mcp` + a minimal build/status API — one Hono app, one process, fs-only
 * state (decisions 0002 + 0008).
 */
export function createApp(config: NecronomidocConfig): App {
  const store = new ManifestStore(config.dataDir);
  store.reload();

  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/api/status", (c) =>
    c.json({ dataDir: config.dataDir, repos: store.listRepos() }),
  );

  // Manual bearer auth — the slice-1 stand-in for provider adapters (slice 2).
  app.post("/api/build", async (c) => {
    if (!config.token) return c.json({ error: "Build endpoint disabled (no token set)." }, 403);
    const auth = c.req.header("authorization") ?? "";
    if (auth !== `Bearer ${config.token}`) return c.json({ error: "Unauthorized" }, 401);
    let body: { repoUrl?: string; path?: string; name?: string; ref?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const target = body.repoUrl ?? body.path;
    if (!target) return c.json({ error: "Provide { repoUrl | path }" }, 400);
    try {
      const result = await buildRepo({
        dataDir: config.dataDir,
        target,
        name: body.name,
        ref: body.ref,
      });
      store.reload(); // hot-reload manifests into the MCP handler
      return c.json({ ok: true, repo: result.entry, adapter: result.adapter });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // Stateless MCP endpoint (fetch-portable).
  app.all("/mcp", (c) => handleMcpRequest(store, c.req.raw));

  // Manifests, consumed by the SPA and available to any client.
  app.get("/data/*", (c) => {
    const rel = c.req.path.slice("/data/".length);
    const abs = safeJoin(config.dataDir, rel);
    if (abs) {
      const res = fileResponse(abs);
      if (res) return res;
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

  return { fetch: app.fetch, store };
}
