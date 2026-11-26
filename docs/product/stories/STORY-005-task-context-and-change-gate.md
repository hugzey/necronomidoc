---
id: STORY-005
title: Get a task's context in one call and gate the change
status: implemented
persona: PER-003
want: to describe my task once and get the relevant code, boundaries, intents and conventions within a token budget — then check my diff before committing
soThat: I stop spending tool calls and tokens rediscovering the repo, and my change keeps its intents, boundaries and tests intact
jobs: [JOB-001, JOB-003]
activity: Use
step: Find before writing
release: R3
priority: must
code:
  - packages/mcp/src/context.ts#getContextForTask
  - packages/mcp/src/change.ts#checkChange
  - packages/mcp/src/duplicates.ts#isThisADuplicate
  - packages/mcp/src/changes.ts#whatChangedSince
---

# Get a task's context in one call and gate the change

## Acceptance criteria

```gherkin
@AC-1
Scenario: One packed, budgeted bundle per task
  Given a repo with a curated subsystem map, invariants and a test importing a helper
  When the agent calls get_context_for_task with a task and a token budget
  Then the top symbols with signatures, the owning subsystem's boundaries and invariants, and the nearby tests come back
  And the response stays within the budget, reporting what was omitted

@AC-2
Scenario: Proposed code that already exists is flagged
  Given an existing formatCurrency helper
  When the agent asks is_this_a_duplicate for "formatMoney" that formats money
  Then the verdict is likely-duplicate and formatCurrency is the top candidate

@AC-3
Scenario: A diff is gated before commit
  Given a diff that adds a React import to a subsystem whose boundary excludes React
  When the agent calls check_change with the diff
  Then the verdict is review, the boundary statement is quoted, and the tests importing the file are listed to run

@AC-4
Scenario: A returning agent reads only what changed
  Given two published versions where one function's signature changed
  When the agent calls what_changed_since with the older version
  Then only the changed file and symbol come back, with the old signature
```

## Requirements (EARS)

- **REQ-1** WHEN an agent-written doc proposal fails the documentation linter, THE SYSTEM SHALL return the findings and store nothing.
- **REQ-2** WHILE a proposal has not been accepted by a human, THE SYSTEM SHALL NOT publish it.
