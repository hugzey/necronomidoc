# 0024 — Agent tooling: task-scoped answers, detail levels, change gates and doc write-back

**Status:** Accepted

## Context

The MCP tools (decision 0008) answered lookups well, but an agent at work
asks task-shaped questions. Gathering context for one task took 4–6 calls:
`search_docs`, then `get_file_doc`, then `get_function_doc`, then
`get_subsystem_overview`. Each response was full-size, because
`get_file_doc` returned a whole inventory when one function was needed. The
quality gaps were the same ones every time:

- agents guessed argument shapes;
- they missed one-line constraints;
- they wrote helpers that already existed (JOB-001);
- they could not tell which tests a change needed, or whether an answer was
  still true;
- they re-read whole repos after a few commits;
- the docs never learned from any of it.

## Decision

1. **Task-scoped context.** `get_context_for_task(task, budget)` ranks
   symbols, the owning subsystems, bound intents, a recipe, a conventions
   excerpt and nearby tests. It packs them greedily by priority into a
   **token budget** (about four characters per token) and reports what it
   omitted.
2. **A shared `detail` parameter** (`brief` | `normal` | `full`) on every
   read tool. `normal` keeps the established shapes, so existing clients are
   unaffected. `get_file_doc` gains `symbol` to narrow to one declaration.
   Responses are compact JSON.
3. **Code-aware search.** Filler is stripped, synonyms expanded, exported
   symbols and exact names boosted, and test/fixture files penalised. Hits are
   weighted by query coverage, and each file is collapsed with its matching
   symbols. A **`bestAnswer`** is named only when the ranking is decisive.
   The same ranker powers the task tools.
4. **Change-scoped answers.** `what_changed_since(version | commit)` diffs
   the version journal's per-version archive (decision 0021) against the live
   state. No new storage is needed.
5. **Build-time mining** into a new published manifest, `agent.json`:
   - "how do I…" **recipes** from repeated sibling-file patterns, with a
     ≤ 5-line canonical example, registration sites and steps (curated
     `recipes.yaml` wins on id);
   - **real call sites** per exported symbol, from the import graph;
   - **test-to-code bindings**: the files each test imports, from the same
     single walk that finds id citations;
   - curated **synonyms**;
   - **undocumented concepts** from the miss log.
6. **Gates.** `check_change(diff | files | symbols)` maps hunks to
   declarations and returns:
   - intents with the criteria to keep true;
   - tests to run (citing, importing, one hop away);
   - **boundary violations**: added code whose kind (UI, persistence,
     network, filesystem, formatting logic) matches a `notOwns` statement,
     imports a boundary names, and import cycles;
   - invariants, docs that will go stale, and new exports that duplicate
     existing ones.

   `is_this_a_duplicate` scores existing symbols by name, purpose and
   signature similarity after stemming and synonym canonicalisation. It is
   deterministic and lexical. Embeddings were rejected because they would
   need a provider at query time, against the project's key-optional stance
   (decision 0016).
7. **Invariants** are a structured `invariants: string[]` on overlays,
   attached enrichment and subsystems (additive in schema v1). They are
   surfaced in every answer touching that code.
8. **One trust score** (0–1, `high`/`medium`/`low`). It combines provenance,
   staleness, binding drift and test coverage, next to the existing
   `provenance` and `stale` fields.
9. **Executable session checks.** Skeletons are generated per session
   outcome: Playwright, MCP-client, CLI or HTTP, by entry channel. They are
   declared `fixme`/`skip` and titled with outcome ids. The test scan now
   **ignores skipped/pending declarations**, so a skeleton never counts as
   coverage until it is implemented.
10. **Agent-written docs with verification.** `propose_overlay` and
    `propose_product_doc` exist only when an admin token is configured, and
    require it on the call. Proposals are linted by the same rules as human
    docs; errors are returned and nothing is stored. Valid ones are stored as
    private drafts. A human accepts them (CLI or REST) into the server-side
    curation tier. Accepted overlays carry `human` provenance and publish on
    the next build.
11. **Learning from misses.** Queries with no useful hit are logged
    (`full` / `hashed` / `off`, `DOCS_MISS_LOG`). They feed back as
    undocumented concepts, a `misses` CLI/REST view, and suggested synonyms.
12. **A built-in `using-necronomidoc` skill.** necronomidoc ships one fixed
    Agent Skill that teaches the workflow above. It is available from the
    site's Skills page (copy and download buttons), from
    `/api/agent-skill[/SKILL.md|/download]`, and from
    `necronomidoc skills --builtin`, with the serving instance's MCP URL
    filled in. A test fails if a registered MCP tool is missing from the
    skill. The LLM skill generator's prompt now points generated skills at
    the same tools.

## Consequences

- One call usually replaces four to six. Brief listings and compact JSON cut
  response sizes further, and `bestAnswer` often ends a search in one call.
- `normal` shapes are unchanged apart from added fields (`trust`,
  `invariants`, `usages`, `matches`, `fileSummary`). The `search_docs`
  collapse moves secondary symbols of a file into `matches`, so clients that
  scanned the flat list for a specific symbol should also check `matches`.
  The `mcp-eval` harness does.
- `agent.json` adds a build step whose cost is proportional to the import
  graph. Source reads are bounded per file, and IR-only builds skip what
  needs a working tree.
- `what_changed_since` is the one MCP path that reads disk, bounded by a
  four-entry cache. It reaches back only as far as the archive cap (ten
  versions).
- Boundary checks are heuristics over added lines: they warn, they don't
  block. Their value grows with curated `notOwns` statements.
- The MCP handler is no longer strictly side-effect free. The miss log and
  proposals write to private paths under the data dir, which are never
  served.
- Test files that cite ids from skipped tests lose that coverage. That is
  intended, but it can surface new `untested-*` findings.
