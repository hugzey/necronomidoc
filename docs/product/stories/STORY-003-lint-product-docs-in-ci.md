---
id: STORY-003
title: Lint product docs in CI
status: implemented
persona: PER-002
want: a lint command that validates product docs against the code and the tests
soThat: drift between documented intent and behaviour fails the build
jobs: [JOB-003]
activity: Grow
step: Guard intent
release: R2
priority: must
code:
  - packages/server/src/product.ts#lintProduct
  - packages/enrichment/src/product/build.ts#buildProduct
---

# Lint product docs in CI

## Acceptance criteria

```gherkin
@AC-1
Scenario: A binding to removed code is an error
  Given an accepted session whose step binds "src/api/removed.ts#gone"
  When product lint runs
  Then it reports a broken-binding error for that step
  And it exits non-zero

@AC-2
Scenario: Changed code under an unchanged doc asks for review
  Given a published session bound to "src/api/cart.ts#checkout"
  When checkout's code changes and the docs are rebuilt
  Then the binding is marked "changed" and the session is stale
```

## Requirements (EARS)

- **REQ-1** WHEN a test cites an id no product doc defines THE linter SHALL report an orphan-test-ref warning
