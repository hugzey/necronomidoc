# Research: Hosting an MCP Server "Statically" Alongside a Documentation Site

*Status: research complete — 2026-07-10*
*Question: can we host our generated doc site's MCP interface "statically, same as the Storybook MCP addon does", and if not, what is the cheapest/simplest architecture that gets us there?*

---

## 1. Summary & Recommendation

**TL;DR — a pure static host (S3/nginx serving only files) cannot be an MCP server, and notably the Storybook MCP addon is *not* static either.** MCP's Streamable HTTP transport requires answering `POST` requests carrying JSON-RPC bodies, which static file hosting cannot do. However, the Storybook model — which is exactly the right reference — shows the practical next-best thing:

> **Bake all knowledge into static JSON artifacts at build time ("manifests"), then put a tiny, stateless, dependency-light HTTP handler in front of them.** The handler holds no state, needs no database, and can run as a single Node process, an edge/serverless function, or inside the same server that serves the static site.

**Recommended architecture for us** (details in §6):

1. **Build step** emits, next to the static React SPA, a set of pre-baked JSON artifacts under e.g. `/manifests/`: `repos.json`, per-repo `files.json` + `functions.json`, a `search-index.json` (MiniSearch/FlexSearch serialized index), and `subsystems.json`. These are plain static files — also fetchable directly by humans/agents, like Storybook's `/manifests/components.json`.
2. **A single-file stateless MCP handler** (Hono or Express + `@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport` with `sessionIdGenerator: undefined` and `enableJsonResponse: true`) that loads those JSON files at startup (or lazily) and answers `POST /mcp`. No sessions, no SSE, no DB — every request is an ordinary HTTP request/response.
3. **Deploy** as one Node process that serves both the SPA static files and `/mcp` (simplest), or nginx-for-static + node-for-`/mcp` on EC2, or a single Azure App Service Node app. Total infra: one small box or one App Service plan. The MCP endpoint URL becomes e.g. `https://docs.internal.yellow-ace.com/mcp`.
4. **Tools** (§7): `search_docs`, `list_repos`, `get_file_doc`, `get_function_doc`, `get_subsystem_overview` — mirrors the emerging docs-MCP convention (Context7/Mintlify/GitBook/Storybook all converge on *search + get-by-id + list*), with cursor pagination and response-size discipline (Claude Code rejects tool results > 25k tokens by default).

This is precisely the Storybook pattern: their standalone `@storybook/mcp` package is "a reusable MCP package" whose only input is the statically-built manifest files, and their official `self-host-mcp` example deploys it as a Netlify Function reading `manifests/` copied from a static Storybook build ([storybookjs/mcp](https://github.com/storybookjs/mcp), [self-host example](https://github.com/storybookjs/mcp/tree/main/apps/self-host-mcp)).

**Also do (cheap, zero-risk):** publish `llms.txt` / `llms-full.txt` and per-page `.md` files in the static build. This is the true "no server at all" fallback that agents without MCP configured can still use, and it's now standard across GitBook/Mintlify ([GitBook LLM-ready docs](https://gitbook.com/docs/ai-and-search/llm-ready-docs), [llms.txt platforms](https://www.mintlify.com/library/best-llms-txt-platforms)).

---

## 2. Can an MCP server be truly static?

**No — but "almost".** What the protocol requires vs. what static hosting provides:

- MCP's remote transport is **Streamable HTTP** (spec versions 2025-03-26 → 2025-06-18 → 2025-11-25). The server exposes a **single endpoint** (conventionally `/mcp`) that must accept `POST` bodies containing JSON-RPC messages and may respond either with `Content-Type: application/json` (single response) or `text/event-stream` (streaming). A `GET` on the endpoint is only for optional server-initiated streams. ([MCP transports spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports), [MCPcat guide](https://mcpcat.io/guides/building-streamablehttp-mcp-server/), [transport comparison](https://chatforest.com/guides/mcp-transports-explained/))
- Static file hosting can only answer `GET` with fixed bytes. It cannot dispatch on JSON-RPC method names (`initialize`, `tools/list`, `tools/call` with arbitrary arguments). So **you always need at least a thin request handler** — but it can be tiny, stateless, and read only pre-baked files.
- **The trend is strongly in our favor:** the MCP **2026-07-28 spec release candidate is "stateless-first"** — it *eliminates the `initialize` handshake and the `Mcp-Session-Id` header entirely*; client capabilities travel in `_meta` on each request, and new `Mcp-Method`/`Mcp-Name` headers let load balancers route without body inspection. "Any MCP request can land on any server instance." RC locked 2026-05-21, final spec due 2026-07-28. ([MCP blog: 2026-07-28 RC](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/), [analysis](https://azukiazusa.dev/en/blog/mcp-stateless/), [what changed](https://stacktr.ee/blog/mcp-2026-spec-changes)) Even under the current 2025-11-25 spec, stateless JSON-response mode is fully supported: in the TypeScript SDK, set `sessionIdGenerator: undefined` + `enableJsonResponse: true` on `StreamableHTTPServerTransport` and the server behaves like a plain JSON API. ([Spring's equivalent stateless docs](https://docs.spring.io/spring-ai/reference/api/mcp/mcp-stateless-server-boot-starter-docs.html), [mhart/mcp-hono-stateless](https://github.com/mhart/mcp-hono-stateless))

### Prior art for "static-ish" MCP

| Pattern | What it is | Verdict for us |
|---|---|---|
| **Static JSON manifests + thin handler** (Storybook) | Build emits JSON; stateless handler reads it | **Our model** — §3 |
| **Edge/serverless functions** | Cloudflare Workers `McpAgent`/`createMcpHandler` (~15 LOC, near-zero cold start, 100k req/day free); Vercel `mcp-handler`; Netlify Functions; AWS Lambda | Great if we accept edge platforms; we're constrained to EC2/Azure ([Cloudflare remote MCP](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/), [hosting comparison](https://mcpplaygroundonline.com/blog/free-mcp-server-hosting-cloudflare-vercel-guide)) |
| **WebMCP / MCP-B** (the "mcp-b" lead) | The *web page itself* is the MCP server: tools registered in page JavaScript, transported via `postMessage`/`navigator.modelContext` to browser-embedded agents. W3C Community Group accepted Sep 2025; Chrome 146 shipped an Early Preview behind a flag (Feb 2026). This *is* genuinely static-hostable — but only reachable by agents *running in the user's browser*, not by Claude Code/CLI agents hitting a URL. ([MCP-B/WebMCP](https://github.com/MiguelsPizza/WebMCP), [docs.mcp-b.ai](https://docs.mcp-b.ai/), [W3C webmcp](https://github.com/webmachinelearning/webmcp), [Chrome WebMCP vs MCP](https://developer.chrome.com/docs/ai/webmcp/compare-mcp)) | Interesting future add-on for in-browser copilots; **not sufficient** for our CLI-agent use case |
| **`llms.txt` + raw `.md` pages** | Pure static convention; agents fetch markdown directly | Do it as a complement — zero cost |
| **`.well-known/mcp.json` discovery** | SEP-1649/SEP-1960 propose static discovery manifests at `/.well-known/` so clients auto-discover the MCP endpoint on a domain. Broad support, not yet merged into core spec (as of Feb 2026). ([SEP-1649](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1649), [SEP PR 2127](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127)) | Cheap to add: one static JSON file pointing at our `/mcp` |

---

## 3. Reference model: the Storybook MCP addon — how it actually works

Storybook's MCP story ([storybook.js.org/docs/ai/mcp/overview](https://storybook.js.org/docs/ai/mcp/overview)) is a **monorepo of four packages** ([github.com/storybookjs/mcp](https://github.com/storybookjs/mcp)) and, crucially, splits into a *dev-server mode* and a *static/self-host mode*:

### 3.1 The two-layer architecture

**Layer 1 — build-time manifests (the "static" part).** Storybook ≥ v10.1 generates **manifests**: JSON files describing components and docs, produced by static analysis of CSF story files + prop-type extraction, and MDX docs. They are served at `/manifests/components.json` and `/manifests/docs.json` by the dev server **and are emitted as static files in a built Storybook** at the same routes (newer versions split into per-component payload files under a sibling directory). There's even a human-readable debugger at `/manifests/components.html`. This is an experimental feature "specifically tailored for Storybook's official MCP addon". ([Storybook manifests docs](https://storybook.js.org/docs/ai/manifests), [feature issue #32852](https://github.com/storybookjs/storybook/issues/32852))

**Layer 2a — `@storybook/addon-mcp` (dev-server mode).** An addon that mounts an MCP endpoint at `http://localhost:6006/mcp` inside the Vite dev server (`src/mcp-handler.ts` handles session management, tool registration, request routing). Toolsets: **docs** (component/doc lookup), **development** (story-writing instructions, story previews via MCP Apps if the client supports it, links into Storybook), **testing** (run component/a11y tests, interpret results). This mode only exists while `storybook dev` runs. ([addon page](https://storybook.js.org/addons/@storybook/addon-mcp), [npm](https://www.npmjs.com/package/@storybook/addon-mcp), [DeepWiki architecture](https://deepwiki.com/storybookjs/addon-mcp))

**Layer 2b — `@storybook/mcp` (standalone/static mode — the one that matches the requirement).** A "reusable MCP package for Storybook component and docs knowledge" that **does not require Storybook to be running at all**. Its only input is a *manifest source*: `components.json` (required) + `docs.json` (optional), supplied via a `manifestProvider` callback that can read a **local directory or a remote base URL** — i.e., it can point straight at the `manifests/` folder of a *statically hosted* Storybook build. Transport: fetch-compatible HTTP handler built on `@tmcp/transport-http` (streamable HTTP), exposed via a `createStorybookMcpHandler` utility. Tools registered: **`list-all-documentation`**, **`get-documentation`**, **`get-documentation-for-story`**. ([packages/mcp README](https://github.com/storybookjs/mcp/tree/main/packages/mcp), [npm @storybook/mcp](https://www.npmjs.com/package/@storybook/mcp))

**The official `apps/self-host-mcp` example** wires this up both ways with the *same handler*: a plain Node 20+ process (`pnpm start -- --port 13316 --manifestsPath ./manifests`) **and** a Netlify Function (`netlify.toml` rewrites `/mcp` → `/.netlify/functions/mcp`), with manifests copied out of a built Storybook into the app. Live demo: `https://storybook-mcp-self-host-example.netlify.app/mcp`. ([self-host-mcp](https://github.com/storybookjs/mcp/tree/main/apps/self-host-mcp))

### 3.2 What "hosted statically as an MCP, same as Storybook" therefore means

Storybook does **not** serve MCP from a pure static file host. What it does — and what we should replicate — is:

- **All intelligence is at build time.** The MCP layer contains no analysis logic; it's a dumb lookup over pre-generated JSON.
- **The runtime is a stateless fetch handler** portable across a bare Node process, serverless functions, or any framework that speaks `Request`/`Response`.
- **The static site and the manifests ship together**; the MCP handler can even read the manifests over HTTP from the static host, meaning the handler can be deployed separately from (or beside) the static assets.

Community write-ups confirm this reading of the architecture ([LogRocket: Storybook MCP for AI-aware component libraries](https://blog.logrocket.com/storybook-mcp-component-libraries/), [azukiazusa: Trying out Storybook MCP](https://azukiazusa.dev/en/blog/storybook-mcp/), [Storybook DS+agents RFC](https://github.com/storybookjs/ds-mcp-experiment-reshaped/discussions/1)).

---

## 4. MCP transport state of play (mid-2026)

- **stdio** and **Streamable HTTP** are the two standard transports; **HTTP+SSE (2024-11-05) is deprecated/legacy**. ([transports spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports), [why SSE was deprecated](https://chatforest.com/guides/mcp-transports-explained/))
- **Streamable HTTP mechanics:** single endpoint; client `POST`s JSON-RPC; server replies `application/json` (single message) or `text/event-stream` (stream); notifications get `202 Accepted`. Sessions via optional `Mcp-Session-Id` header — *optional*, and fully stateless servers are first-class ([deep dive](https://medium.com/@shsrams/deep-dive-mcp-servers-with-streamable-http-transport-0232f4bb225e), [MCPcat production guide](https://mcpcat.io/guides/building-streamablehttp-mcp-server/)).
- **Stateless mode (TypeScript SDK):** `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })` — no session, plain JSON responses, no SSE needed. Reference minimal implementation on Hono: [mhart/mcp-hono-stateless](https://github.com/mhart/mcp-hono-stateless). Serverless framings: [AWS Lambda guide](https://hidekazu-konishi.com/entry/mcp_server_aws_lambda_complete_guide.html), [serverless MCP walkthrough](https://ranthebuilder.cloud/blog/building-serverless-mcp-server/).
- **2025-11-25 spec** refined Streamable HTTP and added an experimental **Tasks** primitive for long-running operations (irrelevant to us — our lookups are instant). ([render.com hosting guide](https://render.com/articles/building-and-hosting-mcp-servers-a-complete-guide))
- **2026-07-28 spec (final due in ~3 weeks)** goes **stateless-first**: no `initialize` handshake, no session header, `InputRequiredResult` replaces held-open SSE for server→client asks, new routing headers, caching directives (`ttlMs`, `cacheScope` — useful for us: doc lookups are cacheable), full JSON Schema 2020-12 for tool schemas. Breaking changes; SDKs get a ten-week validation window. **Design takeaway: build stateless now and we're aligned with where the protocol is going.** ([official RC post](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/), [change analysis](https://stacktr.ee/blog/mcp-2026-spec-changes))

---

## 5. Docs-focused MCP servers: survey & tool-design conventions

| Server | How hosted | Tools exposed | Notes |
|---|---|---|---|
| **Storybook `@storybook/mcp`** | Stateless handler over static manifests | `list-all-documentation`, `get-documentation`, `get-documentation-for-story` | list + get-by-id pattern; IDs come from the list call ([repo](https://github.com/storybookjs/mcp)) |
| **Context7** (Upstash) | Hosted remote MCP (curated DB of library docs) | `resolve-library-id` (name → canonical ID, ranked by trust/coverage), `get-library-docs` (ID + optional `topic` filter, **default 5,000-token budget, caller-configurable**) | The two-step *resolve → get* pattern with an explicit token budget is the most-copied docs-MCP design ([Context7 API](https://context7.mintlify.app/api-reference/context/get-documentation-context), [analysis](https://www.trevorlasn.com/blog/context7-mcp)); also exposes a full index at `/llms.txt` |
| **Mintlify** | Auto-generated per docs site, hosted at the docs domain (`/mcp`) | a `search` tool over site content (+ optional tools generated from OpenAPI specs) | "search-first" minimal surface ([Mintlify MCP docs](https://www.mintlify.com/docs/ai/model-context-protocol), [blog](https://www.mintlify.com/blog/generate-mcp-servers-for-your-docs)) |
| **GitBook** | **Every published site automatically includes an MCP server** at the site's own domain; managed, stateless | read/search tools over published pages | strong precedent for "MCP endpoint lives on the docs site's URL" ([GitBook MCP docs](https://gitbook.com/docs/ai-and-search/mcp-servers-for-published-docs), [site MCP API](https://gitbook.com/docs/developers/gitbook-api/api-reference/docs-sites/site-mcp-servers)); also auto-emits `.md` pages, `llms.txt`, `llms-full.txt` ([LLM-ready docs](https://gitbook.com/docs/ai-and-search/llm-ready-docs)) |

**Convention that emerges** (and that we should follow):

1. **Search is the front door** (`search_*`), returning ranked snippets + stable IDs/paths.
2. **Get-by-ID for full content** (`get_*`), where IDs come from search/list results — never force the agent to guess identifiers (Context7 makes this an explicit two-step contract).
3. **A list/overview tool** for orientation (`list-all-documentation`, `llms.txt` index).
4. **Explicit token budgets** on content-returning tools (Context7's `tokens` param, default 5,000).
5. **Static markdown fallbacks** (`llms.txt`, `llms-full.txt`, per-page `.md`) alongside the MCP endpoint.

---

## 6. Recommended architecture

### 6.1 Build pipeline (all repos → one artifact)

```
repo A ─┐
repo B ─┼─ doc extractor ──▶ dist/
repo C ─┘                    ├─ index.html + SPA assets      (React doc site)
                             ├─ llms.txt, llms-full.txt      (static agent fallback)
                             ├─ .well-known/mcp.json         (discovery card, SEP-1649-shaped)
                             └─ manifests/
                                ├─ repos.json                (repo list + subsystem map + doc version/commit SHAs)
                                ├─ subsystems.json           (cross-repo subsystem overviews)
                                ├─ <repo>/files.json         (per-file: path, purpose, scope, concerns, exports)
                                ├─ <repo>/functions.json     (per-function: signature, purpose, params, related)
                                └─ search-index.json         (serialized MiniSearch/FlexSearch index over all of the above)
```

Everything the MCP serves is derivable from `manifests/` — exactly Storybook's `components.json`/`docs.json` split, generalized to files/functions. Keep per-repo files separate so the handler can lazy-load and so single-repo rebuilds are cheap. Pre-serializing the search index at build time keeps the runtime dependency-free and startup instant (MiniSearch/FlexSearch both support `JSON.stringify`'d index loading).

### 6.2 Runtime: one small stateless handler

A ~100-line Hono (or Express) app with two responsibilities:

- `GET /*` → static files from `dist/` (or delegate this to nginx, see below)
- `POST /mcp` → `@modelcontextprotocol/sdk` `McpServer` + `StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })`, tools implemented as pure functions over the in-memory manifest JSON.

Properties: no database, no session store, restart-safe, horizontally trivial, and deployable unchanged to a serverless function later (the handler is fetch-shaped — same portability trick as Storybook's `createStorybookMcpHandler` running on both Node and Netlify). Add `Cache-Control` on manifests and (post-2026-07-28 spec) `ttlMs` cache directives on tool results.

### 6.3 Hosting option comparison

| Option | Shape | Cost/ops | Notes |
|---|---|---|---|
| **EC2, single Node process** | Node serves SPA + `/mcp`; systemd unit; optional Caddy/nginx for TLS | One t4g.nano/micro; simplest possible | Fine for a team-internal tool; TLS + auth token via reverse proxy |
| **EC2, nginx + Node** | nginx serves `dist/` and `location /mcp { proxy_pass http://127.0.0.1:3000; }` | Same box; standard pattern | nginx gives gzip/caching/TLS for free; note: proxying SSE needs `proxy_buffering off`, but with `enableJsonResponse: true` there is **no SSE to worry about** |
| **Azure App Service (one Node app)** | Express/Hono serving static + `/mcp` in one app | One B1/free-tier plan | Microsoft explicitly documents and samples this shape — App Service remote-MCP samples with auth, and "an Express server on App Service doing double duty: static UI + MCP endpoint" ([App Service MCP scenario](https://learn.microsoft.com/en-us/azure/app-service/scenario-ai-model-context-protocol-server), [remote MCP samples + auth](https://techcommunity.microsoft.com/blog/appsonazureblog/host-remote-mcp-servers-on-app-service-updated-samples-now-with-new-languages-an/4420607), [MCP apps on App Service](https://techcommunity.microsoft.com/blog/appsonazureblog/build-and-host-mcp-apps-on-azure-app-service/4509705)); Easy Auth can gate the endpoint |
| **Azure Functions (+ static hosting)** | Static site on Storage/Static Web Apps; MCP on a Function (Node MCP SDK supported directly; stateless streamable-HTTP only, SSE unsupported — fine for us) | Consumption pricing ≈ free at team scale | ([Host MCP SDK servers on Functions](https://learn.microsoft.com/en-us/azure/azure-functions/scenario-host-mcp-server-sdks), [1-step Node hosting](https://developer.microsoft.com/blog/host-your-node-js-mcp-server-on-azure-functions-in-3-simple-steps), [choosing an Azure service for MCP](https://learn.microsoft.com/en-us/azure/container-apps/mcp-choosing-azure-service)) |
| **Edge (Cloudflare/Vercel/Netlify)** | `McpAgent`/`createMcpHandler` (CF), `mcp-handler` (Vercel), Netlify Function (Storybook's own choice) | Free tiers cover team scale; near-zero cold start on CF | Ruled out only by the EC2/Azure constraint; keep as escape hatch since the handler is portable ([CF remote MCP](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/), [hosting comparison](https://mcpplaygroundonline.com/blog/free-mcp-server-hosting-cloudflare-vercel-guide)) |

**Pick:** EC2 nginx+Node or a single Azure App Service app, whichever the team already operates. Both are one artifact, one process, zero external services.

### 6.4 Auth note

For a team-internal server, don't take on MCP's OAuth 2.1 authorization flow initially: a static bearer token checked by the handler/reverse proxy (or Azure Easy Auth / VPN/private networking) is adequate and is what most internal remote-MCP deployments do; full OAuth can be added later without changing tools.

---

## 7. Tool design sketch

Naming: MCP tool names are conventionally `snake_case`, unique, verb_object, unabbreviated; a consistent `action_resource` structure aids client-side filtering ([tool definition guide](https://obot.ai/resources/learning-center/mcp-tools/), [best-practices](https://goclaw.sh/blog/mcp-server-best-practices)). Pagination in MCP is **opaque-cursor based** (`nextCursor`), not page numbers; prefer stateless cursors (encode offset/key into the token) since our server keeps no sessions; always return `has_more` and a `total_count` estimate so the model knows whether to paginate or refine ([MCP pagination spec](https://modelcontextprotocol.io/specification/2025-03-26/server/utilities/pagination), [pagination patterns](https://chatforest.com/guides/mcp-pagination-patterns/), [microsoft/mcp-for-beginners pagination](https://github.com/microsoft/mcp-for-beginners/blob/main/04-PracticalImplementation/pagination/README.md)). **Size discipline:** Claude Code rejects tool results over 25,000 tokens (`MAX_MCP_OUTPUT_TOKENS`), and oversized results silently burn agent context — default every content tool to a few thousand tokens with an explicit `max_tokens`/`detail` parameter, Context7-style ([token-limit war story](https://levelup.gitconnected.com/a-single-mcp-call-returned-278-649-tokens-heres-the-proxy-i-built-to-stop-it-dfaa9b5282e0)).

Proposed surface (6 tools — small enough that agents reliably pick correctly):

| Tool | Params | Returns | Notes |
|---|---|---|---|
| `search_docs` | `query` (req), `repo?`, `kind?` (`file\|function\|subsystem`), `limit=10`, `cursor?` | ranked hits: `{id, kind, repo, path, name, snippet, score}`, `nextCursor`, `has_more`, `total_count` | **Front door.** Description should say: "Call this before writing new code to find existing implementations." |
| `list_repos` | — | `{name, description, subsystems[], doc_commit, doc_generated_at}[]` | Orientation; tiny response; include doc freshness so agents can flag staleness |
| `get_file_doc` | `id` or (`repo`,`path`), `detail?` (`summary\|full`) | purpose, scope, separation-of-concerns notes, exports list, related files | ID comes from `search_docs`/listing — the resolve→get contract |
| `get_function_doc` | `id` or (`repo`,`path`,`function`) | signature, purpose, params/returns, usage notes, "use this instead of reimplementing" pointers | The core reuse tool |
| `get_subsystem_overview` | `subsystem`, `max_tokens=5000` | narrative overview + member files + entry points | Mirrors Context7's `topic` + token budget |
| `list_files` | `repo` (req), `path_prefix?`, `cursor?`, `limit=50` | file paths + one-line purposes | Cheap browse tool; paginated |

Cross-cutting: every content response ends with stable identifiers (`repo`, `path`, `id`) so the agent can chain calls; every tool description states *when to use it and when not to* (per Anthropic's tool-writing guidance: fewer, well-described, high-signal tools beat many granular ones); errors return actionable text ("repo 'foo' not found; available repos: …") rather than bare failures. Consider additionally exposing the manifests as **MCP resources** (`resources/list` over `manifests/*.json`) for clients that prefer resource browsing — free, since the files already exist.

---

## 8. Open questions / follow-ups

1. **Manifest size at scale** — if per-repo `functions.json` gets huge (10k+ functions), shard like Storybook's newer "split manifests" (index + per-item payload files) rather than one blob.
2. **Spec-version churn** — pin the TS SDK and plan a small migration when the 2026-07-28 final lands (10-week SDK validation window announced); stateless design means the migration is mostly SDK-version bumps.
3. **Discovery** — ship `/.well-known/mcp.json` now (static file, SEP-1649 shape); some clients already auto-discover from it.
4. **WebMCP** — revisit once Chrome's WebMCP exits Early Preview if we ever want the doc SPA itself to expose tools to in-browser agents.

---

## 9. Sources

**Storybook (reference model)**
- https://storybook.js.org/docs/ai/mcp/overview — official MCP docs (dev-server addon, toolsets)
- https://github.com/storybookjs/mcp — monorepo: `@storybook/mcp`, `@storybook/addon-mcp`, agent plugins
- https://github.com/storybookjs/mcp/tree/main/packages/mcp — standalone package: manifests in, tmcp streamable-HTTP handler out; tools `list-all-documentation`/`get-documentation`/`get-documentation-for-story`
- https://github.com/storybookjs/mcp/tree/main/apps/self-host-mcp — official self-host example (Node + Netlify Function, same handler)
- https://storybook.js.org/docs/ai/manifests — manifests: `/manifests/components.json`, `/manifests/docs.json`, emitted statically at build
- https://storybook.js.org/addons/@storybook/addon-mcp ; https://www.npmjs.com/package/@storybook/addon-mcp ; https://deepwiki.com/storybookjs/addon-mcp
- https://blog.logrocket.com/storybook-mcp-component-libraries/ ; https://azukiazusa.dev/en/blog/storybook-mcp/ ; https://github.com/storybookjs/ds-mcp-experiment-reshaped/discussions/1

**MCP transports & statelessness**
- https://modelcontextprotocol.io/specification/2025-06-18/basic/transports — Streamable HTTP spec
- https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/ — stateless-first 2026-07-28 RC (final 2026-07-28)
- https://stacktr.ee/blog/mcp-2026-spec-changes ; https://azukiazusa.dev/en/blog/mcp-stateless/
- https://mcpcat.io/guides/building-streamablehttp-mcp-server/ ; https://chatforest.com/guides/mcp-transports-explained/ ; https://medium.com/@shsrams/deep-dive-mcp-servers-with-streamable-http-transport-0232f4bb225e
- https://github.com/mhart/mcp-hono-stateless — minimal stateless Hono example (`sessionIdGenerator: undefined`, `enableJsonResponse: true`)
- https://docs.spring.io/spring-ai/reference/api/mcp/mcp-stateless-server-boot-starter-docs.html ; https://render.com/articles/building-and-hosting-mcp-servers-a-complete-guide

**Static/edge/browser prior art**
- https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/ ; https://developers.cloudflare.com/agents/api-reference/mcp-agent-api
- https://mcpplaygroundonline.com/blog/free-mcp-server-hosting-cloudflare-vercel-guide ; https://hidekazu-konishi.com/entry/mcp_server_aws_lambda_complete_guide.html ; https://ranthebuilder.cloud/blog/building-serverless-mcp-server/
- https://github.com/MiguelsPizza/WebMCP ; https://docs.mcp-b.ai/ ; https://github.com/webmachinelearning/webmcp ; https://developer.chrome.com/docs/ai/webmcp/compare-mcp ; https://zuplo.com/blog/what-is-webmcp ; https://www.arcade.dev/blog/web-mcp-alex-nahas-interview/
- https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1649 ; https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127 ; https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1960 — `.well-known` discovery SEPs

**Docs-MCP survey**
- https://www.mintlify.com/docs/ai/model-context-protocol ; https://www.mintlify.com/blog/generate-mcp-servers-for-your-docs
- https://gitbook.com/docs/ai-and-search/mcp-servers-for-published-docs ; https://gitbook.com/docs/developers/gitbook-api/api-reference/docs-sites/site-mcp-servers ; https://gitbook.com/docs/ai-and-search/llm-ready-docs
- https://context7.mintlify.app/api-reference/context/get-documentation-context ; https://www.trevorlasn.com/blog/context7-mcp — Context7 `resolve-library-id` / `get-library-docs`, 5k-token default
- https://www.mintlify.com/library/best-llms-txt-platforms — llms.txt ecosystem

**Azure hosting**
- https://learn.microsoft.com/en-us/azure/app-service/scenario-ai-model-context-protocol-server
- https://techcommunity.microsoft.com/blog/appsonazureblog/host-remote-mcp-servers-on-app-service-updated-samples-now-with-new-languages-an/4420607
- https://techcommunity.microsoft.com/blog/appsonazureblog/build-and-host-mcp-apps-on-azure-app-service/4509705
- https://learn.microsoft.com/en-us/azure/azure-functions/scenario-host-mcp-server-sdks ; https://developer.microsoft.com/blog/host-your-node-js-mcp-server-on-azure-functions-in-3-simple-steps ; https://learn.microsoft.com/en-us/azure/container-apps/mcp-choosing-azure-service

**Tool design, pagination, limits**
- https://modelcontextprotocol.io/specification/2025-03-26/server/utilities/pagination — cursor-based pagination
- https://chatforest.com/guides/mcp-pagination-patterns/ ; https://github.com/microsoft/mcp-for-beginners/blob/main/04-PracticalImplementation/pagination/README.md
- https://obot.ai/resources/learning-center/mcp-tools/ ; https://goclaw.sh/blog/mcp-server-best-practices
- https://levelup.gitconnected.com/a-single-mcp-call-returned-278-649-tokens-heres-the-proxy-i-built-to-stop-it-dfaa9b5282e0 — 25k-token Claude Code limit (`MAX_MCP_OUTPUT_TOKENS`)
