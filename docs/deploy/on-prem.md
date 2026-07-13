# Deploying on-prem or locally

Target: a box on the corporate network (or a laptop) serving docs + MCP to the team. Budget ~15–30 minutes — no cloud plumbing.

## 1. Run the server

**Docker:**

```bash
git clone https://github.com/<org>/necronomidoc.git && cd necronomidoc
export DOCS_TOKEN=$(openssl rand -hex 32)
export DOCS_AUTH_REQUIRED=1        # or leave off on a trusted network
docker compose up -d --build
```

**Bare Node (no Docker):** install Node 22 + git, then

```bash
npm ci && npm run build:all
DOCS_DATA_DIR=/var/lib/necronomidoc DOCS_TOKEN=<token> node packages/cli/dist/index.js serve
```

For a long-lived host, run it under systemd — [`deploy/necronomidoc.service`](../../deploy/necronomidoc.service) is a hardened unit with install steps in its header.

## 2. Reverse proxy (optional)

On a trusted LAN you can serve plain HTTP on `:4319` directly. If you want TLS or hostname routing, put Caddy/nginx in front exactly as in the [EC2 guide §4](ec2.md#4-tls-reverse-proxy) — with an internal CA or `caddy`'s internal issuer if the host isn't internet-reachable. Make sure the proxy sets `X-Forwarded-Proto` so session cookies are marked `Secure`.

Alternatively, teams already running SSO at a reverse proxy (oauth2-proxy, Authelia, IIS + Entra ID) can leave `DOCS_AUTH_REQUIRED` off and let the proxy own authentication — that's the supported pattern in decision [0014](../decisions/0014-auth-baseline.md). Keep `DOCS_TOKEN` set regardless: MCP clients and CI authenticate with it.

## 3. Ingestion behind a corporate network

Webhooks are **inbound** — GitHub/ADO cloud can't reach a host that isn't internet-exposed. Three working patterns, in order of preference:

1. **Self-hosted git (GitHub Enterprise Server, on-prem ADO):** webhooks originate inside the network — configure them exactly as in the [ops guide](../ops-ingestion.md).
2. **CI-triggered REST:** a pipeline step calls the trigger endpoint after each push — no inbound path from the internet needed, only CI→server:

   ```yaml
   # GitHub Actions example
   - run: |
       curl -fsS -X POST "$DOCS_URL/api/build" \
         -H "Authorization: Bearer ${{ secrets.DOCS_REPO_TOKEN }}" \
         -H "Content-Type: application/json" -d '{"repoId":"my-repo"}'
   ```

   Repos in languages the host has no toolchain for can extract in CI and `POST /api/ir` instead (slice 5, [decision 0013](../decisions/0013-backend-adapters-toolchains.md)).
3. **Polling fallback:** a cron on the server (`crontab -e`) that posts the same REST trigger on a schedule — crude but zero external coupling.

The server still needs **outbound** access to clone the repos (git over HTTPS, token via the repo's `tokenEnv`) — allow that egress or use an internal mirror.

## 4. Backups

`tar` the data dir on a schedule — the [backup guide](backup-restore.md) has the one-liner and the restore procedure.

## 5. Smoke test

Run the [deployment smoke test](smoke-test.md) with `BASE=http://<host>:4319` (or your proxied hostname). On a closed network, use pattern 2 or 3 above for step 1's trigger instead of a webhook.
