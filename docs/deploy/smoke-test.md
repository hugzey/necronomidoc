# Deployment smoke test

Every deployment guide ends here. If all four steps pass, the host is fully operational: ingestion, build pipeline, doc site, and MCP.

Set `BASE` to your server's URL and `DOCS_TOKEN` to the access token you deployed with.

## 1. Register a repo

```bash
# on the server (or any machine with the CLI pointed at the same data dir)
node packages/cli/dist/index.js repo add https://github.com/<org>/<repo>.git \
  --id my-repo --provider github --secret-env MY_REPO_HOOK_SECRET
```

Add the webhook in GitHub (`$BASE/hooks/github`, content type `application/json`, the secret from `MY_REPO_HOOK_SECRET`) — or skip webhooks and trigger via REST:

```bash
curl -sS -X POST "$BASE/api/build" \
  -H "Authorization: Bearer $DOCS_TOKEN" -H "Content-Type: application/json" \
  -d '{"repoId":"my-repo"}'
# → {"accepted":true,"repoId":"my-repo",...}
```

## 2. Push (or trigger) and watch the build

Push a commit to the tracked branch, then:

```bash
curl -sS "$BASE/api/status" -H "Authorization: Bearer $DOCS_TOKEN" | python3 -m json.tool
```

Wait for `sources[].lastBuild.result == "ok"` (the debounce window is 10 s by default, then the build runs).

## 3. See the docs

Open `$BASE/` in a browser — with `DOCS_AUTH_REQUIRED=1` you'll be prompted to sign in with the token first. The repo appears in the sidebar with its extracted docs.

## 4. Connect MCP

Add the endpoint to an MCP client, e.g. Claude Code:

```bash
claude mcp add --transport http necronomidoc "$BASE/mcp" \
  --header "Authorization: Bearer $DOCS_TOKEN"
```

Then ask the agent something like *"what does `<some file in my-repo>` do?"* — the answer should come from the `necronomidoc` MCP tools.

## If something fails

- `necronomidoc doctor` — toolchain gaps, weak/missing secrets, blocked repos.
- `curl $BASE/healthz` — process liveness.
- Server logs are structured JSON (`docker logs` / `journalctl -u necronomidoc`); webhook deliveries are tagged `hookSource`.
- Build failures: `/api/status` with the bearer token includes per-build error detail and a log tail.
