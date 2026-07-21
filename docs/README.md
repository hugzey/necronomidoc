# Necronomidoc documentation

This is the documentation for **necronomidoc itself** — the documentation
server — not for the repositories it documents. It covers installing and
running the server, registering repos, connecting MCP clients, configuring
automatic rebuilds, and every operational feature.

## Start here

| Document | What it covers |
|---|---|
| [Usage guide](usage.md) | Install, build a repo's docs, serve the site + MCP, and every CLI command |
| [Architecture](architecture.md) | How the system is designed: pipeline, packages, and the properties that hold everywhere |
| [HTTP API reference](api.md) | Every endpoint the server exposes, with auth requirements and examples |

## Operating the server

| Document | What it covers |
|---|---|
| [Automated ingestion](ops-ingestion.md) | Register repos and rebuild docs automatically on push — GitHub webhooks, Azure DevOps service hooks, generic REST from any CI |
| [Configuration reference](deploy/configuration.md) | Every environment variable, config key, and operator-relevant endpoint |
| [Deploy on EC2](deploy/ec2.md) · [Azure App Service](deploy/azure-app-service.md) · [on-prem / local](deploy/on-prem.md) | Verified deployment guides — each ends at the same [smoke test](deploy/smoke-test.md) |
| [Backup, restore & upgrades](deploy/backup-restore.md) | The data dir is the whole state; snapshot it and you can rebuild the host from nothing |

## Features

| Document | What it covers |
|---|---|
| [Enrichment](enrichment.md) | LLM purpose summaries for undocumented code, staleness workflow, subsystem maps, provider selection (or no API key at all) |
| [Core docs](core-docs.md) | The four per-repo documents — overview, conventions, packages, architecture — and their source precedence |
| [Source viewer](source-viewer.md) | View a file's actual source next to its docs — split view, syntax highlighting, symbols that navigate to their declaration |
| [Versions & metadata](doc-versions.md) | The per-repo documentation version journal and the (i) info drawer showing generation metadata |
| [Skills](skills.md) | Generate portable Agent Skills (`SKILL.md` folders) from documented repos |
| [Artefacts](artefacts.md) | Fill your own `.md`/`.docx` templates from repo knowledge |
| [Documentation standard](doc-standard.md) | What to write in your repos so docs serve humans and agents alike, plus the `init-docs` scaffolder |

## Design record

| Document | What it covers |
|---|---|
| [Decision register](decisions/README.md) | The binding technical decisions (ADRs), one file per decision |
