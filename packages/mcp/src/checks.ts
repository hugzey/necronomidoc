import { normalizeProductRef, type SessionDoc, type SessionStep } from "@necronomidoc/docmodel";
import type { ManifestStore } from "./store.js";
import type { ToolResult } from "./tools.js";

/**
 * Executable session checks (decision 0024): for each intent interaction
 * session, a test skeleton with one test per outcome — the steps on the path
 * to that outcome as actions to drive, `expects` as assertions to fill, and
 * the outcome's criteria as the final checks. Playwright for web sessions,
 * MCP client calls for agent sessions, process/HTTP calls for CLI/API ones.
 *
 * Tests are declared `test.fixme` / `it.skip` and titled with the outcome id
 * (`[SES-001.OUT-1] …`). Skipped tests are NOT counted as coverage by the
 * test scan, so a skeleton never fakes traceability: implementing it (and
 * dropping `.fixme`/`.skip`) is what makes "does SES-001 still fulfil?" a
 * real, runnable check.
 */

export type CheckFramework = "playwright" | "mcp" | "cli" | "api" | "generic";

export interface SessionCheckFile {
  /** Suggested repo-relative path. */
  path: string;
  framework: CheckFramework;
  session: string;
  /** The outcome refs it checks (`SES-1.OUT-1`, …). */
  outcomes: string[];
  content: string;
}

export function frameworkFor(session: SessionDoc): CheckFramework {
  const channel = (session.entry.channel ?? "").toLowerCase();
  if (/web|browser|ui|site|mobile|desktop/.test(channel)) return "playwright";
  if (/mcp|agent/.test(channel)) return "mcp";
  if (/cli|terminal|shell|command/.test(channel)) return "cli";
  if (/api|http|rest|graphql|webhook/.test(channel)) return "api";
  return "generic";
}

/** Successors of a step: `next`/following step (unless terminal) plus branch targets. */
function successors(session: SessionDoc, step: SessionStep): string[] {
  const out: string[] = [];
  const idx = session.steps.findIndex((s) => s.id === step.id);
  if (step.outcome) out.push(step.outcome);
  else if (step.next) out.push(step.next);
  else if (session.steps[idx + 1]) out.push(session.steps[idx + 1]!.id);
  for (const b of step.branches) out.push(b.goto);
  return out;
}

/**
 * Shortest step path from the first step to an outcome, with the branch
 * condition taken on the way (if any).
 */
export function pathToOutcome(session: SessionDoc, outcomeId: string): { steps: SessionStep[]; via: string[] } | undefined {
  const byId = new Map(session.steps.map((s) => [s.id, s]));
  const first = session.steps[0];
  if (!first) return undefined;
  const queue: { id: string; path: SessionStep[]; via: string[] }[] = [{ id: first.id, path: [first], via: [] }];
  const seen = new Set([first.id]);
  while (queue.length > 0) {
    const { id, path, via } = queue.shift()!;
    const step = byId.get(id)!;
    const succ = successors(session, step);
    const defaultNext = step.branches.length > 0 && succ.length > step.branches.length ? succ[0] : undefined;
    for (const next of succ) {
      // Only a branch that leaves the default flow is "taken".
      const branch = next === defaultNext ? undefined : step.branches.find((b) => b.goto === next);
      const nextVia = branch ? [...via, `${step.id}: ${branch.when}`] : via;
      if (next === outcomeId) return { steps: path, via: nextVia };
      const nextStep = byId.get(next);
      if (!nextStep || seen.has(next)) continue;
      seen.add(next);
      queue.push({ id: next, path: [...path, nextStep], via: nextVia });
    }
  }
  return undefined;
}

const q = (text: string) => JSON.stringify(text);
const comment = (text: string | undefined, indent: string) =>
  text ? text.split("\n").map((l) => `${indent}// ${l}`).join("\n") : "";

/** Backticked snake_case names in a surface/system string — MCP tool names. */
function toolNames(text: string | undefined): string[] {
  return [...(text ?? "").matchAll(/`?\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b`?/g)].map((m) => m[1]!);
}

/** `METHOD /path` in a step's system field. */
function httpCall(text: string | undefined): { method: string; path: string } | undefined {
  const m = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)/.exec(text ?? "");
  return m ? { method: m[1]!, path: m[2]!.replace(/[`.,;]+$/, "") } : undefined;
}

/** A backticked shell command in a surface (`necronomidoc build .`). */
function shellCommand(text: string | undefined): string | undefined {
  return /`([a-z][\w.-]*(?:\s+[^`]+)?)`/.exec(text ?? "")?.[1];
}

function stepBody(framework: CheckFramework, step: SessionStep, indent: string, n: number): string[] {
  const lines: string[] = [];
  const where = [step.surface && `surface: ${step.surface}`, step.system && `system: ${step.system}`].filter(Boolean).join(" — ");
  lines.push(`${indent}// ${step.id} (${step.actor}): ${step.action}${where ? ` — ${where}` : ""}`);
  if (step.code.length > 0) lines.push(`${indent}// code: ${step.code.join(", ")}`);
  if (framework === "playwright") {
    lines.push(`${indent}// TODO(check): drive this step, e.g. await page.goto("/…") or await page.getByRole("button", { name: "…" }).click();`);
    if (step.expects) {
      lines.push(`${indent}// expects: ${step.expects}`);
      lines.push(`${indent}// TODO(check): await expect(page.getByText("…")).toBeVisible();`);
    }
  } else if (framework === "mcp") {
    const tool = toolNames(`${step.surface ?? ""} ${step.system ?? ""}`)[0];
    lines.push(`${indent}const r${n} = await call(${q(tool ?? "TODO_tool_name")}, { /* TODO(check): arguments */ });`);
    lines.push(step.expects ? `${indent}// expects: ${step.expects}` : "");
    lines.push(`${indent}expect(r${n}).toBeDefined(); // TODO(check): assert what the agent observes`);
  } else if (framework === "api") {
    const call = httpCall(step.system);
    if (call) {
      lines.push(`${indent}const r${n} = await fetch(\`\${BASE_URL}${call.path}\`, { method: ${q(call.method)} /* TODO(check): headers, body */ });`);
      lines.push(`${indent}expect(r${n}.ok).toBe(true);`);
    } else {
      lines.push(`${indent}// TODO(check): call the API for this step`);
    }
    if (step.expects) lines.push(`${indent}// expects: ${step.expects}`);
  } else if (framework === "cli") {
    const cmd = shellCommand(step.surface) ?? shellCommand(step.system);
    lines.push(
      cmd
        ? `${indent}const out${n} = run(${q(cmd)}); // TODO(check): adjust arguments`
        : `${indent}// TODO(check): run the command for this step, e.g. const out${n} = run("…");`,
    );
    if (step.expects) lines.push(`${indent}// expects: ${step.expects}`, `${indent}// TODO(check): expect(out${n}).toContain("…");`);
  } else {
    lines.push(`${indent}// TODO(check): perform this step`);
    if (step.expects) lines.push(`${indent}// expects: ${step.expects}`, `${indent}// TODO(check): assert it`);
  }
  return lines.filter((l) => l !== "");
}

/** Generate the check skeleton for one session. */
export function sessionCheckSkeleton(session: SessionDoc, options: { framework?: CheckFramework } = {}): SessionCheckFile {
  const framework = options.framework ?? frameworkFor(session);
  const ext = framework === "playwright" ? "spec.ts" : "test.ts";
  const slug = session.id.toLowerCase();
  const path = `tests/product/${slug}.check.${ext}`;
  const outcomes = session.outcomes.map((o) => normalizeProductRef(`${session.id}.${o.id}`));
  const head: string[] = [
    `// Executable check skeleton for ${session.id} "${session.title}" — generated by necronomidoc`,
    `// from ${session.path}. Fill every TODO(check), then drop \`.${framework === "playwright" ? "fixme" : "skip"}\`:`,
    "// skipped checks are not counted as coverage, implemented ones are (titles cite the outcome ids).",
    `// Intent: ${session.intent}`,
  ];
  const entry = [session.entry.channel, session.entry.auth].filter(Boolean).join(", ");
  if (entry) head.push(`// Entry: ${entry}`);
  for (const p of session.entry.preconditions) head.push(`// Precondition: ${p}`);
  head.push("");

  const imports: string[] = [];
  const helpers: string[] = [];
  if (framework === "playwright") {
    imports.push('import { expect, test } from "@playwright/test";');
  } else {
    imports.push('import { describe, expect, it } from "vitest";');
    if (framework === "mcp") {
      imports.push('import { Client } from "@modelcontextprotocol/sdk/client/index.js";');
      imports.push('import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";');
      helpers.push(
        "",
        'const MCP_URL = process.env.MCP_URL ?? "http://localhost:4319/mcp";',
        "let client: Client;",
        "async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {",
        "  if (!client) {",
        '    client = new Client({ name: "session-check", version: "0.0.0" });',
        "    const headers: Record<string, string> = process.env.DOCS_TOKEN ? { Authorization: `Bearer ${process.env.DOCS_TOKEN}` } : {};",
        "    await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers } }));",
        "  }",
        "  const res = await client.callTool({ name, arguments: args });",
        "  return JSON.parse((res.content as { text: string }[])[0]!.text) as Record<string, unknown>;",
        "}",
      );
    } else if (framework === "api") {
      helpers.push("", 'const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";');
    } else if (framework === "cli") {
      imports.push('import { execSync } from "node:child_process";');
      helpers.push("", 'const run = (cmd: string): string => execSync(cmd, { encoding: "utf8", stdio: "pipe" });');
    }
  }

  const body: string[] = [];
  const declare = framework === "playwright" ? "test.fixme" : "it.skip";
  const describe = framework === "playwright" ? "test.describe" : "describe";
  const fnArgs = framework === "playwright" ? "async ({ page }) =>" : "async () =>";
  body.push(`${describe}(${q(`${session.id} ${session.title}`)}, () => {`);
  session.outcomes.forEach((outcome, i) => {
    const ref = `${session.id}.${outcome.id}`;
    const route = pathToOutcome(session, outcome.id);
    body.push(`  ${declare}(${q(`[${ref}] ${outcome.title} (${outcome.kind})`)}, ${fnArgs} {`);
    if (session.entry.auth) body.push(`    // TODO(check): set up "${session.entry.auth}"`);
    for (const v of route?.via ?? []) body.push(`    // branch taken — ${v}`);
    if (!route) body.push("    // TODO(check): no step path reaches this outcome — check the session's next/branches");
    (route?.steps ?? []).forEach((step, n) => body.push(...stepBody(framework, step, "    ", n + 1)));
    if (outcome.criteria.length > 0) {
      body.push("    // Outcome criteria — what must be true now:");
      for (const c of outcome.criteria) body.push(`    // - ${c}`, "    // TODO(check): assert it");
    }
    body.push("  });");
    if (i < session.outcomes.length - 1) body.push("");
  });
  body.push("});", "");

  return {
    path,
    framework,
    session: session.id,
    outcomes,
    content: [...head, ...imports, ...helpers, "", ...body].join("\n"),
  };
}

/** `get_session_checks`: skeletons for one session or every session in a repo. */
export function getSessionChecks(store: ManifestStore, args: { repo: string; id?: string }): ToolResult {
  const product = store.getProduct(args.repo);
  if (!product) return { error: `No product docs published for repo "${args.repo}".` };
  const sessions = product.docs.filter((d): d is SessionDoc => d.type === "session");
  const key = args.id ? normalizeProductRef(args.id) : undefined;
  const picked = key ? sessions.filter((s) => normalizeProductRef(s.id) === key) : sessions;
  if (picked.length === 0) {
    return { error: args.id ? `No session "${args.id}" in "${args.repo}".` : `No sessions documented in "${args.repo}".`, sessions: sessions.map((s) => s.id) };
  }
  const MAX = 10;
  const files = picked.slice(0, MAX).map((s) => sessionCheckSkeleton(s));
  const tested = (s: SessionDoc) => new Set(s.tests.map((t) => t.ref));
  return {
    repo: args.repo,
    files: files.map((f) => {
      const s = picked.find((p) => p.id === f.session)!;
      const cited = tested(s);
      return { ...f, alreadyTested: f.outcomes.filter((o) => cited.has(o)) };
    }),
    ...(picked.length > MAX ? { truncated: picked.length - MAX, note: "Pass `id` for the rest, or run `necronomidoc product checks`." } : {}),
    howTo: "Write each file at `path`, fill the TODO(check) markers, drop .fixme/.skip, and run it — the titles cite the outcome ids, so the build counts them as coverage once they run.",
  };
}
