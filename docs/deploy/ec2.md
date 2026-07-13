# Deploying on AWS EC2

Target: a single small instance serving docs + MCP over HTTPS, webhook-reachable from GitHub/ADO, with snapshot backups. Budget ~30–45 minutes.

## 1. Instance

- **Type:** `t4g.small` (2 vCPU, 2 GiB, arm64) is enough; pick `t3.small` for x86. Builds are the only heavy work and they're serialized by default.
- **AMI:** Ubuntu 24.04 LTS or Amazon Linux 2023.
- **Storage:** root volume for the OS + a **separate EBS volume** (8–20 GiB gp3) for the data dir, so backups snapshot just the state.
- **Security group:** inbound `443` from anywhere (webhooks + users), `22` from your admin IP only. Nothing else — the app listens on `4319` bound behind the reverse proxy, not exposed.

## 2. Data volume

```bash
sudo mkfs -t ext4 /dev/nvme1n1        # the attached EBS volume
sudo mkdir -p /var/lib/necronomidoc
echo '/dev/nvme1n1 /var/lib/necronomidoc ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab
sudo mount -a
```

## 3. Run the server (Docker path)

```bash
# Docker
curl -fsSL https://get.docker.com | sudo sh

git clone https://github.com/<org>/necronomidoc.git && cd necronomidoc
export DOCS_TOKEN=$(openssl rand -hex 32)          # save this in your secret store
export DOCS_WEBHOOK_SECRET=$(openssl rand -hex 32)
export DOCS_AUTH_REQUIRED=1                        # team-private site + MCP

sudo -E docker compose up -d --build
# add --build-arg WITH_PYTHON=1 / WITH_DOTNET=1 to `docker compose build` if
# your repos need those adapters (see Dockerfile header)
```

Edit `docker-compose.yml` to bind-mount the EBS volume instead of the named volume:

```yaml
    volumes:
      - /var/lib/necronomidoc:/data
```

*Bare-metal alternative:* install Node 22 + git, `npm ci && npm run build:all`, then use the systemd unit in [`deploy/necronomidoc.service`](../../deploy/necronomidoc.service) (its header has the install steps).

## 4. TLS reverse proxy

**Caddy** (simplest — automatic Let's Encrypt):

```bash
sudo apt install -y caddy
echo 'docs.example.com {
    reverse_proxy localhost:4319
}' | sudo tee /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

**nginx + certbot** if you prefer: proxy `/` to `localhost:4319` with `proxy_set_header X-Forwarded-Proto https;` (the app uses it to mark session cookies `Secure`), then `certbot --nginx -d docs.example.com`.

Point DNS (`A`/`AAAA` record) at the instance's Elastic IP before requesting certificates.

## 5. Backups

Schedule EBS snapshots of the data volume with Amazon Data Lifecycle Manager (e.g. daily, keep 7). Restore procedure and what's in the volume: [backup-restore.md](backup-restore.md).

## 6. Smoke test

Run the [deployment smoke test](smoke-test.md) with `BASE=https://docs.example.com`: register a repo, push, watch the docs update, connect MCP with the bearer token.
