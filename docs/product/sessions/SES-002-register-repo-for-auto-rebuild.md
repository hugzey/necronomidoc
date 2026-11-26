---
id: SES-002
title: Platform engineer registers a repo so pushes rebuild its docs
status: implemented
persona: PER-001
job: JOB-002
intent: "Make the widgets repo's docs update themselves on every push."
trigger: A team asked for their new repo to appear on the doc site
entry:
  channel: cli
  auth: shell on the server host (data dir access)
  preconditions:
    - The server is deployed and reachable from GitHub
    - A webhook secret is set in the server environment
steps:
  - id: S1
    action: Registers the repo with its provider and webhook secret
    surface: "`necronomidoc repo add <url> --provider github --secret-env …`"
    system: Writes the repo into the watched-source registry
    expects: "✓ registered, with the webhook URL to configure"
    code: [packages/server/src/ingest/registry.ts#upsertSourceRepo]
  - id: S2
    action: Adds the webhook in the repo's GitHub settings
    surface: GitHub repository settings → Webhooks
    expects: GitHub's ping delivery succeeds
  - id: S3
    actor: system
    action: A push arrives; the signature is verified and a build is queued
    system: POST /hooks/github → debounced, journaled build queue
    expects: Build status shows the repo queued, then building
    code: [packages/server/src/ingest/providers.ts#verifyWebhook, packages/server/src/ingest/queue.ts#BuildQueue.enqueue]
    branches:
      - when: The signature doesn't match the secret
        goto: OUT-2
  - id: S4
    actor: system
    action: Clones, extracts, merges enrichment and publishes atomically
    system: Build pipeline
    expects: The repo's docs appear on the site with the new commit
    code: [packages/server/src/build.ts#publishModel]
    outcome: OUT-1
    branches:
      - when: The build fails
        goto: OUT-3
outcomes:
  - id: OUT-1
    kind: fulfilled
    title: Docs update on every push
    criteria:
      - The published version journal gains an entry for the pushed commit
  - id: OUT-2
    kind: failed
    title: Webhook rejected — nothing builds
    criteria:
      - The hook returns 401 and the status page shows no new build
  - id: OUT-3
    kind: partial
    title: Build fails but the previous docs keep serving
    criteria:
      - The failure is visible on the status page
      - The last good docs are still published
stories: [STORY-002]
journey: { id: JRN-001, stage: Set up }
---

# Platform engineer registers a repo so pushes rebuild its docs

## Narrative

The engineer registers the repo once from the CLI and adds the webhook. From
then on every push is verified, debounced and built; a failed build is
visible but never takes the existing docs down.
