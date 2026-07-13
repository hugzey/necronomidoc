import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import {
  SCHEMA_VERSION,
  SkillSet,
  SkillSetIndex,
  type SkillSetIndexEntry,
} from "@necronomidoc/docmodel";
import {
  SkillResultsFile,
  SkillTaskFile,
  applySkillResults,
  buildSkillTaskFile,
  generateSkillSet,
  renderSkillMd,
  skillSetIdFor,
} from "@necronomidoc/enrichment";
import type { LlmClient } from "@necronomidoc/enrichment";
import { llmClientFor, type LlmFlagOptions } from "./llm.js";
import { resolveScope, type ScopeSelection } from "./scope.js";

/**
 * The `necronomidoc skills` pipeline (slice 8, decision 0017): resolve the
 * repo scope from published docs, ask the LLM for one skill set, and persist
 * it under `data/skills/<set-id>/` — a `skillset.json` manifest plus one
 * `<skill-id>/SKILL.md` folder per skill, ready to copy into an agent's
 * skills directory or download as a zip. Sets are cached against every
 * in-scope repo's content hash: re-running on unchanged docs is free.
 */

const SKILLS_DIR = "skills";
const INDEX_FILE = "index.json";
const SET_FILE = "skillset.json";

export function skillsDir(dataDir: string): string {
  return join(dataDir, SKILLS_DIR);
}

/** Read the skill-set index, or an empty one if none exists yet. */
export function readSkillSetIndex(dataDir: string): SkillSetIndex {
  const file = join(skillsDir(dataDir), INDEX_FILE);
  if (!existsSync(file)) return { schemaVersion: SCHEMA_VERSION, sets: [] };
  const parsed = SkillSetIndex.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    console.warn(`[skills] ignoring invalid ${file}: ${parsed.error.message}`);
    return { schemaVersion: SCHEMA_VERSION, sets: [] };
  }
  return parsed.data;
}

/** Read one persisted skill set, or undefined when absent/invalid. */
export function readSkillSet(dataDir: string, id: string): SkillSet | undefined {
  const file = join(skillsDir(dataDir), id, SET_FILE);
  if (!existsSync(file)) return undefined;
  const parsed = SkillSet.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    console.warn(`[skills] ignoring invalid ${file}: ${parsed.error.message}`);
    return undefined;
  }
  return parsed.data;
}

/** Persist a set: manifest + rendered SKILL.md folders + index entry. */
export function persistSkillSet(dataDir: string, set: SkillSet): void {
  const setDir = join(skillsDir(dataDir), set.id);
  // Rebuild the set dir so skills dropped by a regeneration don't linger.
  rmSync(setDir, { recursive: true, force: true });
  mkdirSync(setDir, { recursive: true });
  writeFileSync(join(setDir, SET_FILE), JSON.stringify(set, null, 2) + "\n");
  for (const skill of set.skills) {
    const skillDir = join(setDir, skill.id);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), renderSkillMd(skill));
  }
  const index = readSkillSetIndex(dataDir);
  const entry: SkillSetIndexEntry = {
    id: set.id,
    scope: set.scope,
    repos: set.repos,
    skillCount: set.skills.length,
    model: set.model,
    generatedAt: set.generatedAt,
  };
  const next: SkillSetIndex = {
    schemaVersion: SCHEMA_VERSION,
    sets: [...index.sets.filter((s) => s.id !== set.id), entry].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
  };
  writeFileSync(join(skillsDir(dataDir), INDEX_FILE), JSON.stringify(next, null, 2) + "\n");
}

/** Zip one set's SKILL.md folders for download (`<skill-id>/SKILL.md`). */
export async function skillSetZip(dataDir: string, id: string): Promise<Uint8Array | undefined> {
  const set = readSkillSet(dataDir, id);
  if (!set) return undefined;
  const zip = new JSZip();
  for (const skill of set.skills) {
    zip.file(`${skill.id}/SKILL.md`, renderSkillMd(skill));
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

export interface SkillsOptions extends LlmFlagOptions, ScopeSelection {
  dataDir: string;
  /** Regenerate even when every in-scope repo hash matches the cached set. */
  force?: boolean;
  /** Report what would be generated without calling the LLM or writing. */
  dryRun?: boolean;
  /** Injected client (tests); defaults to `llmClientFor` over flags + env. */
  client?: LlmClient;
}

export interface SkillsResult {
  setId: string;
  scope: SkillSet["scope"];
  repos: string[];
  /** True when the cached set was fresh and no generation ran. */
  cached: boolean;
  /** Repos whose docs changed since the cached set was generated. */
  staleRepos: string[];
  skillsWritten: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

function staleReposOf(existing: SkillSet | undefined, sourceHashes: Record<string, string>): string[] {
  if (!existing) return Object.keys(sourceHashes);
  return Object.entries(sourceHashes)
    .filter(([slug, hash]) => existing.sourceHashes[slug] !== hash)
    .map(([slug]) => slug)
    .concat(existing.repos.filter((slug) => !(slug in sourceHashes)));
}

/** Generate (or reuse) the skill set for a scope. */
export async function generateSkills(options: SkillsOptions): Promise<SkillsResult> {
  const dataDir = resolve(options.dataDir);
  // Scope first: it's cheap local reads, and a bad selection should be
  // reported precisely even when no LLM credentials are configured.
  const { scope, inputs, sourceHashes } = resolveScope(dataDir, options);
  const slugs = inputs.map((i) => i.model.repo.slug);
  const setId = skillSetIdFor(scope, slugs);

  const existing = readSkillSet(dataDir, setId);
  const staleRepos = staleReposOf(existing, sourceHashes);
  const fresh = existing !== undefined && staleRepos.length === 0;

  const base: SkillsResult = {
    setId,
    scope,
    repos: slugs,
    cached: fresh && !options.force,
    staleRepos,
    skillsWritten: 0,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  if (options.dryRun || (fresh && !options.force)) return base;

  // Resolve credentials only when a generation will actually run — cached
  // and dry-run paths must work with no provider configured.
  const client = options.client ?? llmClientFor(options);
  const generated = await generateSkillSet(inputs, scope, client);
  const set: SkillSet = {
    schemaVersion: SCHEMA_VERSION,
    id: setId,
    scope,
    repos: slugs,
    sourceHashes,
    model: client.model,
    generatedAt: new Date().toISOString(),
    skills: generated.skills,
  };
  persistSkillSet(dataDir, set);
  return {
    ...base,
    cached: false,
    skillsWritten: generated.skills.length,
    calls: generated.calls,
    inputTokens: generated.inputTokens,
    outputTokens: generated.outputTokens,
  };
}

/** Copy a set's SKILL.md folders to an output directory (CLI `--out`). */
export function writeSkillFolders(dataDir: string, id: string, outDir: string): number {
  const set = readSkillSet(dataDir, id);
  if (!set) throw new Error(`No skill set "${id}" — generate it first.`);
  mkdirSync(resolve(outDir), { recursive: true });
  for (const skill of set.skills) {
    const skillDir = join(resolve(outDir), skill.id);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), renderSkillMd(skill));
  }
  return set.skills.length;
}

// ---- Agent-mode export/import (decision 0016 pattern) ----

export interface ExportSkillTasksOptions extends ScopeSelection {
  dataDir: string;
  outFile: string;
}

export interface ExportSkillTasksResult {
  setId: string;
  repos: string[];
  outFile: string;
}

/** Agent-mode step 1: the exact live prompt, written to a task file. */
export function exportSkillTasks(options: ExportSkillTasksOptions): ExportSkillTasksResult {
  const dataDir = resolve(options.dataDir);
  const { scope, inputs, sourceHashes } = resolveScope(dataDir, options);
  const setId = skillSetIdFor(scope, inputs.map((i) => i.model.repo.slug));
  const taskFile = buildSkillTaskFile(inputs, scope, { setId, sourceHashes });
  const outFile = resolve(options.outFile);
  writeFileSync(outFile, JSON.stringify(taskFile, null, 2) + "\n");
  return { setId, repos: taskFile.repos, outFile };
}

export interface ImportSkillResultsOptions {
  dataDir: string;
  resultsFile: string;
  tasksFile: string;
}

export interface ImportSkillResultsResult {
  setId: string;
  skillsWritten: number;
  failures: { id: string; error: string }[];
}

function readJsonFile(path: string, what: string): unknown {
  const absolute = resolve(path);
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read ${what} ${absolute}: ${(err as Error).message}`);
  }
}

/** Agent-mode step 2: validate the agent's results and persist the set. */
export function importSkillResults(options: ImportSkillResultsOptions): ImportSkillResultsResult {
  const parsedTasks = SkillTaskFile.safeParse(readJsonFile(options.tasksFile, "tasks file"));
  if (!parsedTasks.success) {
    throw new Error(`Invalid tasks file ${options.tasksFile}: ${parsedTasks.error.message}`);
  }
  const parsedResults = SkillResultsFile.safeParse(
    readJsonFile(options.resultsFile, "results file"),
  );
  if (!parsedResults.success) {
    throw new Error(`Invalid results file ${options.resultsFile}: ${parsedResults.error.message}`);
  }
  const taskFile = parsedTasks.data;
  const applied = applySkillResults(taskFile, parsedResults.data);
  if (applied.skills.length > 0) {
    const set: SkillSet = {
      schemaVersion: SCHEMA_VERSION,
      id: taskFile.setId,
      scope: taskFile.scope,
      repos: taskFile.repos,
      // Hashes recorded at export time, so docs changed since the export show
      // as stale on the next run — the standard staleness machinery.
      sourceHashes: taskFile.sourceHashes,
      model: applied.model,
      generatedAt: new Date().toISOString(),
      skills: applied.skills,
    };
    persistSkillSet(resolve(options.dataDir), set);
  }
  return {
    setId: taskFile.setId,
    skillsWritten: applied.skills.length,
    failures: applied.failures,
  };
}
