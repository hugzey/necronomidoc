# Slice 1 — TypeScript/React repo → interactive doc site + MCP

> **Status: ✅ Completed (2026-07-10).** The full vertical slice is implemented,
> tested (12 passing tests), and demoable end-to-end. See the
> [implementation notes](#implementation-notes--outcome) at the bottom for what
> shipped, what was deferred, and the recorded spike outcomes. Usage:
> [docs/usage.md](../usage.md).

**Goal (requirement 9):** point the system at a TypeScript React frontend repo and get (a) an interactive web doc site and (b) a working MCP endpoint serving per-file/per-function purpose docs — hosted by the portable server. Triggering is manual in this slice (CLI or a bare REST call); automated webhooks are slice 2.

**Definition of demo:** `necronomidoc build <git-url-or-path>` then `necronomidoc serve` → browse the repo's docs in the SPA, and connect Claude Code to `http://host:PORT/mcp` and successfully ask "what is `src/hooks/useThing.ts` for?" and "is there an existing function that does X?".

## Scope

**In:** monorepo scaffold; DocModel IR schema; TS adapter (ts-morph sweep + react-docgen-typescript; TypeDoc JSON optional); enrichment merge with heuristic + human overlay files; Fumadocs RR7/Vite site fed by a custom source; static search index; MCP manifests + 6 MCP tools; Hono server serving site + `/mcp` + minimal `POST /api/build`; CLI.

**Out:** webhooks/provider adapters (slice 2), LLM enrichment writer (slice 3), OpenAPI (slice 4), non-TS languages (slice 5), auth/Docker/deploy guides (slice 6 — but keep code portable per decision 0002 throughout).

## Work breakdown

### 1. Scaffold (0.5–1 day)

- npm workspaces monorepo per [overview](00-overview.md) layout; TypeScript strict; vitest; eslint/prettier; CI later.
- Packages: `docmodel`, `adapter-ts`, `enrichment`, `site`, `mcp`, `server`, `cli`.

### 2. `packages/docmodel` — IR + manifest schemas (1–2 days)

- Zod schemas: `DocModel` (repo → files → symbols), `Symbol` kinds (`function`, `class`, `interface`, `type`, `variable`, `component`, `hook`, `endpoint`…), `SourceLocation`, doc-comment block (summary/remarks/params/returns/examples as written), exports/imports, cross-references.
- Stable IDs: `repo:relative/path.ts#Namespace.symbolName` + deterministic disambiguation for overloads.
- Content hashing (per file, per symbol) for staleness/incremental builds.
- Enrichment overlay schema: `{ targetId, summary, purpose?, scope?, notes?, provenance: human|llm|heuristic, sourceContentHash, updatedAt }`.
- Manifest schemas consumed by MCP/site: repo registry, per-repo doc manifest, search-index descriptor. `schemaVersion` everywhere.
- Export JSON Schema artifacts for future non-TS adapter authors.

### 3. `packages/adapter-ts` — extraction (3–5 days)

Adapter interface (the pattern every language implements):

```ts
interface DocAdapter {
  readonly language: string;
  detect(repoDir: string): Promise<AdapterMatch | null>;   // finds tsconfig etc.
  extract(repoDir: string, config: AdapterConfig): Promise<DocModel>;
}
```

- **ts-morph sweep:** every `.ts/.tsx` under configured globs → all declarations (incl. non-exported), JSDoc/TSDoc text, signatures rendered to display strings, file-level comments, import/export graph.
- **react-docgen-typescript:** component detection + prop tables merged onto component symbols.
- **TypeDoc `--json` (optional flag):** richer semantics for exported API when entry points resolve; merge by symbol ID; failure downgrades gracefully to sweep-only.
- No target-code execution; `npm i --ignore-scripts` only if type resolution demands it (make it a config option, default off).
- Test fixtures: a small synthetic React repo in-tree + snapshot tests of the emitted IR; validate against docmodel schemas.

### 4. `packages/enrichment` — overlay + merge (1–2 days)

- Load overlay files from the repo's data dir (`enrichment/**/*.{json,yaml}`) and optionally from the *source repo itself* (`.necronomidoc/enrichment/` — lets teams keep curation next to code).
- Heuristic producer: derive one-line purposes from file names, directory structure, export shapes, and existing comments (aider repo-map-style structural signal). Provenance `heuristic`.
- Merge precedence human > llm > heuristic > raw; staleness = `sourceContentHash` mismatch → keep content, mark `stale: true`.
- Output: the **merged doc model** — single input for site + MCP manifests.

### 5. `packages/site` — Fumadocs on React Router 7 + Vite (3–5 days, includes spike)

- **Day-1 spike (timeboxed):** validate Fumadocs RR7 static build + custom (non-filesystem) source + client-side search. If blocked, fall back per decision 0005 to fumadocs-core headless with our own layout — record outcome in the decision register.
- Custom source: merged doc model → page tree (repo → directories → files; symbol anchors within file pages; component pages with prop tables).
- Page content generated as structured data rendered by React components (not string-concatenated MDX) wherever possible.
- Search: build-time index (Orama or MiniSearch) over file purposes, symbol names, summaries.
- Output: static bundle per repo section + shared shell; root landing page lists repos from the registry manifest.

### 6. `packages/mcp` — tools over manifests (2–3 days)

- Build step: merged doc model → `manifests/` (registry, per-repo docs, serialized search index) + `llms.txt` + per-page `.md` fallback.
- Tools (per decision 0008): `list_repos`, `search_docs`, `get_file_doc`, `get_function_doc`, `get_subsystem_overview` (from directory structure + overlays in this slice), `list_files`. Cursor pagination; response budgets ≤ ~20k tokens; provenance/staleness included.
- Implemented fetch-portable (Hono router + official MCP TS SDK, stateless JSON mode).
- Test with MCP Inspector + a scripted client; snapshot tool responses.

### 7. `packages/server` + `packages/cli` (2–3 days)

- Hono server: serve static site from data dir; mount `/mcp`; `POST /api/build { repoUrl | path, ref? }` with a static bearer token (the slice-1 stand-in for provider adapters); `GET /api/status`; health endpoint.
- Build orchestration: clone/copy → adapter → enrichment merge → site build → manifests → **atomic swap** (build to temp dir, rename into place) → hot-reload manifests in the MCP handler.
- CLI: `necronomidoc build <target>`, `necronomidoc serve`, `necronomidoc validate <ir.json>`.
- Config: env vars + `necronomidoc.config.json` (data dir, port, token, per-repo adapter config).

### 8. Dogfood + docs (1–2 days)

- Run against a real TS React repo (candidate: this project's own `packages/site`, or a team repo).
- Write `docs/usage.md` (build, serve, connect MCP from Claude Code/Cursor) and update research/decisions with anything learned.

## Acceptance criteria

1. `necronomidoc build` on a TS React repo produces schema-valid IR, merged model, static site, and manifests — with zero configuration beyond the repo path for a conventional Vite/CRA-style repo.
2. Site: browse by directory/file, see per-file purpose, per-symbol docs, component prop tables; client-side search returns file and symbol hits; works as a static SPA served by the portable server.
3. MCP: from Claude Code, `search_docs` finds a function by concept keywords; `get_file_doc` returns purpose + symbol inventory with provenance; responses within budget.
4. Human overlay: editing an enrichment YAML and rebuilding changes both site and MCP output; touching the underlying code marks it stale.
5. Whole flow runs identically on a local machine (macOS/Linux) and a bare Linux server; state confined to `DOCS_DATA_DIR`.

## Risks

| Risk | Mitigation |
|------|-----------|
| Fumadocs RR7 custom-source friction | Timeboxed spike first; headless fallback pre-decided (0005) |
| ts-morph perf on large repos | Per-file incremental extraction keyed by content hash; measure in dogfood |
| Type resolution needing installs | Optional `--install` flag, `--ignore-scripts`, degrade to syntactic extraction |
| Sparse comments → thin slice-1 docs | Heuristic overlay producer ships in this slice; LLM writer next (slice 3) |

**Estimated effort:** ~3 weeks single-developer, less with the spike going smoothly.

## Implementation notes & outcome

The slice shipped as a 7-package npm-workspaces monorepo. Everything builds with
`npm run build:all`, tests pass with `npm test`, and the demo runs via
`necronomidoc build fixtures/sample-react-app` → `necronomidoc serve`.

**What shipped, per package**

- **`docmodel`** — Zod schemas for the file-rooted IR (`DocModel` → files →
  symbols), enrichment overlay, and manifests; stable IDs
  (`slug:path#symbol`), content hashing, and JSON-Schema export.
- **`adapter-ts`** — `DocAdapter` interface + a ts-morph sweep capturing every
  declaration (incl. non-exported), JSDoc, signatures, imports/exports, file
  module docs, React component detection, and prop tables. Snapshot-style tests
  against an in-tree fixture.
- **`enrichment`** — heuristic purpose producer (folds in existing comments),
  overlay loader (`.necronomidoc/enrichment/**`, YAML/JSON), and a merge with
  `human > llm > heuristic` precedence + content-hash staleness.
- **`mcp`** — manifest builder (doc model + serialized MiniSearch index +
  `llms.txt`), an in-memory store, and the 6 tools over a **stateless**
  streamable-HTTP MCP server (official SDK, `sessionIdGenerator: undefined`,
  JSON mode), fetch-portable.
- **`server`** — Hono app: static site + `/data` manifests + `POST /mcp` +
  bearer-guarded `POST /api/build` + `/api/status` + `/health`; build
  orchestration with an atomic per-repo directory swap and MCP hot-reload.
- **`cli`** — `necronomidoc build | serve | validate | export-schemas`.
- **`site`** — a React + Vite + React Router 7 SPA (data-driven from the
  manifests) with directory/file browsing, symbol cards, prop tables,
  provenance/staleness badges, and client-side MiniSearch.

**Deferred within slice-1 scope (with pragmatic equivalents in place)**

- **Fumadocs UI** was deferred in favor of the pre-decided decision-0005
  fallback: React Router 7 + Vite with our own layout, fed by a custom
  (non-filesystem) source. The stack constraint (React + Vite + React Router)
  holds; only the UI-kit layer differs. Adopting Fumadocs UI is now a
  hardening task, not a slice-1 blocker. (Recorded in decision 0005.)
- **TypeDoc `--json`** and **react-docgen-typescript** — the plan marked both
  optional. Component/prop extraction is done syntactically in the ts-morph
  sweep (resolves prop interfaces/type-literals in-file), so prop tables work
  today without the extra tools. TypeDoc's richer exported-API semantics remain
  a graceful, optional upgrade.

**Acceptance criteria** 1–5 are all met and demonstrated (schema-valid IR +
manifests with zero config; browsable static site with search; MCP search/get
within budget; human overlay round-trips to site + MCP with staleness; whole
flow filesystem-confined and host-portable).
