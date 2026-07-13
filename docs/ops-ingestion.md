# Automated ingestion — rebuild docs on push

How to make repos rebuild their docs automatically on push. Three trigger
paths, all normalizing to the same internal event and the same build queue
(decision [0001](decisions/0001-git-provider-adapter.md)):

| Path | Endpoint | Auth |
|------|----------|------|
| GitHub webhook | `POST /hooks/github` | `X-Hub-Signature-256` HMAC |
| Azure DevOps service hook | `POST /hooks/ado` | Basic auth on the hook URL |
| Generic REST (any CI) | `POST /api/build` | Bearer token (global or per-repo) |

## 1. Register the repo

```bash
necronomidoc repo add https://github.com/acme/widgets.git \
  --id widgets --provider github --branch main \
  --secret-env WIDGETS_HOOK_SECRET \
  --token-env WIDGETS_GIT_PAT        # only for private repos

necronomidoc repo list
necronomidoc repo remove widgets [--purge]   # --purge also drops published docs
```

The registry lives at `<data-dir>/repos.json` and is plain JSON — you can edit
it by hand. Fields:

| Field | Meaning |
|-------|---------|
| `id` | Stable slug (lowercase letters/digits/dashes); doubles as the docs slug and clone dir name |
| `provider` | `github` \| `ado` \| `generic` — which trigger path fires builds |
| `url` | Clone URL (https/ssh) or a local directory path. Register the exact clone URL — a webhook payload that ambiguously matches several registered repos is rejected. ADO SSH URLs (`git@ssh.dev.azure.com:v3/…`) match their https service-hook form automatically |
| `branch` | Tracked branch; pushes to anything else are ignored |
| `secretEnv` | **Env var name** holding the webhook secret / hook credential |
| `tokenEnv` | **Env var name** holding the git PAT used to clone/fetch |
| `apiTokenEnv` | **Env var name** holding a REST token scoped to this repo |
| `enabled` | `false` keeps serving docs but accepts no triggers |

**Credential convention: the registry stores env var *names*, never secrets.**
Set the actual values in the server's environment (systemd unit, container
env, App Service settings). Secrets never appear in `repos.json`, logs, or
status output; git credentials are injected into the clone URL at exec time
only and scrubbed from error text.

## 2. GitHub webhook

1. Generate a secret: `openssl rand -hex 32`; export it on the server as the
   var named in `secretEnv` (e.g. `WIDGETS_HOOK_SECRET`). Repos may share one
   secret via `DOCS_WEBHOOK_SECRET` instead — a per-repo `secretEnv` wins.
2. In the GitHub repo: **Settings → Webhooks → Add webhook**
   - Payload URL: `https://<your-server>/hooks/github`
   - Content type: `application/json`
   - Secret: the value from step 1
   - Events: *Just the push event*
3. Save — GitHub sends a `ping`, which the server answers (202, `ignored:
   "ping"`) once the signature verifies.
4. For private repos, create a PAT with read-only repo contents scope and
   export it as the var named in `tokenEnv`.

Push to the tracked branch → the server verifies the HMAC over the raw body
(constant-time), queues a build, and answers 202 immediately. Forged or
unsigned deliveries get 401 and a `[ingest] rejected …` log line.

## 3. Azure DevOps service hook

1. Export the hook credential on the server (var named in `secretEnv`). Use a
   `user:password` pair or a single password string.
2. In ADO: **Project settings → Service hooks → Create subscription → Web Hooks**
   - Trigger: *Code pushed*, filtered to your repo + branch
   - URL: `https://<your-server>/hooks/ado`
   - Basic auth username/password: the credential from step 1
3. ADO has no payload signing — the basic-auth credential on the URL is its
   supported mechanism, so always run this behind HTTPS. Consider also
   restricting inbound IPs to Azure ranges at your proxy.
4. For private repos set `tokenEnv` to a var holding an ADO PAT (Code → Read).

## 4. Generic REST (GitLab, Jenkins, any CI)

Trigger a registered repo by id — this is the documented CI-integration path:

```bash
curl -X POST https://<your-server>/api/build \
  -H 'authorization: Bearer $TOKEN' -H 'content-type: application/json' \
  -d '{"repoId":"widgets"}'          # → 202, work happens on the queue
```

`$TOKEN` is either the global admin token (`DOCS_TOKEN`) or a per-repo token
(the value of the var named in that repo's `apiTokenEnv` — scoped to that repo
only). Builds always target the repo's tracked branch. The ad-hoc form
`{"path":…}` / `{"repoUrl":…}` also works and requires the global token.

## 4b. Pre-extracted IR from CI — `POST /api/ir`

For repos in languages the server doesn't bundle a toolchain for (or repos
that can't build on the server), CI extracts the docs itself and posts a
complete, schema-valid DocModel:

```bash
curl -X POST https://<your-server>/api/ir \
  -H 'authorization: Bearer $TOKEN' -H 'content-type: application/json' \
  --data @docmodel.json               # → 200 with the published registry entry
```

- The body must validate against the DocModel JSON Schema
  (`necronomidoc export-schemas`); rejects list the first validation issues.
- Repo identity comes from `repo.slug` in the body (must be slug-form). If a
  registered repo has that id, its `apiTokenEnv` token is accepted; otherwise
  the global token is required.
- Publication is identical to an adapter build downstream of extraction:
  server-side enrichment overlays merge, atomic per-repo swap, registry +
  search + `llms.txt` + MCP, and a `trigger: "external-ir"` record in
  `status.json`. Payloads over 64 MB are rejected.

Toolchain health for the bundled backend adapters (Python needs
python3 + griffe, C# needs the .NET SDK + docfx) is reported by
`necronomidoc doctor`; a build needing a missing toolchain fails that repo's
build with the fix in its status message and keeps serving the last good docs.

## 5. Queue behavior

- **Debounce:** rapid pushes coalesce; a trigger for an already-queued repo
  just updates its target sha and restarts the window (`DOCS_DEBOUNCE_MS`,
  default 10s).
- **Serialization:** one repo never builds twice at once; global cap
  `DOCS_BUILD_CONCURRENCY` (default 1).
- **Durability:** accepted triggers are journaled to `<data-dir>/queue.json`;
  a restart mid-queue picks up where it left off.
- **Failures:** a failing build never unpublishes — the repo keeps serving its
  last good docs. The failure (message + log tail) lands in
  `<data-dir>/status.json`, capped at 20 records per repo. Builds exceeding
  `DOCS_BUILD_TIMEOUT_MS` (default 10 min) are recorded as failed.
- **Clones:** persistent shallow clones live under `<data-dir>/clones/<id>`
  (fetch `--depth 1` + hard reset per build). `repo remove` deletes the clone.

## 6. Status

- `GET /api/status` — per repo: last build (sha, time, duration, result),
  queue depth, trigger source. Failure log tails appear only with
  `authorization: Bearer <DOCS_TOKEN>`.
- The doc site has a matching **Build status** page (link at the bottom of the
  sidebar, `/status`), which polls the same JSON.
- `GET /data/*` serves **only** the published manifests (`registry.json` and
  `repos/**`). Clones, build logs, and queue/registry state live in the same
  data dir but are never served.

## Env var summary

| Var | Purpose | Default |
|-----|---------|---------|
| `DOCS_TOKEN` | Global admin token (REST builds, status detail) | unset (disabled) |
| `DOCS_WEBHOOK_SECRET` | Shared webhook secret fallback | unset |
| `DOCS_DEBOUNCE_MS` | Push-coalescing window | `10000` |
| `DOCS_BUILD_CONCURRENCY` | Max concurrent builds | `1` |
| `DOCS_BUILD_TIMEOUT_MS` | Per-build timeout | `600000` |
| *(per repo)* `secretEnv` / `tokenEnv` / `apiTokenEnv` | Named by the registry | — |
