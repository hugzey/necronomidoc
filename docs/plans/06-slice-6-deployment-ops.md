# Slice 6 — Deployment & ops hardening: Docker, EC2 / Azure / on-prem guides, auth, backups

**Goal (requirement 8 + [decision 0002](../decisions/0002-hosting-portability.md)):** anyone can stand this up in under an hour on a single EC2, a single Azure App Service, or an on-prem/local machine — securely, with backups and updates understood. (Portability is enforced from slice 1; this slice packages and documents it.)

## Work breakdown

### 1. Packaging (2–3 days)

- Multi-stage Dockerfile: build workspaces → slim runtime image (Node LTS); language-toolchain build args from slice 5; image published to GHCR.
- `docker-compose.yml` reference (server + volume for `DOCS_DATA_DIR`).
- Bare-metal path: `npm ci && npm run build && node packages/server` behind a systemd unit example.
- Config reference doc: every env var / config key, defaults, examples.

### 2. Deployment guides (2–3 days, verified by actually deploying)

- **EC2:** t4g.small-class instance, EBS volume for data dir, nginx in front (TLS via certbot) or Caddy for auto-TLS; systemd or Docker; security group notes (443 only).
- **Azure App Service:** container deploy (B1), persistent storage mount for data dir, App Service TLS; note on always-on for webhook receipt.
- **On-prem/local:** Docker or bare Node; reverse-proxy optional; how MCP + webhooks work behind a corporate network (inbound hooks may need the REST/CI path instead — cross-reference slice 2 docs).
- Each guide ends with the same smoke test: register a repo, push, see docs update, connect MCP.

### 3. Authentication & access (3–4 days)

- Decide and record (new decision entry): is the doc site team-private?
  - **Baseline shipped here:** single shared-secret session login OR reverse-proxy/basic-auth guidance, plus bearer tokens for MCP (`Authorization: Bearer` — supported by Claude Code/Cursor MCP clients) and admin API.
  - OIDC/SSO (Entra ID, GitHub OAuth) documented as the follow-on if the team needs it; keep it behind the same middleware seam.
- Secrets hygiene pass: tokens/PATs only via env, redaction in logs, `necronomidoc doctor` warns on default tokens.

### 4. Operability (2 days)

- Structured logs (pino), request logging with hook-source tagging.
- `/healthz` (liveness) + `/api/status` (already exists) documented for uptime monitors.
- Backup/restore: the entire state is `DOCS_DATA_DIR` — document snapshot/restore (EBS snapshot, App Service backup, tar). Registry + enrichment overlays optionally mirrored to a git repo (`necronomidoc export`) for versioned curation.
- Upgrade path: image tag bump; manifests carry `schemaVersion`, server refuses/migrates old data dirs explicitly.

## Acceptance criteria

1. Fresh EC2 and fresh Azure App Service each reach the smoke test in <1 hour following only the guide.
2. Site/MCP/admin all refuse unauthenticated access when auth is enabled; MCP works from Claude Code with a bearer token.
3. Kill the box, restore data dir from backup on a new host → everything serves again with no rebuilds.

**Estimated effort:** ~2 weeks including verification deploys.
