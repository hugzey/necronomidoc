# sample-api

Fixture repo that mixes TypeScript code with an OpenAPI spec, used to test
that both adapters run over one repo and publish under a single entry.

## Layout

- `openapi.yaml` — the REST surface (OpenAPI 3.0)
- `src/client.ts` — a typed client for it
