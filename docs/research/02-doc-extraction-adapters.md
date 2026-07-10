# Doc Extraction Adapters: Research

**Date:** 2026-07-10
**Scope:** Extraction tooling for a multi-repo documentation server built on an adapter pattern. Language-specific adapters consume existing doc-generator output and normalize it into a common intermediate documentation model (IR). Downstream consumers: a React doc site and an MCP server that documents the purpose of every file and function in a repo for LLM agents.

---

## Summary & Recommendation

### Recommended extraction stack for the TS/React first slice

| Concern | Tool | Why |
|---|---|---|
| Primary symbol extraction (functions, classes, types, modules) | **TypeDoc `--json`** (v0.28.x as of mid-2026) | Best-maintained machine-readable model for TS; JSON schema is published as TypeScript interfaces (`JSONOutput.ProjectReflection`); every reflection carries `sources` (file + line), giving per-file grouping for free |
| Doc-comment syntax | **TSDoc** conventions, parsed by TypeDoc | TypeDoc supports TSDoc tags; `@microsoft/tsdoc` is available if we ever need strict standalone comment parsing |
| React component props | **react-docgen-typescript** (accuracy) with **react-docgen** as a fast fallback | react-docgen-typescript resolves imported types via the TS compiler; react-docgen (Babel-based) is ~50% faster but shallower — same trade-off Storybook exposes |
| Gap-filling (non-exported functions, file-header comments, per-file inventory) | **ts-morph** custom pass | TypeDoc only documents entry-point-reachable exports; ts-morph walks every source file and every function, exported or not |
| OpenAPI parsing | **@readme/openapi-parser** (fork of @apidevtools/swagger-parser) | Dereferences `$ref`s into a plain JS object we can map into the IR; better validation errors than upstream |
| OpenAPI rendering | **Scalar** (`@scalar/api-reference-react`) embedded in the React site | Modern default in 2026 (ASP.NET Core 9 replaced Swagger UI with it); full OpenAPI 3.1, built-in API client |

**Key finding on granularity:** API Extractor's `.api.json` doc model is the most rigorously designed TS interchange format, but it operates on a package's *rolled-up public API* (from `.d.ts`), deliberately erasing file structure. That is exactly wrong for our MCP use case (per-FILE and per-FUNCTION purpose). TypeDoc JSON + a ts-morph sweep is the right pair: TypeDoc for rich typed API docs, ts-morph for exhaustive per-file coverage.

### Recommended IR approach

**Invent a small, versioned JSON IR of our own; do not adopt an existing interchange format.** Every candidate we surveyed (§4) is either single-language (rustdoc JSON, griffe, Doxygen XML), package-API-centric rather than file-centric (API Extractor), effectively unmaintained as a universal model (DocFX Universal Reference / type2docfx), or explicitly unstable (TypeDoc JSON schema changes per minor version; rustdoc JSON has a `format_version` bump policy). None models "file purpose" or "separation of concerns" at all — those are our differentiators.

The IR should be a file-rooted tree (repo → file → symbol → nested symbols) where each node carries: `kind`, `name`, `qualifiedName`, `signature` (plain string, not a type AST), `docComment` (structured: summary, params, returns, examples, tags), `location` (path, line span), `visibility/exported`, `summary` (possibly LLM-generated, provenance-tagged), and `links` (to other nodes). Borrow proven ideas: canonical references and release tags from API Extractor's doc model, `uid`/`children`/`references` linking from DocFX UR, and `sources` location records from TypeDoc. Pin `irVersion` in every emitted document; adapters own the mapping from upstream formats (which will churn) into the stable IR.

---

## 1. TypeScript/React Extraction

### 1.1 TypeDoc JSON output

TypeDoc (v0.28.x current as of mid-2026) converts a TS program into a tree of *reflections* and can emit that tree as JSON via `--json <file>` on the CLI or `app.generateJson(project, path)` programmatically. The format is defined by TypeScript interfaces in the `JSONOutput` namespace — root type `JSONOutput.ProjectReflection` — so an adapter gets compile-time types for the whole payload ([TypeDoc JSONOutput API](https://typedoc.org/api/modules/JSONOutput.html), [TypeDoc Development docs](https://typedoc.org/documents/Development.html)).

Properties relevant to us:

- **Per-symbol granularity:** every declaration reflection includes `kind` (module, class, function, variable…), `comment` (parsed doc comment split into summary + block tags), `signatures` (with parameters and types), `children`, and `sources` — an array of `{fileName, line, character}` records. Grouping reflections by `sources[0].fileName` reconstructs a per-file view.
- **Plugins can extend the JSON** by registering custom serializers/deserializers, so an adapter-side TypeDoc plugin could inject extra fields (e.g., file-header comments) directly into the payload.
- **Packages mode** (`entryPointStrategy: "packages"`) handles monorepos: each package is converted and the serialized models are merged, which suits our multi-repo/multi-package reality.
- **Caveat — schema stability:** the JSON schema is versioned with TypeDoc itself and changes across minor releases (the 0.28 line introduced "several under-the-hood breaking API changes" per the [typedoc-plugin-markdown changelog](https://typedoc-plugin-markdown.org/docs/CHANGELOG)). Pin the TypeDoc version per adapter release. Community tooling like [typedoc-json-parser](https://www.npmjs.com/package/typedoc-json-parser) exists to wrap the raw JSON but tracks TypeDoc versions closely.

**typedoc-plugin-markdown** (v4.9.x) renders TypeDoc's model to Markdown instead of HTML, now built on TypeDoc's router architecture ([docs](https://typedoc-plugin-markdown.org/), [schema docs](https://typedoc-plugin-markdown.org/docs/schema)). Useful reference: it is itself a "TypeDoc-model → other format" adapter, i.e., proof that consuming the reflection model downstream is a supported pattern. For our pipeline, though, consuming the JSON model directly beats parsing generated Markdown — Markdown output should be a *rendering* concern, not the interchange layer.

### 1.2 TSDoc standard vs TypeDoc

- **TSDoc** ([tsdoc.org](https://tsdoc.org/), [microsoft/tsdoc](https://github.com/microsoft/tsdoc)) is a *comment-syntax specification* plus a reference parser (`@microsoft/tsdoc`), not a doc generator. Its motivation: JSDoc's grammar "is not rigorously specified, but rather inferred from the behavior of a particular implementation," and most JSDoc tags exist to annotate types that TS already expresses.
- **TypeDoc** is a *generator* that parses doc comments (supporting TSDoc tags — see [TypeDoc TSDoc support](https://typedoc.org/documents/Doc_Comments.TSDoc_Support.html)) and combines them with compiler type information.
- **Practical takeaway:** standardize authored comments on TSDoc tags (`@param`, `@returns`, `@remarks`, `@example`, `@public/@internal`), let TypeDoc do the parsing. Keep `@microsoft/tsdoc` in reserve for lint-style enforcement or for parsing comments in a ts-morph custom pass, so both extraction paths interpret comments identically.

### 1.3 API Extractor / api-documenter

[API Extractor](https://api-extractor.com/) produces three outputs from a package's `.d.ts` rollup: an API report, a trimmed `.d.ts`, and a **doc model** — one `<package>.api.json` per package capturing public API signatures + TSDoc comments. The companion library [@microsoft/api-extractor-model](https://www.npmjs.com/package/@microsoft/api-extractor-model) loads folders of `.api.json` files into a queryable `ApiModel` hierarchy with cross-package link resolution, and [@microsoft/api-documenter](https://www.npmjs.com/package/@microsoft/api-documenter) renders that model to Markdown or DocFX YAML. Microsoft explicitly documents building a ["custom doc pipeline"](https://api-extractor.com/pages/setup/custom_docs/) on top of the doc model — architecturally, this is the closest prior art to our adapter pattern and worth studying for IR design (canonical references, release tags, excerpt tokens).

**Why it is not our primary extractor:** it models the *public API surface of a package*, derived from declaration rollups. Internal functions, non-exported helpers, and file organization are out of scope by design. For a "document every file and function" requirement it discards precisely the information we need. Verdict: mine its design; don't build on it.

### 1.4 react-docgen and react-docgen-typescript

Two established extractors for React component props, both emitting structured JSON per component:

- **[react-docgen-typescript](https://github.com/styleguidist/react-docgen-typescript)** uses the TypeScript compiler, so it resolves **imported types** (props interfaces defined in other files/packages) — historically the decisive advantage. Slower; requires named exports.
- **[react-docgen](https://react-docgen.dev/)** parses with Babel into an AST and extracts "information from React component files … in a structured machine-readable format." Much faster but does a shallower analysis that can miss imported/complex types.
- Storybook's experience is the best field data: Storybook 8 [switched the React default to react-docgen](https://storybook.js.org/blog/storybook-8/) for up to 50% faster startup, calling it "good enough for virtually all components," while keeping react-docgen-typescript as the accuracy fallback; conversely users hit [multi-second fast-refresh penalties](https://github.com/storybookjs/storybook/issues/28269) with the TS-based one.

**For a batch documentation server** (not a dev-loop), extraction speed matters far less than completeness: default to **react-docgen-typescript**, since we're already paying TS compiler cost via TypeDoc/ts-morph and can share a program instance. The React adapter should merge docgen prop tables into the IR nodes TypeDoc/ts-morph produce for the same component (matched by file + symbol name).

### 1.5 ts-morph / compiler-API custom extraction

[ts-morph](https://github.com/dsherret/ts-morph) wraps the TypeScript compiler API for ergonomic traversal: `project.getSourceFiles()` → per file, `getFunctions()`, `getClasses()`, `getExportedDeclarations()`, plus JSDoc access (`getJsDocs()`, tag comments) and comment-range APIs ([ts-morph comments docs](https://ts-morph.com/details/comments), [worked example](https://souporserious.com/generate-typescript-docs-using-ts-morph/)). The raw [compiler API](https://github.com/Microsoft/TypeScript/wiki/Using-the-Compiler-API) does the same with more ceremony.

**Role in our stack:** the per-file sweep TypeDoc can't do — enumerate *every* file and *every* function (exported or not), capture file-header comments, compute export lists and import graphs (inputs for heuristic file-purpose summaries, §5). This is a few hundred lines of adapter code, not a framework.

### 1.6 Which gives the best machine-readable intermediate model?

Ranking for per-file/per-function granularity:

1. **TypeDoc JSON** — richest typed model, per-symbol `sources` locations, plugin-extensible serialization. Weaknesses: entry-point/export-oriented; schema churn across versions.
2. **ts-morph custom extraction** — total control and true per-file coverage; you define the output model (which is fine, since we're defining an IR anyway).
3. **react-docgen(-typescript)** — best-in-class for the narrow prop-table problem; merge into the above.
4. **API Extractor doc model** — best-*designed* model, wrong scope (public package API only).

Recommended composition: **TypeDoc JSON as the backbone + ts-morph sweep for file/function completeness + react-docgen-typescript for prop tables**, all normalized by the TS adapter into the IR.

---

## 2. OpenAPI

An OpenAPI spec is *already* a machine-readable doc model, so the "adapter" here is mostly mapping + rendering.

### 2.1 Parsing into the common doc model

- **[@apidevtools/swagger-parser](https://github.com/APIDevTools/swagger-parser)** — the long-standing standard: validates Swagger 2.0 / OpenAPI 3.0/3.1 and **dereferences all `$ref` pointers** (including external files/URLs) into a plain JS object.
- **[@readme/openapi-parser](https://github.com/readmeio/openapi-parser)** — ReadMe's hard fork; same API surface (promise-only) with significantly better validation errors via `better-ajv-errors` plus error-leveling. **Recommended.**
- Adapter mapping is natural: file → the spec; "functions" → operations (`method + path`, `operationId`, `summary`/`description`, parameters, request/response schemas map cleanly onto the IR's symbol/signature/docComment fields).

### 2.2 Rendering options

| Tool | Notes |
|---|---|
| **[Scalar](https://github.com/scalar/scalar)** | Modern three-panel UI + built-in API client, full OpenAPI 3.1, theming; React wrapper [`@scalar/api-reference-react`](https://www.npmjs.com/package/@scalar/api-reference-react) (the core is Vue, wrapped for React; SSR untested). ~500K weekly downloads and rising; ASP.NET Core 9 made it the default reference UI. Best default for new projects in 2026 ([comparison](https://www.pkgpulse.com/blog/scalar-vs-redoc-vs-swagger-ui-api-documentation-2026), [survey](https://dev.to/_d7eb1c1703182e3ce1782/best-api-documentation-tools-for-developers-in-2025-swagger-redoc-scalar-and-more-3d7g)). |
| **Redoc** | Clean read-only three-panel reference, great for very large specs; no try-it in OSS (paid Redocly adds it). ~1M weekly downloads. |
| **swagger-ui** | Most deployed (~3M weekly), "Try it out," dated UI; choose only for legacy compatibility. |
| **[docusaurus-openapi-docs](https://github.com/PaloAltoNetworks/docusaurus-openapi-docs)** (Palo Alto Networks) | Generates **MDX files** from Swagger 2.0/OpenAPI 3.x at build time for Docusaurus v3; interesting precedent for spec→static-content pipelines (incl. `externalJsonProps` to keep MDX small), but couples us to Docusaurus. |
| **fumadocs-openapi** | [Fumadocs](https://www.fumadocs.dev/docs/comparisons)' OpenAPI integration for Next.js docs sites; generates API reference pages with a playground. Attractive only if the whole doc site adopts Fumadocs. |

**Recommendation:** parse with `@readme/openapi-parser` → normalize operations/schemas into the IR for search/MCP purposes, but render the *interactive reference* with embedded Scalar rather than re-implementing schema rendering in our own components. (Rebuilding request/response schema UIs is where custom OpenAPI renderers go to die.)

---

## 3. Backend Language Doc Generators (machine-readable output)

Ordered by how clean the consumable object model is:

- **Rust — `rustdoc --output-format json`.** The cleanest design of the lot: a single JSON document deserializable into typed structs via the official [rustdoc-types](https://crates.io/crates/rustdoc-types) crate ("the canonical source of truth for the rustdoc-json output format"). Includes item docs, spans (file/line), visibility, full type info. **Still nightly-only/unstable** as of mid-2026 (`cargo +nightly rustdoc -- --output-format json -Z unstable-options`); docs.rs has been building rustdoc JSON since 2025-05, but stabilization is blocked on a long-term metaformat and cross-crate ID lookup ([RFC 2963](https://rust-lang.github.io/rfcs/2963-rustdoc-json.html), [docs.rs](https://docs.rs/about/rustdoc-json)). Check `format_version` on every payload.
- **Python — griffe.** [Griffe](https://mkdocstrings.github.io/griffe/) (the engine behind [mkdocstrings-python](https://mkdocstrings.github.io/python/)) extracts a full object model — Module/Class/Function/Attribute/Alias with signatures, docstrings (with structured docstring-section parsing), and source locations — and serializes it: `griffe dump <package>` on the CLI or `as_json()` on any object. Purpose-built as a programmatic API-data layer, static analysis (no imports needed), actively maintained. **The best backend story; make Python the second adapter.** Sphinx/autodoc is the incumbent renderer but has no first-class JSON model — treat mkdocstrings/griffe as the extraction path even for Sphinx shops.
- **C# — compiler XML docs + DocFX metadata.** The C# compiler emits XML doc files, and [`docfx metadata`](https://dotnet.github.io/docfx/reference/docfx-cli-reference/docfx-metadata.html) uses Roslyn to walk the code and emit **ManagedReference YAML** (`### YamlMime:ManagedReference`) — a well-specified per-item model with `uid`, `children`, `parent`, signatures, and comments ([metadata format spec](https://dotnet.github.io/docfx/spec/metadata_format_spec.html), [.NET YAML format](https://dotnet.github.io/docfx/docs/dotnet-yaml-format.html)). Clean enough to consume directly; DocFX also supports `--outputFormat json` variants of metadata in recent versions. Good adapter target.
- **Go — `go/doc`.** No standard JSON output, but the stdlib [go/doc](https://pkg.go.dev/go/doc) + `go/doc/comment` packages "extract source code documentation from a Go AST" — a tiny custom Go program can walk packages and emit our IR (or generic JSON) directly; this is exactly how [gomarkdoc](https://github.com/princjef/gomarkdoc) works internally (its [`lang` package](https://pkg.go.dev/github.com/princjef/gomarkdoc/lang) wraps go/doc constructs before templating to Markdown). Bonus: Go's file/package/exported-identifier conventions make heuristic summaries unusually reliable.
- **Java — javadoc doclets.** Javadoc's pluggable [doclet architecture](https://openjdk.org/groups/compiler/javadoc-architecture.html) supports custom output; existing JSON doclets ([java-json-doclet](https://github.com/kamichidu/java-json-doclet), [jsonDoclet](https://github.com/tantaman/jsonDoclet) — one JSON file per class) are small and mostly stale, so plan on maintaining a thin in-house doclet (~small, stable API surface) rather than depending on them. Weakest off-the-shelf story of the five.

**Pattern that emerges:** every ecosystem has *some* structured export (JSON, YAML, or XML), but their schemas share nothing. This is the strongest argument for the adapter-pattern + own-IR architecture: adapters are thin schema mappers, and upstream churn (rustdoc `format_version`, TypeDoc minor versions) is absorbed at the adapter boundary.

---

## 4. Prior Art on Universal / Common Documentation Models

Is there an existing interchange format to adopt?

- **API Extractor doc model (`.api.json`)** — well-designed (canonical references, excerpt token streams, release-tag trimming, `ApiModel` query API, [custom pipeline support](https://api-extractor.com/pages/setup/custom_docs/)) but TS-only and package-API-scoped; no file dimension.
- **TypeDoc serialized model** — rich but explicitly a serialization of TypeDoc internals, versioned with the tool and TS-only. A consumption format, not an interchange standard.
- **DocFX Universal Reference (UR) YAML** — the closest historical attempt at exactly our goal: one YAML metadata model (`uid`s + items + references) with converters feeding it from multiple languages — [type2docfx](https://github.com/docascode/type2docfx) (TypeDoc JSON → UR), Node2DocFX, [sphinx-docfx-yaml](https://sphinx-docfx-yaml.readthedocs.io/en/latest/design.html) — consolidated under a UniversalDocumentProcessor ([dotnet/docfx#2220](https://github.com/dotnet/docfx/issues/2220)). **Cautionary tale:** the non-.NET converters are abandoned ("type2docfx now a dead project" — [docfx discussion #8602](https://github.com/dotnet/docfx/discussions/8602)); modern DocFX natively supports only .NET + REST. The *architecture* (per-item `uid`/`parent`/`children`/`references`) is worth copying; the format itself is not a live standard.
- **Doxygen XML** — venerable multi-language (C-family) XML model consumed by bridges like [Breathe](https://breathe.readthedocs.io/) for Sphinx. Proves the "generator emits model, separate tool renders" pattern at scale, but the XML is Doxygen-shaped, awkward, and C-centric.
- **Markdown outputs (typedoc-plugin-markdown, gomarkdoc, api-documenter, rustdoc-md)** — these are lossy *renderings*, not models; parsing Markdown back into structure would throw away exactly the machine-readability we need.

**Conclusion:** there is **no living, cross-language documentation interchange format** — DocFX UR tried and was abandoned outside .NET. Adopt none; define our own minimal JSON IR (shape sketched in the Summary), steal the good ideas (UR's `uid` linking, API Extractor's canonical references and release tags, TypeDoc's `sources`, griffe's structured docstring sections), version it explicitly, and keep it deliberately *smaller* than any upstream model — the IR only needs what the doc site and MCP server consume, not full type ASTs. Full upstream payloads can be archived alongside for future re-normalization.

---

## 5. Per-File/Function Purpose Summaries (brief)

Doc comments will be sparse in real repos, so the IR's `summary` field needs multiple provenance-tagged sources, in priority order:

1. **Authored doc comments** (extracted as above) — always win.
2. **Structural heuristics** — file path/name conventions, export lists, import graph position, and signatures already say a lot ("`useAuth.ts` exports one hook consumed by 14 components"). Aider's [repo map](https://aider.chat/docs/repomap.html) validates this: a graph-ranked map of files, key symbols, and signatures — no prose at all — is enough for LLMs to navigate a codebase. Our ts-morph/go-doc sweeps produce these inputs for free.
3. **Optional LLM summarization pass** — batch job over the IR that fills empty `summary` fields per file and per function, storing results keyed by content hash so only changed files re-summarize. Prior art: [codebase-summarizer](https://github.com/shaktiwadekar9/codebase-summarizer) (per-repo/file/symbol summaries + JSON indexes), [repo-map](https://github.com/cyanheads/repo-map) (LLM-enhanced file-purpose analysis), and Meta-RAG research showing hierarchical code summaries cut context ~80% while preserving task performance ([arXiv 2508.02611](https://arxiv.org/html/2508.02611v1)).

Design note: keep summarization *outside* the adapters — adapters extract facts; a separate enrichment stage (heuristics, then LLM) writes `summary` with `provenance: "doc-comment" | "heuristic" | "llm"` so the MCP server can signal confidence to agents.

---

## Sources

- TypeDoc: https://typedoc.org/api/modules/JSONOutput.html · https://typedoc.org/documents/Development.html · https://typedoc.org/documents/Doc_Comments.TSDoc_Support.html · https://typedoc.org/documents/Plugins.html
- typedoc-plugin-markdown: https://typedoc-plugin-markdown.org/ · https://typedoc-plugin-markdown.org/docs/CHANGELOG
- TSDoc: https://tsdoc.org/ · https://github.com/microsoft/tsdoc
- API Extractor: https://api-extractor.com/pages/setup/custom_docs/ · https://www.npmjs.com/package/@microsoft/api-extractor-model · https://www.npmjs.com/package/@microsoft/api-documenter
- react-docgen(-typescript): https://github.com/styleguidist/react-docgen-typescript · https://react-docgen.dev/ · https://storybook.js.org/blog/storybook-8/ · https://github.com/storybookjs/storybook/issues/28269
- ts-morph: https://github.com/dsherret/ts-morph · https://ts-morph.com/details/comments · https://souporserious.com/generate-typescript-docs-using-ts-morph/
- OpenAPI parsing: https://github.com/readmeio/openapi-parser · https://github.com/APIDevTools/swagger-parser
- OpenAPI rendering: https://github.com/scalar/scalar · https://www.npmjs.com/package/@scalar/api-reference-react · https://github.com/PaloAltoNetworks/docusaurus-openapi-docs · https://www.fumadocs.dev/docs/comparisons · https://www.pkgpulse.com/blog/scalar-vs-redoc-vs-swagger-ui-api-documentation-2026 · https://dev.to/_d7eb1c1703182e3ce1782/best-api-documentation-tools-for-developers-in-2025-swagger-redoc-scalar-and-more-3d7g
- Rust: https://crates.io/crates/rustdoc-types · https://rust-lang.github.io/rfcs/2963-rustdoc-json.html · https://docs.rs/about/rustdoc-json
- Python: https://mkdocstrings.github.io/griffe/ · https://mkdocstrings.github.io/python/
- C#/DocFX: https://dotnet.github.io/docfx/spec/metadata_format_spec.html · https://dotnet.github.io/docfx/docs/dotnet-yaml-format.html · https://dotnet.github.io/docfx/reference/docfx-cli-reference/docfx-metadata.html
- Go: https://pkg.go.dev/go/doc · https://github.com/princjef/gomarkdoc · https://pkg.go.dev/github.com/princjef/gomarkdoc/lang
- Java: https://openjdk.org/groups/compiler/javadoc-architecture.html · https://github.com/kamichidu/java-json-doclet · https://github.com/tantaman/jsonDoclet
- Universal models: https://github.com/docascode/type2docfx · https://github.com/dotnet/docfx/issues/2220 · https://github.com/dotnet/docfx/discussions/8602 · https://sphinx-docfx-yaml.readthedocs.io/en/latest/design.html · https://breathe.readthedocs.io/
- Summarization: https://aider.chat/docs/repomap.html · https://github.com/shaktiwadekar9/codebase-summarizer · https://github.com/cyanheads/repo-map · https://arxiv.org/html/2508.02611v1
