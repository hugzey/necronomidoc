# HTTP API reference

Everything the server exposes, in one place. Base URL examples assume
`http://localhost:4319`.

**Auth model** ([decision 0014](decisions/0014-auth-baseline.md)): one shared
token (`DOCS_TOKEN`). Endpoints marked **admin** require
`Authorization: Bearer <DOCS_TOKEN>` and are disabled entirely when no token
is set. With `DOCS_AUTH_REQUIRED=1` the *whole* surface additionally requires
a credential — a browser session (sign in at `/login`) or the bearer token —
except `/healthz`, `/login`, `/logout`, and the webhook receivers (which
verify each delivery themselves).

## Health & status

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /healthz` (alias `/health`) | always public | Liveness: `{"ok":true}`. For uptime monitors, Docker `HEALTHCHECK`, load balancers. |
| `GET /api/status` | public; **admin** unlocks failure log tails | Registered sources, last builds (sha, duration, result), queue depth and items. The site's **Build status** page polls this. |

## Docs, site & MCP

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /` and site routes | public* | The doc-site SPA. `/help` serves this documentation. |
| `ALL /mcp` | public*; bearer when auth is on | Stateless streamable-HTTP MCP endpoint. Tools: `list_repos`, `search_docs`, `get_file_doc`, `get_function_doc`, `get_core_doc`, `get_subsystem_overview`, `list_files`. |
| `GET /data/registry.json` | public* | Which repos are published (name, slug, counts). |
| `GET /data/repos/<slug>/…` | public* | Published manifests: `docmodel.json`, `search.json`, `coredocs.json`, `subsystems.json`, `llms.txt`, `enrichment-report.json`. Nothing else under the data dir is ever served. |

\* "public" means public unless `DOCS_AUTH_REQUIRED=1`, which gates all of
these behind the session/bearer credential.

## Triggering builds

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /hooks/github` | `X-Hub-Signature-256` HMAC per delivery | GitHub push webhook receiver. Answers `202` (accepted/ignored) immediately; the build runs on the queue. |
| `POST /hooks/ado` | Basic auth per delivery | Azure DevOps *code pushed* service hook receiver. |
| `POST /api/build` | bearer: global token, or the repo's own `apiTokenEnv` token | Queue a registered repo: `{"repoId":"widgets"}` → `202`. Builds always target the repo's tracked branch. |
| `POST /api/build` | **admin** | Ad-hoc build of an unregistered target: `{"path":"…"}` or `{"repoUrl":"…"}` plus optional `name`/`ref`. Runs synchronously; returns the published registry entry. |
| `POST /api/ir` | bearer: global token, or the matching repo's `apiTokenEnv` token | Publish pre-extracted docs from your own CI: the body is a complete, schema-valid DocModel (≤ 64 MB). Same enrichment merge and atomic publish as an adapter build. Validate first with `necronomidoc export-schemas`. |

Details and CI recipes: [automated ingestion](ops-ingestion.md).

## Skills

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/skills` | public* | Index of generated skill sets. |
| `GET /api/skills/<id>` | public* | One set's manifest including every `SKILL.md` body. |
| `GET /api/skills/<id>/download` | public* | The set as a zip of skill folders. |
| `POST /api/skills/generate` | **admin** | Generate: `{"all":true}` or `{"repos":["a","b"]}`, optional `"force":true`. Calls the LLM — can take minutes. |

## Artefacts

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/artefacts` | public* | Index of generated artefacts. |
| `GET /api/artefacts/<id>` | public* | One artefact's record (mode, scope, fill counts). |
| `GET /api/artefacts/<id>/output` / `…/template` | public* | Download the filled output or the stored template copy. |
| `POST /api/artefacts/generate` | **admin** | Generate from an uploaded template: `multipart/form-data` with a `template` file (`.md`/`.docx`, ≤ 10 MB) and `repos` (`"all"` or `"a,b"`). |

## Sessions

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /login`, `POST /login` | public | Browser sign-in form (the password is `DOCS_TOKEN`). Only meaningful with `DOCS_AUTH_REQUIRED=1`; otherwise it bounces to `/`. |
| `POST /logout` | public | Clears the session cookie. |

## Examples

```bash
# queue a registered repo from CI
curl -X POST https://docs.example.com/api/build \
  -H "Authorization: Bearer $DOCS_TOKEN" -H "Content-Type: application/json" \
  -d '{"repoId":"widgets"}'

# publish CI-extracted docs for a language the host has no toolchain for
curl -X POST https://docs.example.com/api/ir \
  -H "Authorization: Bearer $DOCS_TOKEN" -H "Content-Type: application/json" \
  --data @docmodel.json

# connect an MCP client (Claude Code shown)
claude mcp add --transport http necronomidoc https://docs.example.com/mcp \
  --header "Authorization: Bearer $DOCS_TOKEN"
```
