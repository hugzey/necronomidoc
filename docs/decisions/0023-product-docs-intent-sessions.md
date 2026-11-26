# 0023 — Product docs: personas, jobs, intent interaction sessions and stories, verified against code and tests

**Status:** Accepted

## Context

necronomidoc documented *what code is*: files, symbols, subsystems, core docs.
It said nothing about *what the product is for*: who uses it, what they
arrive intending to do, and how that intent should play out. That knowledge
lived in tickets and wikis, disconnected from the code. Nothing noticed when a
refactor broke a user journey, and coding agents had no way to ask which
behaviour a change must preserve.

The practices are mature: personas, jobs-to-be-done, user stories with
Gherkin acceptance criteria, EARS requirements, story maps, journey maps, and
use cases. Spec-driven AI tooling has also converged on markdown specs with
structured acceptance criteria. What was missing was a format that ties these
to the code and the tests, and the one artefact that follows **a single
user's intent end to end through the product**.

## Decision

1. **A standard, file-per-document format in `docs/product/`.** The folder is
   in the repo root (not `.necronomidoc/`) because it is product
   documentation that humans, any agent and other tools should find. Each
   document is markdown with YAML frontmatter: structured, validatable fields
   in the frontmatter (zod schemas, exported as JSON Schema and written to
   `docs/product/schema.json`), and narrative, Gherkin and EARS in the body.
   Ids are typed by prefix (`PER`, `JOB`, `EPIC`, `STORY`, `JRN`, `SES`) and
   compared numerically.
2. **Established notations only.** Job stories for intent, Connextra stories
   sized by INVEST, Gherkin scenarios tagged `@AC-n` as acceptance criteria,
   optional EARS statements `REQ-n`, Patton story maps (generated from story
   fields), journey-map stages with 1–5 emotion (Mermaid `journey`).
3. **The intent interaction session (`SES`) as the core artefact.** One
   persona arrives with one job's intent and is followed from the entry state
   through ordered steps (action, surface, system response, observable
   evidence), branches, and typed outcomes (`fulfilled` / `partial` /
   `diverted` / `abandoned` / `failed`). It fuses Cockburn use cases, Event
   Modeling's user-perspective timeline, Arazzo's step and success-criteria
   shape, and the Screenplay test pattern. The session graph is validated:
   targets must exist, every step must be reachable, and there must be a
   reachable `fulfilled` outcome.
4. **Code bindings with drift detection.** Stories and session steps
   reference code (`path#Symbol`, `path`, `dir/`, a unique bare name, or
   `METHOD /path`). Backticked names and endpoint mentions in step text bind
   automatically when they resolve. A binding is **broken** when its target
   is gone (an error on accepted docs). It is **changed** when the target's
   hash moved since the doc was last edited; the baseline is the previously
   published manifest, so no extra state is needed, and editing the doc or
   its `verified:` field re-baselines.
5. **Traceability by deliberate citation.** Tests cite ids in brackets
   (`[STORY-1.AC-2]`), as tags (`@SES-1.OUT-1`) or in identifier form
   (`test_story_1_ac_2`). Bare mentions in assertions or test data don't
   count, so coverage can't be faked by accident. The build scans test files
   (skipping fixtures) and reports untested criteria, requirements and
   outcomes on `accepted`/`implemented` docs, plus orphan citations.
6. **Surfaces.** OpenAPI operations and screen-like components are listed
   with the sessions that touch them. Uncovered surfaces show intents nobody
   has written down.
7. **Pipeline integration like core docs.** Precedence is repo > server
   override (merged by id) > an LLM-drafted set (used only when nothing is
   curated, cached against the repo hash, `status: proposed`). Outputs are a
   `product.json` manifest (archived per version), site pages (overview with
   an intent map, story map, traceability matrix, per-document pages with
   generated flow, sequence and emotion diagrams, file-page intent chips),
   three MCP tools (`get_product_overview`, `get_product_doc`,
   `find_intents_for_code`), search hits and an `llms.txt` section.
8. **Tooling.** `necronomidoc product init | new | lint | export`. `lint`
   runs the full build-time checks against a working tree and exits non-zero
   on errors (`--strict`: on warnings) for CI. If a language toolchain is
   missing it skips that adapter rather than failing. `enrich --product`
   (live or agent task export/import) drafts a first set.

## Consequences

- Product intent is versioned with the code it describes, and a change that
  breaks a documented journey fails CI instead of surfacing after release.
- Agents gain a pre-change question, "what intents run through this file?",
  answered from bindings, with the outcomes and criteria to keep true.
- The format is plain markdown and YAML in standard notations, so it is
  readable on GitHub without necronomidoc and fillable by any LLM. The JSON
  Schema and templates make agent output checkable.
- Markdown in `docs/product/` is also extracted as ordinary prose. The
  markdown adapter now ignores frontmatter for titles and summaries and skips
  `_templates/`. The site strips frontmatter when rendering any markdown.
- Server-side overlay loading ignores the `product/` override tree and
  `product.llm.json`.
- The test scan reads the working tree, so builds from pre-extracted IR
  report coverage as "not scanned".
- necronomidoc dogfoods the standard in its own `docs/product/`, and its tests
  cite those ids.
