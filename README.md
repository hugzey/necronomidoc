# necronomidoc

A self-hostable documentation server for a team's repos. It extracts docs from
code, merges a curated/heuristic/LLM enrichment layer, and publishes two
synchronized outputs from one portable Node process (filesystem-only state):

1. an interactive **web doc site** (React + Vite + React Router SPA), and
2. an **MCP endpoint** so coding agents can ask what a file/function is for and
   find existing code instead of duplicating it.

Full documentation lives in [docs/](docs/README.md) — and is served by the
running server itself at `/help`. The
[decision register](docs/decisions/README.md) records the binding technical
choices; [docs/architecture.md](docs/architecture.md) explains the design.

## What it does

- **Documents repos from their code** — TypeScript/React, Python (griffe),
  C#/.NET (docfx), OpenAPI 3.x specs (interactive API reference with a
  "try it" console), and markdown prose, all through one adapter pattern.
  Languages the host has no toolchain for can publish pre-extracted docs from
  their own CI via `POST /api/ir`.
- **Rebuilds automatically on push** — register a repo and GitHub webhooks,
  Azure DevOps service hooks, or REST calls from any CI trigger debounced,
  journaled builds with atomic publish; a failing build never unpublishes.
- **Fills documentation gaps with an LLM** — `necronomidoc enrich` writes
  purpose summaries for everything a human hasn't curated (content-hash
  cached, hard budget caps), flags stale overlays, and proposes subsystem
  maps ("owns X / does not own Y"). Provider-agnostic: Anthropic, OpenAI,
  OpenRouter, Azure AI, Ollama, AWS Bedrock, or **no API key at all** via a
  local coding agent.
- **Publishes four core docs per repo** — overview, conventions, packages,
  architecture (with a diagram) — resolved by precedence: repo-shipped file >
  server-side override > LLM-generated > an always-present heuristic floor.
- **Serves agents, not just browsers** — MCP tools with provenance and
  staleness on every answer, `llms.txt` per repo, generated
  **Agent Skills** (`necronomidoc skills`), and **artefact generation** that
  fills your own `.md`/`.docx` templates from repo knowledge
  (`necronomidoc artefact`).
- **Deploys anywhere, operates simply** — one container or bare Node process;
  opt-in team-private mode (session login + bearer token from one shared
  secret); structured JSON logs; `/healthz`; schema-versioned data dir;
  `necronomidoc doctor` diagnoses toolchains, secrets hygiene, and doc-standard
  compliance.

## Quick start

```bash
npm install
npm run build:all

# extract + enrich + build manifests for a repo
node packages/cli/dist/index.js build fixtures/sample-react-app --name sample-react-app

# serve the doc site + MCP endpoint
node packages/cli/dist/index.js serve --port 4319
# → site  http://localhost:4319/
# → help  http://localhost:4319/help   (this documentation, served)
# → MCP   http://localhost:4319/mcp

# register a repo so pushes rebuild it automatically
node packages/cli/dist/index.js repo add https://github.com/acme/widgets.git \
  --id widgets --provider github --secret-env WIDGETS_HOOK_SECRET

# fill documentation gaps with LLM summaries (any provider, or no key at all)
ANTHROPIC_API_KEY=sk-ant-… node packages/cli/dist/index.js enrich widgets

# generate agent skills / fill a template from everything documented
node packages/cli/dist/index.js skills --all --out ~/.claude/skills
node packages/cli/dist/index.js artefact release-notes.md --all --out filled.md

# scaffold the documentation standard into a repo
node packages/cli/dist/index.js init-docs ../widgets
```

Full guide: [docs/usage.md](docs/usage.md).

## Deploy it for the team

```bash
# one container, one volume — all state in /data
DOCS_TOKEN=$(openssl rand -hex 32) DOCS_AUTH_REQUIRED=1 docker compose up -d --build
```

Guides that end in the same smoke test (register a repo → push → docs update →
MCP connects): [EC2](docs/deploy/ec2.md) ·
[Azure App Service](docs/deploy/azure-app-service.md) ·
[on-prem/local](docs/deploy/on-prem.md). Plus the
[configuration reference](docs/deploy/configuration.md) and
[backup/restore & upgrades](docs/deploy/backup-restore.md).

## Packages

| Package | Role |
|---------|------|
| `packages/docmodel` | Versioned file-rooted IR + enrichment/manifest schemas (Zod), stable IDs, hashing |
| `packages/adapter-ts` | TypeScript/React extraction (ts-morph sweep, JSDoc, components, prop tables) |
| `packages/adapter-markdown` | Markdown prose extraction (READMEs, docs pages, heading sections) |
| `packages/adapter-openapi` | OpenAPI 3.x spec extraction (validate + bundle, one `endpoint` symbol per operation) |
| `packages/adapter-python` | Python extraction via pinned `griffe dump` (parsed docstrings, signatures; static analysis, out of process) |
| `packages/adapter-csharp` | C#/.NET extraction via `docfx metadata` ManagedReference YAML (Roslyn-driven, out of process) |
| `packages/enrichment` | Heuristic + LLM purpose producers, overlay loader, precedence merge, staleness reports, subsystem maps |
| `packages/mcp` | Manifest builder + MCP tools over a stateless streamable-HTTP server |
| `packages/server` | Hono server (site + `/data` + `/mcp` + webhooks + build API + auth + structured logs), provider adapters, journaled build queue |
| `packages/cli` | `necronomidoc build \| enrich \| skills \| artefact \| init-docs \| serve \| repo add\|list\|remove \| validate \| export-schemas \| export \| doctor` |
| `packages/site` | React + Vite + React Router SPA doc site, client-side search, the served `/help` documentation |

## Tests

```bash
npm test
```
