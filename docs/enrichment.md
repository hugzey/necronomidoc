# Enrichment guide — LLM summaries, staleness, subsystems (slice 3)

The enrichment layer (decision [0004](decisions/0004-enrichment-layer.md))
sits between extraction and presentation. Three producers feed it, merged per
target with fixed precedence:

**human > llm > heuristic**

- **human** — overlay files you curate (never auto-touched).
- **llm** — written by `necronomidoc enrich` (this guide).
- **heuristic** — always-present fallback derived from doc comments, names and
  directory structure.

## Run the LLM overlay writer

```bash
export ANTHROPIC_API_KEY=sk-ant-…

# preview: what would be summarized, zero API calls
node packages/cli/dist/index.js enrich fixtures/sample-react-app --dry-run

# the real run: summarize every file/symbol lacking a human overlay
node packages/cli/dist/index.js enrich fixtures/sample-react-app
```

The target can be a **registered repo id** (uses its managed clone), a **local
path**, or a **git URL**. The run:

1. extracts the repo (same adapters as `build`);
2. plans work — a target is summarized only if it has **no human overlay** and
   **no fresh llm overlay** (see caching below);
3. sends one batched prompt per file (file purpose + all its symbols in one
   call, structured JSON out);
4. writes overlays to `data/enrichment/<slug>/llm.json` with
   `provenance: llm` and the target's `sourceContentHash`;
5. generates any [core docs](core-docs.md) the repo hasn't curated
   (repo-hash cached; `--no-core-docs` opts out);
6. republishes the repo's docs — site, MCP and `llms.txt` all update.

Output reports cost: calls made, input/output tokens, overlays written, and
what was skipped.

### Cost controls

| Control | Default | Meaning |
|---|---|---|
| content-hash cache | always on | a target is re-summarized **only when its code hash changes** — re-running on an unchanged repo makes zero calls |
| `--max-files <n>` | 200 | at most n files per run; the rest wait for the next run |
| `--max-tokens <n>` | 400000 | total token budget (input+output); hitting it aborts gracefully, keeping overlays generated so far |
| `--dry-run` | off | plan + report only, no calls, nothing written |
| `--model <id>` | `claude-opus-4-8` | any Anthropic model id (`NECRONOMIDOC_ENRICH_MODEL` env var works too) |

## Staleness workflow

Every rebuild compares each overlay's `sourceContentHash` against the current
code and publishes an **enrichment report**
(`data/repos/<slug>/enrichment-report.json`); coverage + stale counts also
appear on `GET /api/status` and each MCP/site response carries `stale: true`
per target ("may be outdated" badge on the site).

Policy:

- **stale llm overlays** regenerate automatically on the next `enrich` run;
- **stale human overlays are never overwritten** — review them instead:

```bash
node packages/cli/dist/index.js enrich <target> --review-stale
```

This prints each stale human overlay next to the current code (signature and
doc comment now) so re-curation is quick, and lists stale llm overlays that
will self-heal.

## Subsystem overviews

A subsystem is a named group of directories with a purpose, boundary
statements ("owns X / does not own Y"), entry points, and relationships —
exactly what agents need for "where does auth live and what shouldn't go in
it?" questions (`get_subsystem_overview`, indexed by `search_docs`, rendered
on the site's **Subsystems** page).

Sources, highest precedence wins (the winning source defines the whole map):

1. **human** — `.necronomidoc/subsystems.yaml` in the repo (or
   `data/enrichment/<slug>/subsystems.yaml` server-side):

   ```yaml
   subsystems:
     - id: auth
       name: Auth
       purpose: Owns login, sessions and tokens.
       owns: [session issuance, token refresh]
       notOwns: [user profile data — that lives in accounts]
       entryPoints: [src/auth/index.ts]
       dirs: [src/auth]
       related:
         - name: api
           relation: issues the tokens api attaches to requests
   ```

2. **llm** — proposals from `enrich --subsystems`, written to
   `data/enrichment/<slug>/subsystems.llm.json` for review. Promote a good
   proposal by copying it into a `subsystems.yaml`.
3. **heuristic** — one subsystem per top-level directory (the always-present
   floor).

```bash
# ask the model to propose a subsystem map (1 extra call)
node packages/cli/dist/index.js enrich <target> --subsystems
```

## Measuring MCP answer quality

```bash
npm run eval:mcp                       # scores the bundled fixture question set
node scripts/mcp-eval.mjs <repo> my-questions.json   # your repo + questions
```

Each question is `{ "query", "expect", "k" }` — it passes when a `search_docs`
hit whose id contains `expect` ranks in the top `k`. Use it before/after an
enrich run to see what the LLM summaries buy you.
