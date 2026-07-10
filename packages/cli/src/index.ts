#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DocModel, exportJsonSchemas } from "@necronomidoc/docmodel";
import { buildRepo, loadConfig, startServer } from "@necronomidoc/server";

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

const USAGE = `necronomidoc — team documentation server (slice 1)

Usage:
  necronomidoc build <path-or-git-url> [--name <n>] [--ref <ref>] [--data-dir <dir>]
  necronomidoc serve [--port <p>] [--data-dir <dir>] [--site-dir <dir>] [--token <t>]
  necronomidoc validate <docmodel.json>
  necronomidoc export-schemas [<out.json>]

Env: DOCS_DATA_DIR, PORT, DOCS_TOKEN, SITE_DIR
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
