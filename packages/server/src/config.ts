import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface NecronomidocConfig {
  /** Where all state lives (manifests + built site data). Portable, fs-only. */
  dataDir: string;
  /** HTTP port for `serve`. */
  port: number;
  /** Bearer token required by POST /api/build. Empty disables the endpoint. */
  token: string;
  /** Directory of the built static site (SPA). */
  siteDir: string;
}

const DEFAULTS: NecronomidocConfig = {
  dataDir: ".necronomidoc-data",
  port: 4319,
  token: "",
  siteDir: "packages/site/dist",
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
