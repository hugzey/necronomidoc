# Artefact generation — fill your templates from repo knowledge

**Decision [0018](decisions/0018-artefact-generation.md).** `necronomidoc
artefact` takes a template you provide — markdown (`.md`, `.markdown`,
`.txt`) or Word (`.docx`) — and fills it in from the documented knowledge of
one, many, or all repos. Release notes, audit questionnaires, onboarding
one-pagers: you own the document's shape, the server supplies the facts.

```bash
node packages/cli/dist/index.js artefact release-notes.md widgets
node packages/cli/dist/index.js artefact audit.docx --repos widgets,billing-api
node packages/cli/dist/index.js artefact overview.md --all --out filled.md
```

Like skills, artefacts generate from **published docs only** — build (and
ideally enrich) the repos first. Every run persists under
`data/artefacts/<id>/` (template copy + output + record) and appears on the
site's **Artefacts** page (`/artefacts`), which can also upload + generate
(admin token required) and download results.

## Two modes

The template decides — run `--dry-run` to see which mode applies and how
many fill tasks it plans.

### Placeholders mode (recommended)

Mark fill-in points with `{{…}}` or `<…>`; the text inside is the
instruction:

```markdown
# Release notes — {{the product name}}

<One-paragraph summary of what shipped, grounded in the architecture doc>

Everything outside markers is preserved byte-for-byte.
```

- One LLM task per placeholder, prompted with the instruction, its
  surrounding text, the full template, and the repo context.
- **Everything outside the markers is preserved** (markdown: byte-for-byte;
  docx: the document package — styles, headers, images — is preserved and
  only marked paragraphs are edited).
- Diamond markers must read like prose (multiple words); tags, generics
  (`Map<string>`), and URLs are never treated as placeholders. `{{…}}` is
  always a placeholder and may span lines.

### Sections mode (no markers found)

The LLM first **plans** the document — its sections and what belongs in
each, from your headings when present, best guess otherwise — then writes
each section as its own task and assembles them in order. Use it for
skeleton templates; know that fixed boilerplate is *not* guaranteed to
survive (the document is rewritten section-by-section).

## docx specifics

- Placeholder fills preserve the Word document entirely; a placeholder must
  sit within one paragraph (it may span formatting runs), and the fill
  takes the paragraph's leading formatting.
- A `.docx` with **no** placeholders (sections mode) outputs **markdown** —
  the server doesn't fabricate Word layout. The CLI, API response, and site
  all flag this.

## Cost controls

`--max-tokens <n>` caps the run (unfilled tasks are reported, markers left
in place); at most 40 fill tasks per artefact; `--dry-run` never calls the
model. Provider selection is identical to `enrich` (decision 0016).

## No API key? Agent mode

```bash
node packages/cli/dist/index.js artefact audit.docx --all --export-tasks tasks.json
# → have your coding agent complete the file (instructions are inside)
node packages/cli/dist/index.js artefact --import-results results.json --tasks tasks.json --out filled.docx
```

The task file carries every fill prompt *and* the template itself (docx as
base64), so import assembles the finished artefact without the original
file. Sections-mode exports plan from your headings (the LLM planning step
needs a live model).
