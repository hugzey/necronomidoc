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

**Slice 1 is complete** — point it at a TypeScript/React repo and get a doc site
+ MCP endpoint, triggered manually via CLI or a REST call. See
[docs/plans/01-slice-1-ts-docs-and-mcp.md](docs/plans/01-slice-1-ts-docs-and-mcp.md).

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
```

Full guide: [docs/usage.md](docs/usage.md).

## Packages

| Package | Role |
|---------|------|
| `packages/docmodel` | Versioned file-rooted IR + enrichment/manifest schemas (Zod), stable IDs, hashing |
| `packages/adapter-ts` | TypeScript/React extraction (ts-morph sweep, JSDoc, components, prop tables) |
| `packages/enrichment` | Heuristic purpose producer + overlay loader + precedence merge + staleness |
| `packages/mcp` | Manifest builder + 6 MCP tools over a stateless streamable-HTTP server |
| `packages/server` | Hono server (site + `/data` + `/mcp` + build API) and build orchestration |
| `packages/cli` | `necronomidoc build \| serve \| validate \| export-schemas` |
| `packages/site` | React + Vite + React Router SPA doc site, client-side search |

## Tests

```bash
npm test
```
