import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  CoreDocKind,
  LlmCoreDoc,
  SCHEMA_VERSION,
  repoContentHash,
  type CoreDoc,
  type CoreDocsManifest,
  type DocModel,
} from "@necronomidoc/docmodel";
import type { LlmClient, LlmCompleteRequest } from "./llm/client.js";

/**
 * Core docs (slice 7): four documents every repo publishes — project
 * overview, conventions, packages/modules/libraries, and architecture (with a
 * mermaid or ASCII diagram). Each doc resolves independently by fixed source
 * precedence:
 *
 *   repo (`.necronomidoc/docs/<kind>.md` shipped in the source repo)
 *   > override (`data/enrichment/<slug>/docs/<kind>.md`, server-side curation)
 *   > llm (written by `necronomidoc enrich`, cached against the repo hash)
 *   > heuristic (always-present floor derived from the extracted model)
 */

export const CORE_DOC_KINDS = CoreDocKind.options;

/** Subdirectory of `.necronomidoc/` (repo) or the enrichment dir (server) holding `<kind>.md`. */
export const CORE_DOCS_SUBDIR = "docs";

/** Server-side cache of LLM-written core docs, next to `llm.json`. */
export const LLM_CORE_DOCS_FILE = "coredocs.llm.json";

export const CORE_DOC_TITLES: Record<CoreDocKind, string> = {
  overview: "Project overview",
  conventions: "Conventions",
  packages: "Packages, modules & libraries",
  architecture: "Architecture",
};

/** First `# heading` of a markdown document, if any (ignoring fenced code). */
function firstHeading(markdown: string): string | undefined {
  // Strip fenced code blocks first so a `# comment` line inside a ```bash
  // block can't be mistaken for the document title.
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, "");
  return withoutFences.match(/^#\s+(.+?)\s*$/m)?.[1];
}

/** Load one curated core doc (`<dir>/<kind>.md`), or undefined when absent. */
export function loadMarkdownCoreDoc(
  dir: string,
  kind: CoreDocKind,
  provenance: "repo" | "override",
): CoreDoc | undefined {
  const path = join(dir, `${kind}.md`);
  if (!existsSync(path)) return undefined;
  const content = readFileSync(path, "utf8");
  if (content.trim().length === 0) return undefined;
  return {
    kind,
    title: firstHeading(content) ?? CORE_DOC_TITLES[kind],
    content,
    provenance,
    stale: false,
  };
}

/** Load the server-side LLM core-doc cache written by a previous enrich run. */
export function loadLlmCoreDocs(dir: string): LlmCoreDoc[] {
  const path = join(dir, LLM_CORE_DOCS_FILE);
  if (!existsSync(path)) return [];
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    // A truncated or hand-edited cache must not abort the whole build/enrich —
    // degrade to "no cached docs" (they regenerate on the next enrich run),
    // matching how invalid individual entries are tolerated below.
    console.warn(`[enrichment] ignoring unreadable ${path}: ${(err as Error).message}`);
    return [];
  }
  const out: LlmCoreDoc[] = [];
  for (const entry of Array.isArray(data) ? data : []) {
    const parsed = LlmCoreDoc.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
    else console.warn(`[enrichment] invalid core doc in ${path}: ${parsed.error.message}`);
  }
  return out;
}

// ---- Heuristic floor ----

/** Group a file path for module-level views: up to two leading segments. */
function moduleKey(path: string): string {
  const parts = path.split("/");
  if (parts.length === 1) return "(root)";
  return parts.length === 2 ? parts[0]! : `${parts[0]}/${parts[1]}`;
}

function moduleCounts(model: DocModel): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of model.files) {
    const key = moduleKey(f.path);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Map([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

/** Normalize a relative import against the importing file's directory. */
function resolveRelative(fromPath: string, spec: string): string | undefined {
  const parts = fromPath.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join("/");
}

/** The npm package name of an external import specifier (undefined for relative/builtin). */
function packageName(spec: string): string | undefined {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) return undefined;
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

interface PackageUse {
  files: string[];
}

/** Aggregate external package usage across the model's import statements. */
export function collectExternalPackages(model: DocModel): Map<string, PackageUse> {
  const byPackage = new Map<string, PackageUse>();
  for (const file of model.files) {
    for (const imp of file.imports) {
      const name = packageName(imp.moduleSpecifier);
      if (!name) continue;
      const use = byPackage.get(name) ?? { files: [] };
      if (!use.files.includes(file.path)) use.files.push(file.path);
      byPackage.set(name, use);
    }
  }
  return new Map(
    [...byPackage.entries()].sort((a, b) => b[1].files.length - a[1].files.length || a[0].localeCompare(b[0])),
  );
}

/** Directed module-level dependency edges derived from relative imports. */
function moduleEdges(model: DocModel): [string, string][] {
  const filePaths = new Set(model.files.map((f) => f.path));
  const stripExt = new Map<string, string>();
  for (const p of filePaths) stripExt.set(p.replace(/\.[a-z]+$/i, ""), p);
  // Dedup on JSON-encoded pairs so a module key containing any character
  // (space, punctuation) can't collide — the tuples are what we return.
  const seen = new Set<string>();
  const edges: [string, string][] = [];
  for (const file of model.files) {
    for (const imp of file.imports) {
      if (!imp.moduleSpecifier.startsWith(".")) continue;
      const resolved = resolveRelative(file.path, imp.moduleSpecifier);
      if (!resolved) continue;
      // Imports usually omit the extension (and .js maps to .ts on disk).
      const target =
        stripExt.get(resolved.replace(/\.[a-z]+$/i, "")) ??
        stripExt.get(`${resolved}/index`) ??
        (filePaths.has(resolved) ? resolved : undefined);
      if (!target) continue;
      const from = moduleKey(file.path);
      const to = moduleKey(target);
      if (from === to) continue;
      const key = JSON.stringify([from, to]);
      if (!seen.has(key)) {
        seen.add(key);
        edges.push([from, to]);
      }
    }
  }
  return edges.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}

const CURATE_HINT = (kind: CoreDocKind): string =>
  `> Heuristic draft. Replace it by shipping \`.necronomidoc/docs/${kind}.md\` in the repo, ` +
  `dropping an override in the server's \`data/enrichment/<slug>/docs/${kind}.md\`, or running ` +
  "`necronomidoc enrich` to generate an LLM version.";

function languageBreakdown(model: DocModel): string[] {
  const byExt = new Map<string, number>();
  for (const f of model.files) {
    // Extension from the basename only — a dotted directory (`api.v2/`) or an
    // extension-less file (`Makefile`) must not yield a bogus "extension".
    const base = f.path.split("/").pop()!;
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 ? base.slice(dot + 1) : "(none)";
    byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
  }
  return [...byExt.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([ext, n]) => `- \`.${ext}\` — ${n} file${n === 1 ? "" : "s"}`);
}

function heuristicOverview(model: DocModel): string {
  const symbolCount = model.files.reduce((n, f) => n + f.symbols.length, 0);
  const readme = model.files.find((f) => f.format === "markdown" && /^readme\.(md|markdown|mdx)$/i.test(f.path));
  // First non-heading paragraph of the README is the best summary on hand.
  const intro = readme?.content
    ?.split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0 && !p.startsWith("#") && !p.startsWith("["));
  const lines = [
    `# ${CORE_DOC_TITLES.overview}`,
    "",
    CURATE_HINT("overview"),
    "",
    `**${model.repo.name}** — ${model.files.length} documented files, ${symbolCount} top-level symbols.`,
    "",
  ];
  if (intro) lines.push(intro, "");
  lines.push("## Layout", "");
  for (const [dir, count] of moduleCounts(model)) {
    lines.push(`- \`${dir}\` — ${count} file${count === 1 ? "" : "s"}`);
  }
  lines.push("", "## File types", "", ...languageBreakdown(model));
  return lines.join("\n");
}

function heuristicConventions(model: DocModel): string {
  const tests = model.files.filter((f) => /(\.|_)(test|spec)\.[a-z]+$/i.test(f.path));
  const wellKnown = ["components", "hooks", "utils", "lib", "api", "services", "pages", "types", "src", "tests", "docs"];
  const dirs = new Set(model.files.flatMap((f) => f.path.split("/").slice(0, -1)));
  const observed = wellKnown.filter((d) => dirs.has(d));
  const exported = model.files.flatMap((f) => f.symbols.filter((s) => s.exported).map((s) => s.name));
  const pascal = exported.filter((n) => /^[A-Z]/.test(n)).length;
  const camel = exported.filter((n) => /^[a-z]/.test(n)).length;
  const lines = [
    `# ${CORE_DOC_TITLES.conventions}`,
    "",
    CURATE_HINT("conventions"),
    "",
    "Patterns observable in the extracted model:",
    "",
    ...languageBreakdown(model),
    "",
    tests.length > 0
      ? `- Tests: ${tests.length} file${tests.length === 1 ? "" : "s"} using the \`*.test.*\` / \`*.spec.*\` naming pattern, colocated with the code.`
      : "- Tests: no `*.test.*` / `*.spec.*` files detected in the documented set.",
    `- Exported naming: ${pascal} PascalCase and ${camel} camelCase top-level exports.`,
  ];
  if (observed.length > 0) {
    lines.push(`- Directory conventions in use: ${observed.map((d) => `\`${d}/\``).join(", ")}.`);
  }
  return lines.join("\n");
}

function heuristicPackages(model: DocModel): string {
  const packages = collectExternalPackages(model);
  const lines = [
    `# ${CORE_DOC_TITLES.packages}`,
    "",
    CURATE_HINT("packages"),
    "",
  ];
  if (packages.size === 0) {
    lines.push("No third-party package imports were found in the documented files.");
    return lines.join("\n");
  }
  lines.push(
    "Third-party packages imported by the documented files (why/how each is used needs curation or an enrich run):",
    "",
    "| Package | Imported by | Example |",
    "|---|---|---|",
  );
  for (const [name, use] of packages) {
    lines.push(`| \`${name}\` | ${use.files.length} file${use.files.length === 1 ? "" : "s"} | \`${use.files[0]}\` |`);
  }
  return lines.join("\n");
}

function heuristicArchitecture(model: DocModel): string {
  const counts = moduleCounts(model);
  const edges = moduleEdges(model);
  const ids = new Map<string, string>();
  let i = 0;
  for (const dir of counts.keys()) ids.set(dir, `m${i++}`);

  // Double quotes close a mermaid label string; a directory name may legally
  // contain one, which would corrupt the whole diagram. Encode it as the
  // entity mermaid renders literally.
  const label = (text: string): string => text.replace(/"/g, "#quot;");

  const lines = [
    `# ${CORE_DOC_TITLES.architecture}`,
    "",
    CURATE_HINT("architecture"),
    "",
    "Module map derived from the directory layout and relative imports:",
    "",
    "```mermaid",
    "graph LR",
  ];
  for (const [dir, count] of counts) {
    lines.push(`  ${ids.get(dir)}["${label(dir)} (${count})"]`);
  }
  for (const [from, to] of edges) {
    // Both ends are module keys, so ids always resolve — but guard anyway.
    if (ids.has(from) && ids.has(to)) lines.push(`  ${ids.get(from)} --> ${ids.get(to)}`);
  }
  lines.push("```", "", "## Modules", "");
  for (const [dir, count] of counts) {
    const uses = edges.filter(([from]) => from === dir).map(([, to]) => `\`${to}\``);
    lines.push(
      `- \`${dir}\` — ${count} file${count === 1 ? "" : "s"}${uses.length ? `; depends on ${uses.join(", ")}` : ""}`,
    );
  }
  return lines.join("\n");
}

/** The always-present floor for one core doc kind. */
export function heuristicCoreDoc(model: DocModel, kind: CoreDocKind): CoreDoc {
  const content = {
    overview: heuristicOverview,
    conventions: heuristicConventions,
    packages: heuristicPackages,
    architecture: heuristicArchitecture,
  }[kind](model);
  return { kind, title: CORE_DOC_TITLES[kind], content, provenance: "heuristic", stale: false };
}

// ---- Resolution ----

export interface BuildCoreDocsOptions {
  /** The source repo's `.necronomidoc/docs/` (absent for pre-extracted IR). */
  repoDocsDir?: string;
  /** The server's `data/enrichment/<slug>/docs/` override dir. */
  overrideDir?: string;
  /** The server's `data/enrichment/<slug>/` dir holding the LLM cache. */
  llmDir?: string;
  now?: () => string;
}

/** Resolve all four core docs by per-doc source precedence and package them. */
export function buildCoreDocs(model: DocModel, options: BuildCoreDocsOptions = {}): CoreDocsManifest {
  const repoHash = repoContentHash(model.files);
  const llmDocs = options.llmDir ? loadLlmCoreDocs(options.llmDir) : [];
  const docs = CORE_DOC_KINDS.map((kind) => {
    const repoDoc = options.repoDocsDir && loadMarkdownCoreDoc(options.repoDocsDir, kind, "repo");
    if (repoDoc) return repoDoc;
    const override = options.overrideDir && loadMarkdownCoreDoc(options.overrideDir, kind, "override");
    if (override) return override;
    const llm = llmDocs.find((d) => d.kind === kind);
    if (llm) {
      return {
        kind,
        title: llm.title,
        content: llm.content,
        provenance: "llm" as const,
        // Stale llm docs are still served (better than the heuristic floor),
        // flagged for the "may be outdated" badge; the next enrich run
        // regenerates them.
        stale: llm.sourceRepoHash !== repoHash,
        updatedAt: llm.updatedAt,
      };
    }
    return heuristicCoreDoc(model, kind);
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    repo: model.repo.slug,
    docs,
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
  };
}

// ---- LLM writer ----

export interface CoreDocsPlan {
  /** Kinds the LLM should (re)write: not curated, and no fresh cache entry. */
  needed: CoreDocKind[];
  /** Kinds owned by a repo or override file (never LLM-written). */
  curated: CoreDocKind[];
  /** Kinds whose cached LLM doc matches the current repo hash. */
  fresh: CoreDocKind[];
}

/** Decide which core docs an enrich run should generate. */
export function planCoreDocs(model: DocModel, options: BuildCoreDocsOptions): CoreDocsPlan {
  const repoHash = repoContentHash(model.files);
  const llmDocs = options.llmDir ? loadLlmCoreDocs(options.llmDir) : [];
  const plan: CoreDocsPlan = { needed: [], curated: [], fresh: [] };
  for (const kind of CORE_DOC_KINDS) {
    const curated =
      (options.repoDocsDir && loadMarkdownCoreDoc(options.repoDocsDir, kind, "repo")) ??
      (options.overrideDir && loadMarkdownCoreDoc(options.overrideDir, kind, "override"));
    if (curated) {
      plan.curated.push(kind);
      continue;
    }
    const cached = llmDocs.find((d) => d.kind === kind);
    if (cached && cached.sourceRepoHash === repoHash) plan.fresh.push(kind);
    else plan.needed.push(kind);
  }
  return plan;
}

const LlmCoreDocResponse = z.object({ title: z.string(), content: z.string() });

const CORE_DOC_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: { type: "string" },
    content: { type: "string" },
  },
  required: ["title", "content"],
  additionalProperties: false,
};

const CORE_DOC_INSTRUCTIONS: Record<CoreDocKind, string> = {
  overview: [
    "Write the repository's PROJECT OVERVIEW document: what the project is,",
    "what it does, its main components, and how its outputs are used.",
    "Aim for a concise page a new team member reads first.",
  ].join(" "),
  conventions: [
    "Write the repository's CONVENTIONS document: the coding style and",
    "patterns actually observable in the files — naming, file organization,",
    "typing, error handling, and testing patterns. Describe only what the",
    "evidence supports; note where a convention is inconsistent.",
  ].join(" "),
  packages: [
    "Write the repository's PACKAGES, MODULES & LIBRARIES document: for each",
    "third-party package in the import data, explain what it is, why the",
    "project plausibly uses it, and where (which files/areas import it).",
    "Ground every claim in the provided import data.",
  ].join(" "),
  architecture: [
    "Write the repository's ARCHITECTURE document: a high-level layout of the",
    "code modules, how they depend on each other, and any evident",
    "infrastructure or external systems. It MUST include a mermaid diagram in",
    "a ```mermaid fenced code block (graph TD or LR) built from the modules",
    "and dependencies in the provided data, followed by a short explanation",
    "of each part.",
  ].join(" "),
};

const CORE_DOC_SYSTEM_PROMPT = [
  "You write core documentation pages for a repository documentation site",
  "used by humans and coding agents. Base everything strictly on the",
  "provided extraction data — never invent files, packages, or behavior.",
  "The `content` field is a complete markdown document starting with a",
  "top-level `#` heading. Respond with JSON only, matching the schema.",
].join(" ");

/**
 * The full completion request for one core-doc kind — shared by the live
 * generator below and the agent task export, so both send identical prompts.
 */
export function coreDocRequestFor(kind: CoreDocKind, context: string): LlmCompleteRequest {
  return {
    system: CORE_DOC_SYSTEM_PROMPT,
    prompt: `${CORE_DOC_INSTRUCTIONS[kind]}\n\n${context}`,
    maxOutputTokens: 3000,
    jsonSchema: CORE_DOC_JSON_SCHEMA,
  };
}

/**
 * Parse one core-doc model response and stamp the cacheable `LlmCoreDoc`
 * (repo hash for staleness, model id for provenance). Shared by the live
 * generator and the agent results import. Throws on malformed JSON.
 */
export function llmCoreDocFromResponse(
  kind: CoreDocKind,
  text: string,
  meta: { sourceRepoHash: string; model: string; now: () => string },
): LlmCoreDoc {
  const parsed = LlmCoreDocResponse.parse(JSON.parse(text));
  return {
    kind,
    title: parsed.title,
    content: parsed.content,
    sourceRepoHash: meta.sourceRepoHash,
    model: meta.model,
    updatedAt: meta.now(),
  };
}

/** Shared context block: layout, files (with summaries), packages, README. */
export function coreDocContext(model: DocModel): string {
  const lines: string[] = [`Repository: ${model.repo.name}`, "", "Modules (dir — file count):"];
  for (const [dir, count] of moduleCounts(model)) lines.push(`- ${dir} — ${count}`);

  const packages = collectExternalPackages(model);
  if (packages.size > 0) {
    lines.push("", "External packages (name — importing files):");
    for (const [name, use] of [...packages].slice(0, 40)) {
      lines.push(`- ${name} — ${use.files.slice(0, 5).join(", ")}${use.files.length > 5 ? ", …" : ""}`);
    }
  }

  const fileLines = model.files.map((f) => {
    const summary = f.enrichment?.summary ?? "";
    const imports = f.imports
      .map((i) => i.moduleSpecifier)
      .filter((m) => m.startsWith("."))
      .join(", ");
    return `- ${f.path}${summary ? ` — ${summary}` : ""}${imports ? ` [imports: ${imports}]` : ""}`;
  });
  lines.push("", "Files:", ...fileLines.slice(0, 300));
  if (fileLines.length > 300) lines.push(`… (${fileLines.length - 300} more files)`);

  const readme = model.files.find((f) => f.format === "markdown" && /^readme\.(md|markdown|mdx)$/i.test(f.path));
  if (readme?.content) {
    lines.push("", "README excerpt:", "```", readme.content.slice(0, 1500), "```");
  }
  return lines.join("\n");
}

export interface GenerateCoreDocsResult {
  docs: LlmCoreDoc[];
  calls: number;
  inputTokens: number;
  outputTokens: number;
  failures: { kind: CoreDocKind; error: string }[];
}

/**
 * Ask the LLM to write the given core docs, one call per document. Results
 * carry the current repo hash so `buildCoreDocs`/`planCoreDocs` can cache and
 * flag staleness, mirroring the overlay writer's content-hash policy.
 */
export async function generateCoreDocs(
  model: DocModel,
  client: LlmClient,
  kinds: CoreDocKind[],
  options: { now?: () => string; maxTokens?: number } = {},
): Promise<GenerateCoreDocsResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const repoHash = repoContentHash(model.files);
  const context = coreDocContext(model);
  const result: GenerateCoreDocsResult = {
    docs: [],
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    failures: [],
  };
  for (const kind of kinds) {
    // Stop before a call that would blow the remaining token budget (the
    // in-flight call already made can overshoot by one, same as the overlay
    // writer). Uncovered kinds are picked up by the next enrich run.
    if (
      options.maxTokens !== undefined &&
      result.inputTokens + result.outputTokens >= options.maxTokens
    ) {
      break;
    }
    try {
      const completion = await client.complete(coreDocRequestFor(kind, context));
      result.calls++;
      result.inputTokens += completion.inputTokens;
      result.outputTokens += completion.outputTokens;
      result.docs.push(
        llmCoreDocFromResponse(kind, completion.text, {
          sourceRepoHash: repoHash,
          model: client.model,
          now,
        }),
      );
    } catch (err) {
      result.failures.push({ kind, error: (err as Error).message });
    }
  }
  return result;
}
