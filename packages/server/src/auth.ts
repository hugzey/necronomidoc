import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";

/**
 * Baseline authentication (slice 6, decision 0014): one shared secret gates the
 * whole surface when `authRequired` is on. Two credential shapes, one secret:
 *
 *   • Browsers log in at `/login` with the secret and get a signed, HTTP-only
 *     session cookie (so the SPA and its assets load normally afterwards).
 *   • Programmatic clients (MCP, admin API, CI) send `Authorization: Bearer
 *     <secret>` — the shape Claude Code / Cursor MCP clients already support.
 *
 * OIDC/SSO stays a documented follow-on behind this same middleware seam; the
 * reverse-proxy path (basic-auth / SSO in nginx) is the alternative for teams
 * that want it and simply leaves `authRequired` off.
 */

const COOKIE_NAME = "necro_session";
/** Session lifetime; browsers re-login after this. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** `<expiryMs>.<hex hmac>` — the secret never travels in the cookie. */
export function signSession(secret: string, expiresAt: number): string {
  const payload = String(expiresAt);
  const mac = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${mac}`;
}

export function verifySession(secret: string, cookie: string, now: number): boolean {
  const dot = cookie.indexOf(".");
  if (dot === -1) return false;
  const payload = cookie.slice(0, dot);
  const mac = cookie.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  if (!constantTimeEqual(mac, expected)) return false;
  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** Extract a bearer token, tolerating the `Bearer ` prefix casing. */
export function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const m = authorization.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : undefined;
}

export interface AuthConfig {
  /** When false, the middleware is a no-op and the whole surface is public. */
  authRequired: boolean;
  /** Shared secret: login password and bearer token both. */
  token: string;
  /** HMAC key for session cookies; falls back to `token` when unset. */
  sessionSecret: string;
}

/** Paths that stay public even with auth on: liveness and the login flow. */
const PUBLIC_PATHS = new Set(["/health", "/healthz", "/login", "/logout"]);

/**
 * Webhook receivers can't carry our bearer token (GitHub/ADO send their own
 * credentials) and every delivery is already verified cryptographically by the
 * provider adapter (HMAC / basic auth, decision 0001) — so they bypass the
 * session gate (decision 0014 §3).
 */
const isPublicPath = (path: string): boolean => PUBLIC_PATHS.has(path) || path.startsWith("/hooks/");

/** Does this request already carry a valid credential? */
export function isAuthenticated(c: Context, cfg: AuthConfig, now: number): boolean {
  const bearer = bearerToken(c.req.header("authorization"));
  if (bearer && constantTimeEqual(bearer, cfg.token)) return true;
  const cookie = readCookie(c.req.header("cookie"), COOKIE_NAME);
  const sessionSecret = cfg.sessionSecret || cfg.token;
  return cookie ? verifySession(sessionSecret, cookie, now) : false;
}

const LOGIN_PAGE = (error?: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>necronomidoc — sign in</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;display:grid;place-items:center;min-height:100vh;margin:0}
  form{background:#1a1d24;padding:2rem;border-radius:12px;width:min(90vw,22rem);box-shadow:0 8px 30px rgba(0,0,0,.4)}
  h1{font-size:1.1rem;margin:0 0 1rem}
  input{width:100%;box-sizing:border-box;padding:.6rem;border-radius:8px;border:1px solid #333;background:#0f1115;color:#e6e6e6;margin-bottom:.75rem}
  button{width:100%;padding:.6rem;border-radius:8px;border:0;background:#6d5efc;color:#fff;font-weight:600;cursor:pointer}
  .err{color:#ff7a7a;font-size:.85rem;margin-bottom:.75rem}
</style></head>
<body><form method="post" action="/login">
  <h1>necronomidoc</h1>
  ${error ? `<div class="err">${error}</div>` : ""}
  <input type="password" name="token" placeholder="Access token" autofocus aria-label="Access token">
  <button type="submit">Sign in</button>
</form></body></html>`;

function sessionCookie(value: string, maxAgeMs: number, secure: boolean): string {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** True when the client prefers HTML — decides redirect-vs-401 on rejection. */
function wantsHtml(c: Context): boolean {
  return (c.req.header("accept") ?? "").includes("text/html");
}

/**
 * Register the login/logout routes and the gate. Call before the content
 * routes. When `authRequired` is off this only registers `/login` (which
 * immediately bounces to `/`) so the surface stays fully public.
 */
export function installAuth(
  app: {
    get: (path: string, handler: (c: Context) => Response | Promise<Response>) => unknown;
    post: (path: string, handler: (c: Context) => Response | Promise<Response>) => unknown;
    use: (mw: (c: Context, next: Next) => Promise<void | Response>) => unknown;
  },
  cfg: AuthConfig,
  now: () => number = Date.now,
): void {
  // Secure cookies over HTTPS only; detect via the proxy header so a
  // reverse-proxy TLS terminator still gets Secure cookies.
  const isSecure = (c: Context): boolean =>
    (c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "")) === "https";

  app.get("/login", (c) => {
    if (!cfg.authRequired || isAuthenticated(c, cfg, now())) return c.redirect("/");
    return c.html(LOGIN_PAGE());
  });

  app.post("/login", async (c) => {
    if (!cfg.authRequired) return c.redirect("/");
    let submitted: string | undefined;
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("application/json")) {
      submitted = ((await c.req.json().catch(() => ({}))) as { token?: string }).token;
    } else {
      const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
      submitted = typeof form.token === "string" ? form.token : undefined;
    }
    if (!submitted || !constantTimeEqual(submitted, cfg.token)) {
      return c.html(LOGIN_PAGE("Invalid token."), 401);
    }
    const secret = cfg.sessionSecret || cfg.token;
    const cookie = signSession(secret, now() + SESSION_TTL_MS);
    c.header("Set-Cookie", sessionCookie(cookie, SESSION_TTL_MS, isSecure(c)));
    return c.redirect("/");
  });

  app.post("/logout", (c) => {
    c.header("Set-Cookie", sessionCookie("", 0, isSecure(c)));
    return c.redirect("/login");
  });

  if (!cfg.authRequired) return;

  app.use(async (c, next) => {
    if (isPublicPath(c.req.path)) return next();
    if (isAuthenticated(c, cfg, now())) return next();
    if (wantsHtml(c)) return c.redirect("/login");
    return c.json({ error: "Unauthorized" }, 401);
  });
}
