# 0001 — Support GitHub, Azure DevOps, and generic REST triggers via a provider adapter pattern

- **Status:** Accepted
- **Date:** 2026-07-10
- **Decider:** Luke (project owner)

## Context

The server must be notified automatically when source repos change (requirement 7). Candidate notification sources are GitHub webhooks, Azure DevOps service hooks, and plain authenticated REST calls (from any CI system or manual trigger). We asked whether to prioritize one platform for the first slice.

## Decision

Support **all three from the start**, behind a **git provider adapter** interface, mirroring the language-adapter pattern used for doc extraction. Each provider adapter is responsible for:

1. **Trigger normalization** — parsing and authenticating its inbound notification (GitHub `X-Hub-Signature-256` HMAC, ADO service hook auth, bearer-token REST) and normalizing it to a common internal event: `{ repoId, ref, commitSha, provider }`.
2. **Repo access** — knowing how to clone/fetch the repo it fired for (deploy key / PAT / App token per provider).

The generic REST trigger is the *lowest common denominator*: internally, GitHub and ADO adapters resolve to the same normalized event the REST endpoint accepts directly. New providers (GitLab, Bitbucket, Gitea) are added by writing one adapter, no core changes.

## Consequences

- Slightly more slice-1 work than a single-provider spike, but the trigger interface is small; the REST path costs almost nothing since it *is* the internal event format.
- Webhook endpoints for both platforms must be documented (payload shapes, auth setup) in ops docs.
- Provider credentials are per-repo configuration in the repo registry, not global.
