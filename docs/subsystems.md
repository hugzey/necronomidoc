# Subsystems

A **subsystem** is a named group of a repo's files with a clear job: a purpose,
explicit in/out-of-scope boundaries, entry points, and relationships to the
other subsystems. Together they answer the question a new contributor (or a
coding agent) asks first — *"what are the moving parts here, what does each own,
and how do they fit together?"* — without reading the whole tree.

The published map for a repo is rendered on the site's **Subsystems** page
(`/r/<slug>/subsystems`), served to agents through the `get_subsystem_overview`
MCP tool, indexed by `search_docs`, and folded into `llms.txt`.

## What a subsystem carries

| Field | Meaning |
|---|---|
| `id` | Stable slug, unique in the repo. Used for anchors and `related.to` links. |
| `name` | Display name. |
| `purpose` | One or two sentences: what this subsystem is for. |
| `owns` | **In scope** — responsibilities that belong here. |
| `notOwns` | **Out of scope** — what must *not* go here (and where it lives instead). |
| `entryPoints` | The files/symbols you start reading from. Linked to their file pages. |
| `dirs` | Directory prefixes whose files belong to this subsystem. |
| `related` | Directed relationships to other subsystems (see below). |

Two repo-level fields sit alongside the list:

- **`overview`** — a short narrative ("how it all fits together") shown at the
  top of the page.
- **`diagram`** — a [Mermaid](https://mermaid.js.org/) architecture diagram.
  Generated automatically from the relationships; override it when you want a
  hand-drawn one.

## Relationships and two-way links

A relationship is directed — subsystem A *does something with* subsystem B:

```yaml
related:
  - to: state            # the `id` of another subsystem in THIS repo
    relation: renders state exposed by the hooks subsystem
  - name: Stripe         # a free-text label for something OUTSIDE the repo
    relation: charges cards via the billing webhook
```

- **`to`** points at another subsystem's `id`. This is what makes links
  **bidirectional**: A's card shows a `→ B` link, and B's card automatically
  shows a `← A` "referenced by" backlink. Internal edges are also the ones drawn
  in the architecture diagram.
- **`name`** is a fallback label used only for relationships to things that have
  no `id` — an external SaaS, another repo. These render as plain text and are
  left out of the diagram (there is no node to point at). Maps written before
  `to` existed still work: a bare `name` is treated as an external label.

References are hyperlinked **both ways** across the docs:

- subsystem → subsystem (via `related.to` and the generated `← referenced by`),
- subsystem → file (entry points and the owned-files list link to file pages),
- file → subsystem (every file page shows a `subsystem: …` chip linking back to
  the subsystem that owns it, resolved by the longest matching `dirs` prefix).

## The architecture diagram

Unless you supply your own, the diagram is generated from the `related.to`
graph — one node per subsystem, one arrow per internal relationship, labelled
with the `relation` text. Every repo therefore gets a diagram, even an
uncurated one.

To hand-author it, add a top-level `diagram:` with a Mermaid definition; a
curated diagram always wins over the generated one:

```yaml
diagram: |
  graph TD
    ui["Web UI"] -->|renders| state["State"]
    state -->|reads/writes| store[("Store")]
```

## Curating a map

Create `.necronomidoc/subsystems.yaml` in the repo (this file, when present,
defines the **complete** map — it replaces LLM proposals and the heuristic
floor). Server operators can instead place it at
`data/enrichment/<slug>/subsystems.yaml`, which overrides the in-repo file.

```yaml
# how the subsystems fit into the larger picture (shown atop the page)
overview: >
  The app is a thin UI shell over a shared state layer and pure utilities.
  The UI renders state the hooks own; nothing imports back into the UI.

subsystems:
  - id: ui
    name: UI
    purpose: React components and the app shell — everything the user sees.
    owns: [rendering and layout, component-local presentation state]
    notOwns: [business logic (use utils), shared state machines (use hooks)]
    entryPoints: [src/App.tsx]
    dirs: [src/components]
    related:
      - to: state
        relation: renders state exposed by the hooks subsystem

  - id: state
    name: State hooks
    purpose: Reusable stateful hooks shared across the app.
    owns: [the canonical counter state machine]
    notOwns: [persistence, presentation concerns]
    entryPoints: [src/hooks/useCounter.ts]
    dirs: [src/hooks]
```

`.necronomidoc/subsystems.yml` and `subsystems.json` are accepted too. Invalid
entries are skipped with a warning; the valid ones still publish.

## Letting an LLM propose the map

`enrich --subsystems` asks the model to cluster the repo into subsystems from
each file's purpose summary, its **exported symbols**, and its **imports** — so
the grouping reflects how the code actually depends on itself, not just its
folder layout. It also writes the `overview` narrative and expresses
relationships as `to` links between the subsystems it proposes.

```bash
node packages/cli/dist/index.js enrich <target> --subsystems
```

The proposal lands at `data/enrichment/<slug>/subsystems.llm.json` with
`provenance: llm`. Review it on the site, then **promote** a good one by copying
its contents into a `subsystems.yaml` (which flips provenance to `human` and
freezes it against future runs). No API key? The same task rides the offline
[agent-mode](enrichment.md) flow (`enrich --export-tasks … --subsystems` →
complete locally → `enrich --import-results`).

## The heuristic floor (no curation, no LLM)

When neither a human file nor an LLM proposal exists, necronomidoc still
publishes a map by **clustering the import graph**:

- files are grouped by directory cohesion (monorepo containers such as
  `packages/`, `apps/`, `services/` are recursed one level deeper so each
  package becomes its own subsystem);
- **edges** between groups come from imports that cross a group boundary;
- **entry points** are the files most depended on from *outside* their group
  (the real public surface), falling back to a barrel/`index` file;
- the **diagram** is generated from those edges.

This floor is deliberately generic — it exists so every repo has something on
day one and so agents always get *an* answer. Curate the YAML (or run
`--subsystems`) to replace it with real boundaries.

## Provenance

Every map — and its overview and diagram — is badged `human`, `llm`, or
`heuristic` on the page and returned on the `curated` flag from
`get_subsystem_overview`, so readers always know whether a boundary was written
by a person, proposed by a model, or merely inferred.
