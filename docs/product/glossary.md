# Glossary

| Term | Meaning | Not to be confused with |
|---|---|---|
| Binding | A reference from a product doc to code (`path#Symbol`, `GET /route`), resolved at build time | An import |
| Core doc | One of the four per-repo documents: overview, conventions, packages, architecture | Product docs |
| Drift | A binding that no longer resolves (broken) or whose code changed since the doc was verified (changed) | Staleness of LLM summaries |
| Enrichment | Purpose summaries layered over extracted facts (human > llm > heuristic) | Extraction |
| Intent | What a user arrives wanting to get done — recorded as a job (JOB-…) | A feature |
| Interaction session | One persona, one intent, followed end to end through the product (SES-…) | A login session |
| Manifest | A published JSON artifact under `data/repos/<slug>/` | The registry |
| Surface | An API operation or screen-like component where users interact | An entry point |
