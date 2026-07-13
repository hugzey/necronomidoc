# Slice 7 — Core docs: overview, conventions, packages, architecture

**Goal:** every documented repo publishes four core documents as a first-class
feature — a project overview, a conventions guide, a third-party packages
guide, and an architecture document with a mermaid/ASCII diagram — resolved
per-document with fixed precedence: **source-repo file > intermediate
(server-side) override > LLM-generated**, over an always-present heuristic
floor. Binding choices in [decision 0015](../decisions/0015-core-docs.md).

## Requirements

- The four documents are generated for every repo; the architecture document
  carries a mermaid or ASCII diagram of the code modules, infrastructure and
  systems.
- A repo provides its own documents via **specific filenames at a specific
  location**: `.necronomidoc/docs/{overview,conventions,packages,architecture}.md`.
- An intermediate override tier lets doc-server admins replace LLM output
  without touching the source repo: `data/enrichment/<slug>/docs/<kind>.md`.
- LLM generation runs through `necronomidoc enrich` (default on,
  `--no-core-docs` opts out) with the established cost model: repo-hash
  caching, shared token budget, staleness flags instead of silent rewrites.
- Core docs are served on all surfaces: site pages, `get_core_doc` MCP tool,
  `search_docs` index, `llms.txt`.

## Work breakdown

### 1. Schema + resolution (docmodel, enrichment)

- `CoreDoc` / `CoreDocsManifest` / `LlmCoreDoc` schemas; `CoreDocProvenance`
  (`repo`/`override`/`llm`/`heuristic`) distinct from overlay provenance.
- `repoContentHash` — whole-repo digest for repo-scoped staleness.
- `buildCoreDocs` resolves each kind independently by precedence;
  `planCoreDocs` + `generateCoreDocs` implement the LLM writer;
  heuristic generators produce the floor (packages table from import data,
  mermaid module diagram from relative-import edges).

### 2. Pipeline + serving (server, mcp, cli)

- `publishModel` builds and publishes `coredocs.json` with the other
  manifests (atomic swap); `enrichRepo` plans/generates/caches LLM docs.
- MCP: manifest load, `get_core_doc` tool, `type: "coredoc"` search rows,
  core docs at the top of `llms.txt`.
- CLI: enrich reporting (`core docs: N written (X curated, Y cached)`),
  `--no-core-docs`.

### 3. Site

- `/r/<slug>/docs/<kind>` tabbed pages with provenance badges; sidebar
  **Core docs** section; mermaid code blocks render as diagrams (lazily
  loaded, falls back to source text on parse errors).

## Acceptance criteria

1. Building any repo publishes all four core docs (heuristic floor at
   minimum); the architecture doc contains a mermaid diagram.
2. A repo shipping `.necronomidoc/docs/<kind>.md` sees that file win over
   overrides, LLM output and heuristics for that kind only.
3. A server-side override beats LLM output and survives rebuilds.
4. `enrich` writes LLM docs only for uncurated kinds; re-running on unchanged
   code makes zero core-doc calls; code changes flag published LLM docs
   `stale: true` until regenerated.
5. `get_core_doc` serves every kind with provenance + staleness;
   `search_docs` surfaces core docs; `llms.txt` leads with them.

**Status: ✅ done.** Covered by `packages/enrichment/src/coredocs.test.ts`,
`packages/mcp/src/tools.test.ts`, and the enrich e2e suite
(`packages/server/src/enrich.e2e.test.ts`) over the sample fixture, which
ships `.necronomidoc/docs/architecture.md` to exercise the repo tier.
