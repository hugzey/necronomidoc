# Slice 5 — Second language adapter (backend) proving the adapter pattern

**Goal (requirement 5, backend leg):** ship one non-TypeScript language adapter end-to-end, validating that the adapter interface, IR, enrichment, site, and MCP genuinely support new languages without core changes — and establish the pattern for packaging language toolchains into the server.

## Language choice

**Recommended first: Python via griffe** — [research 02](../research/02-doc-extraction-adapters.md) found griffe's JSON object model (`griffe dump`) is the cleanest machine-readable doc model of any backend ecosystem, and Python toolchain packaging is easy. Alternates, in order of adapter ergonomics: C# (DocFX ManagedReference), Go (small custom `go/doc` program), Java (thin custom JSON doclet). **Confirm against the team's actual backend stack before starting** — if the team is C#/.NET, do C# first despite the extra effort; update this plan and the decision register accordingly.

## Work breakdown (assuming Python)

### 1. `packages/adapter-python` (3–4 days)

- `detect()`: `pyproject.toml` / `setup.py` / `*.py` density.
- Run `griffe dump` (pinned version) via a vendored Python environment; map griffe's object model (modules → classes/functions, docstrings, signatures, source locations) to DocModel.
- Docstring parsing: google/numpy/sphinx styles via griffe's docstring parsers → structured summary/params/returns.
- Non-exported coverage: griffe walks whole modules, so per-file/per-function coverage matches the ts-morph sweep's guarantees.
- Fixture repo + IR snapshot tests, same harness as adapter-ts.

### 2. Toolchain packaging pattern (2–3 days) — the real point of this slice

- Adapters declare toolchain requirements (`requires: { python: ">=3.11", pip: ["griffe==x.y"] }`).
- Dockerfile gains an opt-in build arg per language (`--build-arg WITH_PYTHON=1`) so hosts only carry toolchains they use; bare-metal installs get a `necronomidoc doctor` command that checks and reports missing toolchains per registered repo.
- Graceful degradation: a repo whose adapter's toolchain is missing fails its build with an actionable status message, not a server crash.
- Document the escape hatch from [decision 0003](../decisions/0003-central-server-pull-ingestion.md): `POST /api/ir` accepting pre-extracted, schema-validated DocModel JSON from a repo's own CI — covering languages we don't yet bundle. (Small: validation + same downstream pipeline. Implement here.)

### 3. Site/MCP verification (1 day)

- No code changes expected — that's the acceptance test of the pattern. Python symbols render, search, and serve over MCP purely via the IR.

## Acceptance criteria

1. A Python repo registers and documents end-to-end with zero changes to `docmodel`, `site`, `mcp`, or `server` core (adapter registration only).
2. `POST /api/ir` lets an arbitrary-language repo's CI publish docs without a bundled toolchain.
3. Missing-toolchain failure is a clear per-repo status, and `necronomidoc doctor` explains the fix.

**Estimated effort:** ~1.5 weeks.
