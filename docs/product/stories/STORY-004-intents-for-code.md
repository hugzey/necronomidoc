---
id: STORY-004
title: Ask which intents run through a file
status: implemented
persona: PER-003
want: to ask which sessions and stories bind to the file I'm about to change
soThat: I keep their outcomes and acceptance criteria true
jobs: [JOB-003]
activity: Grow
step: Guard intent
release: R2
priority: should
code:
  - packages/mcp/src/tools.ts#tools
---

# Ask which intents run through a file

## Acceptance criteria

```gherkin
@AC-1
Scenario: Sessions and stories bound to a symbol are returned
  Given a session step and a story both bound to "src/api/cart.ts#checkout"
  When the agent calls find_intents_for_code for that file and symbol
  Then both documents are returned with the steps, outcomes and criteria to preserve
```
