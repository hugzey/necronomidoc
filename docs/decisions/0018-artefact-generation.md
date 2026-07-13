# 0018 — Artefact generation: LLM-filled document templates (.md / .docx)

**Status:** Accepted (slice 8)

## Context

Teams write recurring documents *about* their code — release notes, audit
questionnaires, onboarding one-pagers, architecture summaries for
stakeholders — whose contents the doc server already knows. Users want to
hand over their own template (markdown or Word) and get it filled in from
the documented knowledge of one, many, or all repos. Templates vary wildly:
some mark exactly what to fill in, others are just a skeleton of headings,
and the fill-in points aren't always machine-obvious.

## Decision

1. **Two fill modes, decided by scanning the template:**
   - **placeholders** — the template contains `{{…}}` or `<…>` markers; the
     marker text is the instruction ("`{{one-line summary of the product}}`").
     Everything outside markers is **preserved verbatim**; each placeholder
     becomes one completion, prompted with its instruction, surrounding text,
     the whole template, and the repo-scope context. Diamond markers are
     heuristically distinguished from markup (multi-word prose only; never
     tags, generics, or URLs).
   - **sections** — no markers found. The LLM first *plans* the document
     (sections + per-section instructions, from the template's headings when
     present, best guess otherwise), then writes each section as its own
     completion; the output is the assembled sections. Fixed boilerplate is
     not guaranteed to survive in this mode, and the docs say so.
2. **.docx support via minimal OOXML editing** (jszip): a template's
   `word/document.xml` is read for placeholder scanning, and fills are
   spliced back at the paragraph level — markers split across formatting
   runs are matched on the paragraph's combined text; styling, headers, and
   images are preserved. **No general docx generation**: a sections-mode
   .docx template outputs markdown (flagged in every surface) rather than a
   badly reconstructed Word file.
3. **Scope + grounding = decision 0017's model**: published docs only,
   `repo`/`multi`/`global`, same context builder, same anti-hallucination
   system prompt ("where the documentation doesn't answer, say so").
4. **Persistence: `data/artefacts/<id>/`** (template copy, output,
   `artefact.json` record) + `data/artefacts/index.json`, newest first. Ids
   are template-slug + timestamp; artefacts are point-in-time documents, so
   there is no hash cache — every run is explicit.
5. **All decision-0016 provider paths apply**, including the no-key agent
   loop: `artefact --export-tasks` packages every fill prompt *and the
   template itself* (docx as base64) into the task file, so
   `--import-results` assembles without re-reading the original. The plan
   step has no LLM at export time, so sections mode exports the
   heading-derived plan.
6. **Surfaces:** the `necronomidoc artefact` CLI command (`--dry-run` shows
   mode + task count, `--max-tokens` budget cap, `--out` copies the output),
   authenticated multipart `POST /api/artefacts/generate` + public list/
   detail/download routes, and a site **Artefacts** page (upload, generate,
   download).

## Consequences

- Placeholder templates get deterministic, reviewable behavior — the diff
  against the template is exactly the fills. That is the recommended
  authoring style and the docs lead with it.
- Sections mode trades fidelity for convenience; a template with neither
  markers nor headings degrades to a single whole-document completion.
- Placeholder fills inherit the first run's character formatting in docx
  (paragraph-level splice) — a documented simplification, revisit only if
  real templates demand run-level fidelity.
- One completion per placeholder/section keeps prompts small but makes cost
  linear in template size; `MAX_FILL_TASKS` (40) and the token budget cap
  the worst case.
