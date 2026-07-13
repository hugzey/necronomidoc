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
export ANTHROPIC_API_KEY=sk-ant-…   # or any provider — see "Choosing a provider"

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
| `--model <id>` | provider default | model id as your provider knows it (`NECRONOMIDOC_LLM_MODEL` env var works too) |

## Choosing a provider

The writer talks to a one-method `LlmClient` interface, so any provider slots
in (decision [0016](decisions/0016-llm-provider-agnostic.md)). With exactly
one provider's key in the environment, `enrich` auto-detects it; with several
(or none), pick explicitly with `--provider` / `NECRONOMIDOC_LLM_PROVIDER`.

**API keys are optional.** `enrich` needs *a* model, not *a key*: Ollama and
Bedrock work without one (local server / AWS credential chain), and
[agent mode](#agent-based-enrichment-no-api-key) needs no model access at
all — your coding agent does the writing. `--dry-run`, `--export-tasks`,
`--import-results`, and `--review-stale` never require credentials. Only a
live generation run with nothing configured errors, and that error lists
every option and points here.

| Provider | Select with | Credentials | Notes |
|---|---|---|---|
| Anthropic | auto, or `--provider anthropic` | `ANTHROPIC_API_KEY` | default model `claude-opus-4-8`; JSON schema enforced server-side |
| OpenAI | auto, or `--provider openai` | `OPENAI_API_KEY` | `--model` required |
| OpenRouter | auto, or `--provider openrouter` | `OPENROUTER_API_KEY` | any OpenRouter model id, e.g. `--model openrouter/auto` |
| Azure AI / Azure OpenAI | auto, or `--provider azure` | `AZURE_OPENAI_API_KEY` (or `AZURE_AI_API_KEY`) | needs `--base-url https://<resource>.openai.azure.com/openai/v1` |
| Ollama (local) | `--provider ollama` | none | defaults to `http://localhost:11434/v1`; `--model` required |
| Any OpenAI-compatible endpoint | `--provider openai` + `--base-url` | `NECRONOMIDOC_LLM_API_KEY` if needed | vLLM, LM Studio, LiteLLM, Groq, Together, … |
| AWS Bedrock | `--provider bedrock` (never auto-detected) | AWS credential chain (env vars, profiles, SSO, IAM role) | `--model` is the Bedrock model/inference-profile id, e.g. `us.anthropic.claude-opus-4-8-v1:0`; region from `AWS_REGION` |

Generic env vars work for every provider: `NECRONOMIDOC_LLM_PROVIDER`,
`NECRONOMIDOC_LLM_MODEL` (alias: the older `NECRONOMIDOC_ENRICH_MODEL`),
`NECRONOMIDOC_LLM_BASE_URL`, `NECRONOMIDOC_LLM_API_KEY`.

```bash
# OpenRouter
OPENROUTER_API_KEY=sk-or-… node packages/cli/dist/index.js enrich <target> --model anthropic/claude-opus-4.8

# Azure
AZURE_OPENAI_API_KEY=… node packages/cli/dist/index.js enrich <target> \
  --provider azure --base-url https://myres.openai.azure.com/openai/v1 --model my-deployment

# Bedrock (uses your AWS profile / role)
AWS_REGION=us-east-1 node packages/cli/dist/index.js enrich <target> \
  --provider bedrock --model us.anthropic.claude-opus-4-8-v1:0

# Local Ollama
node packages/cli/dist/index.js enrich <target> --provider ollama --model qwen3
```

Structured output is enforced server-side where the provider supports it
(Anthropic, OpenAI-compatible `response_format`); elsewhere the schema is
embedded in the prompt and zod validation is the backstop — malformed
responses are reported per file and never published.

## Agent-based enrichment (no API key)

If you already pay for a CLI coding agent (Claude Code, Codex CLI, …), it can
write the enrichment data locally — no provider key, no per-token bill. The
plan (and its hash-cache/curation skips) is identical to a live run; only the
transport differs:

```bash
# 1. export every planned prompt to a task file
node packages/cli/dist/index.js enrich <target> --export-tasks tasks.json

# 2. point your agent at it — instructions for the agent are embedded, e.g.:
#      "Complete the enrichment tasks in tasks.json and write results.json
#       as its instructions describe."

# 3. validate + publish the results
node packages/cli/dist/index.js enrich <target> --import-results results.json --tasks tasks.json
```

- The task file carries one task per file (same batched prompt as a live run)
  plus core-doc tasks and — with `--subsystems` — a subsystem-map task.
- The import validates every result against the task it answers (schema,
  echoed symbol ids); bad entries are reported and skipped, never published.
- Overlays are stamped with the content hashes captured at export time, so if
  code changed in between they surface as **stale** through the normal
  staleness workflow and regenerate next run — no special case.
- Re-running `--export-tasks` after an import produces an empty task file:
  the hash cache sees everything as fresh.

### Troubleshooting

**Still seeing `enrich: set ANTHROPIC_API_KEY (or use --dry-run …)`?**
That message only exists in pre-0016 builds — you are running a stale
compiled CLI. Rebuild and re-run:

```bash
npm run build        # or build:all; refreshes packages/*/dist
node packages/cli/dist/index.js enrich <target> …
```

(Also re-run `npm install` first if you just pulled, so new dependencies are
present.) Current builds never demand a specific vendor key: with no provider
configured, a live run prints the full menu of options — keys, keyless
providers, agent mode, dry run — and references this document.

**"Credentials for multiple providers found"** — more than one `*_API_KEY`
is exported. Pick one for this run: `--provider anthropic` (or `openai`,
`openrouter`, `azure`, …), or set `NECRONOMIDOC_LLM_PROVIDER`.

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
