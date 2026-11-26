import { stringify as stringifyYaml } from "yaml";
import {
  PRODUCT_ID_PREFIX,
  PRODUCT_TYPE_DIRS,
  slugify,
  type ProductDocType,
} from "@necronomidoc/docmodel";

/**
 * Templates for the product-doc standard (decision 0023, docs/product-docs.md).
 * Embedded as constants — like the core-doc templates — so the CLI scaffolds
 * from any install layout. YAML comments carry the guidance for whoever fills
 * the template (human or agent); `TODO(doc):` marks every value to replace,
 * and the linter flags any that survive.
 *
 * Placeholders `{{id}}` and `{{title}}` are substituted by `product new`.
 */

const PERSONA = `---
# Persona — WHO uses the product. One file per distinct role/goal set.
id: {{id}}
title: "{{title}}"               # how the team refers to them, e.g. "Platform engineer"
status: draft                    # draft | proposed | accepted | implemented | deprecated
summary: "TODO(doc): one sentence — who they are and what they're responsible for"
role: "TODO(doc): the system role / permission set they hold (e.g. admin, member, anonymous)"
expertise: intermediate          # novice | intermediate | expert
goals:
  - "TODO(doc): what they are trying to achieve (outcomes, not features)"
frustrations:
  - "TODO(doc): what gets in their way today"
context: "TODO(doc): where/how/how often they use the product — devices, environment, constraints"
permissions:
  - "TODO(doc): what they may do in the system"
---

# {{title}}

<!-- Optional prose: background, quotes from research, anti-goals. Keep the
     structured facts above — they are what links, diagrams and agents use. -->
`;

const JOB = `---
# Job-to-be-done — an INTENT users arrive with. Solution-agnostic: it should
# still be true if the product were rebuilt from scratch.
# Reads as: "When <situation>, I want to <motivation>, so I can <outcome>."
id: {{id}}
title: "{{title}}"               # short imperative, e.g. "Find existing code before writing it"
status: draft
personas: [PER-000]              # TODO(doc): who holds this intent
situation: "TODO(doc): the circumstance that triggers the need"
motivation: "TODO(doc): what they want to do about it"
outcome: "TODO(doc): the result that makes it worthwhile"
importance: high                 # low | medium | high | critical
successMetrics:
  - "TODO(doc): a measurable signal the job got done (time, error rate, adoption…)"
---

# {{title}}
`;

const EPIC = `---
# Epic — a body of work that groups stories under one or more jobs.
id: {{id}}
title: "{{title}}"
status: draft
summary: "TODO(doc): what this epic delivers and why"
jobs: [JOB-000]                  # TODO(doc): the intents it serves
---

# {{title}}
`;

const STORY = `---
# User story — a unit of delivery. "As a <persona>, I want <want>, so that <soThat>."
# Small, testable, valuable on its own (INVEST).
id: {{id}}
title: "{{title}}"
status: draft
persona: PER-000                 # TODO(doc)
want: "TODO(doc): the capability, in the persona's words"
soThat: "TODO(doc): the benefit — ties back to a job's outcome"
jobs: [JOB-000]                  # TODO(doc): which intents this serves
# epic: EPIC-000
activity: "TODO(doc): story-map backbone activity (column), e.g. Set up"
step: "TODO(doc): story-map step within the activity"
release: MVP                     # story-map release slice (row)
priority: must                   # must | should | could | wont
code: []                         # implementing code: path | path#Symbol | Symbol | "GET /route"
---

# {{title}}

## Acceptance criteria

<!-- One Gherkin scenario per criterion, each tagged @AC-n. Tests cite
     {{id}}.AC-n in their name/tag so coverage can be traced. -->

\`\`\`gherkin
@AC-1
Scenario: TODO(doc) the main success case
  Given TODO(doc) the starting state
  When TODO(doc) the user acts
  Then TODO(doc) the observable result
\`\`\`

## Requirements (EARS)

<!-- Optional system rules in EARS form. Delete this section if unused.
     Templates: THE <system> SHALL … | WHEN <trigger> THE <system> SHALL … |
     WHILE <state> … | IF <unwanted condition> THEN THE <system> SHALL … |
     WHERE <feature is included> … -->

- **REQ-1** WHEN TODO(doc) THE system SHALL TODO(doc)

## Notes
`;

const JOURNEY = `---
# Journey map — a persona's experience across stages, including how it FEELS.
# emotion: 1 (frustrated) … 5 (delighted). Stages link to the sessions that realize them.
id: {{id}}
title: "{{title}}"
status: draft
persona: PER-000                 # TODO(doc)
jobs: [JOB-000]
stages:
  - name: "TODO(doc): Discover"
    goal: "TODO(doc): what they want from this stage"
    actions: ["TODO(doc): what they do"]
    touchpoints: ["TODO(doc): where — screen, email, CLI, docs, a colleague"]
    thoughts: ["TODO(doc): what they're thinking"]
    emotion: 3
    painPoints: ["TODO(doc)"]
    opportunities: ["TODO(doc)"]
    sessions: []                 # SES-… that play out in this stage
    stories: []
---

# {{title}}
`;

const SESSION = `---
# Intent interaction session — ONE user arriving with ONE preconceived intent,
# followed end to end: entry state → every step → the outcome. This is the
# executable truth of what the product is for; tests verify its outcomes
# ({{id}}.OUT-n) and its steps bind to the code they exercise.
id: {{id}}
title: "{{title}}"
status: draft
persona: PER-000                 # TODO(doc): who
job: JOB-000                     # TODO(doc): the job this session tries to get done
intent: "TODO(doc): the goal in the user's own words, as held on arrival"
trigger: "TODO(doc): what happened just before — why now"
entry:
  channel: web                   # web | cli | mcp | api | mobile | email | …
  auth: "TODO(doc): signed in as <role> / anonymous / token"
  preconditions:
    - "TODO(doc): state that must already be true (data, config, permissions)"
steps:
  # actor: user (default) | system | <named external actor>
  # next: defaults to the following step; outcome: ends the session here.
  # code: path | path#Symbol | Symbol | "GET /route" — \`backticked\` names in the
  #       text below are bound automatically when they resolve.
  - id: S1
    action: "TODO(doc): what the user does"
    surface: "TODO(doc): where — screen/route, CLI command, MCP tool"
    system: "TODO(doc): what the system does in response"
    expects: "TODO(doc): what the user sees that tells them it worked"
    code: []
    emotion: 3
  - id: S2
    action: "TODO(doc)"
    expects: "TODO(doc)"
    outcome: OUT-1
    branches:
      - when: "TODO(doc): the alternative the user can hit"
        goto: OUT-2
outcomes:
  - id: OUT-1
    kind: fulfilled              # fulfilled | partial | diverted | abandoned | failed
    title: "TODO(doc): the intent is met"
    criteria:
      - "TODO(doc): observable proof — what is true now"
  - id: OUT-2
    kind: abandoned
    title: "TODO(doc): the user gives up because…"
    criteria:
      - "TODO(doc)"
stories: []                      # STORY-… exercised by this session
# journey: { id: JRN-000, stage: Discover }
metrics:
  - "TODO(doc): e.g. intent fulfilled in ≤ 4 steps"
---

# {{title}}

## Narrative

TODO(doc): two or three sentences telling the session as a story — who
arrives, what they want, what happens, how it ends.

## Assumptions & open questions
`;

const README = `# Product documentation

<!-- Standard: necronomidoc docs/product-docs.md (decision 0023). This page is
     the product narrative shown atop the Product overview. -->

TODO(doc): one paragraph — who the product serves and the intents it exists
to fulfil. Link the most important jobs and sessions by id.

| Folder | Holds | Id |
|---|---|---|
| \`personas/\` | who uses the product | \`PER-001\` |
| \`jobs/\` | the intents they arrive with (jobs-to-be-done) | \`JOB-001\` |
| \`sessions/\` | **intent interaction sessions** — one intent, end to end | \`SES-001\` |
| \`journeys/\` | journey maps across stages, with emotion | \`JRN-001\` |
| \`epics/\` | bodies of work grouping stories | \`EPIC-001\` |
| \`stories/\` | user stories with Gherkin/EARS acceptance criteria | \`STORY-001\` |
| \`glossary.md\` | the product's shared vocabulary | |
| \`_templates/\` | one template per type (never published) | |
| \`schema.json\` | JSON Schema for the frontmatter (generated) | |

Create a document with \`necronomidoc product new <type> --title "…"\`, check
everything with \`necronomidoc product lint\`. Tests cite ids
(\`STORY-001.AC-1\`, \`SES-001.OUT-1\`) so coverage can be traced.
`;

const GLOSSARY = `# Glossary

<!-- The product's ubiquitous language: use these exact terms in stories,
     sessions, code and UI copy. One term per row, alphabetical. -->

| Term | Meaning | Not to be confused with |
|---|---|---|
| TODO(doc) | | |
`;

export const PRODUCT_TEMPLATES: Record<ProductDocType, string> = {
  persona: PERSONA,
  job: JOB,
  epic: EPIC,
  story: STORY,
  journey: JOURNEY,
  session: SESSION,
};

export const PRODUCT_README_TEMPLATE = README;
export const PRODUCT_GLOSSARY_TEMPLATE = GLOSSARY;

/** Fill a template's `{{id}}`/`{{title}}` placeholders. Quotes in the title are escaped for YAML. */
export function fillTemplate(type: ProductDocType, id: string, title: string): string {
  const yamlSafe = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const [front, ...rest] = PRODUCT_TEMPLATES[type].split("\n---\n");
  return [front!.replaceAll("{{id}}", id).replaceAll("{{title}}", yamlSafe), ...rest]
    .join("\n---\n")
    .replaceAll("{{id}}", id)
    .replaceAll("{{title}}", title);
}

/** The id after the highest existing one of this type (`STORY-007` → `STORY-008`). */
export function nextProductId(type: ProductDocType, existingIds: string[]): string {
  const prefix = PRODUCT_ID_PREFIX[type];
  let max = 0;
  for (const id of existingIds) {
    const m = new RegExp(`^${prefix}-(\\d+)`).exec(id);
    if (m) max = Math.max(max, Number.parseInt(m[1]!, 10));
  }
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

/** Conventional file path for a document: `docs/product/stories/STORY-001-sign-in.md`. */
export function productDocPath(type: ProductDocType, id: string, title: string): string {
  const slug = slugify(title).slice(0, 48).replace(/-+$/, "") || "doc";
  return `docs/product/${PRODUCT_TYPE_DIRS[type]}/${id}-${slug}.md`;
}

/**
 * Render a structured document (frontmatter fields + markdown body) as a
 * product-doc file — the path LLM drafts take to become files. Undefined and
 * empty-array fields are dropped so the output reads like a hand-written doc.
 */
export function renderProductMarkdown(fields: Record<string, unknown>, body: string): string {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    clean[key] = value;
  }
  const yaml = stringifyYaml(clean, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${body.trim()}\n`;
}
