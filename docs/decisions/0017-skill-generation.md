# 0017 — Skill generation: LLM-written Agent Skills (SKILL.md) from documented repos

**Status:** Accepted (slice 8)

## Context

The server already gives coding agents *reference* documentation — MCP tools,
core docs, llms.txt. What agents increasingly consume instead of raw
reference is **skills**: small, named playbooks ("add a feature the codebase's
way", "navigate this architecture") loaded by Claude Code and other harnesses
from `SKILL.md` folders. Teams want the documented knowledge the server
already holds turned into such skills automatically — for one repo, an
explicit set of repos, or everything documented ("global"), where a global
set can carry cross-repo skills no single repo's docs could.

## Decision

1. **Output format: the Agent Skills convention.** Each generated skill is a
   folder holding a `SKILL.md` — YAML frontmatter (`name`, `description`,
   both derived from the model response and slug-sanitized) plus a markdown
   body. Portable to any harness that loads SKILL.md folders; no
   necronomidoc-specific skill format.
2. **Scope model: `repo` | `multi` | `global`** (`GenerationScope` in the
   docmodel). A scope resolves against **published docs only**
   (`registry.json` + `repos/<slug>/` manifests) — generation never clones or
   extracts; unbuilt repos are a hard error. One completion per skill set,
   grounded in each repo's core docs, subsystem map, and file summaries, with
   a per-repo context budget that shrinks as the scope grows. Generated
   skills tell agents to use the server's MCP tools for live lookups.
3. **Persistence + caching: `data/skills/<set-id>/`** (`skillset.json` +
   one `<skill-id>/SKILL.md` folder per skill, plus a top-level
   `data/skills/index.json`). Set ids are stable per scope (`global`, the
   slug, or joined slugs). Every set records each in-scope repo's
   `repoContentHash`; re-running on unchanged docs makes **zero** calls
   (`--force` overrides), matching decisions 0011/0015's cost model. Skill
   dirs live outside the atomically swapped repo dirs, so rebuilds never
   touch them.
4. **All decision-0016 provider paths apply**: the same `LlmClient`
   resolution (flags + env, any provider), and the no-API-key agent loop —
   `skills --export-tasks` writes the exact live prompt to a task file,
   `skills --import-results` validates and persists through the same parsing
   path, stamping the export-time hashes.
5. **Surfaces:** the `necronomidoc skills` CLI command (scope, `--dry-run`,
   `--force`, `--out <dir>` to copy folders into an agent's skills dir),
   authenticated `POST /api/skills/generate` + public `GET /api/skills[/:id]`
   + `GET /api/skills/:id/download` (zip), and a site **Skills** page
   (browse, generate, download).

## Consequences

- One LLM call per skill-set generation keeps cost flat regardless of repo
  count; the trade-off is a bounded context per repo, so very large scopes
  yield shallower skills — acceptable for v1, revisit with per-repo calls +
  a synthesis call if quality demands it.
- Skill quality is bounded by enrichment quality: an un-enriched repo
  contributes only heuristic core docs. The docs recommend enriching first.
- Generation endpoints cost money, so they sit behind the same admin token
  as ad-hoc `/api/build`; reads are as public as the rest of the docs.
- Staleness is per-set: any in-scope repo hash change marks the whole set
  regenerable (skills routinely mix repo knowledge, so per-skill staleness
  would be false precision).
