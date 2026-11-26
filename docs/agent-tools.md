# Agent tools — fewer tokens, better changes

The MCP endpoint answers task-shaped questions, not just lookups. An agent
should be able to describe its task once, act on the answer, check its diff
before committing, and leave the docs better than it found them. It should
pay for this in one or two tool calls instead of six.
[Decision 0024](decisions/0024-agent-tooling.md) records the design.

| Tool | Replaces / adds |
|---|---|
| [`get_context_for_task`](#one-call-per-task-get_context_for_task) | search → file → function → subsystem round trips |
| [`detail` on every tool](#detail-levels) | full inventories when one function is needed |
| [`search_docs` `bestAnswer`](#search-ranking-and-bestanswer) | reading a page of hits to pick one |
| [`what_changed_since`](#returning-agents-what_changed_since) | re-reading a repo the agent already knew |
| [`get_recipes`](#how-do-i-recipes-get_recipes) | reverse-engineering conventions from several files |
| [`check_change`](#the-pre-commit-gate-check_change) | guessing which intents, boundaries and tests a diff touches |
| [`is_this_a_duplicate`](#duplicate-guard-is_this_a_duplicate) | writing a helper that already exists |
| [`get_session_checks`](#executable-session-checks-get_session_checks) | inferring whether a session still works |
| [Usage examples](#real-call-sites), [invariants](#invariants-and-gotchas), [trust](#one-trust-score) | carried inside other answers |
| [`propose_overlay` / `propose_product_doc`](#agents-improve-the-docs-proposals) | the same lookups being rediscovered every session |
| [Miss log](#learning-from-misses) | docs that never learn where agents struggle |

Responses are compact JSON, not pretty-printed, because indentation costs
tokens and carries no information.

## One call per task: `get_context_for_task`

```json
{ "task": "add price formatting to CartPage", "repo": "shop", "budget": 1500 }
```

One packed bundle comes back:

- **`symbols`**: the top 3–5 existing symbols, each with signature, one-line
  purpose, [trust](#one-trust-score), [invariants](#invariants-and-gotchas)
  and one [real call site](#real-call-sites).
- **`subsystems`**: the owning subsystem's purpose, `owns`, `doesNotOwn` and
  invariants. Heuristic groupings are labelled as such.
- **`intents`**: sessions and stories bound to those files, with the outcome
  and criterion ids to keep true.
- **`recipes`**: the best-matching ["how do I…" recipe](#how-do-i-recipes-get_recipes).
- **`conventions`**: the sections of the conventions core doc most relevant
  to the task.
- **`tests`**: the test files that import those files.

`budget` is in tokens (default 1500, range 200–8000). Items are ranked by
priority and packed greedily: the top symbol first, then the owning
subsystem, a strong recipe match, the intents, and so on. The conventions
excerpt shrinks to fit. Anything that did not fit is counted in `omitted`, and
`used` reports the estimate (about four characters per token). `next` names
the follow-up worth making, usually `get_function_doc` at `detail=full` for
the one symbol the agent picked.

## Detail levels

Every read tool takes `detail`:

| Level | What you get |
|---|---|
| `brief` | id, name, one-line purpose, signature. Lists page twice as far. |
| `normal` | The default: the established shape, plus `trust` and `invariants`. |
| `full` | Everything: doc comments, props, real call sites, `usedBy`, `testedBy`, longer bodies. |

List at `brief`, then fetch `full` for the one hit you choose.
`get_file_doc` also takes `symbol` to return a single declaration (or
`Class.member`) instead of the whole inventory.

## Search ranking and `bestAnswer`

`search_docs` ranks like a code search, not a prose search:

- filler words are dropped ("how do I", "the", "where does") and curated
  [synonyms](#learning-from-misses) are expanded;
- exported symbols are boosted and exact-name matches doubled (`format
  date` ≡ `formatDate`). Test, fixture, mock and story files are penalised;
- each hit is weighted by how much of the query it covers;
- a file hit is **collapsed** with its symbol hits. The best symbol
  represents the file, the other matching symbols are listed in `matches`, and
  the file's purpose is kept in `fileSummary`.

When the ranking is decisive, the response carries a **`bestAnswer`** with
the signature, purpose, trust, invariants and a real call site, plus
`confidence` and `reason`. Decisive means an exact name match, or a top hit
that covers the query and clearly outscores the runner-up. The agent can
usually stop there. No `bestAnswer` means the hits are ambiguous: refine the
query or inspect the top few at `detail=brief`.

`npm run eval:mcp` scores both: top-k hit rate and `bestAnswer` precision.

## Returning agents: `what_changed_since`

```json
{ "repo": "shop", "since": 12 }          // or "v12", or a commit sha prefix ≥ 4 chars
```

The tool diffs the [version journal's](doc-versions.md) archived state for
that version against the live one and returns only what moved:

- files added, removed or changed, plus doc-only changes;
- symbols added, removed or changed, with `signatureWas`;
- product intents added, removed or changed;
- code-binding state transitions (`ok → changed`, `→ broken`);
- subsystem changes.

Lists are capped. `unchanged: true` means nothing moved. Only the newest ten
versions keep their content: older ones answer with the archived list, so the
agent can diff from the oldest one still kept (a superset of the changes).
`list_repos detail=full` shows the current version and commit.

## "How do I…" recipes: `get_recipes`

At build time the server mines **repeated patterns**: sibling files in one
directory that export the same kind of declaration (three or more, or two
when their names share an affix like `*Page`). Each becomes a recipe:

```json
{
  "title": "Add a page",
  "pattern": "src/pages/*Page.tsx",
  "steps": [
    "Create `src/pages/<Name>Page.tsx` exporting a component shaped like `CartPage` in `src/pages/CartPage.tsx`.",
    "Register it in `src/router.tsx` (it imports 3 of the 3 existing ones).",
    "Add a test alongside the existing ones, e.g. `tests/pages.test.tsx`."
  ],
  "example": { "path": "src/pages/CartPage.tsx", "line": 4, "snippet": "export function CartPage(…) {\n…" },
  "files": ["src/pages/CartPage.tsx", "src/router.tsx", "tests/pages.test.tsx"]
}
```

The example comes from the most typical (median-sized) instance and is at
most five lines. Registration sites are files that import at least half the
instances. Pass `task` to get the best matches only.

Curate recipes in `.necronomidoc/recipes.yaml` (or
`data/enrichment/<slug>/recipes.yaml`). A curated recipe replaces a mined
one with the same `id`:

```yaml
recipes:
  - id: add-an-api-endpoint-src-api
    title: Add an API endpoint
    keywords: [route, handler]
    steps:
      - Add the handler in `src/api/<name>.ts`
      - Declare the operation in `openapi.yaml`
      - Add a contract test under `tests/api/`
    example: { path: src/api/cart.ts, snippet: "export async function checkout() { … }" }
```

## The pre-commit gate: `check_change`

Submit a unified diff (`git diff` output), or `files` / `symbols` when you
have no diff:

```json
{ "repo": "app", "diff": "diff --git a/src/utils/format.ts b/src/utils/format.ts\n…" }
```

The answer:

| Field | What it holds |
|---|---|
| `verdict` | `ok`, or `review` when a boundary is violated or a duplicate is added. |
| `intents` | Sessions and stories bound to the touched files and symbols (hunks are mapped to declarations), with the ids to keep true. |
| `testsToRun` | Tests citing those ids, tests importing the changed files, tests one import hop away, and changed tests, each with `why`. |
| `boundaryViolations` | Added code of a kind the subsystem's `notOwns` excludes (UI/React, persistence, network, filesystem, formatting/business logic), quoting the statement. Also imports into a subsystem the boundary names, and new imports that create a cycle. |
| `boundaryNotes` | New cross-subsystem dependencies the map does not declare. |
| `invariants` | Every invariant of the touched code and its subsystem. |
| `docsToUpdate` | Curated or LLM descriptions of touched symbols, which the change will mark stale. Fix them with `propose_overlay`. |
| `possibleDuplicates` | New exports in the diff that look like existing symbols. |

This turns `find_intents_for_code` into a gate. The tests come from
[test-to-code bindings](#test-to-code-bindings), so "which tests should I
run?" is a lookup, not the whole suite.

## Duplicate guard: `is_this_a_duplicate`

Before writing a new function, send what you are about to write:

```json
{ "name": "formatMoney", "signature": "(amount: number) => string", "purpose": "format money for display" }
```

Candidates come from the search index plus a scan of symbol names. Each is
scored by Dice similarity of its name words (45%), purpose (40%) and
signature tokens (15%), after canonicalisation: light stemming plus synonym
groups such as fetch ≈ load ≈ get and currency ≈ money ≈ price. The scoring
is deterministic and needs no API key or embedding provider.
`verdict` is `likely-duplicate` (≥ 0.65), `possible-overlap` (≥ 0.4), or
`no-duplicate-found`, with `advice`. Each candidate has its signature, trust
and a call site.

## Executable session checks: `get_session_checks`

For each [intent interaction session](product-docs.md#intent-interaction-sessions-ses)
this generates a test skeleton. Each outcome gets one test titled with its id
(`[SES-001.OUT-1] Order placed (fulfilled)`). The test walks the shortest step
path to that outcome, including any branch taken. Each step becomes an action
to drive, each `expects` an assertion to fill, and the outcome criteria the
final checks.

| `entry.channel` | Skeleton |
|---|---|
| `web`, `browser`, `mobile`… | Playwright (`test.fixme`) |
| `mcp`, `agent` | vitest + MCP SDK client calling the tools named in each step's surface |
| `cli` | vitest + `execSync` of the backticked command |
| `api`, `http` | vitest + `fetch` of `METHOD /path` from the step's `system` |

Write the skeletons into a repo with the CLI:

```bash
necronomidoc product checks . --session SES-001     # → tests/product/ses-001.check.spec.ts
```

Skeletons are declared skipped (`test.fixme` / `it.skip`). **Skipped and
pending tests do not count as coverage** in the test scan, so a skeleton never
fakes traceability. Filling it in and dropping `.fixme` / `.skip` is what
makes "does SES-001 still fulfil?" a real, runnable check.

## Real call sites

For each exported symbol the build records one or two **real call sites**:
the files that import it (resolved through the import graph) and the first
line in each that uses it. Calls, JSX and member access are preferred, and
imports, comments and the declaration itself are skipped. They appear as
`usages` in `get_function_doc`, as `usage` in `bestAnswer`, in
`get_context_for_task` symbols and in duplicate candidates. Agents copy a
correct argument shape instead of guessing it.

## Test-to-code bindings

The build's test scan already found product-id citations. Now it also
records which repo files each test file **imports**: relative specifiers,
`@/`/`~/` aliases onto `src/`, and dotted Python modules. `check_change`,
`get_context_for_task` and `get_file_doc detail=full` (`testedBy`) read
these bindings. Pre-extracted IR (`POST /api/ir`) has no working tree, so its
tests are reported as not scanned.

## Invariants and gotchas

Overlays and subsystems take a structured `invariants` list: one-line
constraints to keep true.

```yaml
# .necronomidoc/enrichment/overlays.yaml
- targetId: "app:src/store/cart.ts#CartStore"
  summary: "The one cart state container."
  invariants:
    - Must hold the cart lock while mutating items.
    - Never call from the UI layer — go through useCart().
```

```yaml
# .necronomidoc/subsystems.yaml
  - id: ids
    name: Identity
    invariants:
      - IDs are stable across builds.
```

They are surfaced automatically in every answer that touches the code:
search `bestAnswer`, `get_file_doc`, `get_function_doc`, `get_context_for_task`
and `check_change`. Subsystem invariants are prefixed with the subsystem's
name. Invariants are what agents miss most, and here they cost only one line.

## One trust score

Answers about files and symbols carry `trust: { score, level, why }`:

| Factor | Effect |
|---|---|
| Provenance | human / repo 0.9, override 0.85, llm 0.65, heuristic 0.4 (0.6 when it comes from the code's own doc comment) |
| Stale (code changed since written) | −0.35 |
| A product-doc binding to it is broken / changed | −0.2 / −0.1 |
| Tests import it or cite intents bound to it | +0.1 |

`high` (≥ 0.75): rely on it. `medium`: fine for orientation. `low` (< 0.5):
re-verify against the source.

## Agents improve the docs: proposals

When an admin token is configured, the MCP endpoint adds write-back tools.
Calls to them must carry `Authorization: Bearer <DOCS_TOKEN>`.

- **`propose_overlay`**: a better summary, purpose or scope, or invariants,
  for a file or symbol (by `targetId`, or `path` + `symbol`). Proposed fields
  are merged over the target's current curated ones, so proposing only
  invariants never wipes a human summary. The current content hash is
  stamped, so staleness keeps working.
- **`propose_product_doc`**: a persona, job, story, journey or session as
  markdown with frontmatter. It is linted with the same rules as `product lint`, against
  the published code: schema, cross-references, session graph and bindings.
- **`list_proposals`**: what is pending.

Every proposal is validated at submission. **Errors are returned to the agent
and nothing is stored.** Examples: placeholders like TODO/TBD, empty or
over-long fields, a summary that only restates the name, unknown targets,
dangling product refs. Valid proposals land as **drafts** under
`data/proposals/<slug>/` (never served) until a human reviews them:

```bash
necronomidoc proposals list                       # pending drafts
necronomidoc proposals show P-mabc123-1f2e3d
necronomidoc proposals accept P-mabc123-1f2e3d --note "verified"
necronomidoc proposals reject P-mabc123-9a8b7c --note "wrong: it does retry"
```

…or over REST (`GET /api/proposals`, `POST /api/proposals/<id>/accept|reject`,
admin). Accepting writes the proposal into the server-side curation tier.
Overlays go to `enrichment/<slug>/accepted/`, with `human` provenance because
a person approved them. Product docs go to `enrichment/<slug>/product/…`. The
next build publishes it: the REST accept queues that build for a registered
repo. A product doc the repo itself ships wins over the override, so commit
those into the repo instead. The review output says so. At most 200 drafts
can be pending per repo.

## Learning from misses

Queries that returned nothing useful are appended to
`data/telemetry/mcp-misses.jsonl`. That covers a `search_docs` with no hit
covering at least half the query, a `get_context_for_task` with no matching
code, and a `get_function_doc` lookup that failed. `DOCS_MISS_LOG` sets the
privacy mode:

| Mode | Records |
|---|---|
| `full` (default) | the normalized query text |
| `hashed` | a SHA-256 of it only: repeats still aggregate, no content is kept |
| `off` | nothing |

The misses feed back three ways:

1. **Undocumented concepts.** Each build lists the repo's misses that still
   return nothing in `agent.json` (`undocumented`).
2. **Review.** `necronomidoc misses [--repo <slug>]` (or `GET /api/misses`,
   admin) ranks them by frequency.
3. **Synonyms.** `necronomidoc misses --repo <slug> --suggest` proposes
   `term: [existingName]` pairs, and `--write` merges them into
   `data/enrichment/<slug>/synonyms.yaml`. Synonyms are also curated by hand
   in `.necronomidoc/synonyms.yaml`:

```yaml
currency: [formatMoney, money]
"sign in": [login, authenticate]
```

Search expands those terms, and hits on the expansion count as covering
the original term.

## Where it lives

| Artefact | Path |
|---|---|
| Recipes, call sites, test bindings, synonyms, undocumented concepts | `data/repos/<slug>/agent.json` (published, schema `AgentManifest`) |
| Curated recipes / synonyms | `.necronomidoc/recipes.yaml`, `.necronomidoc/synonyms.yaml`, or the same under `data/enrichment/<slug>/` |
| Proposals (drafts) | `data/proposals/<slug>/<id>.json` (private) |
| Accepted overlays | `data/enrichment/<slug>/accepted/` |
| Miss log | `data/telemetry/mcp-misses.jsonl` (private; rotates at 5 MB) |
