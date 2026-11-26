#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DocModel, exportJsonSchemas, slugify } from "@necronomidoc/docmodel";
import {
  buildRepo,
  checkDocStandard,
  cloneDirFor,
  enrichRepo,
  exportArtefactTasks,
  exportEnrichTasks,
  exportProductDrafts,
  exportSkillTasks,
  exportState,
  generateArtefact,
  generateSkills,
  importArtefactResults,
  importEnrichResults,
  importSkillResults,
  initProductDocs,
  lintProduct,
  listProposals,
  ManifestStore,
  aggregateMisses,
  contentTerms,
  findDuplicates,
  missLogPath,
  readMisses,
  readProposal,
  reviewProposal,
  sessionCheckSkeleton,
  mergeSynonymsFile,
  BUILTIN_SKILL_ID,
  builtinSkillMd,
  mcpConnectCommand,
  newProductDoc,
  readPublishedProductManifest,
  KNOWN_PROVIDERS,
  LLM_PROVIDERS,
  listAdapters,
  loadConfig,
  purgeRepoDocs,
  readBuildStatus,
  readSourceRegistry,
  removeClone,
  removeSourceRepo,
  reviewStale,
  scaffoldDocs,
  startServer,
  upsertSourceRepo,
  writeSkillFolders,
  type ScopeSelection,
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
                 [--max-tokens <n>] [--provider <p>] [--model <id>] [--base-url <url>]
                 [--subsystems] [--product] [--no-core-docs] [--review-stale]
                 [--export-tasks <tasks.json>] [--import-results <results.json> --tasks <tasks.json>]
                 [--name <n>] [--ref <ref>] [--data-dir <dir>]
  necronomidoc skills --builtin [--out <skills-dir>] [--mcp-url <url>] [--auth]
  necronomidoc skills [<repo-slug> | --repos <a,b,c> | --all] [--out <dir>] [--force]
                 [--dry-run] [--provider <p>] [--model <id>] [--base-url <url>]
                 [--export-tasks <tasks.json>] [--import-results <results.json> --tasks <tasks.json>]
                 [--data-dir <dir>]
  necronomidoc artefact <template.md|.docx> [<repo-slug> | --repos <a,b,c> | --all]
                 [--out <file>] [--max-tokens <n>] [--dry-run]
                 [--provider <p>] [--model <id>] [--base-url <url>]
                 [--export-tasks <tasks.json>] [--data-dir <dir>]
  necronomidoc artefact --import-results <results.json> --tasks <tasks.json> [--out <file>]
  necronomidoc init-docs <repo-path> [--force]
  necronomidoc product init [<repo-path>] [--force]
  necronomidoc product new <persona|job|epic|story|journey|session> --title "<title>" [--dir <repo-path>]
  necronomidoc product lint [<repo-path>] [--strict] [--json]
  necronomidoc product export <repo-id> [--out <dir>] [--force] [--data-dir <dir>]
  necronomidoc product checks [<repo-path>] [--out <dir>] [--session <SES-id>] [--force] [--print]
  necronomidoc proposals list [--repo <slug>] [--status proposed|accepted|rejected] [--json] [--data-dir <dir>]
  necronomidoc proposals show <id> [--data-dir <dir>]
  necronomidoc proposals accept|reject <id> [--note "<why>"] [--data-dir <dir>]
  necronomidoc misses [--repo <slug>] [--limit <n>] [--suggest] [--write] [--json] [--data-dir <dir>]
  necronomidoc serve [--port <p>] [--data-dir <dir>] [--site-dir <dir>] [--token <t>] [--auth]
  necronomidoc repo add <url-or-path> [--id <slug>] [--provider github|ado|generic]
                 [--branch <b>] [--name <n>] [--secret-env <VAR>] [--token-env <VAR>]
                 [--api-token-env <VAR>] [--disabled] [--data-dir <dir>]
  necronomidoc repo list [--data-dir <dir>]
  necronomidoc repo remove <id> [--purge] [--data-dir <dir>]
  necronomidoc validate <docmodel.json>
  necronomidoc export-schemas [<out.json>]
  necronomidoc export <out-dir> [--data-dir <dir>]
  necronomidoc doctor [--data-dir <dir>]

Env: DOCS_DATA_DIR, PORT, DOCS_TOKEN, SITE_DIR, DOCS_WEBHOOK_SECRET,
     DOCS_DEBOUNCE_MS, DOCS_BUILD_CONCURRENCY, DOCS_BUILD_TIMEOUT_MS,
     DOCS_AUTH_REQUIRED, DOCS_SESSION_SECRET, DOCS_LOG_FORMAT, DOCS_MISS_LOG

Enrich LLM providers (--provider ${LLM_PROVIDERS.join(" | ")}, auto-detected from keys):
     ANTHROPIC_API_KEY | OPENAI_API_KEY | OPENROUTER_API_KEY | AZURE_OPENAI_API_KEY
     NECRONOMIDOC_LLM_PROVIDER, NECRONOMIDOC_LLM_MODEL, NECRONOMIDOC_LLM_BASE_URL,
     NECRONOMIDOC_LLM_API_KEY — bedrock uses the AWS credential chain.
     No key? Use --export-tasks + a local coding agent + --import-results.
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

  // Agent mode, step 1: write the planned prompts to a task file for a local
  // coding agent to complete — no provider API key involved.
  const exportTasks = str(flags, "export-tasks");
  if (exportTasks) {
    const result = await exportEnrichTasks({
      dataDir: config.dataDir,
      target,
      name: str(flags, "name"),
      ref: str(flags, "ref"),
      maxFiles: int(flags, "max-files"),
      subsystems: flags["subsystems"] === true,
      coreDocs: flags["no-core-docs"] === true ? false : undefined,
      product: flags["product"] === true,
      outFile: exportTasks,
    });
    const total =
      result.fileTasks +
      result.coreDocTasks.length +
      (result.subsystemsTask ? 1 : 0) +
      (result.productTask ? 1 : 0);
    console.log(`✓ exported ${total} enrichment task${total === 1 ? "" : "s"} for ${result.slug} → ${result.outFile}`);
    console.log(
      `  ${result.fileTasks} file summaries` +
        (result.coreDocTasks.length > 0 ? `, core docs: ${result.coreDocTasks.join(", ")}` : "") +
        (result.subsystemsTask ? ", 1 subsystem map" : "") +
        (result.productTask ? ", 1 product-docs draft" : ""),
    );
    console.log(
      `  skipped: ${result.skippedHuman} human-curated, ${result.skippedFresh} unchanged (hash cache)` +
        (result.filesOverCap ? `, ${result.filesOverCap} files over --max-files cap` : ""),
    );
    if (total === 0) {
      console.log("  nothing to generate — everything is curated or cached.");
    } else {
      console.log("Next: have your coding agent complete the task file (instructions are inside), then:");
      console.log(`  necronomidoc enrich ${target} --import-results <results.json> --tasks ${exportTasks}`);
    }
    return 0;
  }

  // Agent mode, step 2: validate + publish the agent's results.
  const importResults = str(flags, "import-results");
  if (importResults) {
    const tasksFile = str(flags, "tasks");
    if (!tasksFile) {
      console.error(
        "enrich: --import-results needs --tasks <tasks.json> (the file written by --export-tasks).",
      );
      return 1;
    }
    const result = await importEnrichResults({
      dataDir: config.dataDir,
      target,
      name: str(flags, "name"),
      ref: str(flags, "ref"),
      resultsFile: importResults,
      tasksFile,
    });
    console.log(`✓ imported ${result.applied} results for ${result.slug}`);
    console.log(
      `  ${result.overlaysWritten} overlays, ${result.coreDocsWritten} core docs` +
        (result.subsystemsProposed !== undefined
          ? `, ${result.subsystemsProposed} subsystems proposed`
          : "") +
        (result.productDocsDrafted !== undefined
          ? `, ${result.productDocsDrafted} product docs drafted`
          : ""),
    );
    if (result.missingTasks.length > 0) {
      console.warn(
        `  ⚠ ${result.missingTasks.length} task(s) had no result (re-run the agent or re-export): ${result.missingTasks.slice(0, 5).join(", ")}${result.missingTasks.length > 5 ? ", …" : ""}`,
      );
    }
    for (const id of result.unmatchedResults) {
      console.warn(`  ⚠ ignored result with unknown or duplicate id: ${id}`);
    }
    for (const failure of result.failures) console.warn(`  ✗ ${failure.id}: ${failure.error}`);
    // Fail when there was work to do and none of it landed — an all-unmatched
    // or empty results file must not read as success to scripts/CI.
    const nothingLanded =
      result.applied === 0 &&
      result.failures.length +
        result.unmatchedResults.length +
        result.missingTasks.length >
        0;
    return nothingLanded ? 1 : 0;
  }

  const dryRun = flags["dry-run"] === true;
  const result = await enrichRepo({
    dataDir: config.dataDir,
    target,
    name: str(flags, "name"),
    ref: str(flags, "ref"),
    provider: str(flags, "provider"),
    model: str(flags, "model"),
    baseUrl: str(flags, "base-url"),
    maxFiles: int(flags, "max-files"),
    maxTokens: int(flags, "max-tokens"),
    dryRun,
    subsystems: flags["subsystems"] === true,
    coreDocs: flags["no-core-docs"] === true ? false : undefined,
    product: flags["product"] === true,
  });

  const r = result.report;
  if (result.product) {
    const p = result.product;
    const why = {
      curated: "skipped — the repo has curated docs/product/ (never LLM-written)",
      fresh: "cached drafts still match the code",
      missing: dryRun ? "would draft a product doc set" : `drafted ${p.written} product docs`,
      stale: dryRun ? "would re-draft (code changed since the drafts)" : `re-drafted ${p.written} product docs`,
    }[p.reason];
    console.log(`  product docs: ${p.error ? `✗ ${p.error}` : why}`);
    if (!dryRun && p.written > 0) {
      console.log(`    review them on the site, then promote: necronomidoc product export ${result.slug} --out docs/product`);
    }
  }
  if (dryRun) {
    console.log(`Dry run for ${result.slug} (model ${r.model}):`);
    console.log(
      `  would summarize ${r.plannedFiles} files (${r.plannedFileSummaries} file + ${r.plannedSymbolSummaries} symbol summaries)`,
    );
    if (result.coreDocs) {
      console.log(
        `  would generate core docs: ${result.coreDocs.planned.join(", ") || "none"}` +
          ` (${result.coreDocs.curated} curated, ${result.coreDocs.fresh} cached)`,
      );
    }
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
    if (result.coreDocs) {
      console.log(
        `  core docs: ${result.coreDocs.written} written` +
          ` (${result.coreDocs.curated} curated, ${result.coreDocs.fresh} cached)`,
      );
      for (const failure of result.coreDocs.failures) {
        console.warn(`  ✗ core doc ${failure.kind}: ${failure.error}`);
      }
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

/** Shared scope flags: positional slug, `--repos a,b,c`, or `--all`. */
function scopeFrom(flags: Flags, positionalIndex: number): ScopeSelection {
  const positional = (flags._ as string[])[positionalIndex];
  const reposFlag = str(flags, "repos");
  if (flags["all"] === true) return { all: true };
  if (reposFlag) {
    return { repos: reposFlag.split(",").map((s) => s.trim()).filter(Boolean) };
  }
  return positional ? { repos: [positional] } : {};
}

async function cmdSkills(flags: Flags): Promise<number> {
  // The built-in `using-necronomidoc` skill: no LLM, no built repo needed.
  if (flags["builtin"] === true) {
    const options = { mcpUrl: str(flags, "mcp-url"), authRequired: flags["auth"] === true };
    const md = builtinSkillMd(options);
    const out = str(flags, "out");
    if (!out) {
      process.stdout.write(md);
      return 0;
    }
    const file = join(resolve(out), BUILTIN_SKILL_ID, "SKILL.md");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, md);
    console.log(`✓ wrote ${file}`);
    if (!options.mcpUrl) console.log("  tip: pass --mcp-url https://<your-docs-server>/mcp to fill in your server's address");
    console.log(`  connect the MCP server too:\n  ${mcpConnectCommand(options).replace(/\n/g, "\n  ")}`);
    return 0;
  }
  const config = loadConfig({ dataDir: str(flags, "data-dir") });

  // Agent mode, step 2: validate + persist the agent's skill set.
  const importResults = str(flags, "import-results");
  if (importResults) {
    const tasksFile = str(flags, "tasks");
    if (!tasksFile) {
      console.error("skills: --import-results needs --tasks <tasks.json> (written by --export-tasks).");
      return 1;
    }
    const result = importSkillResults({
      dataDir: config.dataDir,
      resultsFile: importResults,
      tasksFile,
    });
    for (const failure of result.failures) console.warn(`  ✗ ${failure.id}: ${failure.error}`);
    if (result.skillsWritten === 0) {
      console.error(`✗ no skills imported for set ${result.setId}`);
      return 1;
    }
    console.log(`✓ imported ${result.skillsWritten} skills → data/skills/${result.setId}/`);
    return 0;
  }

  const scope = scopeFrom(flags, 1);

  // Agent mode, step 1: write the skill prompt to a task file (no API key).
  const exportTasks = str(flags, "export-tasks");
  if (exportTasks) {
    const result = exportSkillTasks({ dataDir: config.dataDir, ...scope, outFile: exportTasks });
    console.log(`✓ exported 1 skill-set task for ${result.repos.join(", ")} → ${result.outFile}`);
    console.log("Next: have your coding agent complete the task file (instructions are inside), then:");
    console.log(`  necronomidoc skills --import-results <results.json> --tasks ${exportTasks}`);
    return 0;
  }

  const dryRun = flags["dry-run"] === true;
  const result = await generateSkills({
    dataDir: config.dataDir,
    ...scope,
    provider: str(flags, "provider"),
    model: str(flags, "model"),
    baseUrl: str(flags, "base-url"),
    force: flags["force"] === true,
    dryRun,
  });

  if (dryRun) {
    console.log(`Dry run for skill set "${result.setId}" (${result.scope}, ${result.repos.length} repo(s)):`);
    console.log(
      result.cached
        ? "  cached set is fresh — nothing to generate (use --force to regenerate)."
        : `  would generate one skill set (changed repos: ${result.staleRepos.join(", ") || "first run"}).`,
    );
    return 0;
  }
  if (result.cached) {
    console.log(`✓ skill set "${result.setId}" is fresh (hash cache) — use --force to regenerate.`);
  } else {
    console.log(`✓ generated ${result.skillsWritten} skills for "${result.setId}"`);
    console.log(
      `  ${result.calls} call — ${result.inputTokens} input + ${result.outputTokens} output tokens → data/skills/${result.setId}/`,
    );
  }
  const out = str(flags, "out");
  if (out) {
    const copied = writeSkillFolders(config.dataDir, result.setId, out);
    console.log(`  copied ${copied} SKILL.md folder(s) → ${resolve(out)}`);
  }
  return 0;
}

async function cmdArtefact(flags: Flags): Promise<number> {
  const config = loadConfig({ dataDir: str(flags, "data-dir") });
  const out = str(flags, "out");

  const copyOut = (outputPath: string): void => {
    if (!out) return;
    copyFileSync(outputPath, resolve(out));
    console.log(`  copied output → ${resolve(out)}`);
  };

  // Agent mode, step 2: validate the agent's fills, assemble, persist.
  const importResults = str(flags, "import-results");
  if (importResults) {
    const tasksFile = str(flags, "tasks");
    if (!tasksFile) {
      console.error("artefact: --import-results needs --tasks <tasks.json> (written by --export-tasks).");
      return 1;
    }
    const result = await importArtefactResults({
      dataDir: config.dataDir,
      resultsFile: importResults,
      tasksFile,
    });
    console.log(`✓ assembled "${result.record.name}" — ${result.applied} fills → ${result.outputPath}`);
    if (result.missingTasks.length > 0) {
      console.warn(`  ⚠ ${result.missingTasks.length} task(s) had no result: ${result.missingTasks.slice(0, 5).join(", ")}${result.missingTasks.length > 5 ? ", …" : ""}`);
    }
    for (const id of result.unmatchedResults) console.warn(`  ⚠ ignored result with unknown or duplicate id: ${id}`);
    for (const failure of result.failures) console.warn(`  ✗ ${failure.id}: ${failure.error}`);
    copyOut(result.outputPath);
    return result.applied === 0 ? 1 : 0;
  }

  const template = (flags._ as string[])[1];
  if (!template) {
    console.error("artefact: missing <template.md|.docx>");
    return 1;
  }
  const scope = scopeFrom(flags, 2);

  // Agent mode, step 1: write every fill prompt to a task file (no API key).
  const exportTasks = str(flags, "export-tasks");
  if (exportTasks) {
    const result = await exportArtefactTasks({
      dataDir: config.dataDir,
      ...scope,
      templatePath: template,
      outFile: exportTasks,
    });
    console.log(`✓ exported ${result.tasks} artefact task(s) [${result.mode} mode] → ${result.outFile}`);
    console.log("Next: have your coding agent complete the task file (instructions are inside), then:");
    console.log(`  necronomidoc artefact --import-results <results.json> --tasks ${exportTasks}`);
    return 0;
  }

  const dryRun = flags["dry-run"] === true;
  const result = await generateArtefact({
    dataDir: config.dataDir,
    ...scope,
    templatePath: template,
    provider: str(flags, "provider"),
    model: str(flags, "model"),
    baseUrl: str(flags, "base-url"),
    maxTokens: int(flags, "max-tokens"),
    dryRun,
  });

  if (dryRun) {
    console.log(`Dry run for ${template}:`);
    console.log(
      result.mode === "placeholders"
        ? `  ${result.tasks} placeholder(s) found — everything outside them is preserved.`
        : `  no placeholders — sections mode (${result.tasks} planned section(s) estimated from headings).`,
    );
    if (result.markdownFallback) {
      console.log("  ⚠ sections mode on a .docx template outputs markdown (see docs/artefacts.md).");
    }
    return 0;
  }

  console.log(`✓ generated "${result.record!.name}" [${result.mode} mode] — ${result.filled}/${result.tasks} filled`);
  console.log(
    `  ${result.calls} calls — ${result.inputTokens} input + ${result.outputTokens} output tokens → ${result.outputPath}`,
  );
  if (result.markdownFallback) {
    console.log("  ⚠ .docx template had no placeholders — output written as markdown.");
  }
  if (result.aborted) console.log("  ⚠ token budget reached — some sections were not filled.");
  for (const failure of result.failures) console.warn(`  ✗ ${failure.id}: ${failure.error}`);
  copyOut(result.outputPath!);
  return result.filled === 0 && result.tasks > 0 ? 1 : 0;
}

/** Scaffold the doc-standard templates into a repo (decision 0019). */
function cmdInitDocs(flags: Flags): number {
  const target = (flags._ as string[])[1];
  if (!target) {
    console.error("init-docs: missing <repo-path>");
    return 1;
  }
  const result = scaffoldDocs(target, { force: flags["force"] === true });
  console.log(`✓ scaffolded doc templates under ${result.dir}`);
  for (const label of result.written) console.log(`  + ${label}`);
  for (const label of result.skipped) console.log(`  = ${label} (exists — kept; --force overwrites)`);
  console.log("Fill in the TODO(doc) markers, commit, and rebuild — repo docs beat every other source.");
  return 0;
}

/** `necronomidoc product …` — the product-doc standard's tooling (decision 0023). */
async function cmdProduct(flags: Flags): Promise<number> {
  const [, action, arg] = flags._ as string[];
  switch (action) {
    case "init": {
      const result = initProductDocs(arg ?? ".", { force: flags["force"] === true });
      console.log(`✓ product docs scaffolded under ${result.dir}`);
      for (const label of result.written) console.log(`  + ${label}`);
      for (const label of result.skipped) console.log(`  = ${label} (exists — kept; --force overwrites)`);
      console.log('Next: necronomidoc product new persona --title "…" (then job, session, story…).');
      return 0;
    }
    case "new": {
      const title = str(flags, "title");
      if (!arg || !title) {
        console.error('product new: usage — product new <type> --title "<title>" [--dir <repo-path>]');
        return 1;
      }
      const created = newProductDoc(str(flags, "dir") ?? ".", arg, title);
      console.log(`✓ ${created.id} → ${created.path}`);
      console.log("  replace every TODO(doc) marker, then: necronomidoc product lint");
      return 0;
    }
    case "lint": {
      const manifest = await lintProduct(arg ?? ".");
      if (flags["json"] === true) {
        console.log(JSON.stringify({ findings: manifest.findings, coverage: manifest.coverage }, null, 2));
      } else {
        const counts = new Map<string, number>();
        for (const d of manifest.docs) counts.set(d.type, (counts.get(d.type) ?? 0) + 1);
        console.log(
          `Product docs: ${manifest.docs.length} (${[...counts].map(([t, n]) => `${n} ${t}`).join(", ") || "none"})`,
        );
        const c = manifest.coverage;
        console.log(
          `  tests cite ${c.criteriaTested}/${c.criteria} acceptance criteria, ${c.requirementsTested}/${c.requirements} requirements, ${c.outcomesTested}/${c.outcomes} session outcomes`,
        );
        console.log(
          `  code bindings: ${c.bindings} (${c.bindingsBroken} broken) — sessions cover ${c.surfacesCovered}/${c.surfaces} interaction surfaces`,
        );
        const icons = { error: "✗", warn: "⚠", info: "ℹ" } as const;
        for (const f of manifest.findings) {
          console.log(`  ${icons[f.level]} ${f.docId ?? f.path ?? ""}${f.docId || f.path ? ": " : ""}${f.message} [${f.code}]`);
        }
      }
      const errors = manifest.findings.filter((f) => f.level === "error").length;
      const warnings = manifest.findings.filter((f) => f.level === "warn").length;
      if (errors > 0 || (flags["strict"] === true && warnings > 0)) {
        if (flags["json"] !== true) console.log(`✗ ${errors} error(s), ${warnings} warning(s)`);
        return 1;
      }
      if (flags["json"] !== true) console.log(`✓ no errors (${warnings} warning(s))`);
      return 0;
    }
    case "export": {
      if (!arg) {
        console.error("product export: missing <repo-id>");
        return 1;
      }
      const config = loadConfig({ dataDir: str(flags, "data-dir") });
      const out = str(flags, "out") ?? "docs/product";
      const result = exportProductDrafts(config.dataDir, arg, out, { force: flags["force"] === true });
      if (result.stale) console.warn("  ⚠ these drafts predate the latest code — consider re-running enrich --product");
      console.log(`✓ exported ${result.written.length} drafted product docs → ${out}`);
      for (const label of result.written) console.log(`  + ${label}`);
      for (const label of result.skipped) console.log(`  = ${label} (exists — kept; --force overwrites)`);
      console.log("Review, set status: accepted where true, commit — curated docs replace the drafts.");
      return 0;
    }
    case "checks": {
      // Executable session-check skeletons (decision 0024), one file per session.
      const root = resolve(arg ?? ".");
      const manifest = await lintProduct(root);
      const want = str(flags, "session")?.toUpperCase();
      const sessions = manifest.docs.filter(
        (d): d is Extract<typeof d, { type: "session" }> => d.type === "session" && (!want || d.id === want),
      );
      if (sessions.length === 0) {
        console.error(want ? `product checks: no session ${want}` : "product checks: no sessions documented");
        return 1;
      }
      const outDir = str(flags, "out");
      for (const session of sessions) {
        const file = sessionCheckSkeleton(session);
        if (flags["print"] === true) {
          console.log(`// ---- ${file.path} ----\n${file.content}`);
          continue;
        }
        const target = outDir ? join(resolve(outDir), file.path.split("/").pop()!) : join(root, file.path);
        if (existsSync(target) && flags["force"] !== true) {
          console.log(`  = ${target} (exists — kept; --force overwrites)`);
          continue;
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.content);
        console.log(`  + ${target} [${file.framework}] ${file.outcomes.join(", ")}`);
      }
      if (flags["print"] !== true) {
        console.log("Fill every TODO(check), then drop .fixme/.skip — implemented checks count as outcome coverage.");
      }
      return 0;
    }
    default:
      console.error("product: one of init | new | lint | export | checks");
      return 1;
  }
}

/** `necronomidoc proposals …` — review agent-written doc drafts (decision 0024). */
function cmdProposals(flags: Flags): number {
  const [, action, id] = flags._ as string[];
  const config = loadConfig({ dataDir: str(flags, "data-dir") });
  switch (action) {
    case "list":
    case undefined: {
      const list = listProposals(config.dataDir, { repo: str(flags, "repo"), status: str(flags, "status") ?? (action ? undefined : "proposed") });
      if (flags["json"] === true) {
        console.log(JSON.stringify(list, null, 2));
        return 0;
      }
      if (list.length === 0) console.log("No proposals.");
      for (const p of list) {
        const target = p.overlay?.targetId ?? p.productDoc?.path ?? "?";
        const warns = p.findings.filter((f) => f.level !== "info").length;
        console.log(`${p.id}  [${p.status}] ${p.kind} ${target}${p.author ? ` — by ${p.author}` : ""}${warns ? ` (${warns} finding(s))` : ""}`);
        if (p.rationale) console.log(`    why: ${p.rationale.split("\n")[0]}`);
      }
      return 0;
    }
    case "show": {
      const p = id ? readProposal(config.dataDir, id) : undefined;
      if (!p) {
        console.error(`proposals show: no proposal "${id ?? ""}"`);
        return 1;
      }
      console.log(JSON.stringify(p, null, 2));
      return 0;
    }
    case "accept":
    case "reject": {
      if (!id) {
        console.error(`proposals ${action}: missing <id>`);
        return 1;
      }
      const reviewed = reviewProposal(config.dataDir, id, action, { note: str(flags, "note") });
      console.log(`✓ ${reviewed.id} ${reviewed.status}${reviewed.writtenTo ? ` → ${reviewed.writtenTo}` : ""}`);
      if (reviewed.status === "accepted") console.log(`  publishes on the next build of "${reviewed.repo}" (push, or necronomidoc build …).`);
      for (const f of reviewed.findings.filter((x) => x.code === "repo-shipped")) console.log(`  ℹ ${f.message}`);
      return 0;
    }
    default:
      console.error("proposals: one of list | show | accept | reject");
      return 1;
  }
}

/** `necronomidoc misses` — what agents asked for that the docs couldn't answer (decision 0024). */
function cmdMisses(flags: Flags): number {
  const config = loadConfig({ dataDir: str(flags, "data-dir") });
  const repo = str(flags, "repo");
  const limit = Number.parseInt(str(flags, "limit") ?? "25", 10) || 25;
  const concepts = aggregateMisses(readMisses(missLogPath(config.dataDir)), repo, limit);
  const suggest = flags["suggest"] === true || flags["write"] === true;
  let store: InstanceType<typeof ManifestStore> | undefined;
  if (suggest) {
    store = new ManifestStore(config.dataDir);
    store.reload();
  }
  // Candidate synonyms: the miss's key terms → the closest existing symbol name.
  const suggestions: Record<string, string[]> = {};
  const rows = concepts.map((c) => {
    let candidate: string | undefined;
    if (store && !c.hashed) {
      const term = contentTerms(c.query).join(" ");
      const hit = findDuplicates(store, { repo, name: term, purpose: c.query }, 1)[0];
      if (hit && term) {
        candidate = hit.name;
        suggestions[term] = [...new Set([...(suggestions[term] ?? []), hit.name])];
      }
    }
    return { ...c, candidate };
  });
  if (flags["json"] === true) {
    console.log(JSON.stringify({ mode: config.missLog, undocumented: rows, ...(suggest ? { synonyms: suggestions } : {}) }, null, 2));
  } else {
    if (rows.length === 0) console.log(`No misses recorded${repo ? ` for ${repo}` : ""} (miss log mode: ${config.missLog}).`);
    for (const r of rows) {
      console.log(`${String(r.count).padStart(4)}×  ${r.hashed ? `#${r.query} (hashed)` : `"${r.query}"`}  [${r.tools.join(", ")}]${r.candidate ? `  → maybe ${r.candidate}` : ""}`);
    }
    if (suggest && Object.keys(suggestions).length > 0) {
      console.log("\nCandidate synonyms (synonyms.yaml):");
      for (const [term, names] of Object.entries(suggestions)) console.log(`${term}: [${names.join(", ")}]`);
    }
  }
  if (flags["write"] === true) {
    if (!repo) {
      console.error("misses --write: needs --repo <slug> (synonyms are per repo)");
      return 1;
    }
    if (Object.keys(suggestions).length === 0) return 0;
    const { file, added } = mergeSynonymsFile(join(config.dataDir, "enrichment", slugify(repo)), suggestions);
    console.log(`✓ added ${added} synonym(s) to ${file} — review it; applies on the next build of ${repo}.`);
  }
  return 0;
}

function cmdServe(flags: Flags): number {
  const { config } = startServer({
    dataDir: str(flags, "data-dir"),
    siteDir: str(flags, "site-dir"),
    token: str(flags, "token"),
    authRequired: flags["auth"] === true ? true : undefined,
    port: str(flags, "port") ? Number.parseInt(str(flags, "port")!, 10) : undefined,
  });
  const base = `http://localhost:${config.port}`;
  console.log(`necronomidoc serving on ${base}`);
  console.log(`  site      ${base}/`);
  console.log(`  MCP       ${base}/mcp   (streamable HTTP, stateless)`);
  console.log(`  status    ${base}/api/status`);
  console.log(`  health    ${base}/healthz`);
  console.log(`  data dir  ${config.dataDir}`);
  console.log(`  auth      ${config.authRequired ? "required (shared token)" : "open"}`);
  console.log("Press Ctrl+C to stop.");
  return 0;
}

/** Export curation state (registry + enrichment overlays) for versioned backup. */
function cmdExport(flags: Flags): number {
  const out = (flags._ as string[])[1];
  if (!out) {
    console.error("export: missing <out-dir>");
    return 1;
  }
  const config = loadConfig({ dataDir: str(flags, "data-dir") });
  const result = exportState(config.dataDir, resolve(out));
  console.log(`✓ exported curation state → ${result.outDir}`);
  console.log(`  registry.json   ${result.registryCopied ? "copied" : "none yet"}`);
  console.log(`  enrichment/     ${result.enrichmentCopied ? "copied" : "none yet"}`);
  console.log("  commit this directory to version your curation (see docs/deploy/backup-restore.md).");
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

  // Secrets hygiene (slice 6): catch placeholder/weak credentials before they
  // reach the internet. Warnings only — a laptop demo shouldn't exit 1.
  const weak = /^(changeme|change-me|password|secret|token|test|example|default|admin|1234|12345678)$/i;
  const hygiene: string[] = [];
  if (config.token && (weak.test(config.token) || config.token.length < 16)) {
    hygiene.push("DOCS_TOKEN looks weak or default — use a long random value (e.g. `openssl rand -hex 32`).");
  }
  if (config.webhookSecret && (weak.test(config.webhookSecret) || config.webhookSecret.length < 16)) {
    hygiene.push("DOCS_WEBHOOK_SECRET looks weak or default — use a long random value.");
  }
  if (config.authRequired && !config.token) {
    hygiene.push("DOCS_AUTH_REQUIRED is on but DOCS_TOKEN is empty — the server will refuse to start.");
  }
  if (!config.authRequired && !config.token) {
    hygiene.push(
      "No auth configured: site/MCP/status are public and /api/build is disabled. Fine on a trusted network; set DOCS_TOKEN (+ DOCS_AUTH_REQUIRED=1 or reverse-proxy auth) before exposing this host.",
    );
  }
  if (hygiene.length > 0) {
    console.log("Secrets & auth:");
    for (const warning of hygiene) console.log(`  ⚠ ${warning}`);
    console.log("");
  }

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

    // Doc-standard compliance (decision 0019): advisory only — the heuristic
    // floor keeps every repo documented, so nothing here affects exit codes.
    if (existsSync(cloneDir)) {
      const icons = { ok: "✓", info: "ℹ", warn: "⚠" } as const;
      for (const finding of checkDocStandard(cloneDir)) {
        console.log(`      ${icons[finding.level]} docs: ${finding.message}`);
      }
    }
    // Product docs (decision 0023): summarize the published manifest —
    // advisory, like the doc-standard checks.
    const product = readPublishedProductManifest(config.dataDir, repo.id);
    if (product) {
      const errors = product.findings.filter((f) => f.level === "error").length;
      const warnings = product.findings.filter((f) => f.level === "warn").length;
      const c = product.coverage;
      console.log(
        product.source === "none"
          ? "      ℹ product: no docs/product/ yet — `necronomidoc product init` scaffolds it"
          : `      ${errors > 0 ? "⚠" : "✓"} product (${product.source}): ${product.docs.length} docs, ${errors} errors, ${warnings} warnings; tests cite ${c.criteriaTested}/${c.criteria} criteria, ${c.outcomesTested}/${c.outcomes} outcomes; ${c.bindingsBroken} broken bindings`,
      );
    }
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
    case "skills":
      return cmdSkills(flags);
    case "artefact":
      return cmdArtefact(flags);
    case "init-docs":
      return cmdInitDocs(flags);
    case "product":
      return cmdProduct(flags);
    case "proposals":
      return cmdProposals(flags);
    case "misses":
      return cmdMisses(flags);
    case "serve":
      return cmdServe(flags);
    case "repo":
      return cmdRepo(flags);
    case "validate":
      return cmdValidate(flags);
    case "export-schemas":
      return cmdExportSchemas(flags);
    case "export":
      return cmdExport(flags);
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
