# The necronomidoc documentation standard

**Decision [0019](decisions/0019-doc-standard.md).** One standard for the
comments in your code and the supporting documents around it, written to
three commitments:

1. **Conventional** — it uses each language's established doc idiom
   (TSDoc/JSDoc, PEP 257 docstrings, C# XML docs), not a bespoke syntax.
   Your editor, linter, and every other tool already understand it.
2. **Complete for humans** — a newcomer can answer the four questions every
   codebase gets asked (*what is this? how is it written? what does it
   depend on? how is it shaped?*) plus "what is this file/function for?"
   without opening an implementation.
3. **Optimal for agents** — the same text is the context LLM agents get via
   MCP, `llms.txt`, skills, and artefacts. The rules below (purpose-first
   sentences, explicit boundaries, stable names) exist because that's what
   retrieval and generation actually consume.

Getting started takes one command:

```bash
node packages/cli/dist/index.js init-docs <repo-path>   # scaffold the templates
node packages/cli/dist/index.js doctor                  # advisory compliance report
```

`init-docs` never overwrites existing files (`--force` does); `doctor`'s
doc-standard findings are advisory only — the heuristic floor (decision
[0015](decisions/0015-core-docs.md)) keeps every repo documented, this
standard upgrades it.

## 1. Comments in code

### The purpose-first rule

Every doc comment **starts with one plain sentence saying what the thing is
for** — not how it works, not its type signature restated. That first
sentence is what extraction surfaces, what search indexes, what MCP tools
return as the one-line summary, and what a human scans in a file listing.

```ts
/**
 * Content hash used for staleness detection and incremental rebuilds.
 * Short hex prefix of a sha256 — collision risk is negligible at repo scale.
 */
export function hashContent(content: string): string { … }
```

Bad first sentences: `"This function takes a string and…"` (mechanics),
`"Helper for hashing."` (says nothing), `"See hashContent."` (indirection).

### What must carry a doc comment

- **Every exported/public symbol** (function, class, type, component,
  endpoint handler). Unexported symbols: only where the name can't carry
  the meaning.
- **Every file/module** whose purpose isn't obvious from one glance: a
  module-level comment saying what the file owns and — when it matters —
  what does *not* belong in it. Boundary sentences ("X lives in Y, not
  here") are the single highest-value line for agents deciding where code
  goes.
- **Every non-obvious constraint** inline: why a lock is taken, why a
  fallback exists, why an order matters. Comment the *why*, never the what.

### Per-language idiom

| Language | Idiom | Notes |
|---|---|---|
| TypeScript/JS | TSDoc/JSDoc `/** … */` | `@param`/`@returns` only when names don't carry it; React props documented on the props type |
| Python | PEP 257 docstrings | Summary line first, blank line, detail; Google or NumPy section style — pick one per repo and say so in `conventions.md` |
| C#/.NET | XML doc comments | `<summary>` is the purpose sentence; `<remarks>` for constraints |
| OpenAPI | `summary` + `description` per operation | `summary` is the purpose sentence |
| Markdown docs | First `# heading` is the title; first paragraph is the purpose | Extraction uses both |

### Writing for agents (applies everywhere)

- **Stable, searchable names**: call things by the same name the code uses;
  an agent greps for exact terms.
- **State boundaries explicitly**: "owns X", "does not own Y", "callers
  must Z". This is what `subsystems.yaml` and the MCP boundary answers are
  built from.
- **Examples over adjectives**: one minimal usage example beats three
  sentences of praise. Examples are extracted and shown.
- **No stale pointers**: don't reference line numbers, PR numbers, or
  people; reference files and symbols (they're checkable).

## 2. Supporting documents

### The four core documents (required)

Ship them at the specific location `.necronomidoc/docs/` — they beat every
other source on every rebuild (decision 0015). `init-docs` scaffolds each
template with its required sections:

| Document | Required content |
|---|---|
| `overview.md` | Purpose paragraph; **What it does** (3–6 capabilities); **How it's used** (consumers + entry points); **Boundaries** (what it deliberately doesn't do) |
| `conventions.md` | **Code style**; **Error handling** (named error types/helpers to reuse); **Testing** (framework, layout, how to run); **Documentation** (this standard's per-repo specifics) |
| `packages.md` | Dependency table — *what it is / why we use it / where*; **Internal modules** list |
| `architecture.md` | One-paragraph shape; a **mermaid or ASCII diagram** (required); **Parts** (one per box); **Data & control flow** |

The "why we use it" column and the "Boundaries" section are the two most
load-bearing pieces for agents: they prevent duplicate dependencies and
misplaced code.

### The `.necronomidoc/` layout

```
.necronomidoc/
  docs/            overview.md conventions.md packages.md architecture.md
  enrichment/      *.yaml — human purpose/scope overlays for files & symbols
  subsystems.yaml  curated subsystem map ("owns X / does not own Y")
```

Everything is optional, plain markdown/YAML, and versioned with the code —
documentation changes ride the same PRs as the code they describe.

### Everything else

- **README.md** stays the human front door (install, quick start, badges) —
  it complements `overview.md`, which is the structured answer served to
  tooling. Don't duplicate; link.
- Long-form docs (guides, runbooks, ADRs) live wherever the repo keeps
  them; give each a `# title` and a purpose-first opening paragraph so
  extraction and search represent them well.
- **Decisions**: keep an ADR register (this repo's `docs/decisions/` is the
  reference shape — context / decision / consequences, one file per
  decision, an indexed README).

## 3. Compliance

`necronomidoc doctor` reports, per registered repo (advisory, never fails):

- which core docs are repo-curated vs falling back to override/LLM/heuristic;
- leftover `TODO(doc):` scaffold markers;
- a core doc missing its `# title` heading;
- an `architecture.md` without a mermaid/ASCII diagram.

The pipeline itself rewards compliance without enforcement: human-curated
content is never overwritten by the LLM tiers, purpose-first comments make
`enrich` skip whole files (they already have summaries), and well-bounded
docs directly improve generated skills (decision
[0017](decisions/0017-skill-generation.md)) and artefacts (decision
[0018](decisions/0018-artefact-generation.md)).
