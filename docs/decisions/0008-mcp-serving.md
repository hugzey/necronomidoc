# 0008 — MCP serving: build-time JSON manifests + stateless streamable-HTTP handler in the main server

- **Status:** Accepted
- **Date:** 2026-07-10
- **Decider:** Project (from the MCP static-hosting research)

## Context

Requirement 6: "host the output statically as an MCP, same as the Storybook MCP addon does." Research found that Storybook's model is not literally static: its standalone `@storybook/mcp` package is a **stateless fetch handler that reads build-time JSON manifests** produced by the static build, deployable as a bare Node process or a serverless function. A pure static file host cannot answer MCP's POSTed JSON-RPC; the MCP spec's current direction (streamable HTTP, stateless-first) makes a thin stateless handler the canonical cheap deployment.

## Decision

Adopt the same shape:

- The build pipeline emits, alongside the static site, a set of **MCP manifests**: per-repo doc-model JSON (IR + enrichment merged), a serialized search index (MiniSearch/Orama), a repo registry, and subsystem overviews. Also emit `llms.txt` + per-page markdown as a zero-server fallback for non-MCP agents.
- The main portable server ([0002](0002-hosting-portability.md)) mounts a **stateless streamable-HTTP MCP endpoint** at `POST /mcp` using the official TypeScript SDK (`sessionIdGenerator: undefined`, JSON response mode). No sessions, no DB — every request answered from the manifests on disk (hot-reloaded on rebuild).
- The handler is written fetch-portable (Hono) so the *same* code can later deploy to a serverless/edge function if someone wants site-on-CDN hosting — but the default remains one server.
- Initial tool surface (aligned with docs-MCP conventions — search + get + list, token-budgeted, cursor-paginated):
  - `list_repos` — registry with per-repo summary
  - `search_docs` — search across files/functions/subsystems (repo-filterable)
  - `get_file_doc` — purpose + symbol inventory for a file
  - `get_function_doc` — full doc for one symbol
  - `get_subsystem_overview` — curated/derived subsystem map for scope & separation-of-concerns questions
  - `list_files` — paginated file tree with one-line purposes
- Responses carry provenance/staleness from the enrichment layer ([0004](0004-enrichment-layer.md)) so agents can weigh confidence; responses stay well under common client tool-result caps (~25k tokens).

## Consequences

- MCP adds no infrastructure: same process, same port, same JSON artifacts as the site.
- Statelessness means no server-initiated notifications (fine for docs) and trivially safe restarts/redeploys.
- Tool schemas become a public contract for the team's agents — version them with the manifest schema.
