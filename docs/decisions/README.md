# Decision Register

Architectural and directional decisions for the documentation server project. One file per decision, numbered in the order they were made. Format is a lightweight ADR (Architecture Decision Record): context, decision, consequences.

| # | Decision | Status |
|---|----------|--------|
| [0001](0001-git-provider-adapter.md) | Support GitHub, Azure DevOps, and generic REST triggers via a provider adapter pattern | Accepted |
| [0002](0002-hosting-portability.md) | Host-portable single-server design (EC2 / Azure App Service / on-prem / local) | Accepted |
| [0003](0003-central-server-pull-ingestion.md) | Central server pulls repos and runs extraction (vs CI-push) | Accepted |
| [0004](0004-enrichment-layer.md) | Intermediate doc-enrichment layer (human-curated or LLM) between extraction and presentation | Accepted |
| [0005](0005-doc-ui-framework.md) | Doc UI: Fumadocs on React Router 7 + Vite | Accepted |
| [0006](0006-intermediate-representation.md) | Custom versioned JSON IR as the common documentation model | Accepted |
| [0007](0007-extraction-stack-typescript.md) | TypeScript extraction stack for the first vertical slice | Accepted |
| [0008](0008-mcp-serving.md) | MCP: build-time manifests + stateless streamable-HTTP handler | Accepted |
| [0009](0009-project-stack.md) | Project-wide stack: TypeScript; React + Vite + React Router frontend | Accepted |
| [0010](0010-daisyui-component-base.md) | UI components: Tailwind CSS + daisyUI as the site's component base | Accepted |
| [0011](0011-llm-overlay-writer.md) | LLM overlay writer: Anthropic SDK client, per-file batching, content-hash caching, hard budget caps | Accepted, amended by [0016](0016-llm-provider-agnostic.md) |
| [0012](0012-openapi-adapter.md) | OpenAPI adapter: bundled-spec content, native daisyUI reference UI, browser-direct try-it | Accepted |
| [0013](0013-backend-adapters-toolchains.md) | Backend adapters (Python via griffe, C# via DocFX) + opt-in toolchain packaging, `doctor`, `POST /api/ir` | Accepted |
| [0014](0014-auth-baseline.md) | Access control baseline: opt-in shared-token auth — session cookies for browsers, bearer for MCP/API; reverse-proxy SSO as the supported alternative | Accepted |
| [0015](0015-core-docs.md) | Core docs: four per-repo documents (overview, conventions, packages, architecture) with repo > override > llm > heuristic precedence | Accepted |
| [0016](0016-llm-provider-agnostic.md) | Provider-agnostic enrichment: Anthropic / OpenAI-compatible / Bedrock clients + no-API-key agent task export/import | Accepted |
| [0017](0017-skill-generation.md) | Skill generation: LLM-written Agent Skills (SKILL.md) from one/many/all documented repos, hash-cached | Accepted |
| [0018](0018-artefact-generation.md) | Artefact generation: LLM-filled .md/.docx templates — placeholder mode preserves everything outside markers | Accepted |
| [0019](0019-doc-standard.md) | Documentation standard: one written standard + `init-docs` scaffold + advisory doctor checks | Accepted |

## Statuses

- **Proposed** — under discussion, not yet binding
- **Accepted** — binding; implementation should follow it
- **Superseded** — replaced by a later decision (link to it)
