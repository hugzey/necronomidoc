# Plan Overview — Team Documentation Server ("necronomidoc")

## Vision

A self-hostable documentation server for a team's repos. It pulls source repos when they change, extracts documentation from code (via language adapters over existing doc generators), merges a curated/LLM enrichment layer, and publishes two synchronized outputs from the same doc model:

1. **An interactive web doc site** — a TypeScript React SPA (Vite + React Router 7, Fumadocs UI).
2. **An MCP endpoint** — stateless streamable-HTTP server answering per-file/per-function purpose queries from build-time JSON manifests, so LLM coding agents can understand scope and separation of concerns, find existing code, and avoid duplicating it.

Everything runs as **one portable Node process, filesystem-only state** — deployable on a single EC2, an Azure App Service, an on-prem box, or a laptop.

## Binding decisions

See the [decision register](../decisions/README.md). In brief:

- [0001](../decisions/0001-git-provider-adapter.md) GitHub + ADO + generic REST triggers via provider adapters
- [0002](../decisions/0002-hosting-portability.md) Host-portable single server, filesystem state, no external DB
- [0003](../decisions/0003-central-server-pull-ingestion.md) Central server pulls repos and runs extraction
- [0004](../decisions/0004-enrichment-layer.md) Enrichment overlay layer (human/LLM/heuristic) between extraction and presentation
- [0005](../decisions/0005-doc-ui-framework.md) Fumadocs on React Router 7 + Vite
- [0006](../decisions/0006-intermediate-representation.md) Custom versioned file-rooted JSON IR ("DocModel")
- [0007](../decisions/0007-extraction-stack-typescript.md) TS extraction: ts-morph sweep + TypeDoc JSON + react-docgen-typescript
- [0008](../decisions/0008-mcp-serving.md) MCP = build-time manifests + stateless handler in the main server
- [0009](../decisions/0009-project-stack.md) TypeScript everywhere; React + Vite + React Router frontend

## System architecture (target state)

```
                                triggers
   GitHub webhook ─┐
   ADO service hook ├─► provider adapters ─► normalized event ─► build queue (debounced)
   REST API call ──┘                                                   │
                                                                       ▼
                                                            repo puller (shallow clone)
                                                                       │
                                                                       ▼
                                                        language adapters (per repo config)
                                                        ts │ openapi │ python │ ...
                                                                       │  facts only
                                                                       ▼
                                                          DocModel IR (versioned JSON)
                                                                       │
                                             enrichment overlays ──► merge (human > llm > heuristic)
                                                                       │
                                              ┌────────────────────────┴──────────────────────┐
                                              ▼                                               ▼
                                     site builder (Fumadocs                          MCP manifests + search
                                     RR7/Vite static output)                         index + llms.txt
                                              │                                               │
                                              └───────────────► data dir ◄───────────────────┘
                                                                   │ atomic swap per repo
                                                                   ▼
                                            ┌──────────────────────────────────────────┐
                                            │  portable Node server (Hono)             │
                                            │  • static site        • POST /mcp        │
                                            │  • ingestion API      • health/status    │
                                            └──────────────────────────────────────────┘
```

## Monorepo layout (npm workspaces)

```
packages/
  docmodel/        IR + enrichment + manifest schemas (Zod), stable IDs, hashing
  adapter-ts/      TypeScript/React extraction adapter
  adapter-openapi/ OpenAPI spec adapter (slice 4)
  enrichment/      overlay loading, merge, staleness detection, heuristic producer
  site/            Fumadocs React Router 7 + Vite doc site (builds per-repo static output)
  mcp/             MCP tool implementations over manifests (fetch-portable)
  server/          Hono server: static serving, /mcp, ingestion API, build queue, git providers
  cli/             `necronomidoc` CLI: build a repo locally, validate IR, serve
docs/
  research/  plans/  decisions/
```

## Vertical slices

| Slice | Deliverable | Plan | Status |
|-------|------------|------|--------|
| 1 | **TS/React repo → doc site + MCP, triggered manually (CLI/REST)** — the requirement-9 slice | [01-slice-1-ts-docs-and-mcp.md](01-slice-1-ts-docs-and-mcp.md) | ✅ Done |
| 2 | Automated ingestion: GitHub/ADO/REST triggers, registry, queue, atomic publish | [02-slice-2-automated-ingestion.md](02-slice-2-automated-ingestion.md) | ✅ Done |
| 3 | Enrichment at depth: LLM overlay writer, staleness workflow, subsystem overviews | [03-slice-3-enrichment.md](03-slice-3-enrichment.md) | ✅ Done |
| 4 | OpenAPI adapter + interactive API reference pages | [04-slice-4-openapi.md](04-slice-4-openapi.md) | ✅ Done |
| 5 | Second language adapter (backend) proving the adapter pattern | [05-slice-5-backend-language.md](05-slice-5-backend-language.md) | Planned |
| 6 | Deployment & ops hardening: Docker, EC2/Azure/on-prem guides, auth, backups | [06-slice-6-deployment-ops.md](06-slice-6-deployment-ops.md) | Planned |

Each slice ends deployed and demoable. Slice order after 2 can be re-prioritized; 4/5 are independent of 3.

## Non-goals (for now)

- Horizontal scaling / multi-node; external databases; SaaS multi-tenancy.
- Hand-authored long-form docs CMS (generated + overlay content only; hand-written markdown *pages* can ride along in a repo's `docs/` folder later).
- Doc versioning across historical releases (latest-per-branch only initially).
