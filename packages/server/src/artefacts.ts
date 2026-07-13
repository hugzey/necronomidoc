import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  ArtefactIndex,
  ArtefactRecord,
  SCHEMA_VERSION,
  slugify,
  type ArtefactFormat,
  type ArtefactMode,
  type GenerationScope,
} from "@necronomidoc/docmodel";
import {
  ArtefactResultsFile,
  ArtefactTaskFile,
  applyArtefactResults,
  assembleArtefactMarkdown,
  assembleFilledTemplate,
  buildArtefactTaskFile,
  extractDocxText,
  fillDocxPlaceholders,
  generateArtefactFills,
  headingSections,
  parseTemplate,
  type LlmClient,
  type ParsedTemplate,
} from "@necronomidoc/enrichment";
import { llmClientFor, type LlmFlagOptions } from "./llm.js";
import { resolveScope, type ScopeSelection } from "./scope.js";

/**
 * The `necronomidoc artefact` pipeline (slice 8, decision 0018): fill a
 * user-provided template (.md or .docx) from the documented repos' knowledge.
 * Explicit `{{…}}` / `<…>` placeholders are replaced with everything outside
 * them preserved; marker-free templates are planned into sections and written
 * section-by-section. Each run persists under `data/artefacts/<id>/` — the
 * template copy, the filled output, and an `artefact.json` record — and is
 * listed in `data/artefacts/index.json` for the site and API.
 */

const ARTEFACTS_DIR = "artefacts";
const INDEX_FILE = "index.json";
const RECORD_FILE = "artefact.json";

export function artefactsDir(dataDir: string): string {
  return join(dataDir, ARTEFACTS_DIR);
}

/** Read the artefact index, or an empty one if none exists yet. */
export function readArtefactIndex(dataDir: string): ArtefactIndex {
  const file = join(artefactsDir(dataDir), INDEX_FILE);
  if (!existsSync(file)) return { schemaVersion: SCHEMA_VERSION, artefacts: [] };
  const parsed = ArtefactIndex.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    console.warn(`[artefacts] ignoring invalid ${file}: ${parsed.error.message}`);
    return { schemaVersion: SCHEMA_VERSION, artefacts: [] };
  }
  return parsed.data;
}

/** Read one artefact's record, or undefined when absent/invalid. */
export function readArtefactRecord(dataDir: string, id: string): ArtefactRecord | undefined {
  const file = join(artefactsDir(dataDir), id, RECORD_FILE);
  if (!existsSync(file)) return undefined;
  const parsed = ArtefactRecord.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    console.warn(`[artefacts] ignoring invalid ${file}: ${parsed.error.message}`);
    return undefined;
  }
  return parsed.data;
}

/** Absolute path of an artefact's stored template or output file. */
export function artefactFilePath(
  dataDir: string,
  id: string,
  which: "template" | "output",
): string | undefined {
  const record = readArtefactRecord(dataDir, id);
  if (!record) return undefined;
  return join(artefactsDir(dataDir), id, which === "template" ? record.templateFile : record.outputFile);
}

interface LoadedTemplate {
  name: string;
  format: ArtefactFormat;
  bytes: Uint8Array;
  /** Scannable text: the file itself (markdown) or extracted paragraphs (docx). */
  text: string;
}

const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".txt"];

async function loadTemplate(name: string, bytes: Uint8Array): Promise<LoadedTemplate> {
  const lower = name.toLowerCase();
  if (lower.endsWith(".docx")) {
    return { name, format: "docx", bytes, text: await extractDocxText(bytes) };
  }
  if (MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return { name, format: "markdown", bytes, text: Buffer.from(bytes).toString("utf8") };
  }
  throw new Error(
    `Unsupported template "${name}" — use ${MARKDOWN_EXTENSIONS.join(", ")} or .docx.`,
  );
}

function templateFromOptions(options: ArtefactOptions): { name: string; bytes: Uint8Array } {
  if (options.template) return options.template;
  if (!options.templatePath) throw new Error("No template given.");
  const path = resolve(options.templatePath);
  return { name: basename(path), bytes: readFileSync(path) };
}

/** Filesystem-safe unique artefact id: template slug + UTC timestamp. */
function artefactIdFor(name: string, now: string): string {
  const stem = slugify(name.replace(/\.[a-z]+$/i, "")) || "artefact";
  return `${stem}-${now.replace(/\D/g, "").slice(0, 14)}`;
}

interface PersistArtefactInput {
  name: string;
  format: ArtefactFormat;
  mode: ArtefactMode;
  scope: GenerationScope;
  repos: string[];
  templateBytes: Uint8Array;
  /** Output bytes + its extension (sections-mode docx falls back to .md). */
  output: { bytes: Uint8Array; ext: "md" | "docx" };
  sectionsFilled: number;
  model?: string;
  failures: { id: string; error: string }[];
}

function persistArtefact(dataDir: string, input: PersistArtefactInput): ArtefactRecord {
  const now = new Date().toISOString();
  const id = artefactIdFor(input.name, now);
  const dir = join(artefactsDir(dataDir), id);
  mkdirSync(dir, { recursive: true });
  const templateFile = input.format === "docx" ? "template.docx" : "template.md";
  const outputFile = `output.${input.output.ext}`;
  writeFileSync(join(dir, templateFile), input.templateBytes);
  writeFileSync(join(dir, outputFile), input.output.bytes);
  const record: ArtefactRecord = {
    schemaVersion: SCHEMA_VERSION,
    id,
    name: input.name,
    format: input.format,
    mode: input.mode,
    scope: input.scope,
    repos: input.repos,
    templateFile,
    outputFile,
    sectionsFilled: input.sectionsFilled,
    model: input.model,
    generatedAt: now,
    failures: input.failures,
  };
  writeFileSync(join(dir, RECORD_FILE), JSON.stringify(record, null, 2) + "\n");
  const index = readArtefactIndex(dataDir);
  const { schemaVersion: _v, templateFile: _t, failures: _f, ...entry } = record;
  const next: ArtefactIndex = {
    schemaVersion: SCHEMA_VERSION,
    artefacts: [entry, ...index.artefacts.filter((a) => a.id !== id)],
  };
  writeFileSync(join(artefactsDir(dataDir), INDEX_FILE), JSON.stringify(next, null, 2) + "\n");
  return record;
}

/** Fill a docx template's placeholders in place (everything else preserved). */
async function filledDocx(
  templateBytes: Uint8Array,
  parsed: ParsedTemplate,
  fills: Map<string, string>,
): Promise<Uint8Array> {
  const replacements = new Map<string, string>();
  for (const placeholder of parsed.placeholders) {
    const fill = placeholder.id ? fills.get(placeholder.id) : undefined;
    if (fill !== undefined) replacements.set(placeholder.text, fill);
  }
  return fillDocxPlaceholders(templateBytes, replacements);
}

export interface ArtefactOptions extends LlmFlagOptions, ScopeSelection {
  dataDir: string;
  /** Path to a .md/.docx template (CLI). */
  templatePath?: string;
  /** Inline template (API upload): original filename + bytes. */
  template?: { name: string; bytes: Uint8Array };
  maxTokens?: number;
  /** Report the mode + planned tasks without calling the LLM or writing. */
  dryRun?: boolean;
  /** Injected client (tests); defaults to `llmClientFor` over flags + env. */
  client?: LlmClient;
}

export interface ArtefactResult {
  /** Absent on dry runs. */
  record?: ArtefactRecord;
  /** Absolute path of the filled output (absent on dry runs). */
  outputPath?: string;
  mode: ArtefactMode;
  /** Placeholder count, or the planned/estimated section count. */
  tasks: number;
  filled: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  failures: { id: string; error: string }[];
  /** True when the token budget stopped generation early. */
  aborted: boolean;
  /** Set when a sections-mode docx template fell back to markdown output. */
  markdownFallback: boolean;
}

/** Generate one artefact from a template + repo scope. */
export async function generateArtefact(options: ArtefactOptions): Promise<ArtefactResult> {
  const dataDir = resolve(options.dataDir);
  // Scope first: cheap local reads, and a bad selection reports precisely
  // even when no LLM credentials are configured.
  const { scope, inputs } = resolveScope(dataDir, options);
  const template = await loadTemplate(
    templateFromOptions(options).name,
    templateFromOptions(options).bytes,
  );

  const parsed = parseTemplate(template.text);
  if (options.dryRun) {
    const tasks =
      parsed.mode === "placeholders"
        ? parsed.placeholders.length
        : headingSections(template.text).length;
    return {
      mode: parsed.mode,
      tasks,
      filled: 0,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      failures: [],
      aborted: false,
      markdownFallback: template.format === "docx" && parsed.mode === "sections",
    };
  }

  // Resolve credentials only when a generation will actually run — dry runs
  // must work with no provider configured.
  const client = options.client ?? llmClientFor(options);
  const run = await generateArtefactFills(inputs, template.text, template.name, client, {
    maxTokens: options.maxTokens,
  });

  const markdownFallback = template.format === "docx" && run.plan.mode === "sections";
  const output: PersistArtefactInput["output"] =
    template.format === "docx" && run.plan.mode === "placeholders"
      ? { bytes: await filledDocx(template.bytes, run.plan.parsed, run.fills), ext: "docx" }
      : {
          bytes: Buffer.from(assembleArtefactMarkdown(run.plan, run.fills), "utf8"),
          ext: "md",
        };

  const record = persistArtefact(dataDir, {
    name: template.name,
    format: template.format,
    mode: run.plan.mode,
    scope,
    repos: inputs.map((i) => i.model.repo.slug),
    templateBytes: template.bytes,
    output,
    sectionsFilled: run.fills.size,
    model: client.model,
    failures: run.failures,
  });

  return {
    record,
    outputPath: join(artefactsDir(dataDir), record.id, record.outputFile),
    mode: run.plan.mode,
    tasks:
      run.plan.mode === "placeholders"
        ? run.plan.parsed.placeholders.length
        : (run.plan.sections ?? []).length,
    filled: run.fills.size,
    calls: run.calls,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    failures: run.failures,
    aborted: run.aborted,
    markdownFallback,
  };
}

// ---- Agent-mode export/import (decision 0016 pattern) ----

export interface ExportArtefactTasksOptions extends ScopeSelection {
  dataDir: string;
  templatePath: string;
  outFile: string;
}

export interface ExportArtefactTasksResult {
  mode: ArtefactMode;
  tasks: number;
  outFile: string;
}

/**
 * Agent-mode step 1: package every fill task for offline completion. The
 * template travels inside the task file so import needs nothing else.
 */
export async function exportArtefactTasks(
  options: ExportArtefactTasksOptions,
): Promise<ExportArtefactTasksResult> {
  const dataDir = resolve(options.dataDir);
  const { scope, inputs } = resolveScope(dataDir, options);
  const path = resolve(options.templatePath);
  const template = await loadTemplate(basename(path), readFileSync(path));
  const taskFile = buildArtefactTaskFile(inputs, template.text, {
    name: template.name,
    format: template.format,
    scope,
    docxBytes: template.format === "docx" ? template.bytes : undefined,
  });
  const outFile = resolve(options.outFile);
  writeFileSync(outFile, JSON.stringify(taskFile, null, 2) + "\n");
  return { mode: taskFile.mode, tasks: taskFile.tasks.length, outFile };
}

export interface ImportArtefactResultsOptions {
  dataDir: string;
  resultsFile: string;
  tasksFile: string;
}

export interface ImportArtefactResultsResult {
  record: ArtefactRecord;
  outputPath: string;
  applied: number;
  failures: { id: string; error: string }[];
  unmatchedResults: string[];
  missingTasks: string[];
}

function readJsonFile(path: string, what: string): unknown {
  const absolute = resolve(path);
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read ${what} ${absolute}: ${(err as Error).message}`);
  }
}

/** Agent-mode step 2: validate the agent's fills, assemble, and persist. */
export async function importArtefactResults(
  options: ImportArtefactResultsOptions,
): Promise<ImportArtefactResultsResult> {
  const parsedTasks = ArtefactTaskFile.safeParse(readJsonFile(options.tasksFile, "tasks file"));
  if (!parsedTasks.success) {
    throw new Error(`Invalid tasks file ${options.tasksFile}: ${parsedTasks.error.message}`);
  }
  const taskFile = parsedTasks.data;
  const parsedResults = ArtefactResultsFile.safeParse(
    readJsonFile(options.resultsFile, "results file"),
  );
  if (!parsedResults.success) {
    throw new Error(`Invalid results file ${options.resultsFile}: ${parsedResults.error.message}`);
  }
  const applied = applyArtefactResults(taskFile, parsedResults.data);

  // Re-parsing the embedded template reproduces the exact segments (and ids)
  // the export built its tasks from, so fills splice into the right spots.
  const parsed = parseTemplate(taskFile.template.text);
  const templateBytes = taskFile.template.docxBase64
    ? new Uint8Array(Buffer.from(taskFile.template.docxBase64, "base64"))
    : Buffer.from(taskFile.template.text, "utf8");

  let output: PersistArtefactInput["output"];
  if (taskFile.mode === "placeholders" && taskFile.format === "docx") {
    output = { bytes: await filledDocx(templateBytes, parsed, applied.fills), ext: "docx" };
  } else if (taskFile.mode === "placeholders") {
    output = { bytes: Buffer.from(assembleFilledTemplate(parsed, applied.fills), "utf8"), ext: "md" };
  } else {
    const parts = (taskFile.sections ?? [])
      .map((s) => applied.fills.get(s.id))
      .filter((c): c is string => c !== undefined && c.trim().length > 0);
    output = { bytes: Buffer.from(`${parts.join("\n\n").trim()}\n`, "utf8"), ext: "md" };
  }

  const dataDir = resolve(options.dataDir);
  const record = persistArtefact(dataDir, {
    name: taskFile.name,
    format: taskFile.format,
    mode: taskFile.mode,
    scope: taskFile.scope,
    repos: taskFile.repos,
    templateBytes,
    output,
    sectionsFilled: applied.fills.size,
    model: applied.model,
    failures: applied.failures,
  });

  return {
    record,
    outputPath: join(artefactsDir(dataDir), record.id, record.outputFile),
    applied: applied.applied,
    failures: applied.failures,
    unmatchedResults: applied.unmatchedResults,
    missingTasks: applied.missingTasks,
  };
}
