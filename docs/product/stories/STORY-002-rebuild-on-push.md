---
id: STORY-002
title: Rebuild a repo's docs on push
status: implemented
persona: PER-001
want: pushes to a registered repo to rebuild and publish its docs automatically
soThat: the docs never lag behind the code
jobs: [JOB-002]
activity: Set up
step: Connect repos
release: MVP
priority: must
code:
  - packages/server/src/ingest/queue.ts#BuildQueue
  - packages/server/src/build.ts#publishModel
---

# Rebuild a repo's docs on push

## Requirements (EARS)

- **REQ-1** WHEN a verified push event arrives THE server SHALL queue one debounced build for that repo
- **REQ-2** IF a build fails, THEN THE server SHALL keep serving the previously published docs
