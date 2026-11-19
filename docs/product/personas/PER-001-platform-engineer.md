---
id: PER-001
title: Platform engineer
status: accepted
summary: Runs shared developer tooling for several teams and owns the necronomidoc deployment.
role: server operator (holds DOCS_TOKEN)
expertise: expert
goals:
  - Docs for every team repo with no per-repo babysitting
  - One small, boring service to operate and back up
frustrations:
  - Doc sites that rot because rebuilding them is manual
  - Tools that need a database or a fleet of sidecars
context: Deploys on EC2, Azure App Service or an on-prem box; works from a terminal and CI config.
permissions:
  - register and remove repos
  - trigger builds and enrichment
  - read build status and logs
---

# Platform engineer
