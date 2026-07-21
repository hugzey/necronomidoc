# 0020 — Subsystem modeling: import-graph clustering, two-way links, generated architecture diagram

**Status:** Accepted

## Context

Slice 3 shipped subsystems as a flat list of directory groups with a purpose
and `owns`/`notOwns` boundaries (decision [0004](0004-enrichment-layer.md)'s
precedence applied to a new manifest). Three gaps limited how well the map
answered *"what are the moving parts and how do they fit together?"*:

1. The heuristic floor was one subsystem per top-level directory — it never
   reflected how the code actually depends on itself, and in a monorepo it
   collapsed every package under `packages`.
2. Relationships were free-text `{ name, relation }` with no link to the
   subsystem they named, so nothing was navigable and no diagram could be drawn
   from them. File pages had no way back to the subsystem that owned them.
3. There was no repo-level narrative and no architecture diagram — the "larger
   picture" lived only in a reader's head.

## Decision

1. **Import-graph clustering as the heuristic floor.** Files are grouped by
   directory cohesion (monorepo containers — `packages`/`apps`/`services`/
   `libs`/`modules`/`plugins`, or any dir with ≥3 populated child dirs — recurse
   one level so each package is its own subsystem). Relationships, entry points,
   and the diagram are then **derived from the resolved import graph**: edges
   from cross-group imports, entry points from highest external in-degree. Every
   uncurated repo gets logical groupings with real edges.
2. **Directed, id-referencing relationships.** `related` entries gain a `to`
   field naming another subsystem's `id`. `to` makes links bidirectional (the
   target renders an inbound "referenced by" edge) and gives the diagram its
   arrows. Free-text `name` is kept as a backward-compatible fallback for
   external relationships (a SaaS, another repo) that have no id. Additive to
   the schema — old maps parse unchanged.
3. **Repo-level overview + generated architecture diagram** on the manifest.
   `overview` is a short narrative shown atop the page; `diagram` is a Mermaid
   definition generated from the relationship graph, overridable by a curated
   top-level `diagram:`. Both follow the same source precedence as the map and
   carry their own provenance.
4. **Two-way hyperlinking end to end.** Subsystem↔subsystem (via `to` +
   inbound edges), subsystem→file (entry points, owned files), and file→
   subsystem (a chip on every file page, resolved by longest matching `dirs`
   prefix). The `get_subsystem_overview` MCP tool returns the overview,
   name-resolved `related`, and `referencedBy` so agents get the same graph.
5. **Smarter LLM proposals.** The proposal prompt feeds each file's summary,
   its **exported symbols**, and its **imports**, and asks for the overview plus
   `to`-linked relationships. Name references the model returns are resolved to
   the generated slug ids so its edges stay internal.

## Consequences

- The heuristic floor is meaningfully more useful and the diagram is always
  present, so the Subsystems page and MCP tool are never empty or shapeless.
- Curation stays the top precedence tier: a `subsystems.yaml` still defines the
  complete map, now including `overview`, `to` links, and an optional `diagram`.
- The LLM proposal file changed from a bare array to `{ subsystems, overview }`.
  The loader reads both forms, so previously written proposals still load.
- Diagram generation and clustering are deterministic and dependency-free (no
  graph library) — they reuse the existing Mermaid renderer already shipped for
  core docs (decision [0015](0015-core-docs.md)).
