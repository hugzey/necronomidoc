# Skill generation — Agent Skills from your documented repos

**Decision [0017](decisions/0017-skill-generation.md).** `necronomidoc
skills` turns the documentation the server already holds — core docs,
subsystem maps, file summaries — into **agent skills** in the Agent Skills
convention: one folder per skill containing a `SKILL.md` with
`name`/`description` frontmatter and a markdown playbook body. Drop the
folders into your agent harness's skills directory (e.g. `.claude/skills/`)
and agents pick them up by description.

Skills are generated from **published docs only**: build (and ideally
enrich) a repo first — richer enrichment means richer skills.

## Scope: one, many, or all repos

```bash
# one repo
node packages/cli/dist/index.js skills sample-react-app

# an explicit set
node packages/cli/dist/index.js skills --repos widgets,billing-api

# everything documented ("global" — includes cross-repo skills)
node packages/cli/dist/index.js skills --all
```

Each scope produces one **skill set** with a stable id (the slug, joined
slugs, or `global`), stored under `data/skills/<set-id>/`:

```
data/skills/
  index.json                      # all sets
  global/
    skillset.json                 # manifest (scope, repos, hashes, skills)
    navigate-the-architecture/SKILL.md
    add-a-feature-the-house-way/SKILL.md
    …
```

## Cost controls

- **One LLM call per set**, whatever the repo count (context is budgeted
  per repo and shrinks as scope grows).
- **Hash cache**: the set records every in-scope repo's content hash;
  re-running on unchanged docs makes zero calls. `--force` regenerates
  anyway; `--dry-run` shows what would happen and which repos changed.
- Same provider selection as `enrich` — any of the decision-0016 providers
  via flags/env, or no key at all (below).

## Using the output

```bash
# copy the folders straight into an agent's skills directory
node packages/cli/dist/index.js skills --all --out ~/.claude/skills

# or download a zip from the server
curl -O http://localhost:4319/api/skills/global/download
```

The site's **Skills** page (`/skills`) lists sets, renders each SKILL.md,
downloads zips, and can trigger generation (paste the server's admin token;
generation costs tokens, so `POST /api/skills/generate` requires it).

## No API key? Agent mode

The decision-0016 loop works here too:

```bash
node packages/cli/dist/index.js skills --all --export-tasks skill-tasks.json
# → have your coding agent complete the file (instructions are inside)
node packages/cli/dist/index.js skills --import-results results.json --tasks skill-tasks.json
```

The exported prompt is byte-identical to the live one; import validates the
results and persists them through the same path, stamping the export-time
repo hashes so the normal staleness/caching applies.

## Quality tips

- Enrich before generating: `enrich` writes the file summaries and core
  docs the skill prompt is grounded in.
- Curate `subsystems.yaml` boundaries — "owns / does not own" statements
  turn directly into "where does this change go" skills.
- Generated skills tell agents to consult the server's MCP tools
  (`search_docs`, `get_core_doc`, …) for live lookups, so keep the server
  reachable from the agents that use the skills.
