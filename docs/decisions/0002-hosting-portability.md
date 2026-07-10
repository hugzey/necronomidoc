# 0002 — Host-portable single-server design (EC2 / Azure App Service / on-prem / local)

- **Status:** Accepted
- **Date:** 2026-07-10
- **Decider:** Luke (project owner)

## Context

Requirement 8: cheap and simple to host, no externally hosted database. The owner will host it themselves and explicitly wants the project buildable/runnable on **any** of: a single EC2 instance, a single Azure App Service, or an on-prem server / local dev machine.

## Decision

Design for **one portable Node.js process** with no cloud-specific dependencies:

- One server process serves the static doc site, the MCP endpoint (`POST /mcp`), and the ingestion/webhook API. (Optionally fronted by nginx on EC2/on-prem, but must work without it.)
- **Storage is the local filesystem only** — a configurable data directory (`DOCS_DATA_DIR`) containing repo clones, extracted doc-model JSON, and the built site. No S3/Blob dependency in core; object storage may be added later behind a storage interface if ever needed.
- **State is files, not a database.** Repo registry, build status, and indexes are JSON files on disk. SQLite is permitted later *only* as an embedded local file if JSON indexes hit limits — never an external DB.
- Configuration via environment variables + a config file; no cloud metadata services, no vendor SDKs in core paths.
- Ship a Dockerfile as the universal deployment artifact; also runnable bare (`node`) for local/on-prem.

## Consequences

- Azure App Service and EC2 both run the same container/Node app; local dev is `npm run dev` — no environment-specific code paths.
- Filesystem persistence means the host needs a persistent disk (EBS volume / App Service persistent storage / local disk). Ephemeral-only hosts (default Azure SWA, Lambda) are out of scope for the server; the *static site output* remains copyable to any static host.
- Horizontal scaling is out of scope by design (single-writer server). Acceptable for a team docs server.
