# Configuration reference

Configuration is resolved in precedence order: **defaults → `necronomidoc.config.json` (in the working directory) → environment variables → CLI flags**. All persistent state lives in the data dir (decision [0002](../decisions/0002-hosting-portability.md)) — there is no database.

| Env var | Config key | Default | What it does |
|---------|-----------|---------|--------------|
| `DOCS_DATA_DIR` | `dataDir` | `.necronomidoc-data` | Root for **all** state: registry, clones, built manifests, enrichment overlays, build history. Back this up and you have backed up everything ([backup guide](backup-restore.md)). |
| `PORT` | `port` | `4319` | HTTP port for `serve`. |
| `DOCS_TOKEN` | `token` | *(empty)* | The shared access token. Authorizes `POST /api/build` / `POST /api/ir`, unlocks failure detail on `/api/status`, and — when auth is on — is both the browser login password and the `Authorization: Bearer` token for MCP. Empty disables the admin endpoints. Generate with `openssl rand -hex 32`. |
| `DOCS_AUTH_REQUIRED` | `authRequired` | `false` | `1`/`true` makes the **whole** surface team-private: site, `/data`, `/mcp`, and status all require a session cookie (browser login at `/login`) or bearer token. Requires `DOCS_TOKEN`; the server refuses to start without it. See decision [0014](../decisions/0014-auth-baseline.md). |
| `DOCS_SESSION_SECRET` | `sessionSecret` | *(empty)* | HMAC key for session cookies. Falls back to `DOCS_TOKEN`; set it separately if you want to rotate the login token without invalidating sessions (or vice versa). |
| `SITE_DIR` | `siteDir` | `packages/site/dist` | Directory of the built SPA. |
| `DOCS_WEBHOOK_SECRET` | `webhookSecret` | *(empty)* | Shared fallback secret for webhook verification (GitHub HMAC / ADO basic auth). A repo's `secretEnv` takes precedence. |
| `DOCS_DEBOUNCE_MS` | `debounceMs` | `10000` | Debounce window for coalescing rapid pushes into one build. |
| `DOCS_BUILD_CONCURRENCY` | `buildConcurrency` | `1` | Max concurrent builds. |
| `DOCS_BUILD_TIMEOUT_MS` | `buildTimeoutMs` | `600000` | Per-build timeout. |
| `DOCS_LOG_FORMAT` | `logFormat` | `json` | `json` emits one structured line per event (for `docker logs`, journald, log shippers); `text` is human-readable for local dev. |
| `ANTHROPIC_API_KEY` | — | *(empty)* | Enables `necronomidoc enrich` (LLM summaries, slice 3). |
| `NECRONOMIDOC_ENRICH_MODEL` | — | *(see enrichment docs)* | Overrides the enrichment model. |

Per-repo webhook/token env vars (`--secret-env`, `--token-env`, `--api-token-env` on `repo add`) name **which environment variable** holds that repo's secret — the secret itself always comes from the environment, never from files in the data dir (see [ops guide](../ops-ingestion.md)).

## Endpoints an operator should know

| Path | Auth | Purpose |
|------|------|---------|
| `/healthz` (alias `/health`) | always public | Liveness for uptime monitors, Docker `HEALTHCHECK`, load balancers. |
| `/api/status` | public, admin detail with bearer | Build/queue observability — poll it from uptime monitors for deeper checks. |
| `/mcp` | bearer when auth is on | Streamable-HTTP MCP endpoint. |
| `/login`, `/logout` | public | Browser session login (only meaningful with `DOCS_AUTH_REQUIRED=1`). |
| `/hooks/github`, `/hooks/ado` | verified per delivery | Webhook receivers (HMAC / basic auth — independent of `DOCS_AUTH_REQUIRED`). |

## Data-dir versioning

The server stamps the data dir with the DocModel schema version (`meta.json`). A dir written by a **newer** schema than the running binary refuses to serve with an explicit error ("upgrade necronomidoc") instead of misreading it. Upgrading the binary/image on the same data dir is always safe: same-version dirs serve as-is, older dirs are migrated (or explicitly refused) at startup — never silently.
