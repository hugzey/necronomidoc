# Product documentation

necronomidoc serves three kinds of user. **Platform engineers** (PER-001)
stand the server up once and want it to keep itself current (JOB-002).
**Application developers** (PER-002) read the docs to understand code they
didn't write, and describe what their own product is for (JOB-003).
**Coding agents** (PER-003) query it over MCP so they reuse existing code
instead of duplicating it (JOB-001), and check which user intents a change
could break (JOB-003).

The core intents, end to end: SES-001 (an agent checks whether code already
exists), SES-002 (an engineer registers a repo so pushes rebuild its docs) and
SES-003 (a developer documents an intent and keeps it from drifting).

This folder is necronomidoc dogfooding its own product-doc standard — see
[the standard](../product-docs.md) for the format.
