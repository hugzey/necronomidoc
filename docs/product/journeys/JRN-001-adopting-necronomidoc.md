---
id: JRN-001
title: A team adopts necronomidoc
status: accepted
persona: PER-001
jobs: [JOB-002, JOB-001, JOB-003]
stages:
  - name: Set up
    goal: A running server with the team's repos registered
    actions: [Deploys the container, Registers repos, Adds webhooks]
    touchpoints: [Deploy guides, necronomidoc CLI, GitHub settings]
    thoughts: ["Is this going to be one more thing to babysit?"]
    emotion: 3
    painPoints: [Toolchains for Python/C# extraction on the host]
    opportunities: [doctor names the exact missing toolchain]
    sessions: [SES-002]
    stories: [STORY-002]
  - name: Use
    goal: Developers and agents get answers from the docs
    actions: [Browses the site, Connects agents over MCP]
    touchpoints: [Doc site, MCP endpoint]
    thoughts: ["The agent stopped reinventing our helpers."]
    emotion: 4
    sessions: [SES-001]
    stories: [STORY-001]
  - name: Grow
    goal: The docs describe what the product is for, and stay true
    actions: [Writes product docs, Adds product lint to CI]
    touchpoints: [docs/product/, CI pipeline, Product page]
    thoughts: ["Refactors stopped silently breaking checkout."]
    emotion: 5
    painPoints: [Writing the first sessions takes time]
    opportunities: [enrich --product drafts a first set to edit]
    sessions: [SES-003]
    stories: [STORY-003, STORY-004]
---

# A team adopts necronomidoc
