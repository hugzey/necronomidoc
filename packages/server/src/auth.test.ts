import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "./app.js";
import { signSession, verifySession } from "./auth.js";
import { loadConfig } from "./config.js";

describe("session signing", () => {
  it("round-trips a valid session", () => {
    const cookie = signSession("s3cret", 2_000);
    expect(verifySession("s3cret", cookie, 1_000)).toBe(true);
  });

  it("rejects expiry and tampering", () => {
    const cookie = signSession("s3cret", 2_000);
    expect(verifySession("s3cret", cookie, 3_000)).toBe(false); // expired
    expect(verifySession("other", cookie, 1_000)).toBe(false); // wrong key
    const [payload, mac] = cookie.split(".");
    expect(verifySession("s3cret", `${Number(payload) + 1}.${mac}`, 1_000)).toBe(false); // forged expiry
  });
});

describe("auth gate", () => {
  let dataDir: string;
  let app: App;
  const TOKEN = "correct-horse-battery-staple";

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "necro-auth-"));
    app = createApp(
      loadConfig({ dataDir, siteDir: join(dataDir, "no-site"), token: TOKEN, authRequired: true }),
    );
  });

  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  it("refuses to start with authRequired but no token", () => {
    expect(() =>
      createApp(loadConfig({ dataDir, siteDir: join(dataDir, "no-site"), authRequired: true, token: "" })),
    ).toThrow(/no token/);
  });

  it("keeps /healthz public", async () => {
    const res = await app.fetch(new Request("http://x/healthz"));
    expect(res.status).toBe(200);
  });

  it("lets webhook deliveries through to provider verification", async () => {
    // Providers verify each delivery themselves (HMAC/basic auth); the auth
    // gate must not 401 them just because GitHub can't send our bearer token.
    const res = await app.fetch(
      new Request("http://x/hooks/github", { method: "POST", body: "{}" }),
    );
    expect(res.status).not.toBe(401); // 400 from the provider (unsigned), never the gate's 401
  });

  it("401s API requests without a credential", async () => {
    const res = await app.fetch(new Request("http://x/api/status"));
    expect(res.status).toBe(401);
  });

  it("redirects browsers to /login", async () => {
    const res = await app.fetch(
      new Request("http://x/", { headers: { accept: "text/html" } }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("accepts a bearer token on the API and MCP", async () => {
    for (const path of ["/api/status", "/data/registry.json"]) {
      const res = await app.fetch(
        new Request(`http://x${path}`, { headers: { authorization: `Bearer ${TOKEN}` } }),
      );
      expect(res.status, path).not.toBe(401);
    }
  });

  it("rejects a wrong bearer token", async () => {
    const res = await app.fetch(
      new Request("http://x/api/status", { headers: { authorization: "Bearer nope" } }),
    );
    expect(res.status).toBe(401);
  });

  it("logs in with the token and gets a working session cookie", async () => {
    const login = await app.fetch(
      new Request("http://x/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: TOKEN }),
      }),
    );
    expect(login.status).toBe(302);
    const setCookie = login.headers.get("set-cookie")!;
    expect(setCookie).toContain("necro_session=");
    expect(setCookie).toContain("HttpOnly");

    const cookie = setCookie.split(";")[0]!;
    const res = await app.fetch(new Request("http://x/api/status", { headers: { cookie } }));
    expect(res.status).toBe(200);
  });

  it("rejects a bad login", async () => {
    const login = await app.fetch(
      new Request("http://x/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "wrong" }),
      }),
    );
    expect(login.status).toBe(401);
    expect(login.headers.get("set-cookie")).toBeNull();
  });

  it("stays fully open when authRequired is off", async () => {
    const openDir = mkdtempSync(join(tmpdir(), "necro-open-"));
    try {
      const open = createApp(loadConfig({ dataDir: openDir, siteDir: join(openDir, "no-site") }));
      const res = await open.fetch(new Request("http://x/api/status"));
      expect(res.status).toBe(200);
    } finally {
      rmSync(openDir, { recursive: true, force: true });
    }
  });
});
