# 0014 — Access control baseline: shared-token auth (opt-in), sessions for browsers, bearer for MCP

**Status:** Accepted (slice 6)

## Context

Slice 6 had to answer "is the doc site team-private?" before publishing deployment guides. The docs describe internal repos — for most teams the answer is *yes, private*, but the effort had to stay proportionate: this is a single-process, filesystem-only server (decision 0002), and dragging in an identity provider dependency for the baseline would break the "stood up in under an hour" goal.

The surface has two very different client types:

- **browsers** loading the SPA and its assets — need a login page and a cookie, can't attach headers to every asset request;
- **programmatic clients** — MCP (Claude Code, Cursor), the admin API, CI — which all speak `Authorization: Bearer` natively.

## Decision

1. **The site is team-private by default in the deployment guides** (`DOCS_AUTH_REQUIRED=1`), but auth is **opt-in in the code** so local/demo use and trusted networks stay zero-config.
2. **One shared secret (`DOCS_TOKEN`), two credential shapes:**
   - Browsers sign in at `/login`; the server sets an HTTP-only, SameSite=Lax, HMAC-signed session cookie (7-day expiry, `Secure` when behind HTTPS/`X-Forwarded-Proto`). The secret itself never travels in the cookie.
   - Everything else sends `Authorization: Bearer <token>` — the same token that already gated `/api/build`, now accepted across the surface.
3. **Always-public paths:** `/healthz`/`/health` (liveness), `/login`/`/logout`, and the webhook receivers (`/hooks/*` verify each delivery cryptographically per decision 0001 — a login gate would just break providers).
4. **Reverse-proxy auth is the supported alternative**, not a fallback: teams with SSO at a proxy (oauth2-proxy, Authelia, App Service Easy Auth) leave `authRequired` off and let the proxy own identity.
5. **OIDC/SSO in-process is a documented follow-on**, kept feasible by routing every check through one middleware seam (`installAuth`) — swapping the credential check does not touch routes.
6. **Secrets hygiene:** tokens only via env vars, never in the data dir; log fields with secret-shaped names are redacted; `necronomidoc doctor` warns on weak/placeholder tokens and on exposed-but-open configurations.

## Consequences

- One token for the whole team means no per-user identity or audit trail — acceptable for the baseline, and the explicit trade for staying dependency-free. Rotation is cheap (`DOCS_TOKEN` is env-only; `DOCS_SESSION_SECRET` can rotate sessions independently).
- MCP clients configure a single static header — verified shape for Claude Code / Cursor.
- The auth gate refuses to start when `authRequired` is set without a token, so a typo'd secret can't silently deploy an open server that the operator believes is private.
- Per-repo scoped tokens (slice 2) keep working unchanged for `/api/build` + `/api/ir`.
