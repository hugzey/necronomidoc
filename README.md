# necronomidoc

A self-hostable documentation server for a team's repos. It extracts docs from
code, merges a curated/heuristic enrichment layer, and publishes two
synchronized outputs from one portable Node process (filesystem-only state):

1. an interactive **web doc site** (React + Vite + React Router SPA), and
2. an **MCP endpoint** so coding agents can ask what a file/function is for and
   find existing code instead of duplicating it.

See [docs/plans/00-overview.md](docs/plans/00-overview.md) for the architecture
and roadmap, and the [decision register](docs/decisions/README.md) for the
binding technical choices.

## Status

**Slices 1–4 are complete.**

- Slice 1 — point it at a TypeScript/React repo and get a doc site + MCP
  endpoint ([plan](docs/plans/01-slice-1-ts-docs-and-mcp.md)).
- Slice 2 — automated ingestion: register repos, and pushes rebuild their docs
  via GitHub webhooks, Azure DevOps service hooks, or authenticated REST calls
  — debounced, journaled build queue with atomic publish and a status surface
  ([plan](docs/plans/02-slice-2-automated-ingestion.md),
  [ops guide](docs/ops-ingestion.md)).
- Slice 3 — enrichment at depth: `necronomidoc enrich` writes LLM purpose
  summaries for everything a human hasn't curated (content-hash cached, hard
  budget caps), rebuilds flag stale overlays for review, and curated subsystem
  maps ("owns X / does not own Y") are served by MCP, search, and the site
  ([plan](docs/plans/03-slice-3-enrichment.md),
  [enrichment guide](docs/enrichment.md)).
- Slice 4 — OpenAPI: any OpenAPI 3.x spec in a repo becomes an interactive
  API reference (tag-grouped operations, schemas, a "try it" console) and its
  operations become searchable, enrichable `endpoint` symbols served by MCP —
  in the same repo entry as the code docs
  ([plan](docs/plans/04-slice-4-openapi.md)).

## Quick start

```bash
npm install
npm run build:all

# extract + enrich + build manifests for a repo
node packages/cli/dist/index.js build fixtures/sample-react-app --name sample-react-app

# serve the doc site + MCP endpoint
node packages/cli/dist/index.js serve --port 4319
# → site  http://localhost:4319/
# → MCP   http://localhost:4319/mcp

# or register a repo so pushes rebuild it automatically (slice 2)
node packages/cli/dist/index.js repo add https://github.com/acme/widgets.git \
  --id widgets --provider github --secret-env WIDGETS_HOOK_SECRET

# fill documentation gaps with LLM summaries (slice 3)
ANTHROPIC_API_KEY=sk-ant-… node packages/cli/dist/index.js enrich widgets
```

Full guide: [docs/usage.md](docs/usage.md).

## Packages

| Package | Role |
|---------|------|
| `packages/docmodel` | Versioned file-rooted IR + enrichment/manifest schemas (Zod), stable IDs, hashing |
| `packages/adapter-ts` | TypeScript/React extraction (ts-morph sweep, JSDoc, components, prop tables) |
| `packages/adapter-openapi` | OpenAPI 3.x spec extraction (validate + bundle, one `endpoint` symbol per operation) |
| `packages/enrichment` | Heuristic + LLM purpose producers, overlay loader, precedence merge, staleness reports, subsystem maps |
| `packages/mcp` | Manifest builder + 6 MCP tools over a stateless streamable-HTTP server |
| `packages/server` | Hono server (site + `/data` + `/mcp` + webhooks + build API), provider adapters, journaled build queue |
| `packages/cli` | `necronomidoc build \| enrich \| serve \| repo add\|list\|remove \| validate \| export-schemas` |
| `packages/site` | React + Vite + React Router SPA doc site, client-side search |

## Tests

```bash
npm test
```
