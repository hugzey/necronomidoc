# Usage — doc site + MCP from your repos

necronomidoc points at a TypeScript/React repo and produces (a) an interactive
doc site and (b) an MCP endpoint, both served by one portable Node process with
filesystem-only state.

## Prerequisites

- Node.js ≥ 20 (developed on Node 22)
- `git` on `PATH` (only needed to build from a git URL; local paths don't need it)

## Install & build

```bash
npm install          # install workspace deps
npm run build:all    # compile all packages (tsc) + build the site SPA (vite)
```

`build:all` runs `build` (the TypeScript packages) and `build:site` (the Vite
SPA). You can run them separately.

## Build a repo's docs

```bash
# from a local path…
node packages/cli/dist/index.js build fixtures/sample-react-app --name sample-react-app

# …or from a git URL (shallow-cloned to a temp dir, then discarded)
node packages/cli/dist/index.js build https://github.com/org/repo.git --ref main
```

This runs: **extract** (every adapter that recognizes the repo — the TypeScript
sweep plus the markdown adapter for READMEs/`docs/` prose) → **enrich**
(heuristics + your overlays) → **write manifests** (doc model JSON, search
index, `llms.txt`) with an atomic per-repo swap. Output lands under the data
dir (default `./.necronomidoc-data`).

Markdown files ride along as first-class docs: the repo page renders the root
README, each `.md` gets its own rendered page in the file tree, headings become
searchable `section` entries, and MCP's `get_file_doc` returns the document
body.

Flags: `--name <n>`, `--ref <git-ref>`, `--data-dir <dir>`.

Every build also publishes the repo's four **core docs** — overview,
conventions, packages, architecture (with a mermaid diagram) — resolved by
precedence: a file the repo ships at `.necronomidoc/docs/<kind>.md` > a
server-side override > LLM-generated (via `enrich`) > an always-present
heuristic floor. See [core-docs.md](core-docs.md).

## OpenAPI specs → interactive API reference (slice 4)

Any OpenAPI 3.x spec in the repo (`openapi.yaml`, `api/spec.json`, … — found
by content sniffing, not filename) is documented alongside the code:

- The site's sidebar gains an **API Reference** entry per spec; the page shows
  operations grouped by tag with parameters, request/response schemas, and a
  per-operation **Try it** console. Try-it requests go straight from your
  browser to the target API, so the API must allow the docs origin via CORS.
- Every operation is an `endpoint` symbol: searchable
  (`search_docs("create user")` finds `POST /users`), enrichable with
  overlays, and served by `get_function_doc` (by id or by name, e.g.
  `"GET /users/{id}"` in any casing). `get_file_doc` on the spec lists
  operations grouped by tag, and `llms.txt` carries the compact
  method + path + purpose index.
- A repo can mix TypeScript and specs — both adapters run and publish under
  one repo entry (try `fixtures/sample-api`).

Swagger 2.0 is not supported: the spec's page says so instead of documenting
it (convert to OpenAPI 3.x). A spec-named file (`openapi*`, `swagger*`, …)
that fails validation gets a page showing the validation error; the rest of
the repo's docs still build. Sniff-only candidates that fail validation are
treated as not-specs and skipped.

## Python and C#/.NET repos (slice 5)

Backend repos document exactly like TypeScript ones — `build` just works once
the host has the language's toolchain:

- **Python** (detected via `pyproject.toml`/`setup.py` or `.py` files): needs a
  Python 3.9+ interpreter with `pip install "griffe>=1.0"`. The adapter runs a
  pinned `griffe dump` out of process (static analysis — your code is parsed,
  never imported). Google/numpy/sphinx docstrings become structured
  params/returns/raises docs; `src/` layouts, packages, and flat modules are
  all discovered; private symbols are documented but marked non-exported. Set
  `NECRONOMIDOC_PYTHON=/path/to/venv/bin/python` to isolate the interpreter.
- **C#/.NET** (detected via `.csproj`): needs the .NET SDK 8+ and
  `dotnet tool install -g docfx`. The adapter runs `docfx metadata` (Roslyn)
  against the repo's projects and maps the ManagedReference output — XML doc
  comments (`<summary>`, `<param>`, `<returns>`, `<exception>`, `<example>`)
  become structured docs, grouped per source file with classes/enums keeping
  their members. The repo must restore/compile on the host (NuGet access).
  Set `NECRONOMIDOC_DOCFX` to point at a specific docfx executable.

Check what your host can build with:

```bash
node packages/cli/dist/index.js doctor
#   ✓ typescript — built in, always available
#   ✓ python — Python 3.11.15, griffe 2.1.0 (…)
#   ✗ csharp — missing: docfx (dotnet global tool)
#       fix: Install the .NET SDK 8+ and `dotnet tool install -g docfx` …
```

`doctor` also lists registered repos and flags any whose detected languages
need a toolchain the host is missing (exit code 1). A build that hits a
missing toolchain fails **that repo's** build with the same actionable fix in
its status record — the server keeps running and previously published docs
keep serving.

In Docker, toolchains are opt-in per image:

```bash
docker build -t necronomidoc --build-arg WITH_PYTHON=1 --build-arg WITH_DOTNET=1 .
```

### Languages we don't bundle: publish IR from your own CI

Any repo can extract docs itself (in CI, where its toolchain already lives)
and POST the result — it is served, searched, enriched, and exposed over MCP
exactly like an adapter build:

```bash
# validate against the published JSON Schema first (optional but recommended)
node packages/cli/dist/index.js export-schemas schemas.json

curl -X POST https://docs.example.com/api/ir \
  -H "Authorization: Bearer $DOCS_TOKEN" \
  -H "Content-Type: application/json" \
  --data @docmodel.json
```

The body is a complete DocModel (`schemaVersion: 1`, `repo.slug` must be a
slug, plus `files[]`). Repos registered with `repo add --api-token-env` can use
their per-repo token instead of the global one.

## Serve the site + MCP

```bash
node packages/cli/dist/index.js serve --port 4319
```

- Site: <http://localhost:4319/>
- MCP endpoint: `http://localhost:4319/mcp` (streamable HTTP, stateless)
- Status: <http://localhost:4319/api/status>
- Health: <http://localhost:4319/healthz>

Env vars mirror the flags: `DOCS_DATA_DIR`, `PORT`, `SITE_DIR`, `DOCS_TOKEN` —
full list in the [configuration reference](deploy/configuration.md).

### Team-private mode (slice 6)

```bash
node packages/cli/dist/index.js serve --token "$(openssl rand -hex 32)" --auth
```

With `--auth` (or `DOCS_AUTH_REQUIRED=1`) the whole surface requires the token:
browsers sign in at `/login` and get a session cookie; MCP and API clients send
`Authorization: Bearer <token>`. `/healthz` stays public for uptime monitors.
See [decision 0014](decisions/0014-auth-baseline.md) and the
[deployment guides](deploy/) for TLS, reverse-proxy SSO, and backups.

## Connect the MCP endpoint from Claude Code

```bash
claude mcp add --transport http necronomidoc http://localhost:4319/mcp
# team-private server? add: --header "Authorization: Bearer $DOCS_TOKEN"
```

(Or in Cursor / any MCP client: add an HTTP MCP server at that URL.) Available
tools: `list_repos`, `search_docs`, `get_file_doc`, `get_function_doc`,
`get_core_doc`, `get_subsystem_overview`, `list_files`. Every response carries
provenance and a `stale` flag; `get_core_doc` serves the repo's overview /
conventions / packages / architecture documents (see
[core-docs.md](core-docs.md)), and `get_subsystem_overview` serves curated
boundaries ("owns X / does not own Y") when a subsystem map exists (see
[enrichment.md](enrichment.md)).

Try asking your agent: *"what is `src/hooks/useCounter.ts` for?"*, *"is there
an existing function that formats currency?"*, or *"where does counter state
live and what shouldn't go in it?"*. Measure answer quality with
`npm run eval:mcp`.

## Automatic rebuilds on push (slice 2)

Register the repo, configure a webhook, and pushes rebuild its docs with no
manual step:

```bash
node packages/cli/dist/index.js repo add https://github.com/acme/widgets.git \
  --id widgets --provider github --secret-env WIDGETS_HOOK_SECRET
```

Then point a GitHub webhook at `/hooks/github` (or an Azure DevOps service
hook at `/hooks/ado`, or call `/api/build` with `{"repoId":"widgets"}` from
any CI). Rapid pushes are debounced into one build, accepted triggers survive
restarts (`queue.json`), and a failing build keeps the previous docs serving.
Build results appear on `GET /api/status` and the site's **Build status**
page. Full setup guide: [ops-ingestion.md](ops-ingestion.md).

## Trigger an ad-hoc build over HTTP

Set a token, then POST to `/api/build`:

```bash
DOCS_TOKEN=secret node packages/cli/dist/index.js serve &
curl -X POST localhost:4319/api/build \
  -H 'authorization: Bearer secret' -H 'content-type: application/json' \
  -d '{"path":"fixtures/sample-react-app","name":"sample-react-app"}'
```

The MCP handler hot-reloads the new manifests immediately — no restart.

## Fill the gaps with LLM summaries (slice 3)

On repos with sparse doc comments, let the LLM overlay writer summarize every
file and symbol that no human overlay covers:

```bash
export ANTHROPIC_API_KEY=sk-ant-…   # or any other provider — see below
node packages/cli/dist/index.js enrich fixtures/sample-react-app --dry-run   # preview
node packages/cli/dist/index.js enrich fixtures/sample-react-app             # write + republish
```

The writer is provider-agnostic (decision
[0016](decisions/0016-llm-provider-agnostic.md)): Anthropic, OpenAI,
OpenRouter, Azure AI, Ollama, or any OpenAI-compatible endpoint via API key
(auto-detected, or `--provider` / `--model` / `--base-url`), plus AWS Bedrock
through the standard AWS credential chain. No API key at all? Export the work
as a task file and let a local coding agent do the writing:

```bash
node packages/cli/dist/index.js enrich <target> --export-tasks tasks.json
# have your agent (Claude Code, Codex CLI, …) complete tasks.json → results.json
node packages/cli/dist/index.js enrich <target> --import-results results.json --tasks tasks.json
```

Re-runs are free on unchanged code (content-hash cache), human overlays are
never touched, and `--max-files` / `--max-tokens` cap every run. The same run
generates any [core docs](core-docs.md) the repo hasn't curated
(`--no-core-docs` opts out). Add `--subsystems` to have the model propose a
reviewed subsystem map, and `--review-stale` to list human overlays whose
code has changed. Full guide: [enrichment.md](enrichment.md).

## Add human enrichment overlays

Drop YAML/JSON overlay files in the source repo under
`.necronomidoc/enrichment/`, keyed by the stable DocModel id
(`<slug>:<path>#<symbol>`):

```yaml
- targetId: "sample-react-app:src/hooks/useCounter.ts#useCounter"
  provenance: human
  summary: "Canonical counter hook — use this instead of hand-rolling useState."
  purpose: "App-wide counter state machine."
```

Rebuild and both the site and MCP reflect the change. If the underlying code
changes, the overlay is kept but flagged `stale: true`.

## Validate / export schemas

```bash
node packages/cli/dist/index.js validate .necronomidoc-data/repos/sample-react-app/docmodel.json
node packages/cli/dist/index.js export-schemas docmodel.schema.json   # JSON Schema for non-TS adapters
```

## Deploy it for the team (slice 6)

- [EC2](deploy/ec2.md) · [Azure App Service](deploy/azure-app-service.md) · [on-prem/local](deploy/on-prem.md) — each ends with the same [smoke test](deploy/smoke-test.md).
- [Configuration reference](deploy/configuration.md) — every env var and endpoint.
- [Backup, restore & upgrades](deploy/backup-restore.md) — the data dir is the whole state; `necronomidoc export <dir>` snapshots just the curated parts for git.

## Run the tests

```bash
npm test    # vitest: adapter extraction, enrichment merge, server + MCP endpoint
```
