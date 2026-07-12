# Usage — doc site + MCP from your repos

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

This runs: **extract** (every adapter that recognizes the repo — the TypeScript
sweep plus the markdown adapter for READMEs/`docs/` prose) → **enrich**
(heuristics + your overlays) → **write manifests** (doc model JSON, search
index, `llms.txt`) with an atomic per-repo swap. Output lands under the data
dir (default `./.necronomidoc-data`).

Markdown files ride along as first-class docs: the repo page renders the root
README, each `.md` gets its own rendered page in the file tree, headings become
searchable `section` entries, and MCP's `get_file_doc` returns the document
body.

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
(`human` / `llm` / `heuristic`) and a `stale` flag; `get_subsystem_overview`
serves curated boundaries ("owns X / does not own Y") when a subsystem map
exists (see [enrichment.md](enrichment.md)).

Try asking your agent: *"what is `src/hooks/useCounter.ts` for?"*, *"is there
an existing function that formats currency?"*, or *"where does counter state
live and what shouldn't go in it?"*. Measure answer quality with
`npm run eval:mcp`.

## Automatic rebuilds on push (slice 2)

Register the repo, configure a webhook, and pushes rebuild its docs with no
manual step:

```bash
node packages/cli/dist/index.js repo add https://github.com/acme/widgets.git \
  --id widgets --provider github --secret-env WIDGETS_HOOK_SECRET
```

Then point a GitHub webhook at `/hooks/github` (or an Azure DevOps service
hook at `/hooks/ado`, or call `/api/build` with `{"repoId":"widgets"}` from
any CI). Rapid pushes are debounced into one build, accepted triggers survive
restarts (`queue.json`), and a failing build keeps the previous docs serving.
Build results appear on `GET /api/status` and the site's **Build status**
page. Full setup guide: [ops-ingestion.md](ops-ingestion.md).

## Trigger an ad-hoc build over HTTP

Set a token, then POST to `/api/build`:

```bash
DOCS_TOKEN=secret node packages/cli/dist/index.js serve &
curl -X POST localhost:4319/api/build \
  -H 'authorization: Bearer secret' -H 'content-type: application/json' \
  -d '{"path":"fixtures/sample-react-app","name":"sample-react-app"}'
```

The MCP handler hot-reloads the new manifests immediately — no restart.

## Fill the gaps with LLM summaries (slice 3)

On repos with sparse doc comments, let the LLM overlay writer summarize every
file and symbol that no human overlay covers:

```bash
export ANTHROPIC_API_KEY=sk-ant-…
node packages/cli/dist/index.js enrich fixtures/sample-react-app --dry-run   # preview
node packages/cli/dist/index.js enrich fixtures/sample-react-app             # write + republish
```

Re-runs are free on unchanged code (content-hash cache), human overlays are
never touched, and `--max-files` / `--max-tokens` cap every run. Add
`--subsystems` to have the model propose a reviewed subsystem map, and
`--review-stale` to list human overlays whose code has changed. Full guide:
[enrichment.md](enrichment.md).

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
