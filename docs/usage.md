# Usage — Slice 1 (TS/React → doc site + MCP)

necronomidoc points at a TypeScript/React repo and produces (a) an interactive
doc site and (b) an MCP endpoint, both served by one portable Node process with
filesystem-only state.

## Prerequisites

- Node.js ≥ 20 (developed on Node 22)
- `git` on `PATH` (only needed to build from a git URL; local paths don't need it)

## Install & build

```bash
npm install          # install workspace deps
npm run build:all    # compile all packages (tsc) + build the site SPA (vite)
```

`build:all` runs `build` (the TypeScript packages) and `build:site` (the Vite
SPA). You can run them separately.

## Build a repo's docs

```bash
# from a local path…
node packages/cli/dist/index.js build fixtures/sample-react-app --name sample-react-app

# …or from a git URL (shallow-cloned to a temp dir, then discarded)
node packages/cli/dist/index.js build https://github.com/org/repo.git --ref main
```

This runs: **extract** (ts-morph sweep) → **enrich** (heuristics + your overlays)
→ **write manifests** (doc model JSON, search index, `llms.txt`) with an atomic
per-repo swap. Output lands under the data dir (default `./.necronomidoc-data`).

Flags: `--name <n>`, `--ref <git-ref>`, `--data-dir <dir>`.

## Serve the site + MCP

```bash
node packages/cli/dist/index.js serve --port 4319
```

- Site: <http://localhost:4319/>
- MCP endpoint: `http://localhost:4319/mcp` (streamable HTTP, stateless)
- Status: <http://localhost:4319/api/status>
- Health: <http://localhost:4319/health>

Env vars mirror the flags: `DOCS_DATA_DIR`, `PORT`, `SITE_DIR`, `DOCS_TOKEN`.

## Connect the MCP endpoint from Claude Code

```bash
claude mcp add --transport http necronomidoc http://localhost:4319/mcp
```

(Or in Cursor / any MCP client: add an HTTP MCP server at that URL.) Available
tools: `list_repos`, `search_docs`, `get_file_doc`, `get_function_doc`,
`get_subsystem_overview`, `list_files`. Every response carries provenance
(`human` / `llm` / `heuristic`) and a `stale` flag.

Try asking your agent: *"what is `src/hooks/useCounter.ts` for?"* or *"is there
an existing function that formats currency?"*.

## Trigger a build over HTTP (slice-1 stand-in for webhooks)

Set a token, then POST to `/api/build`:

```bash
DOCS_TOKEN=secret node packages/cli/dist/index.js serve &
curl -X POST localhost:4319/api/build \
  -H 'authorization: Bearer secret' -H 'content-type: application/json' \
  -d '{"path":"fixtures/sample-react-app","name":"sample-react-app"}'
```

The MCP handler hot-reloads the new manifests immediately — no restart.

## Add human enrichment overlays

Drop YAML/JSON overlay files in the source repo under
`.necronomidoc/enrichment/`, keyed by the stable DocModel id
(`<slug>:<path>#<symbol>`):

```yaml
- targetId: "sample-react-app:src/hooks/useCounter.ts#useCounter"
  provenance: human
  summary: "Canonical counter hook — use this instead of hand-rolling useState."
  purpose: "App-wide counter state machine."
```

Rebuild and both the site and MCP reflect the change. If the underlying code
changes, the overlay is kept but flagged `stale: true`.

## Validate / export schemas

```bash
node packages/cli/dist/index.js validate .necronomidoc-data/repos/sample-react-app/docmodel.json
node packages/cli/dist/index.js export-schemas docmodel.schema.json   # JSON Schema for non-TS adapters
```

## Run the tests

```bash
npm test    # vitest: adapter extraction, enrichment merge, server + MCP endpoint
```
