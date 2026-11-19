---
id: SES-001
title: Coding agent checks whether code already exists
status: implemented
persona: PER-003
job: JOB-001
intent: "Before I write a currency formatter — does this repo already have one?"
trigger: The developer asked the agent to add price formatting to a component
entry:
  channel: mcp
  auth: bearer token (DOCS_TOKEN)
  preconditions:
    - The repo is registered and has at least one published build
    - The agent's MCP client is configured with the server's /mcp URL
steps:
  - id: S1
    action: Lists the documented repos to find the right slug
    surface: MCP tool `list_repos`
    system: Answers from the in-memory manifest store
    expects: The repo appears with a one-line summary
    code: [packages/mcp/src/store.ts#ManifestStore.listRepos]
  - id: S2
    action: Searches by concept, not by name
    surface: MCP tool `search_docs` ("currency formatting")
    system: Ranks files, symbols, subsystems, core docs and product docs
    expects: A ranked hit list with ids for follow-up calls
    code: [packages/mcp/src/store.ts#ManifestStore.search, packages/mcp/src/search.ts#buildCorpusDocs]
    branches:
      - when: Nothing relevant comes back
        goto: S4
  - id: S3
    action: Inspects the best hit's signature and purpose
    surface: MCP tool `get_function_doc`
    system: Returns signature, params, examples and purpose summary with provenance
    expects: Enough to call the function without opening the file
    code: [packages/mcp/src/store.ts#ManifestStore.getSymbolById]
    outcome: OUT-1
  - id: S4
    action: Asks where new code of this kind belongs
    surface: MCP tool `get_subsystem_overview`
    system: Returns subsystems with owns / does-not-own boundaries
    expects: A subsystem whose boundaries say the formatter belongs there
    code: [packages/mcp/src/store.ts#ManifestStore.getSubsystems]
    outcome: OUT-2
outcomes:
  - id: OUT-1
    kind: fulfilled
    title: Reuses the existing function
    criteria:
      - The agent imports the existing symbol instead of writing a new one
  - id: OUT-2
    kind: diverted
    title: Nothing exists — writes it in the right place
    criteria:
      - New code lands in the subsystem whose boundaries own it
stories: [STORY-001]
journey: { id: JRN-001, stage: Use }
metrics:
  - Intent fulfilled in ≤ 3 tool calls
---

# Coding agent checks whether code already exists

## Narrative

Asked to add price formatting, the agent first asks necronomidoc rather than
grepping. A concept search surfaces the existing formatter; its documented
signature is enough to call it. When nothing matches, the subsystem
boundaries tell the agent where the new code belongs.
