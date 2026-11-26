---
id: STORY-001
title: Search the docs by concept over MCP
status: implemented
persona: PER-003
want: to search every documented repo by concept and get ranked, typed hits
soThat: I can find existing code even when I don't know its name
jobs: [JOB-001]
activity: Use
step: Find code
release: MVP
priority: must
code:
  - packages/mcp/src/search.ts#buildCorpusDocs
  - packages/mcp/src/store.ts#ManifestStore.search
---

# Search the docs by concept over MCP

## Acceptance criteria

```gherkin
@AC-1
Scenario: Product docs are searchable alongside code
  Given a repo whose docs/product/ defines a persona "Returning shopper"
  When the agent calls search_docs with "returning shopper"
  Then a hit of type "product" is returned
```
