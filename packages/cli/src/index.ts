#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DocModel, exportJsonSchemas, slugify } from "@necronomidoc/docmodel";
import {
  buildRepo,
  cloneDirFor,
  enrichRepo,
  KNOWN_PROVIDERS,
  listAdapters,
  loadConfig,
  purgeRepoDocs,
  readBuildStatus,
  readSourceRegistry,
  removeClone,
  removeSourceRepo,
  reviewStale,
  startServer,
  upsertSourceRepo,
} from "@necronomidoc/server";

interface Flags {
  _: string[];
  [key: string]: string | boolean | string[];
}

/** Minimal `--flag value` / `--flag=value` / `--bool` parser. */
function parseArgs(argv: string[]): Flags {
  const flags: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          flags[arg.slice(2)] = next;
          i++;
        } else {
          flags[arg.slice(2)] = true;
        }
      }
    } else {
      (flags._ as string[]).push(arg);
    }
  }
  return flags;
}

function str(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

const USAGE = `necronomidoc — team documentation server

Usage:
  necronomidoc build <path-or-git-url> [--name <n>] [--ref <ref>] [--data-dir <dir>]
  necronomidoc enrich <repo-id-or-path-or-url> [--dry-run] [--max-files <n>]
                 [--max-tokens <n>] [--model <id>] [--subsystems]
                 [--review-stale] [--name <n>] [--ref <ref>] [--data-dir <dir>]
  necronomidoc serve [--port <p>] [--data-dir <dir>] [--site-dir <dir>] [--token <t>]
  necronomidoc repo add <url-or-path> [--id <slug>] [--provider github|ado|generic]
                 [--branch <b>] [--name <n>] [--secret-env <VAR>] [--token-env <VAR>]
                 [--api-token-env <VAR>] [--disabled] [--data-dir <dir>]
  necronomidoc repo list [--data-dir <dir>]
  necronomidoc repo remove <id> [--purge] [--data-dir <dir>]
  necronomidoc validate <docmodel.json>
  necronomidoc export-schemas [<out.json>]
  necronomidoc doctor [--data-dir <dir>]

Env: DOCS_DATA_DIR, PORT, DOCS_TOKEN, SITE_DIR, DOCS_WEBHOOK_SECRET,
     DOCS_DEBOUNCE_MS, DOCS_BUILD_CONCURRENCY, DOCS_BUILD_TIMEOUT_MS,
     ANTHROPIC_API_KEY (enrich), NECRONOMIDOC_ENRICH_MODEL (enrich)
`;

async function cmdBuild(flags: Flags): Promise<number> {
  const target = (flags._ as string[])[1];
  if (!target) {
    console.error("build: missing <path-or-git-url>");
    return 1;
  }
  const config = loadConfig({ dataDir: str(flags, "data-dir") });
  console.log(`Building "${target}" → ${config.dataDir}`);
  const result = await buildRepo({
    dataDir: config.dataDir,
    target,
    name: str(flags, "name"),
    ref: str(flags, "ref"),
  });
  const { entry, adapter } = result;
  console.log(
    `✓ ${entry.name} [${adapter}] — ${entry.fileCount} files, ${entry.symbolCount} symbols`,
  );
  console.log(`  manifests written under ${config.dataDir}/repos/${entry.slug}/`);
  return 0;
}

function int(flags: Flags, key: string): number | undefined {
  const v = str(flags, key);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${key} must be a positive integer`);
  return n;
}

async function cmdEnrich(flags: Flags): Promise<number> {
  const target = (flags._ as string[])[1];
  if (!target) {
    console.error("enrich: missing <repo-id-or-path-or-url>");
    return 1;
  }
  const config = loadConfig({ dataDir: str(flags, "data-dir") });

  if (flags["review-stale"] === true) {
    const review = await reviewStale({
      dataDir: config.dataDir,
      target,
      name: str(flags, "name"),
      ref: str(flags, "ref"),
    });
    console.log(review);
    return 0;
  }

  const dryRun = flags["dry-run"] === true;
  if (!dryRun && !process.env["ANTHROPIC_API_KEY"]) {
    console.error(
      "enrich: set ANTHROPIC_API_KEY (or use --dry-run to preview without calling the API).",
    );
    return 1;
  }

  const result = await enrichRepo({
    dataDir: config.dataDir,
    target,
    name: str(flags, "name"),
    ref: str(flags, "ref"),
    model: str(flags, "model") ?? process.env["NECRONOMIDOC_ENRICH_MODEL"],
    maxFiles: int(flags, "max-files"),
    maxTokens: int(flags, "max-tokens"),
    dryRun,
    subsystems: flags["subsystems"] === true,
  });

  const r = result.report;
  if (dryRun) {
    console.log(`Dry run for ${result.slug} (model ${r.model}):`);
    console.log(
      `  would summarize ${r.plannedFiles} files (${r.plannedFileSummaries} file + ${r.plannedSymbolSummaries} symbol summaries)`,
    );
  } else {
    console.log(`✓ enriched ${result.slug} with ${r.model}`);
    console.log(
      `  ${r.calls} calls — ${r.inputTokens} input + ${r.outputTokens} output tokens, ${r.overlaysWritten} overlays written`,
    );
    if (result.subsystemsProposed !== undefined) {
      console.log(
        `  proposed ${result.subsystemsProposed} subsystems (review data/enrichment/${result.slug}/subsystems.llm.json; promote to subsystems.yaml when happy)`,
      );
    }
  }
  console.log(
    `  skipped: ${r.skippedHuman} human-curated, ${r.skippedFresh} unchanged (hash cache)` +
      (r.filesOverCap ? `, ${r.filesOverCap} files over --max-files cap` : ""),
  );
  if (r.aborted) console.log("  ⚠ token budget reached — run again to continue where it stopped.");
  for (const failure of r.failures) console.warn(`  ✗ ${failure.path}: ${failure.error}`);
  return r.failures.length > 0 && r.overlaysWritten === 0 && !dryRun ? 1 : 0;
}

function cmdServe(flags: Flags): number {
  const { config } = startServer({
    dataDir: str(flags, "data-dir"),
    siteDir: str(flags, "site-dir"),
    token: str(flags, "token"),
    port: str(flags, "port") ? Number.parseInt(str(flags, "port")!, 10) : undefined,
  });
  const base = `http://localhost:${config.port}`;
  console.log(`necronomidoc serving on ${base}`);
  console.log(`  site      ${base}/`);
  console.log(`  MCP       ${base}/mcp   (streamable HTTP, stateless)`);
  console.log(`  status    ${base}/api/status`);
  console.log(`  data dir  ${config.dataDir}`);
  console.log("Press Ctrl+C to stop.");
  return 0;
}

function cmdRepo(flags: Flags): number {
  const [, action, arg] = flags._ as string[];
  const config = loadConfig({ dataDir: str(flags, "data-dir") });

  switch (action) {
    case "add": {
      if (!arg) {
        console.error("repo add: missing <url-or-path>");
        return 1;
      }
      const provider = str(flags, "provider") ?? "generic";
      if (!KNOWN_PROVIDERS.includes(provider)) {
        console.error(`repo add: unknown provider "${provider}" (known: ${KNOWN_PROVIDERS.join(", ")})`);
        return 1;
      }
      const id = str(flags, "id") ?? slugify(arg);
      if (slugify(id) !== id) {
        console.error(`repo add: id "${id}" is not a slug — try "--id ${slugify(id)}"`);
        return 1;
      }
      const repo = upsertSourceRepo(config.dataDir, {
        id,
        name: str(flags, "name"),
        provider,
        url: arg,
        branch: str(flags, "branch") ?? "main",
        secretEnv: str(flags, "secret-env"),
        tokenEnv: str(flags, "token-env"),
        apiTokenEnv: str(flags, "api-token-env"),
        enabled: flags["disabled"] !== true,
      });
      console.log(`✓ registered ${repo.id} [${repo.provider}] ${repo.url} (branch ${repo.branch})`);
      if (repo.provider !== "generic" && !repo.secretEnv) {
        console.log(
          "  note: no --secret-env set; webhooks will use the shared DOCS_WEBHOOK_SECRET.",
        );
      }
      return 0;
    }
    case "list": {
      const { repos } = readSourceRegistry(config.dataDir);
      if (repos.length === 0) {
        console.log("no repos registered — add one with `necronomidoc repo add <url>`");
        return 0;
      }
      for (const r of repos) {
        const state = r.enabled ? "" : " (disabled)";
        console.log(`${r.id}  [${r.provider}]  ${r.url}  branch=${r.branch}${state}`);
      }
      return 0;
    }
    case "remove": {
      if (!arg) {
        console.error("repo remove: missing <id>");
        return 1;
      }
      const existed = removeSourceRepo(config.dataDir, arg);
      if (!existed) {
        console.error(`repo remove: no repo with id "${arg}"`);
        return 1;
      }
      removeClone(config.dataDir, arg);
      if (flags["purge"] === true) {
        purgeRepoDocs(config.dataDir, arg);
        console.log(`✓ removed ${arg} (clone + published docs purged)`);
      } else {
        console.log(`✓ removed ${arg} (clone deleted; docs kept — re-run with --purge to drop them)`);
      }
      return 0;
    }
    default:
      console.error("repo: expected add | list | remove");
      return 1;
  }
}

function cmdValidate(flags: Flags): number {
  const file = (flags._ as string[])[1];
  if (!file) {
    console.error("validate: missing <docmodel.json>");
    return 1;
  }
  const data = JSON.parse(readFileSync(resolve(file), "utf8"));
  const result = DocModel.safeParse(data);
  if (result.success) {
    console.log(`✓ valid DocModel — ${result.data.files.length} files`);
    return 0;
  }
  console.error("✗ invalid DocModel:");
  console.error(result.error.message);
  return 1;
}

/**
 * Toolchain health check (slice 5): report each adapter's external toolchain,
 * then flag registered repos whose languages need a toolchain this host is
 * missing. Exits 1 when a registered repo is affected.
 */
async function cmdDoctor(flags: Flags): Promise<number> {
  const config = loadConfig({ dataDir: str(flags, "data-dir") });
  const adapters = listAdapters();

  console.log("Adapter toolchains:");
  const missing = new Map<string, string>(); // language → fix
  for (const adapter of adapters) {
    if (!adapter.checkToolchain) {
      console.log(`  ✓ ${adapter.language} — built in, always available`);
      continue;
    }
    const status = await adapter.checkToolchain();
    if (status.ok) {
      console.log(`  ✓ ${adapter.language} — ${status.details ?? "ok"}`);
    } else {
      console.log(`  ✗ ${adapter.language} — missing: ${(status.missing ?? []).join(", ")}`);
      if (status.fix) console.log(`      fix: ${status.fix}`);
      missing.set(adapter.language, status.fix ?? "");
    }
  }

  const { repos } = readSourceRegistry(config.dataDir);
  if (repos.length === 0) {
    console.log("\nNo repos registered — toolchain gaps above only matter once a repo needs them.");
    return 0;
  }

  console.log("\nRegistered repos:");
  const status = readBuildStatus(config.dataDir);
  let affected = 0;
  for (const repo of repos) {
    const last = status.builds[repo.id]?.[0];
    const lastLine = last
      ? last.result === "ok"
        ? `last build ok (${last.fileCount ?? "?"} files)`
        : `last build FAILED: ${last.error ?? "unknown error"}`
      : "never built";

    // Detection needs a working tree; reuse the ingest clone when we have one.
    const cloneDir = cloneDirFor(config.dataDir, repo.id);
    let needsLine = "";
    if (existsSync(cloneDir)) {
      const needed: string[] = [];
      const blocked: string[] = [];
      for (const adapter of adapters) {
        if (await adapter.detect(cloneDir)) {
          needed.push(adapter.language);
          if (missing.has(adapter.language)) blocked.push(adapter.language);
        }
      }
      needsLine = ` — languages: ${needed.join(", ") || "none detected"}`;
      if (blocked.length > 0) {
        needsLine += ` — ✗ BLOCKED by missing toolchain: ${blocked.join(", ")}`;
        affected++;
      }
    } else {
      needsLine = " — not fetched yet (build once to enable language detection)";
    }
    console.log(`  ${repo.id} [${repo.provider}] ${lastLine}${needsLine}`);
  }

  if (affected > 0) {
    console.log(`\n✗ ${affected} repo(s) need a toolchain this host is missing (fixes above).`);
    return 1;
  }
  console.log("\n✓ no registered repo is blocked by a missing toolchain.");
  return 0;
}

function cmdExportSchemas(flags: Flags): number {
  const out = (flags._ as string[])[1];
  const schemas = exportJsonSchemas();
  const json = JSON.stringify(schemas, null, 2);
  if (out) {
    writeFileSync(resolve(out), json);
    console.log(`✓ wrote JSON Schemas to ${out}`);
  } else {
    console.log(json);
  }
  return 0;
}

async function main(): Promise<number> {
  const flags = parseArgs(process.argv.slice(2));
  const command = (flags._ as string[])[0];
  switch (command) {
    case "build":
      return cmdBuild(flags);
    case "enrich":
      return cmdEnrich(flags);
    case "serve":
      return cmdServe(flags);
    case "repo":
      return cmdRepo(flags);
    case "validate":
      return cmdValidate(flags);
    case "export-schemas":
      return cmdExportSchemas(flags);
    case "doctor":
      return cmdDoctor(flags);
    default:
      console.log(USAGE);
      return command ? 1 : 0;
  }
}

main()
  .then((code) => {
    // `serve` keeps the event loop alive; other commands exit.
    if (code !== 0) process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
