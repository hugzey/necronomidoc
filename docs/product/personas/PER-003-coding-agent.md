---
id: PER-003
title: Coding agent
status: accepted
summary: An LLM coding agent (Claude Code, Codex, Copilot…) working in a team repo on a developer's behalf.
role: MCP client with the bearer token
expertise: expert
goals:
  - Reuse existing code instead of writing duplicates
  - Know where new code belongs and what it must not break
frustrations:
  - Grepping a large repo without knowing the right vocabulary
  - Tool results too large for its context window
context: Connects to /mcp over streamable HTTP; every answer must fit a tool-result budget.
permissions:
  - call the read-only MCP tools
---

# Coding agent
