---
id: SES-003
title: Developer documents a user intent and guards it in CI
status: implemented
persona: PER-002
job: JOB-003
intent: "Write down how checkout is supposed to work, and get told when the code stops matching."
trigger: A refactor of checkout is planned and the team wants a safety net
entry:
  channel: cli
  auth: repo committer
  preconditions:
    - The repo builds with necronomidoc
steps:
  - id: S1
    action: Scaffolds the product-doc folder
    surface: "`necronomidoc product init`"
    system: Writes docs/product/ with README, glossary, templates and schema.json
    expects: The folder layout and one template per document type
    code: [packages/server/src/product.ts#initProductDocs]
  - id: S2
    action: Creates a session with the next free id and fills it in
    surface: "`necronomidoc product new session --title …`"
    system: Allocates SES-nnn from existing ids and renders the template
    expects: A new file with template markers to replace
    code: [packages/server/src/product.ts#newProductDoc, packages/enrichment/src/product/templates.ts#nextProductId]
  - id: S3
    action: Binds steps to code and names tests after outcome ids
    surface: The session file's `code:` lists and the test suite
    expects: Tests named like `[SES-007.OUT-1] …`
  - id: S4
    action: Runs the linter locally and in CI
    surface: "`necronomidoc product lint`"
    system: Extracts the repo, resolves bindings, scans tests, validates every doc
    expects: Coverage summary and findings; non-zero exit on errors
    code: [packages/server/src/product.ts#lintProduct, packages/enrichment/src/product/build.ts#buildProduct]
    outcome: OUT-1
    branches:
      - when: A refactor renamed a bound function
        goto: S5
  - id: S5
    action: Sees the broken binding and updates the doc (or the code)
    surface: CI log / Product page findings
    expects: "✗ … no longer resolves — the documented behaviour has drifted"
    outcome: OUT-2
outcomes:
  - id: OUT-1
    kind: fulfilled
    title: The intent is documented and verified on every change
    criteria:
      - product lint exits 0 and every outcome is cited by a test
  - id: OUT-2
    kind: diverted
    title: Drift is caught before merge
    criteria:
      - The CI run fails with a broken-binding error naming the step
stories: [STORY-003, STORY-004]
journey: { id: JRN-001, stage: Grow }
---

# Developer documents a user intent and guards it in CI

## Narrative

A developer writes the checkout intent down as a session, binds each step to
the code that implements it, and names tests after its outcomes. From then on
`product lint` in CI fails the moment a refactor breaks a binding, and the
Product page shows which outcomes have no test.
