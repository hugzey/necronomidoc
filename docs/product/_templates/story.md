---
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

```gherkin
@AC-1
Scenario: TODO(doc) the main success case
  Given TODO(doc) the starting state
  When TODO(doc) the user acts
  Then TODO(doc) the observable result
```

## Requirements (EARS)

<!-- Optional system rules in EARS form. Delete this section if unused.
     Templates: THE <system> SHALL … | WHEN <trigger> THE <system> SHALL … |
     WHILE <state> … | IF <unwanted condition> THEN THE <system> SHALL … |
     WHERE <feature is included> … -->

- **REQ-1** WHEN TODO(doc) THE system SHALL TODO(doc)

## Notes
