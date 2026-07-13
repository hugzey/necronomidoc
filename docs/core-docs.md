# Core docs — overview, conventions, packages, architecture (slice 7)

Every documented repo publishes four **core documents** (decision
[0015](decisions/0015-core-docs.md)):

| Kind | Answers |
|---|---|
| `overview` | What is this project and what does it do? |
| `conventions` | What style and patterns does the code follow? |
| `packages` | Which third-party packages are used — why, how, and where? |
| `architecture` | How is the system shaped? Includes a **mermaid or ASCII diagram** of the code modules, infrastructure and systems. |

They appear as per-repo **Core docs** pages on the site (with the diagram
rendered), as the `get_core_doc` MCP tool, in `search_docs` results, and at
the top of the repo's `llms.txt`.

## Source precedence (per document)

Each of the four documents resolves independently, highest-precedence source
first:

1. **repo** — a markdown file the source repo ships at the specific location:

   ```
   .necronomidoc/docs/overview.md
   .necronomidoc/docs/conventions.md
   .necronomidoc/docs/packages.md
   .necronomidoc/docs/architecture.md
   ```

   Commit these to make the repo own its docs — they beat everything else on
   every rebuild. The document title is its first `# heading`.

2. **override** — server-side curation at
   `data/enrichment/<slug>/docs/<kind>.md`. Beats LLM output, loses to a repo
   file. Lives outside the atomically swapped repo dir, so rebuilds never
   touch it — use it to fix docs for repos you can't commit to.

3. **llm** — written by `necronomidoc enrich` (see below), cached in
   `data/enrichment/<slug>/coredocs.llm.json`.

4. **heuristic** — the always-present floor, derived from the extracted
   model: layout + file-type overview, observed conventions (test patterns,
   naming, well-known directories), a third-party import table, and a mermaid
   module diagram built from relative-import edges. Each heuristic doc starts
   with a hint telling you exactly how to replace it.

Every surface shows the winning tier as a provenance badge
(`repo` / `override` / `llm` / `heuristic`).

## LLM generation via `necronomidoc enrich`

`enrich` generates core docs **by default** for every kind that has no repo
file and no override — one call per missing document, same client, model
flags and token budget as the overlay writer:

```bash
export ANTHROPIC_API_KEY=sk-ant-…   # or any provider / no key at all —
                                    # see enrichment.md "Choosing a provider"
node packages/cli/dist/index.js enrich <repo-id-or-path-or-url>
#   core docs: 3 written (1 curated, 0 cached)

node packages/cli/dist/index.js enrich <target> --dry-run       # plan only
node packages/cli/dist/index.js enrich <target> --no-core-docs  # opt out
```

Core-doc generation rides along in agent mode too: `enrich --export-tasks`
includes one task per missing document, and `--import-results` publishes
them through the same repo-hash cache.

Cost controls, matching the overlay writer:

- **Repo-hash cache** — each generated doc records the whole-repo content
  hash it was written from. Re-running on unchanged code makes **zero** core
  doc calls.
- **Staleness** — when the code changes, published LLM docs keep serving but
  are flagged `stale: true` ("may be outdated" badge); the next enrich run
  regenerates them. Repo files and overrides are never auto-touched.
- **Token budget** — core doc calls count against `--max-tokens`; a run that
  hit the cap during overlay writing skips core doc generation and picks it
  up next run.

The architecture prompt requires a mermaid diagram in the generated document.

## Promoting an LLM doc

Happy with a generated doc? Copy its content into
`.necronomidoc/docs/<kind>.md` in the source repo (or the server-side
override path) and commit — it becomes curated and the LLM never rewrites it.

## Consuming core docs

- **Site**: `/r/<slug>/docs/<kind>` — tabbed pages, provenance badge, mermaid
  diagrams rendered client-side.
- **MCP**: `get_core_doc(repo, doc)` where `doc` is one of the four kinds —
  the first thing a coding agent should read in an unfamiliar repo.
- **Search**: `search_docs` hits with `type: "coredoc"`.
- **llms.txt**: all four documents (bounded) precede the per-file index.
- **Raw manifest**: `GET /data/repos/<slug>/coredocs.json`.
