# Deploying on Azure App Service

Target: a B1 App Service running the container, with persistent storage for the data dir and platform-managed TLS. Budget ~30–45 minutes.

## 1. Build and push the image

App Service pulls a container image — build it into Azure Container Registry (or use GHCR):

```bash
az group create -n necronomidoc-rg -l westeurope
az acr create -g necronomidoc-rg -n <registry> --sku Basic --admin-enabled true
az acr build -g necronomidoc-rg -r <registry> -t necronomidoc:latest .
# add --build-arg WITH_PYTHON=1 / WITH_DOTNET=1 if your repos need them
```

## 2. Create the App Service

```bash
az appservice plan create -g necronomidoc-rg -n necronomidoc-plan --is-linux --sku B1
az webapp create -g necronomidoc-rg -p necronomidoc-plan -n <app-name> \
  --container-image-name <registry>.azurecr.io/necronomidoc:latest
az webapp config appsettings set -g necronomidoc-rg -n <app-name> --settings \
  WEBSITES_PORT=4319 \
  WEBSITES_ENABLE_APP_SERVICE_STORAGE=true \
  DOCS_DATA_DIR=/home/data \
  DOCS_TOKEN=$(openssl rand -hex 32) \
  DOCS_WEBHOOK_SECRET=$(openssl rand -hex 32) \
  DOCS_AUTH_REQUIRED=1
```

Notes:

- **Persistent storage:** with `WEBSITES_ENABLE_APP_SERVICE_STORAGE=true`, `/home` is durable, shared storage that survives restarts and redeploys — the data dir goes under it (`/home/data`). For bigger installs mount an Azure Files share via `az webapp config storage-account add` and point `DOCS_DATA_DIR` at the mount instead.
- **Always On:** turn it on (`az webapp config set ... --always-on true`, requires B1+). Without it the app is unloaded when idle and **webhook deliveries would 503 while it cold-starts** — pushes would be missed, not queued.
- **TLS:** `https://<app-name>.azurewebsites.net` is TLS-terminated by the platform out of the box; App Service forwards `X-Forwarded-Proto`, which the app uses to mark session cookies `Secure`. Custom domains get managed certificates via `az webapp config hostname add` + an App Service managed certificate.
- **Health check:** point App Service's health-check feature at `/healthz` so unhealthy workers are recycled.

## 3. Backups

The whole state is under `/home/data` — use App Service backups, or Azure Files snapshots if you mounted a share. Details: [backup-restore.md](backup-restore.md).

## 4. Smoke test

Run the [deployment smoke test](smoke-test.md) with `BASE=https://<app-name>.azurewebsites.net`: register a repo, push, watch the docs update, connect MCP with the bearer token.
