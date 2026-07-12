# 0012 — OpenAPI adapter: bundled-spec content + native reference UI

**Status:** Accepted (slice 4)

## Context

Slice 4 documents a repo's REST surface from OpenAPI specs, in the same site
and MCP as code (decision 0006: OpenAPI is just another adapter). Open
questions the plan left to implementation: which parser, how the site gets
the spec for rich rendering, which reference widget, and what to do with
Swagger 2.0 and invalid specs.

## Decision

1. **Parse/validate/bundle with `@readme/openapi-parser`.** It supports
   OpenAPI 3.0 and 3.1, and its validation errors point at the offending
   lines — those messages are published verbatim when a spec is broken.
2. **Publish the `bundle()`d spec, not the `dereference()`d one.** Bundling
   keeps every `$ref` internal (`#/components/...`) so the document stays a
   tree — self-referential schemas (`User.manager: User`) survive
   `JSON.stringify` with no cycle handling. The DocFile carries this JSON in
   `content` (new `format: "openapi"`); both adapter and site resolve internal
   pointers with the same small depth-limited `deref` helper.
3. **Native daisyUI reference UI instead of Scalar / fumadocs-openapi.** The
   site is a hand-rolled daisyUI SPA (decision 0010); embedding Scalar would
   add a second design system and megabytes of bundle, and fumadocs-openapi
   assumes the Fumadocs stack we left. Our renderer covers tag-grouped
   operations, parameters, request/response schemas (depth-limited,
   cycle-safe), and a "try it" console — and keeps working in the static
   single-file export.
4. **"Try it" calls go browser → target API.** No proxy in core (keeps
   hosting static-simple); the UI states that the target must allow the docs
   origin via CORS. A config-flag proxy route on the server remains a
   possible later add.
5. **Swagger 2.0 is explicitly unsupported; broken specs don't break builds.**
   A Swagger 2.0 or invalid spec publishes an explanatory page (the DocFile
   has no symbols/content, `moduleDoc.summary` carries the validation error)
   instead of failing the whole repo build — a mixed repo keeps its code docs.
   The error page is only published when the *filename* announces a spec
   (`openapi*`, `swagger*`, `*api-spec*`); files that merely tripped the
   content sniff (e.g. a `package.json` pinning a dependency named `openapi`
   to 3.x) and then fail validation are quietly dropped, so junk never
   appears as a broken "API Reference" entry.
6. **Endpoint identity is `METHOD path`,** slugged per character
   (`GET /users/{id}` → `…openapi.yaml#get__users__id_`), not `operationId` —
   stable ids that survive operationId renames and absent operationIds.

## Consequences

- Endpoints are ordinary `endpoint` symbols: searchable, enrichable
  (overlays apply, staleness tracked via an operation-content hash), and
  served by the existing MCP tools; `get_file_doc` on a spec additionally
  groups operations by tag.
- Rendering depth is bounded (4 levels of `$ref` indirection, 3 of schema
  nesting), so pathological specs degrade to labels instead of hanging the
  page.
- OpenAPI 3.1 `webhooks` are not yet mapped (paths only) — revisit if a
  consuming team needs them.
