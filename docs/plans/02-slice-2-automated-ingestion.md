# Slice 2 — Automated ingestion: GitHub / ADO / REST triggers, registry, queue, atomic publish

> **Status: ✅ Done.** Registry is `repos.json` (CLI `repo add|list|remove`);
> providers in `packages/server/src/ingest/providers.ts`; journaled queue in
> `queue.ts`; persistent shallow clones in `fetch.ts`; status in `status.json`
> + `GET /api/status` + the site's `/status` page. Setup guide:
> [../ops-ingestion.md](../ops-ingestion.md).

**Goal (requirement 7):** repos update their docs automatically on push. Implements the provider adapter pattern ([decision 0001](../decisions/0001-git-provider-adapter.md)) on top of the central-pull pipeline ([decision 0003](../decisions/0003-central-server-pull-ingestion.md)); slice 1's manual `POST /api/build` becomes one of three normalized trigger paths.

## Architecture

```
GitHub webhook ──► /hooks/github ──► GithubProvider.verify+parse ─┐
ADO service hook ► /hooks/ado ────► AdoProvider.verify+parse ─────┼─► TriggerEvent ─► queue ─► pipeline
REST call ───────► /api/build ────► token auth ───────────────────┘      (debounced,
                                                                          per-repo serialized)
```

```ts
interface GitProvider {
  readonly id: 'github' | 'ado' | 'generic';
  verifyAndParse(req: Request, repoConfigs: RepoConfig[]): Promise<TriggerEvent | Rejection>;
  fetchRepo(repo: RepoConfig, ref: string, destDir: string): Promise<FetchResult>; // shallow clone/fetch
}

type TriggerEvent = { repoId: string; ref: string; commitSha?: string; provider: string; receivedAt: string };
```

## Work breakdown

### 1. Repo registry (1–2 days)

- `registry.json` in the data dir (edited via CLI `necronomidoc repo add|remove|list`, and file-editable): per repo — id, provider, clone URL, credentials ref (env var name, never the secret itself), tracked branch, adapter config, enrichment config.
- Registry drives everything: hook routing, build pipeline, site landing page, MCP `list_repos`.

### 2. Provider adapters (3–4 days)

- **GitHub:** `push` webhook; verify `X-Hub-Signature-256` HMAC (per-repo or shared secret, constant-time compare); filter to tracked branch; repo auth via PAT or deploy key (GitHub App later if needed).
- **Azure DevOps:** `git.push` service hook; verify via basic-auth credential on the hook URL (ADO's supported mechanism) + optional IP note in docs; repo auth via PAT.
- **Generic REST:** slice 1's `POST /api/build` hardened — per-token scoping to repo ids, becomes the documented CI-integration path (works from GitLab, Jenkins, anything).
- Rejections logged with reason; endpoint always returns quickly (202) — work happens on the queue.

### 3. Build queue (2–3 days)

- In-process queue, state journaled to disk (`queue.json`) so restarts don't lose accepted triggers; per-repo serialization (never two builds of one repo concurrently); global concurrency cap (default 1–2, config).
- **Debounce:** rapid pushes coalesce — a trigger for a repo already queued just updates its target sha (10–30s window, config).
- Timeouts + failure capture: stderr/log tail stored per build; repo keeps serving its last good docs on failure.

### 4. Fetch + atomic publish (1–2 days)

- Shallow clone on first build; `fetch --depth 1` + reset thereafter; disk cleanup policy for removed repos.
- Publish: build into `data/builds/<repo>/<sha>/`, validate, then atomically swap the `current` symlink (or rename) for that repo's site section + manifests; MCP handler hot-reloads manifests on swap. Rollback = re-point symlink.

### 5. Status surface (1–2 days)

- `GET /api/status`: per repo — last build (sha, time, duration, result), queue depth, last trigger source.
- Minimal status page in the site shell (reads the same JSON); build-failure detail (log tail) behind the admin token.

### 6. Ops docs (1 day)

- How to configure a GitHub webhook and an ADO service hook (screenshots/steps, secret setup), how to call the REST API from CI, credential env var conventions.

## Acceptance criteria

1. Push to a registered GitHub repo → docs and MCP answers reflect the change within a couple of minutes, no manual step.
2. Same for an ADO repo via service hook, and any repo via authenticated REST call.
3. Forged/unsigned webhook requests are rejected and logged; secrets never appear in logs or registry.
4. Five rapid pushes produce ~1 build (debounce); a failing build leaves the previous docs serving and shows the failure in status.
5. Server restart mid-queue loses nothing already accepted.

## Risks

| Risk | Mitigation |
|------|-----------|
| Publicly exposed hook endpoints | Signature/token verification, 202-and-queue (no work in request path), rate limiting |
| Disk growth (clones + old builds) | Keep N last builds per repo (default 2), scheduled cleanup |
| Long builds blocking freshness | Per-repo serialization with global cap; incremental extraction by content hash later |

**Estimated effort:** ~2 weeks.
