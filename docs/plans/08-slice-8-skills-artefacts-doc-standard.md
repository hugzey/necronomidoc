# Slice 8 — Skill generation, artefact generation & the documentation standard

**Goal:** turn the documentation the server already holds into things teams
and agents *use*: generated Agent Skills (decision
[0017](../decisions/0017-skill-generation.md)), user-template artefacts
filled from repo knowledge (decision
[0018](../decisions/0018-artefact-generation.md)), and a written
documentation standard with scaffolding and advisory checks (decision
[0019](../decisions/0019-doc-standard.md)).

## Requirements

1. **Skills** — an LLM generates skills from the documented codebases,
   scoped to one repo, an explicit list, or every documented repo. Output is
   the portable Agent Skills convention (`SKILL.md` folders), cached against
   repo content hashes, downloadable (zip / `--out` copy), and generatable
   from CLI, authenticated API, and the site.
2. **Artefacts** — a user provides a `.md` or `.docx` template; the LLM
   fills it from one/many/all repos as the data source. Explicit `{{…}}` /
   `<…>` placeholders are replaced with everything outside them preserved;
   marker-free templates are planned into sections (headings first, best
   guess otherwise) and written section-by-section. CLI + API + site.
3. **Documentation standard** — one written standard
   ([doc-standard.md](../doc-standard.md)) that is conventional, covers
   everything a human needs, and covers optimal agent context; scaffolded by
   `init-docs`; checked (advisory) by `doctor`.
4. Everything LLM-touching honors decision 0016: any provider via
   flags/env, plus the no-API-key agent task export/import loop with
   byte-identical prompts.

## Work breakdown

### docmodel

- `GenerationScope`, `SkillDefinition`, `SkillSet`, `SkillSetIndex(Entry)`,
  `ArtefactFormat`, `ArtefactMode`, `ArtefactRecord`, `ArtefactIndex(Entry)`
  Zod schemas (additive, schema v1).

### enrichment

- `skills.ts` — scope context builder (core docs + subsystems + file
  summaries, per-repo budget), skill-set prompt + response parsing
  (slugified unique ids, scope-filtered repo claims), `SKILL.md` rendering,
  set-id derivation, agent task file build/apply.
- `artefacts.ts` — template scanner (`{{…}}` always; `<…>` only when
  prose-like), segment model + byte-preserving reassembly, plan/fill
  prompts, heading-derived fallback plan, live fill runner with token
  budget, agent task file build/apply (template embedded, docx as base64).
- `docx.ts` — minimal OOXML support over jszip: paragraph text extraction
  and paragraph-level placeholder replacement (split-run markers matched on
  combined text; styling preserved; newlines → `<w:br/>`).

### server

- `scope.ts` — `resolveScope` over published manifests (`ScopeError` for
  caller-fixable problems), per-repo `repoContentHash`.
- `llm.ts` — shared `llmClientFor` (flags + env, dry-run stub), also used
  by `enrich`.
- `skills.ts` / `artefacts.ts` — orchestration + persistence
  (`data/skills/<set-id>/`, `data/artefacts/<id>/`, top-level indexes),
  hash-cache (skills), zip download, export/import wrappers.
- `docstandard.ts` — embedded templates, `scaffoldDocs`, `checkDocStandard`.
- `app.ts` — `GET/POST /api/skills*`, `GET/POST /api/artefacts*`
  (generation admin-token-gated like ad-hoc `/api/build`; ids validated
  against traversal; template uploads size-capped).

### cli

- `skills`, `artefact`, `init-docs` commands (+ scope flags, `--dry-run`,
  `--force`, `--out`, `--export-tasks`/`--import-results`); doctor prints
  per-repo doc-standard findings (advisory).

### site

- `/skills`, `/skills/:id`, `/artefacts` routes: list/detail views with
  scope badges, SKILL.md rendering, zip/output downloads, and generate
  forms (repo picker, admin-token input kept in sessionStorage).

### docs

- Decisions 0017–0019 (+ register), this plan, guides
  ([skills](../skills.md), [artefacts](../artefacts.md)), the standard
  itself ([doc-standard](../doc-standard.md)), README + usage updates.

## Acceptance criteria

1. `skills --all` on a built data dir writes `data/skills/global/` with
   valid SKILL.md folders; an immediate re-run makes zero LLM calls.
2. A markdown template with placeholders round-trips with everything
   outside the markers byte-identical; a placeholder docx keeps its
   package intact with only marked paragraphs edited.
3. `skills`/`artefact --export-tasks` → agent → `--import-results`
   produces the same artifacts as a live run, with no API key configured.
4. `init-docs` scaffolds the four templates + README without clobbering
   existing files; `doctor` reports TODO markers and a diagram-less
   architecture doc, without changing its exit code.
5. All generation API routes refuse unauthenticated calls and traversal
   ids; scope errors and provider misconfiguration return 400 with the
   message.
