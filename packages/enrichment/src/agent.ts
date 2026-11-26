import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  Recipe,
  SCHEMA_VERSION,
  slugify,
  type AgentManifest,
  type DocFile,
  type DocModel,
  type DocSymbolShape,
  type TestFileBinding,
  type UndocumentedConcept,
  type UsageExample,
} from "@necronomidoc/docmodel";
import { isTestPath } from "./product/testrefs.js";
import { resolveModule } from "./subsystems.js";

/**
 * Build-time knowledge for agents (decision 0024): real call sites per
 * exported symbol, "how do I…" recipes mined from repeated file patterns,
 * test-to-code bindings, and curated search synonyms — published as
 * `agent.json` so MCP answers stay one call deep.
 */

/** Reads a repo file's text by repo-relative path (undefined when unavailable). */
export type SourceReader = (path: string) => string | undefined;

/** A reader over a working tree, bounded per file so one huge file can't stall a build. */
export function workingTreeReader(repoDir: string, maxBytes = 512_000): SourceReader {
  const cache = new Map<string, string | undefined>();
  return (path) => {
    if (cache.has(path)) return cache.get(path);
    let text: string | undefined;
    try {
      const buf = readFileSync(join(repoDir, path));
      text = buf.length > maxBytes ? undefined : buf.toString("utf8");
    } catch {
      text = undefined;
    }
    cache.set(path, text);
    return text;
  };
}

// ---- Usage examples (call sites from the import graph) ----

const USAGES_PER_SYMBOL = 2;
const SNIPPET_MAX = 240;

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Line indexes that belong to import/re-export statements (skipped as call sites). */
function importLines(lines: string[]): Set<number> {
  const out = new Set<number>();
  let inBlock = false;
  lines.forEach((line, i) => {
    const t = line.trim();
    if (inBlock) {
      out.add(i);
      if (/\bfrom\s*["'`]/.test(t) || /^}\s*;?$/.test(t)) inBlock = false;
      return;
    }
    if (/^(import\b|export\s+(\*|\{[^}]*\})\s*from\b|from\s+\S+\s+import\b)/.test(t)) {
      out.add(i);
      if (/^import\s*(type\s*)?\{[^}]*$/.test(t) || /^export\s*\{[^}]*$/.test(t)) inBlock = true;
    }
  });
  return out;
}

/** The call starting at `start`, extended while its parentheses are unbalanced (≤ 3 lines). */
function snippetAt(lines: string[], start: number): string {
  const parts: string[] = [];
  let depth = 0;
  for (let i = start; i < Math.min(lines.length, start + 3); i++) {
    const line = lines[i]!.trim();
    parts.push(line);
    for (const ch of line) {
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") depth--;
    }
    if (depth <= 0) break;
  }
  const text = parts.join("\n");
  return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX - 1)}…` : text;
}

/** First line in `lines` that uses `name` (calls / JSX / member access first, then any reference). */
function findUse(lines: string[], name: string, skip: Set<number>): number | undefined {
  const n = escapeRe(name);
  const strong = new RegExp(`(?<![\\w$.])${n}\\s*(\\(|<[^=]|\\.|\`)|<${n}[\\s/>]|\\bnew\\s+${n}\\b`);
  const weak = new RegExp(`(?<![\\w$.'"])${n}(?![\\w$])`);
  for (const re of [strong, weak]) {
    for (let i = 0; i < lines.length; i++) {
      if (skip.has(i)) continue;
      const line = lines[i]!;
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("#") || t.startsWith('"""')) continue;
      // The declaration itself is not a usage.
      if (new RegExp(`\\b(function|class|const|let|var|def|interface|type)\\s+${n}\\b`).test(line)) continue;
      if (re.test(line)) return i;
    }
  }
  return undefined;
}

/**
 * For each exported top-level symbol, up to two real call sites: the files
 * importing it (resolved through the doc model's import graph) and the first
 * line in each that uses it. Deterministic — importers are visited by path.
 */
export function mineUsageExamples(model: DocModel, read: SourceReader): Record<string, UsageExample[]> {
  const known = new Set(model.files.map((f) => f.path));
  const exportedByPath = new Map<string, Map<string, string>>();
  for (const file of model.files) {
    const names = new Map<string, string>();
    for (const s of file.symbols) if (s.exported) names.set(s.name, s.id);
    if (names.size > 0) exportedByPath.set(file.path, names);
  }
  const usages: Record<string, UsageExample[]> = {};
  const importers = model.files
    .filter((f) => f.format === "source")
    .sort((a, b) => a.path.localeCompare(b.path));
  for (const importer of importers) {
    let lines: string[] | undefined;
    let skip = new Set<number>();
    let unreadable = false;
    for (const imp of importer.imports) {
      if (unreadable) break;
      if (imp.isTypeOnly) continue;
      const target = resolveModule(importer.path, imp.moduleSpecifier, known);
      if (!target || target === importer.path) continue;
      const exported = exportedByPath.get(target);
      if (!exported) continue;
      for (const name of imp.names) {
        if (name.startsWith("* as ")) continue;
        const id = exported.get(name);
        if (!id) continue;
        const list = (usages[id] ??= []);
        if (list.length >= USAGES_PER_SYMBOL || list.some((u) => u.path === importer.path)) continue;
        if (!lines) {
          const text = read(importer.path);
          if (text === undefined) {
            unreadable = true;
            break;
          }
          lines = text.split(/\r?\n/);
          skip = importLines(lines);
        }
        const at = findUse(lines, name, skip);
        if (at === undefined) continue;
        list.push({ path: importer.path, line: at + 1, snippet: snippetAt(lines, at) });
      }
    }
  }
  for (const [id, list] of Object.entries(usages)) if (list.length === 0) delete usages[id];
  return usages;
}

// ---- Recipes ("how do I…") ----

/** The declaration a file is "about": first exported value-level symbol. */
function primarySymbol(file: DocFile): DocSymbolShape | undefined {
  const exported = file.symbols.filter((s) => s.exported);
  return exported.find((s) => s.kind !== "type" && s.kind !== "interface") ?? exported[0];
}

function extOf(path: string): string {
  const base = path.split("/").pop()!;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
}

function stem(path: string): string {
  const base = path.split("/").pop()!;
  const ext = extOf(path);
  return ext ? base.slice(0, -ext.length) : base;
}

/** camelCase / PascalCase / snake / kebab → words. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter(Boolean);
}

/** Longest whole-word prefix and suffix shared by every name. */
function sharedAffixes(names: string[]): { prefix: string; suffix: string } {
  const split = names.map(words);
  let p = 0;
  while (split.every((w) => w.length > p + 1 && w[p]!.toLowerCase() === split[0]![p]!.toLowerCase())) p++;
  let q = 0;
  while (split.every((w) => w.length > q + p + 1 && w[w.length - 1 - q]!.toLowerCase() === split[0]![split[0]!.length - 1 - q]!.toLowerCase())) q++;
  const firstName = names[0]!;
  const firstWords = split[0]!;
  // Rebuild from the first name's own spelling so case conventions survive.
  const prefixLen = firstWords.slice(0, p).join("").length;
  const suffixLen = firstWords.slice(firstWords.length - q).join("").length;
  const compact = firstName.replace(/[\s_\-.]/g, "");
  const sep = /[_\-.]/.exec(firstName)?.[0] ?? "";
  if (sep) {
    // snake/kebab: affixes keep their separators.
    const parts = firstName.split(sep);
    return {
      prefix: p > 0 ? `${parts.slice(0, p).join(sep)}${sep}` : "",
      suffix: q > 0 ? `${sep}${parts.slice(parts.length - q).join(sep)}` : "",
    };
  }
  return { prefix: compact.slice(0, prefixLen), suffix: q > 0 ? compact.slice(compact.length - suffixLen) : "" };
}

const PAGE_DIRS = new Set(["pages", "screens", "views", "routes", "app"]);
const API_DIRS = new Set(["api", "routes", "endpoints", "handlers", "controllers", "resolvers"]);

function singular(word: string): string {
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(ss|us)$/.test(word)) return word;
  return word.replace(/s$/, "");
}

function article(noun: string): string {
  return /^[aeiou]/i.test(noun) ? "an" : "a";
}

function recipeTitle(dir: string, kind: string, prefix: string, suffix: string): { title: string; keywords: string[] } {
  const seg = (dir.split("/").pop() ?? dir).toLowerCase();
  if (kind === "hook" || prefix === "use") return { title: "Add a hook", keywords: ["hook", "state", "use"] };
  if (kind === "component" && (/^(page|screen|view|route)$/i.test(suffix) || PAGE_DIRS.has(seg))) {
    return { title: "Add a page", keywords: ["page", "screen", "view", "route", "ui"] };
  }
  if (API_DIRS.has(seg) && (kind === "function" || kind === "variable" || kind === "class")) {
    return { title: "Add an API endpoint", keywords: ["api", "endpoint", "route", "handler", "request"] };
  }
  if (kind === "component") return { title: "Add a component", keywords: ["component", "ui", "widget"] };
  if (seg === "commands" || seg === "cmd") return { title: "Add a command", keywords: ["command", "cli"] };
  const noun = suffix ? suffix.toLowerCase() : singular(seg);
  return { title: `Add ${article(noun)} ${noun}`, keywords: [noun, seg, kind] };
}

const SNIPPET_LINES = 5;

/** The first lines of a symbol's declaration from source, or its signature. */
function exampleSnippet(file: DocFile, symbol: DocSymbolShape, read: SourceReader): { line?: number; snippet: string } {
  const text = read(file.path);
  if (text !== undefined && symbol.location.line > 0) {
    const lines = text.split(/\r?\n/);
    const start = symbol.location.line - 1;
    const end = Math.min(lines.length, symbol.location.endLine ?? start + SNIPPET_LINES, start + SNIPPET_LINES);
    const body = lines.slice(start, Math.max(end, start + 1)).join("\n").trimEnd();
    if (body.trim()) return { line: symbol.location.line, snippet: body };
  }
  return { snippet: symbol.signature ?? `${symbol.kind} ${symbol.name}` };
}

export interface MineRecipesOptions {
  read?: SourceReader;
  tests?: TestFileBinding[];
  /** Minimum instances before a pattern counts (2 with a shared name affix). */
  minInstances?: number;
}

/**
 * Mine "how do I…" recipes from repeated file patterns: sibling source files
 * in one directory that export the same kind of declaration (≥ 3, or ≥ 2 when
 * their names share an affix like `*Page`). Each recipe names the pattern, a
 * five-line canonical example from the most typical instance, the files a new
 * instance must touch (the module that registers most instances, a sibling
 * test) and ordered steps.
 */
export function mineRecipes(model: DocModel, options: MineRecipesOptions = {}): Recipe[] {
  const read = options.read ?? (() => undefined);
  const min = options.minInstances ?? 3;
  const known = new Set(model.files.map((f) => f.path));
  const groups = new Map<string, { dir: string; ext: string; kind: string; files: DocFile[] }>();
  for (const file of model.files) {
    if (file.format !== "source" || isTestPath(file.path)) continue;
    if (/^(index|__init__|mod|main)$/.test(stem(file.path))) continue;
    const primary = primarySymbol(file);
    if (!primary) continue;
    const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ".";
    const ext = extOf(file.path);
    const key = `${dir}|${ext}|${primary.kind}`;
    const g = groups.get(key) ?? { dir, ext, kind: primary.kind, files: [] };
    g.files.push(file);
    groups.set(key, g);
  }

  // Which files import which (for registration sites).
  const importsOf = new Map<string, Set<string>>();
  for (const file of model.files) {
    const set = new Set<string>();
    for (const imp of file.imports) {
      const hit = resolveModule(file.path, imp.moduleSpecifier, known);
      if (hit) set.add(hit);
    }
    importsOf.set(file.path, set);
  }

  const recipes: Recipe[] = [];
  const titles = new Map<string, number>();
  for (const g of [...groups.values()].sort((a, b) => a.dir.localeCompare(b.dir))) {
    const names = g.files.map((f) => stem(f.path));
    const { prefix, suffix } = g.files.length > 1 ? sharedAffixes(names) : { prefix: "", suffix: "" };
    const enough = g.files.length >= min || (g.files.length >= 2 && (prefix !== "" || suffix !== ""));
    if (!enough) continue;
    const members = new Set(g.files.map((f) => f.path));

    // Canonical example: the median-sized instance (most typical, not the outlier).
    const sized = g.files
      .map((f) => ({ f, s: primarySymbol(f)!, size: (primarySymbol(f)!.location.endLine ?? 0) - primarySymbol(f)!.location.line }))
      .sort((a, b) => a.size - b.size || a.f.path.localeCompare(b.f.path));
    const typical = sized[Math.floor((sized.length - 1) / 2)]!;
    const example = exampleSnippet(typical.f, typical.s, read);

    // Registration sites: files outside the group importing ≥ half of it.
    const need = Math.max(1, Math.ceil(members.size / 2));
    const registrations = model.files
      .filter((f) => !members.has(f.path))
      .map((f) => ({ path: f.path, n: [...(importsOf.get(f.path) ?? [])].filter((p) => members.has(p)).length }))
      .filter((r) => r.n >= need)
      .sort((a, b) => b.n - a.n || a.path.localeCompare(b.path))
      .slice(0, 2);
    const test = (options.tests ?? []).find((t) => t.exercises.some((p) => members.has(p)));

    const { title: baseTitle, keywords } = recipeTitle(g.dir, g.kind, prefix, suffix);
    const seen = titles.get(baseTitle) ?? 0;
    titles.set(baseTitle, seen + 1);
    const title = seen === 0 ? baseTitle : `${baseTitle} (${g.dir})`;
    const pattern = `${g.dir === "." ? "" : `${g.dir}/`}${prefix}*${suffix}${g.ext}`;
    const newName = `${g.dir === "." ? "" : `${g.dir}/`}${prefix}<Name>${suffix}${g.ext}`;
    const steps = [
      `Create \`${newName}\` exporting a ${g.kind} shaped like \`${typical.s.name}\` in \`${typical.f.path}\`.`,
      ...registrations.map((r) => `Register it in \`${r.path}\` (it imports ${r.n} of the ${members.size} existing ones).`),
      ...(test ? [`Add a test alongside the existing ones, e.g. \`${test.path}\`.`] : []),
    ];
    recipes.push({
      id: slugify(`${baseTitle}-${g.dir}`.replace(/\//g, "-")),
      title,
      keywords: [...new Set([...keywords, ...words(suffix || prefix).map((w) => w.toLowerCase())])],
      pattern,
      kind: g.kind,
      steps,
      example: { path: typical.f.path, line: example.line, snippet: example.snippet },
      files: [typical.f.path, ...registrations.map((r) => r.path), ...(test ? [test.path] : [])],
      instances: g.files.map((f) => f.path).slice(0, 10),
      provenance: "heuristic",
    });
  }
  return recipes;
}

// ---- Curated recipes + synonyms ----

const RECIPE_FILES = ["recipes.yaml", "recipes.yml", "recipes.json"];
const SYNONYM_FILES = ["synonyms.yaml", "synonyms.yml", "synonyms.json"];

function readStructured(path: string): unknown {
  const raw = readFileSync(path, "utf8");
  return path.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
}

/** Curated `recipes.yaml` from the given dirs (later dirs win on the same id). */
export function loadCuratedRecipes(dirs: string[]): Recipe[] {
  const byId = new Map<string, Recipe>();
  for (const dir of dirs) {
    for (const name of RECIPE_FILES) {
      const path = join(dir, name);
      if (!existsSync(path)) continue;
      let data: unknown;
      try {
        data = readStructured(path);
      } catch (err) {
        console.warn(`[enrichment] ignoring unreadable ${path}: ${(err as Error).message}`);
        continue;
      }
      const list = Array.isArray(data) ? data : ((data as { recipes?: unknown[] })?.recipes ?? []);
      for (const entry of list) {
        const withId =
          entry && typeof entry === "object" && !("id" in entry) && typeof (entry as { title?: unknown }).title === "string"
            ? { ...entry, id: slugify((entry as { title: string }).title) }
            : entry;
        const parsed = Recipe.safeParse(withId);
        if (parsed.success) byId.set(parsed.data.id, { ...parsed.data, provenance: "human" });
        else console.warn(`[enrichment] invalid recipe in ${path}: ${parsed.error.message}`);
      }
    }
  }
  return [...byId.values()];
}

/**
 * Curated search synonyms (`synonyms.yaml`: `currency: [formatMoney, money]`,
 * optionally under a `synonyms:` key). Keys are lowercased; later dirs add to
 * earlier ones.
 */
export function loadSynonyms(dirs: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const dir of dirs) {
    for (const name of SYNONYM_FILES) {
      const path = join(dir, name);
      if (!existsSync(path)) continue;
      let data: unknown;
      try {
        data = readStructured(path);
      } catch (err) {
        console.warn(`[enrichment] ignoring unreadable ${path}: ${(err as Error).message}`);
        continue;
      }
      const map = (data as { synonyms?: unknown })?.synonyms ?? data;
      if (!map || typeof map !== "object" || Array.isArray(map)) continue;
      for (const [term, value] of Object.entries(map as Record<string, unknown>)) {
        const list = (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string" && v.trim() !== "");
        if (list.length === 0) continue;
        const key = term.trim().toLowerCase();
        out[key] = [...new Set([...(out[key] ?? []), ...list.map((v) => v.trim())])];
      }
    }
  }
  return out;
}

/**
 * Merge synonyms into `<dir>/synonyms.yaml` (created if missing). Returns how
 * many new term → word pairs were added. Rewrites the file as plain YAML.
 */
export function mergeSynonymsFile(dir: string, additions: Record<string, string[]>): { file: string; added: number } {
  const file = join(dir, "synonyms.yaml");
  const current = loadSynonyms([dir]);
  let added = 0;
  for (const [term, words] of Object.entries(additions)) {
    const key = term.trim().toLowerCase();
    if (!key) continue;
    const set = new Set(current[key] ?? []);
    for (const w of words) {
      if (w.trim() && !set.has(w.trim())) {
        set.add(w.trim());
        added++;
      }
    }
    current[key] = [...set];
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    file,
    `# Search synonyms: a term agents use -> the words the code uses (decision 0024).\n${stringifyYaml(current)}`,
  );
  return { file, added };
}

// ---- Assemble ----

export interface BuildAgentManifestOptions {
  read?: SourceReader;
  /** From `scanTests`; undefined = tests not scanned. */
  tests?: TestFileBinding[];
  /** Dirs searched for curated `recipes.yaml` / `synonyms.yaml` (lower precedence first). */
  curatedDirs?: string[];
  undocumented?: UndocumentedConcept[];
  now?: () => string;
}

/** Assemble the per-repo agent manifest (`agent.json`). */
export function buildAgentManifest(model: DocModel, options: BuildAgentManifestOptions = {}): AgentManifest {
  const read = options.read ?? (() => undefined);
  const curatedDirs = options.curatedDirs ?? [];
  const curated = loadCuratedRecipes(curatedDirs);
  const curatedIds = new Set(curated.map((r) => r.id));
  const mined = mineRecipes(model, { read, tests: options.tests }).filter((r) => !curatedIds.has(r.id));
  return {
    schemaVersion: SCHEMA_VERSION,
    repo: model.repo.slug,
    recipes: [...curated, ...mined],
    usages: mineUsageExamples(model, read),
    tests: options.tests ?? [],
    testsScanned: options.tests !== undefined,
    synonyms: loadSynonyms(curatedDirs),
    undocumented: options.undocumented ?? [],
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
  };
}
