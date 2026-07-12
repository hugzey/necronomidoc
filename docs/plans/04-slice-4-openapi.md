# Slice 4 — OpenAPI adapter + interactive API reference

**Goal (requirement 5, OpenAPI leg):** repos containing OpenAPI specs get their REST surface documented in the same site and MCP as code, plus rich interactive reference pages.

## Approach

Per [decision 0006](../decisions/0006-intermediate-representation.md), OpenAPI is *just another adapter*: specs parse into DocModel with `kind: endpoint` symbols rooted at the spec file, so search and MCP treat endpoints like functions. Rich rendering additionally uses the raw spec.

## Work breakdown

### 1. `packages/adapter-openapi` (2–3 days)

- `detect()`: find `openapi.{json,yaml}`/`swagger.*` via config globs + heuristic sniffing (`openapi:`/`swagger:` key).
- Parse + validate + deref with `@readme/openapi-parser` (best error messages; falls back to swagger-parser semantics). Support OpenAPI 3.0/3.1; 2.0 via upconvert or explicit non-support with a clear error (decide during implementation, record in decisions if notable).
- Map to IR: one file entry per spec; symbols per operation (`GET /users/{id}` → id `repo:path/openapi.yaml#get_users__id_`), summary/description/params/responses/tags as facts; tag groups as cross-references.
- Enrichment overlays apply to endpoints exactly like functions (purpose, scope, provenance).

### 2. Site rendering (2–3 days)

- Endpoint pages via `fumadocs-openapi` if it fits the RR7 setup; otherwise embed Scalar (`@scalar/api-reference-react`) for the interactive reference, with our generated per-endpoint pages linking into it.
- "Try it" console: note CORS reality — calls go browser → target API; document that interactive try-it requires the API to allow the docs origin (no proxy in core, keeps hosting static-simple; a config-flag proxy route on the server is a possible later add).

### 3. MCP integration (1 day)

- `search_docs` returns endpoints; `get_function_doc` works for endpoint IDs (alias `get_endpoint_doc` if agent ergonomics demand it); `get_file_doc` on a spec lists its operations grouped by tag.
- Manifests include a compact endpoint index (method, path, one-line purpose) so agents can answer "is there already an endpoint that does X?".

### 4. Mixed-repo support (1 day)

- A repo can run multiple adapters (TS + OpenAPI); merge their DocModels under one repo entry; site nav shows "API Reference" section alongside code docs.

## Acceptance criteria

1. Registering a repo containing an OpenAPI 3.x spec yields browsable, searchable endpoint pages with an interactive reference.
2. MCP `search_docs("create user")` surfaces the relevant endpoint with purpose and location.
3. A repo with both TS code and a spec shows both, cross-searchable, in one repo section.

**Estimated effort:** ~1–1.5 weeks.

## As built

All acceptance criteria met; decisions recorded in
[0012](../decisions/0012-openapi-adapter.md):

- `packages/adapter-openapi` sniffs any `.json`/`.yaml`/`.yml` for an
  `openapi: 3…` key (no filename requirement), validates + bundles with
  `@readme/openapi-parser`, and emits one `endpoint` symbol per operation
  (`repo:path/openapi.yaml#get__users__id_`). Swagger 2.0 and invalid specs
  publish an explanatory page instead of failing the build.
- The DocFile carries the bundled spec as JSON `content`
  (`format: "openapi"`); the site renders it natively with daisyUI (no
  Scalar/fumadocs-openapi — see 0012) as tag-grouped operation cards with
  parameter/schema/response detail and a per-operation "try it" console
  (browser-direct calls; CORS reality noted in the UI). Works in the static
  single-file export. The sidebar gains an "API Reference" section.
- MCP: endpoints surface in `search_docs`, `get_function_doc` accepts
  endpoint ids/names (case-insensitive), `get_file_doc` on a spec returns
  operations grouped by tag, and `llms.txt` doubles as the compact endpoint
  index. No `get_endpoint_doc` alias — `get_function_doc` proved sufficient.
- Mixed repos: the adapter runs alongside TS + markdown; `fixtures/sample-api`
  (TS client + spec + README) covers this in `packages/server/src/build.test.ts`.
