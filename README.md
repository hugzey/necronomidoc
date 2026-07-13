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

**Slices 1–8 are complete.**

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
- Slice 5 — backend languages: **Python** (via griffe) and **C#/.NET** (via
  DocFX ManagedReference) repos document end-to-end with zero core changes —
  proving the adapter pattern. Toolchains are opt-in per host (Docker
  `--build-arg WITH_PYTHON=1` / `WITH_DOTNET=1`), `necronomidoc doctor`
  diagnoses what a host is missing, missing toolchains fail a repo's build
  with an actionable status (never a crash), and `POST /api/ir` lets any
  language's CI publish pre-extracted docs without a bundled toolchain
  ([plan](docs/plans/05-slice-5-backend-language.md),
  [decision 0013](docs/decisions/0013-backend-adapters-toolchains.md)).
- Slice 6 — deployment & ops: verified guides for
  [EC2](docs/deploy/ec2.md), [Azure App Service](docs/deploy/azure-app-service.md),
  and [on-prem/local](docs/deploy/on-prem.md) (Docker/compose with a
  `HEALTHCHECK`, or bare Node under a hardened systemd unit), opt-in
  **team-private mode** — browser session login + `Authorization: Bearer`
  for MCP/API from one shared token
  ([decision 0014](docs/decisions/0014-auth-baseline.md)) — structured JSON
  request logs with secret redaction, `/healthz` for uptime monitors, a
  schema-versioned data dir with an explicit upgrade guard,
  [backup/restore docs](docs/deploy/backup-restore.md), `necronomidoc export`
  for git-versioned curation backups, and a `doctor` secrets-hygiene pass
  ([plan](docs/plans/06-slice-6-deployment-ops.md),
  [config reference](docs/deploy/configuration.md)).
- Slice 7 — core docs: every repo publishes four core documents — **project
  overview**, **conventions**, **packages/modules/libraries**, and
  **architecture** (with a mermaid diagram) — resolved per document by fixed
  precedence: a file the repo ships (`.necronomidoc/docs/<kind>.md`) > a
  server-side override (`data/enrichment/<slug>/docs/<kind>.md`) > LLM
  generation via `enrich` (repo-hash cached) > an always-present heuristic
  floor. Served as site pages, the `get_core_doc` MCP tool, search results,
  and the top of `llms.txt`
  ([plan](docs/plans/07-core-docs.md), [guide](docs/core-docs.md),
  [decision 0015](docs/decisions/0015-core-docs.md)).
- Slice 8 — skills, artefacts & the doc standard: `necronomidoc skills`
  generates **Agent Skills** (portable `SKILL.md` folders) from one, many, or
  all documented repos — hash-cached, downloadable, browsable on the site
  ([guide](docs/skills.md), [decision 0017](docs/decisions/0017-skill-generation.md));
  `necronomidoc artefact` fills a user-provided **.md/.docx template** from
  repo knowledge — `{{…}}`/`<…>` placeholders replaced with everything
  outside them preserved, marker-free templates planned into sections
  ([guide](docs/artefacts.md), [decision 0018](docs/decisions/0018-artefact-generation.md));
  and a **documentation standard** — conventional, human-complete,
  agent-optimal — with an `init-docs` scaffolder and advisory `doctor`
  checks ([the standard](docs/doc-standard.md),
  [decision 0019](docs/decisions/0019-doc-standard.md)). All three ride the
  provider-agnostic LLM layer, including the no-API-key agent loop
  ([plan](docs/plans/08-slice-8-skills-artefacts-doc-standard.md)).

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

# fill documentation gaps with LLM summaries (slice 3) — any provider:
# Anthropic / OpenAI / OpenRouter / Azure AI / Ollama / AWS Bedrock, or no
# API key at all via a local coding agent (see docs/enrichment.md)
ANTHROPIC_API_KEY=sk-ant-… node packages/cli/dist/index.js enrich widgets

# generate agent skills from everything documented (slice 8)
node packages/cli/dist/index.js skills --all --out ~/.claude/skills

# fill your own template from repo knowledge (slice 8)
node packages/cli/dist/index.js artefact release-notes.md --all --out filled.md

# scaffold the documentation standard into a repo (slice 8)
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
| `packages/adapter-openapi` | OpenAPI 3.x spec extraction (validate + bundle, one `endpoint` symbol per operation) |
| `packages/adapter-python` | Python extraction via pinned `griffe dump` (parsed docstrings, signatures; static analysis, out of process) |
| `packages/adapter-csharp` | C#/.NET extraction via `docfx metadata` ManagedReference YAML (Roslyn-driven, out of process) |
| `packages/enrichment` | Heuristic + LLM purpose producers, overlay loader, precedence merge, staleness reports, subsystem maps |
| `packages/mcp` | Manifest builder + 6 MCP tools over a stateless streamable-HTTP server |
| `packages/server` | Hono server (site + `/data` + `/mcp` + webhooks + build API + auth + structured logs), provider adapters, journaled build queue |
| `packages/cli` | `necronomidoc build \| enrich \| skills \| artefact \| init-docs \| serve \| repo add\|list\|remove \| validate \| export-schemas \| export \| doctor` |
| `packages/site` | React + Vite + React Router SPA doc site, client-side search |

## Tests

```bash
npm test
```
