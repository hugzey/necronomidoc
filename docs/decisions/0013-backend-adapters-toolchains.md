# 0013 — Backend language adapters (Python via griffe, C# via DocFX) and opt-in toolchain packaging

**Status:** Accepted (slice 5)

## Context

Slices 1–4 documented TypeScript, Markdown, and OpenAPI — all extractable with
Node-native tooling. Requirement 5 needs backend languages, which means shelling
out to external toolchains the server host may not have. The slice-5 plan
recommended Python first and said to confirm against the team's actual backend
stack; the team confirmed **.NET/C# must be supported too**, so this slice ships
both — which also proves the toolchain-packaging pattern against two very
different toolchains instead of one.

[Research 02](../research/02-doc-extraction-adapters.md) picked the extractors:

- **Python — [griffe](https://mkdocstrings.github.io/griffe/).** `griffe dump
  --full` emits a JSON object model (modules → classes/functions/attributes,
  parsed google/numpy/sphinx docstrings, signatures, line spans) from pure
  static analysis. The cleanest machine-readable doc model of any backend
  ecosystem.
- **C# — [`docfx metadata`](https://dotnet.github.io/docfx/) ManagedReference.**
  Drives Roslyn over the repo's `.csproj` files and emits well-specified
  per-type YAML (`uid`/`parent`/`children`, syntax, XML doc comments, source
  locations). Compiles the code to analyze it; never runs it.

## Decision

1. **Two new adapter packages** — `adapter-python` and `adapter-csharp` — each
   split into a subprocess driver (probe interpreter/SDK, run the tool, collect
   output) and a **pure mapper** (upstream JSON/YAML → DocModel) so the mapping
   is unit-tested without the toolchain installed. Both run the extractor
   **out of process with pinned versions**; upstream format churn is absorbed
   at the adapter boundary (decision 0006).
2. **Toolchain contract in docmodel** (the shared boundary): adapters declare
   `requires` (e.g. `{ tools: { python: ">=3.9" }, pip: ["griffe>=1.0"] }`) and
   implement `checkToolchain()`. `extract()` throws `ToolchainError` with an
   actionable `fix` when the toolchain is absent — the build queue records it
   as a failed per-repo build status; the server never crashes and previously
   published docs keep serving.
3. **Interpreter/tool resolution favors isolation:** `NECRONOMIDOC_PYTHON` /
   `NECRONOMIDOC_DOCFX` env vars win, then a `necronomidoc-python` shim, then
   PATH (`python3`, `docfx`, `~/.dotnet/tools/docfx`).
4. **Docker packaging is opt-in per language:** `--build-arg WITH_PYTHON=1`
   installs a private venv with pinned griffe; `--build-arg WITH_DOTNET=1`
   installs the .NET SDK + docfx. Hosts only carry the toolchains their repos
   need. `necronomidoc doctor` reports each adapter's toolchain and flags
   registered repos blocked by a missing one.
5. **`POST /api/ir` escape hatch** (from decision 0003): a repo whose language
   we don't bundle can extract docs in its own CI and POST schema-validated
   DocModel JSON. Same enrichment merge, atomic publish, registry entry, MCP
   serving, and build-status recording as adapter builds. `necronomidoc
   export-schemas` publishes the JSON Schema such CI jobs validate against.

## Consequences

- The adapter pattern is now proven: both languages shipped with **zero changes
  to docmodel schemas, enrichment, site, or MCP core** — registration is one
  array entry in `server/src/build.ts`.
- Symbol mapping conventions for backend languages: Python modules and C#
  source files are `DocFile`s; classes/enums keep their members nested;
  non-public symbols are extracted but `exported: false` (the same per-file
  coverage guarantee as the ts-morph sweep); docstring/XML-doc sections map to
  the structured `DocComment` (params/returns/raises→tags/examples).
- `docfx metadata` needs the repo to restore/compile (Roslyn), so C# extraction
  is the slowest and needs network for NuGet restore; repos that can't build on
  the server should prefer `POST /api/ir`.
- Go/Java later follow the same recipe: driver + pure mapper + toolchain
  declaration + Dockerfile build arg.
