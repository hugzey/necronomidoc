import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";

describe("structured logger", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits one JSON line per event", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
    createLogger().info("request", { method: "GET", path: "/mcp", status: 200 });
    expect(JSON.parse(lines[0]!)).toEqual({
      level: "info",
      msg: "request",
      method: "GET",
      path: "/mcp",
      status: 200,
    });
  });

  it("redacts secret-shaped fields", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
    createLogger().info("request", { authorization: "Bearer hunter2", token: "abc", path: "/x" });
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.authorization).toBe("[redacted]");
    expect(parsed.token).toBe("[redacted]");
    expect(parsed.path).toBe("/x");
    expect(lines[0]).not.toContain("hunter2");
  });

  it("respects the level threshold and routes warn/error to stderr", () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: string) => void out.push(l));
    vi.spyOn(console, "error").mockImplementation((l: string) => void err.push(l));
    const log = createLogger({ level: "warn" });
    log.info("dropped");
    log.warn("kept");
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
  });

  it("supports human-readable text format", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
    createLogger({ format: "text" }).info("request", { path: "/x", status: 200 });
    expect(lines[0]).toBe("[info] request path=/x status=200");
  });
});
