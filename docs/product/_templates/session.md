---
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
  # code: path | path#Symbol | Symbol | "GET /route" — `backticked` names in the
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
