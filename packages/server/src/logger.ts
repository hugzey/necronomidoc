import type { Context, Next } from "hono";

/**
 * Dependency-free structured logger (decision 0002 keeps the runtime footprint
 * to one Node process with no external services — a small JSON logger honours
 * that better than pulling in a logging framework). One line per event so
 * `docker logs`, journald, and log shippers can parse without config.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "json" | "text";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Keys whose values are redacted wherever they appear in a log record. */
const SECRET_KEYS = /^(authorization|token|secret|password|cookie|apitoken|api_token)$/i;

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = SECRET_KEYS.test(k) ? "[redacted]" : v;
  }
  return out;
}

export interface Logger {
  level: LogLevel;
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(opts: { format?: LogFormat; level?: LogLevel } = {}): Logger {
  const format = opts.format ?? "json";
  const level = opts.level ?? "info";
  const emit = (lvl: LogLevel, msg: string, fields: Record<string, unknown> = {}): void => {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
    const safe = redact(fields);
    const sink = lvl === "error" || lvl === "warn" ? console.error : console.log;
    if (format === "json") {
      sink(JSON.stringify({ level: lvl, msg, ...safe }));
    } else {
      const extra = Object.entries(safe)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
      sink(`[${lvl}] ${msg}${extra ? " " + extra : ""}`);
    }
  };
  return {
    level,
    log: emit,
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

/**
 * Request-logging middleware: one structured line per request with the method,
 * path, status, and duration. Webhook deliveries are tagged with their
 * provider (`hookSource`) so ingestion traffic is greppable in the logs
 * (slice 6 operability: request logging with hook-source tagging).
 */
export function requestLogger(log: Logger) {
  return async (c: Context, next: Next): Promise<void> => {
    const start = Date.now();
    await next();
    const path = c.req.path;
    const fields: Record<string, unknown> = {
      method: c.req.method,
      path,
      status: c.res.status,
      durationMs: Date.now() - start,
    };
    const hookMatch = path.match(/^\/hooks\/([^/]+)$/);
    if (hookMatch) fields.hookSource = hookMatch[1];
    // 5xx is a server problem worth warn-level; everything else is info.
    log.log(c.res.status >= 500 ? "warn" : "info", "request", fields);
  };
}
