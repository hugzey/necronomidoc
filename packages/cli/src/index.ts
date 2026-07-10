#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DocModel, exportJsonSchemas, slugify } from "@necronomidoc/docmodel";
import {
  buildRepo,
  loadConfig,
  purgeRepoDocs,
  readSourceRegistry,
  removeClone,
  removeSourceRepo,
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
  necronomidoc serve [--port <p>] [--data-dir <dir>] [--site-dir <dir>] [--token <t>]
  necronomidoc repo add <url-or-path> [--id <slug>] [--provider github|ado|generic]
                 [--branch <b>] [--name <n>] [--secret-env <VAR>] [--token-env <VAR>]
                 [--api-token-env <VAR>] [--disabled] [--data-dir <dir>]
  necronomidoc repo list [--data-dir <dir>]
  necronomidoc repo remove <id> [--purge] [--data-dir <dir>]
  necronomidoc validate <docmodel.json>
  necronomidoc export-schemas [<out.json>]

Env: DOCS_DATA_DIR, PORT, DOCS_TOKEN, SITE_DIR, DOCS_WEBHOOK_SECRET,
     DOCS_DEBOUNCE_MS, DOCS_BUILD_CONCURRENCY, DOCS_BUILD_TIMEOUT_MS
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
      const id = str(flags, "id") ?? slugify(arg);
      const repo = upsertSourceRepo(config.dataDir, {
        id,
        name: str(flags, "name"),
        provider: str(flags, "provider") ?? "generic",
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
    case "serve":
      return cmdServe(flags);
    case "repo":
      return cmdRepo(flags);
    case "validate":
      return cmdValidate(flags);
    case "export-schemas":
      return cmdExportSchemas(flags);
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
