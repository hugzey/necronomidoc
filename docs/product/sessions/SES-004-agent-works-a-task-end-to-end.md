---
id: SES-004
title: Coding agent works a task with one context call and a pre-commit gate
status: implemented
persona: PER-003
job: JOB-001
intent: "Add price formatting to CartPage — show me only what I need, and tell me if my change breaks anything."
trigger: The developer asked the agent to add price formatting to a page
entry:
  channel: mcp
  auth: bearer token (DOCS_TOKEN)
  preconditions:
    - The repo has a published build from a current server (agent.json present)
steps:
  - id: S1
    action: Describes the task once and sets a token budget
    surface: MCP tool `get_context_for_task`
    system: Ranks code, subsystems, intents, recipes and conventions and packs them to the budget
    expects: The existing helper with its signature, trust, invariants and a real call site
    code: [packages/mcp/src/context.ts#getContextForTask]
    branches:
      - when: The bundle shows no helper for the concept
        goto: S2
  - id: S2
    action: Checks its proposed new function before writing it
    surface: MCP tool `is_this_a_duplicate`
    system: Scores existing symbols by name, purpose and signature similarity
    expects: A verdict with confidence-scored candidates
    code: [packages/mcp/src/duplicates.ts#findDuplicates]
    branches:
      - when: A likely duplicate is found
        goto: OUT-2
  - id: S3
    action: Submits its diff before committing
    surface: MCP tool `check_change`
    system: Maps the diff to intents, tests, boundaries and invariants
    expects: verdict ok, or the violations and exactly which tests to run
    code: [packages/mcp/src/change.ts#checkChange]
  - id: S4
    action: Proposes a doc fix for what it learned
    surface: MCP tool `propose_overlay`
    system: Lints the overlay and stores it as a draft for human review
    expects: An accepted draft id; nothing publishes until a human accepts it
    code: [packages/server/src/proposals.ts#ProposalStore]
    outcome: OUT-1
outcomes:
  - id: OUT-1
    kind: fulfilled
    title: Change committed with its intents, boundaries and tests respected
    criteria:
      - The commit passed check_change (or its violations were resolved)
      - The tests listed by check_change were run
  - id: OUT-2
    kind: diverted
    title: Reuses the existing helper instead of writing a duplicate
    criteria:
      - No new function duplicating an existing one is written
stories: [STORY-005]
journey: { id: JRN-001, stage: Use }
metrics:
  - Context gathered in 1 tool call (was 4–6)
---

# Coding agent works a task with one context call and a pre-commit gate

## Narrative

The agent describes its task once and gets one budgeted bundle. Before
writing a new helper it asks whether one already exists; before committing it
submits its diff to learn which intents, boundaries and tests are at stake.
What it learned about wrong or missing docs it proposes back as a draft.
