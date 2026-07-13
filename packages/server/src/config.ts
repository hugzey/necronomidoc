import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface NecronomidocConfig {
  /** Where all state lives (manifests + built site data). Portable, fs-only. */
  dataDir: string;
  /** HTTP port for `serve`. */
  port: number;
  /**
   * Admin bearer token: authorizes POST /api/build for any repo and unlocks
   * failure detail on /api/status. Empty disables both.
   */
  token: string;
  /** Directory of the built static site (SPA). */
  siteDir: string;
  /** Shared fallback webhook secret; a repo's `secretEnv` takes precedence. */
  webhookSecret: string;
  /** Debounce window for coalescing rapid pushes (ms). */
  debounceMs: number;
  /** Global cap on concurrent builds. */
  buildConcurrency: number;
  /** Per-build timeout (ms). */
  buildTimeoutMs: number;
  /**
   * When true, the whole surface (site, /data, /mcp, admin) requires the shared
   * token — via a session-cookie login for browsers or `Authorization: Bearer`
   * for MCP/admin/CI. Requires `token` to be set (the server refuses to start
   * otherwise). Leave off to run behind reverse-proxy auth (decision 0014).
   */
  authRequired: boolean;
  /** HMAC key for session cookies; falls back to `token` when empty. */
  sessionSecret: string;
  /** Log line format: structured JSON (default) or human-readable text. */
  logFormat: "json" | "text";
}

const DEFAULTS: NecronomidocConfig = {
  dataDir: ".necronomidoc-data",
  port: 4319,
  token: "",
  siteDir: "packages/site/dist",
  webhookSecret: "",
  debounceMs: 10_000,
  buildConcurrency: 1,
  buildTimeoutMs: 10 * 60_000,
  authRequired: false,
  sessionSecret: "",
  logFormat: "json",
};

/**
 * Resolve config from (lowest to highest precedence): defaults, a
 * `necronomidoc.config.json` in cwd, then environment variables. All state is
 * confined to `dataDir` so the whole system is host-portable (decision 0002).
 */
export function loadConfig(overrides: Partial<NecronomidocConfig> = {}): NecronomidocConfig {
  let fileCfg: Partial<NecronomidocConfig> = {};
  const cfgPath = resolve(process.cwd(), "necronomidoc.config.json");
  if (existsSync(cfgPath)) {
    try {
      fileCfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Partial<NecronomidocConfig>;
    } catch (err) {
      console.warn(`[config] ignoring malformed ${cfgPath}: ${(err as Error).message}`);
    }
  }
  const env: Partial<NecronomidocConfig> = {};
  if (process.env.DOCS_DATA_DIR) env.dataDir = process.env.DOCS_DATA_DIR;
  if (process.env.PORT) env.port = Number.parseInt(process.env.PORT, 10);
  if (process.env.DOCS_TOKEN) env.token = process.env.DOCS_TOKEN;
  if (process.env.SITE_DIR) env.siteDir = process.env.SITE_DIR;
  if (process.env.DOCS_WEBHOOK_SECRET) env.webhookSecret = process.env.DOCS_WEBHOOK_SECRET;
  if (process.env.DOCS_DEBOUNCE_MS) env.debounceMs = Number.parseInt(process.env.DOCS_DEBOUNCE_MS, 10);
  if (process.env.DOCS_BUILD_CONCURRENCY)
    env.buildConcurrency = Number.parseInt(process.env.DOCS_BUILD_CONCURRENCY, 10);
  if (process.env.DOCS_BUILD_TIMEOUT_MS)
    env.buildTimeoutMs = Number.parseInt(process.env.DOCS_BUILD_TIMEOUT_MS, 10);
  if (process.env.DOCS_AUTH_REQUIRED)
    env.authRequired = /^(1|true|yes)$/i.test(process.env.DOCS_AUTH_REQUIRED);
  if (process.env.DOCS_SESSION_SECRET) env.sessionSecret = process.env.DOCS_SESSION_SECRET;
  if (process.env.DOCS_LOG_FORMAT === "json" || process.env.DOCS_LOG_FORMAT === "text")
    env.logFormat = process.env.DOCS_LOG_FORMAT;

  const defined = <T extends object>(o: T): Partial<T> =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

  const merged = {
    ...DEFAULTS,
    ...defined(fileCfg),
    ...defined(env),
    ...defined(overrides),
  };
  merged.dataDir = resolve(merged.dataDir);
  merged.siteDir = resolve(merged.siteDir);
  return merged;
}
