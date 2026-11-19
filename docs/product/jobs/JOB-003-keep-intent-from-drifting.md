---
id: JOB-003
title: Keep the product's intent from drifting
status: accepted
personas: [PER-002, PER-003]
situation: The code changes faster than anyone re-reads the product requirements
motivation: have the documented user intents checked against the code and the tests continuously
outcome: a change that breaks a user journey is caught before it ships, not after
importance: high
successMetrics:
  - product lint runs in CI and fails on broken bindings
  - Every accepted session outcome is cited by at least one test
---

# Keep the product's intent from drifting
