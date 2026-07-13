import { z } from "zod";
import {
  SkillDefinition,
  hashContent,
  slugify,
  type CoreDoc,
  type DocModel,
  type GenerationScope,
  type Subsystem,
} from "@necronomidoc/docmodel";
import type { LlmClient, LlmCompleteRequest } from "./llm/client.js";

/**
 * Skill generation (slice 8, decision 0017): the LLM turns documented
 * codebases into agent skills in the Agent Skills convention — a folder per
 * skill holding a SKILL.md with `name`/`description` YAML frontmatter and a
 * markdown body. A skill set is generated for one scope (one repo, an
 * explicit list, or every documented repo) in a single completion, grounded
 * in the repos' core docs, subsystem maps, and file summaries, and cached
 * against each repo's content hash so unchanged scopes never re-generate.
 */

/** Everything the generator knows about one in-scope repo. */
export interface ScopeInput {
  model: DocModel;
  /** Resolved core docs (any provenance) — the highest-signal context. */
  coreDocs?: CoreDoc[];
  subsystems?: Subsystem[];
}

/** Cap on skills accepted from one completion (defense against runaway output). */
export const MAX_SKILLS_PER_SET = 12;

/**
 * Stable id for a scope: `global` for all-repo sets, the slug for one repo,
 * and the joined slugs for an explicit list (hashed when too long for a
 * directory name).
 */
export function skillSetIdFor(scope: GenerationScope, slugs: string[]): string {
  if (scope === "global") return "global";
  const sorted = [...slugs].sort();
  if (scope === "repo") return sorted[0] ?? "repo";
  const joined = sorted.join("+");
  if (joined.length <= 64) return joined;
  return `${sorted[0]}+${sorted.length - 1}-more-${hashContent(joined).slice(0, 8)}`;
}

/** Per-repo character budget for context, shrinking as the scope grows. */
function perRepoCharBudget(repoCount: number): number {
  return Math.max(2500, Math.min(9000, Math.floor(36000 / Math.max(1, repoCount))));
}

function coreDocExcerpt(docs: CoreDoc[] | undefined, kind: CoreDoc["kind"], cap: number): string | undefined {
  const doc = docs?.find((d) => d.kind === kind);
  if (!doc) return undefined;
  const body = doc.content.trim();
  return body.length > cap ? `${body.slice(0, cap)}\n…(truncated)` : body;
}

/**
 * The grounding context for one skill-set completion: per repo, its core
 * docs (overview, conventions, architecture), subsystem boundaries, and a
 * bounded file inventory with summaries.
 */
export function scopeContext(inputs: ScopeInput[]): string {
  const budget = perRepoCharBudget(inputs.length);
  const blocks: string[] = [];
  for (const input of inputs) {
    const { model } = input;
    const lines: string[] = [`## Repository: ${model.repo.name} (slug: ${model.repo.slug})`];
    for (const kind of ["overview", "conventions", "architecture"] as const) {
      const excerpt = coreDocExcerpt(input.coreDocs, kind, Math.floor(budget / 3));
      if (excerpt) lines.push("", `### ${kind}`, excerpt);
    }
    if (input.subsystems && input.subsystems.length > 0) {
      lines.push("", "### Subsystems");
      for (const s of input.subsystems.slice(0, 20)) {
        const owns = s.owns.length > 0 ? ` — owns: ${s.owns.slice(0, 4).join("; ")}` : "";
        lines.push(`- ${s.name}: ${s.purpose}${owns}`);
      }
    }
    const files = model.files
      .map((f) => `- ${f.path}${f.enrichment?.summary ? ` — ${f.enrichment.summary}` : ""}`)
      .slice(0, 80);
    lines.push("", "### Files (bounded)", ...files);
    if (model.files.length > 80) lines.push(`… (${model.files.length - 80} more files)`);
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

const SKILLS_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    skills: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short lowercase-hyphen skill name" },
          description: { type: "string", description: "One or two sentences: what the skill does and when an agent should use it" },
          body: { type: "string", description: "The SKILL.md markdown body: step-by-step instructions" },
          repos: { type: "array", items: { type: "string" }, description: "Repo slugs the skill applies to" },
        },
        required: ["name", "description", "body"],
        additionalProperties: false,
      },
    },
  },
  required: ["skills"],
  additionalProperties: false,
};

const SKILLS_SYSTEM_PROMPT = [
  "You write agent skills (the Agent Skills / SKILL.md convention) for coding",
  "agents that will work inside the documented repositories. Each skill's",
  "`description` states when to reach for it; its `body` is a complete,",
  "self-contained markdown playbook: concrete steps, real file paths and",
  "module names from the provided documentation, conventions to follow, and",
  "pitfalls to avoid. Where live documentation would help, tell the agent to",
  "query the necronomidoc MCP tools (search_docs, get_core_doc, get_file_doc,",
  "get_subsystem_overview, list_files). Ground every claim strictly in the",
  "provided context — never invent files, commands, or behavior. Respond with",
  "JSON only, matching the schema.",
].join(" ");

function skillsInstructions(scope: GenerationScope, repoCount: number): string {
  const shared = [
    "Propose 3 to 8 high-value skills. Prefer skills a coding agent would",
    "actually invoke: adding a feature the codebase's way, navigating the",
    "architecture, following the test/release conventions, extending a",
    "documented extension point.",
  ].join(" ");
  if (scope === "repo") {
    return `${shared} All skills target this single repository.`;
  }
  return [
    shared,
    `The scope covers ${repoCount} repositories. Include at least one`,
    "cross-repository skill (how the repos relate, where shared work lands)",
    "when the documentation supports it, and set each skill's `repos` to the",
    "slugs it draws on.",
  ].join(" ");
}

/**
 * The full completion request for one skill set — shared by the live
 * generator and the agent task export, so both send identical prompts.
 */
export function skillSetRequestFor(
  scope: GenerationScope,
  repoCount: number,
  context: string,
): LlmCompleteRequest {
  return {
    system: SKILLS_SYSTEM_PROMPT,
    prompt: `${skillsInstructions(scope, repoCount)}\n\n${context}`,
    maxOutputTokens: 8000,
    jsonSchema: SKILLS_JSON_SCHEMA,
  };
}

const SkillsResponse = z.object({
  skills: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string().min(1),
      body: z.string().min(1),
      repos: z.array(z.string()).optional(),
    }),
  ),
});

/**
 * Parse one skill-set model response into validated `SkillDefinition`s:
 * names are slugified into folder-safe ids (de-duplicated), and claimed repo
 * slugs are filtered to the ones actually in scope. Throws on malformed JSON.
 */
export function skillsFromResponse(text: string, scopeSlugs: string[]): SkillDefinition[] {
  const parsed = SkillsResponse.parse(JSON.parse(text));
  const known = new Set(scopeSlugs);
  const seen = new Set<string>();
  const skills: SkillDefinition[] = [];
  for (const raw of parsed.skills.slice(0, MAX_SKILLS_PER_SET)) {
    let id = slugify(raw.name) || "skill";
    while (seen.has(id)) id = `${id}-2`;
    seen.add(id);
    const repos = (raw.repos ?? []).filter((slug) => known.has(slug));
    skills.push(
      SkillDefinition.parse({
        id,
        name: id,
        description: raw.description.trim(),
        body: raw.body.trim(),
        // A skill claiming no (valid) repos in a single-repo scope is that repo's.
        repos: repos.length > 0 ? repos : scopeSlugs.length === 1 ? [...scopeSlugs] : [],
      }),
    );
  }
  return skills;
}

/** YAML-safe double-quoted scalar (JSON string quoting is valid YAML). */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

/** Render one skill as its SKILL.md file (frontmatter + body). */
export function renderSkillMd(skill: SkillDefinition): string {
  const lines = [
    "---",
    `name: ${yamlString(skill.name)}`,
    `description: ${yamlString(skill.description)}`,
    "---",
    "",
  ];
  const body = skill.body.startsWith("#") ? skill.body : `# ${skill.name}\n\n${skill.body}`;
  return `${lines.join("\n")}${body}\n`;
}

export interface GenerateSkillSetResult {
  skills: SkillDefinition[];
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

/** Ask the LLM to write one skill set for the scope — a single completion. */
export async function generateSkillSet(
  inputs: ScopeInput[],
  scope: GenerationScope,
  client: LlmClient,
): Promise<GenerateSkillSetResult> {
  const slugs = inputs.map((i) => i.model.repo.slug);
  const completion = await client.complete(
    skillSetRequestFor(scope, inputs.length, scopeContext(inputs)),
  );
  return {
    skills: skillsFromResponse(completion.text, slugs),
    calls: 1,
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens,
  };
}

// ---- Agent-mode tasks (no API key; mirrors llm/tasks.ts, decision 0016) ----

export const SKILL_TASKS_FORMAT_VERSION = 1;

const TaskRequest = z.object({
  system: z.string().optional(),
  prompt: z.string(),
  maxOutputTokens: z.number().int().positive(),
  jsonSchema: z.record(z.unknown()).optional(),
});

export const SkillTaskFile = z.object({
  formatVersion: z.literal(SKILL_TASKS_FORMAT_VERSION),
  kind: z.literal("skills"),
  setId: z.string(),
  scope: z.enum(["repo", "multi", "global"]),
  repos: z.array(z.string()),
  /** slug → repoContentHash at export time, stamped into the imported set. */
  sourceHashes: z.record(z.string()),
  generatedAt: z.string(),
  instructions: z.string(),
  tasks: z.array(z.object({ id: z.literal("skills"), request: TaskRequest })),
});
export type SkillTaskFile = z.infer<typeof SkillTaskFile>;

export const SkillResultsFile = z.object({
  formatVersion: z.literal(SKILL_TASKS_FORMAT_VERSION),
  setId: z.string().optional(),
  model: z.string().optional(),
  results: z.array(z.object({ id: z.string(), output: z.unknown() })),
});
export type SkillResultsFile = z.infer<typeof SkillResultsFile>;

function skillTaskInstructions(): string {
  return [
    "Complete the single `skills` task: treat `request.system` as the system",
    "prompt and `request.prompt` as the user prompt, and produce one JSON",
    "object matching `request.jsonSchema` exactly. Ground everything in the",
    "documentation inside the prompt — never invent files or behavior. Then",
    "write a results file (JSON) shaped like:",
    "",
    '  { "formatVersion": 1, "setId": "<this file\'s setId>", "model": "<your model name>",',
    '    "results": [ { "id": "skills", "output": { "skills": [ ... ] } } ] }',
    "",
    "Finally, apply it with:",
    "",
    "  necronomidoc skills --import-results <results-file> --tasks <this file>",
  ].join("\n");
}

/** Agent-mode step 1: the exact live prompt, packaged for offline completion. */
export function buildSkillTaskFile(
  inputs: ScopeInput[],
  scope: GenerationScope,
  meta: { setId: string; sourceHashes: Record<string, string>; now?: () => string },
): SkillTaskFile {
  const now = meta.now ?? (() => new Date().toISOString());
  return {
    formatVersion: SKILL_TASKS_FORMAT_VERSION,
    kind: "skills",
    setId: meta.setId,
    scope,
    repos: inputs.map((i) => i.model.repo.slug),
    sourceHashes: meta.sourceHashes,
    generatedAt: now(),
    instructions: skillTaskInstructions(),
    tasks: [
      { id: "skills", request: skillSetRequestFor(scope, inputs.length, scopeContext(inputs)) },
    ],
  };
}

export interface AppliedSkillResults {
  skills: SkillDefinition[];
  model: string;
  failures: { id: string; error: string }[];
}

/**
 * Agent-mode step 2: validate the agent's results against the task file and
 * parse them through the exact path the live run uses. Pure — persistence
 * stays with the caller.
 */
export function applySkillResults(
  taskFile: SkillTaskFile,
  resultsFile: SkillResultsFile,
): AppliedSkillResults {
  if (resultsFile.setId && resultsFile.setId !== taskFile.setId) {
    throw new Error(
      `Results file is for skill set "${resultsFile.setId}" but the tasks file is for "${taskFile.setId}".`,
    );
  }
  const applied: AppliedSkillResults = {
    skills: [],
    model: resultsFile.model ?? "external-agent",
    failures: [],
  };
  const result = resultsFile.results.find((r) => r.id === "skills");
  if (!result) {
    applied.failures.push({ id: "skills", error: "no result with id \"skills\" in the results file" });
    return applied;
  }
  const text = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
  try {
    applied.skills = skillsFromResponse(text, taskFile.repos);
  } catch (err) {
    applied.failures.push({ id: "skills", error: (err as Error).message });
  }
  return applied;
}
