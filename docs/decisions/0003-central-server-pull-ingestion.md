# 0003 — Central server pulls repos and runs extraction (vs CI-push)

- **Status:** Accepted
- **Date:** 2026-07-10
- **Decider:** Luke (project owner)

## Context

When a repo changes, doc extraction must run somewhere. Two families were considered:

- **CI-push:** each source repo's CI runs the extractor and pushes normalized artifacts to the docs server (the Backstage TechDocs recommended model). Pro: each repo already has its language toolchain. Con: every repo needs pipeline changes; docs quality depends on N pipelines being maintained.
- **Central server pull:** a webhook/REST trigger hits the docs server, which clones/fetches the repo and runs extraction itself. Pro: zero per-repo CI setup — register a repo + add a webhook and docs appear. Con: the server needs the toolchain for each supported language, plus CPU/disk for clones and builds.

## Decision

**Central server pull.** The ingestion flow is: normalized trigger event (see [0001](0001-git-provider-adapter.md)) → enqueue build for repo → shallow clone/fetch into the data dir → run the language adapter(s) configured for that repo → write IR JSON → merge enrichment layer ([0004](0004-enrichment-layer.md)) → regenerate that repo's site section + MCP manifests → atomic swap.

Mitigations for the known costs:

- **Toolchain scope creep:** the server only bundles toolchains for languages it ships adapters for (slice 1: Node/TypeScript — already present since the server is Node). Later language adapters declare their toolchain requirements; the Dockerfile grows accordingly. The generic REST trigger (0001) additionally allows a *push-style escape hatch* later (CI posts pre-extracted IR), without changing this default.
- **Resource use:** shallow clones (`--depth 1`), one build at a time per repo (queue with debounce), extraction is `typedoc --json` + static analysis — no full app builds, no `npm install` of the target repo required where avoidable (see extraction stack decision [0007](0007-extraction-stack-typescript.md); if type resolution requires dependencies, install with `--ignore-scripts`).

## Consequences

- Onboarding a repo = one registry entry + one webhook. No changes inside source repos.
- The server needs git credentials for private repos (per-provider, per-repo — see 0001) and enough disk for clones (bounded via shallow clones and cleanup).
- Extraction for non-JS languages arrives only when we ship both the adapter *and* its toolchain in the server image; the REST/IR-push escape hatch covers the gap.
