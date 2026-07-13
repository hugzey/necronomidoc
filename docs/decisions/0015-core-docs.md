# 0015 — Core docs: four per-repo documents with repo > override > llm > heuristic precedence

**Status:** Accepted (slice 7)

## Context

Extraction + per-target enrichment answers "what is this file/function for?",
and subsystem maps answer "where does X live?" — but nothing answers the
first questions a newcomer (human or agent) actually asks: *what is this
project, how is it written, what does it depend on, and how is it shaped?*
Teams want those answers to be a **core feature** of every documented repo,
sourced with an explicit precedence so a repo that writes its own docs always
wins, a doc-server admin can correct a repo that doesn't, and the LLM only
fills what nobody curated.

## Decision

1. **Four fixed document kinds per repo**, published as a manifest
   (`coredocs.json`) next to the doc model:
   - `overview` — the overall summary of the repo;
   - `conventions` — the style and patterns used;
   - `packages` — third-party packages: what, why, how, and where used;
   - `architecture` — high-level layout of code modules, infrastructure and
     systems, **carrying a mermaid or ASCII diagram**.
2. **Per-document source precedence — repo > override > llm > heuristic:**
   - **repo**: a markdown file shipped in the source repo at the specific
     location `.necronomidoc/docs/<kind>.md` (e.g.
     `.necronomidoc/docs/architecture.md`). Fits the existing `.necronomidoc/`
     curation convention (overlays, `subsystems.yaml`).
   - **override**: a server-side markdown file at
     `data/enrichment/<slug>/docs/<kind>.md` — beats LLM output, loses to the
     repo file; survives rebuilds because it lives outside the atomically
     swapped repo dir.
   - **llm**: written by `necronomidoc enrich` (on by default;
     `--no-core-docs` disables), one call per missing document, cached in
     `data/enrichment/<slug>/coredocs.llm.json` against a whole-repo content
     hash — re-running on unchanged code makes zero calls, matching decision
     [0011](0011-llm-overlay-writer.md)'s cost model. Stale LLM docs keep
     serving (flagged `stale: true`) until the next enrich run regenerates
     them. The architecture prompt requires a mermaid diagram.
   - **heuristic**: an always-present floor derived from the extracted model —
     layout/file-type summary, observed conventions, a third-party import
     table, and a mermaid module diagram built from relative-import edges.
   Each of the four documents resolves independently (a repo may ship only
   `architecture.md` and let the LLM write the rest).
3. **Served on every surface:** site pages per repo
   (`/r/<slug>/docs/<kind>`, tabs + provenance badge, mermaid rendered
   client-side via a lazily loaded library), a `get_core_doc` MCP tool,
   `search_docs` indexing (`type: "coredoc"`), and the top of `llms.txt`.
4. **`.necronomidoc/` markdown is not swept as repo content.** Core doc files
   are curation input published through this pipeline; documenting them again
   as ordinary markdown pages would duplicate every doc in the file tree and
   search.

## Consequences

- Every repo answers the four newcomer questions from its first build — the
  floor is heuristic but complete, and each tier of curation upgrades one
  document at a time without touching the others.
- A repo file always beats server-side state, so teams own their docs by
  committing them; admins can still fix repos they don't control via
  overrides that no rebuild wipes.
- Default-on generation adds at most four LLM calls to the first enrich run
  per repo (then zero until the code changes); `--no-core-docs` opts out.
- `CoreDocProvenance` (`repo`/`override`/`llm`/`heuristic`) is a distinct
  enum from overlay provenance (`human`/`llm`/`heuristic`) — the tiers name
  *where the file lives*, not who wrote it, and the two must not be conflated
  in consumers.
- The site takes a `mermaid` dependency, code-split so pages without diagrams
  never load it; a diagram that fails to parse falls back to its source text.
