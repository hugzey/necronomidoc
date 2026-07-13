import { z } from "zod";
import type { ArtefactMode, GenerationScope } from "@necronomidoc/docmodel";
import type { LlmClient, LlmCompleteRequest } from "./llm/client.js";
import { scopeContext, type ScopeInput } from "./skills.js";

/**
 * Artefact generation (slice 8, decision 0018): a user-provided template
 * (markdown or docx) is filled in from the documented repos' knowledge.
 *
 * Two modes, decided by what the template contains:
 *
 * - **placeholders** — the template marks fill-in points with `{{…}}` or
 *   `<…>` (the marker text is the instruction). Everything outside the
 *   markers is preserved verbatim; each placeholder is one LLM task.
 * - **sections** — no markers found. The LLM first plans the document's
 *   sections (from its headings when present, best guess otherwise), then
 *   writes each section as its own task; the output is the assembled
 *   sections. Fixed boilerplate is NOT guaranteed to survive in this mode.
 */

/** Cap on fill tasks per artefact (placeholders or planned sections). */
export const MAX_FILL_TASKS = 40;

export interface TemplateSegment {
  kind: "text" | "placeholder";
  /** Verbatim template text (for placeholders: the full marker, braces included). */
  text: string;
  /** Placeholder only: the instruction inside the marker. */
  instruction?: string;
  /** Placeholder only: stable task id (`ph-1`, `ph-2`, …). */
  id?: string;
}

export interface ParsedTemplate {
  mode: ArtefactMode;
  /** Placeholders mode: the template split into text/placeholder runs. */
  segments: TemplateSegment[];
  /** The placeholder segments, in order. */
  placeholders: TemplateSegment[];
}

/**
 * Is this `<…>` content a fill-in marker rather than markup? Diamond markers
 * are prose instructions ("<Such as this section goes here>"), so require
 * multiple words and reject anything tag-shaped (`</`, attributes, URLs).
 */
function isDiamondPlaceholder(inner: string): boolean {
  const trimmed = inner.trim();
  if (trimmed.length < 4 || !/\s/.test(trimmed)) return false;
  if (/^[/!?]/.test(trimmed)) return false;
  if (/[=<>]/.test(trimmed)) return false;
  if (/^[a-z][a-z0-9-]*\s/.test(trimmed) && /"|'/.test(trimmed)) return false;
  if (/^https?:/i.test(trimmed)) return false;
  return true;
}

const MARKER_RE = /\{\{([\s\S]+?)\}\}|<([^<>\n]+)>/g;

/**
 * Scan a template for `{{…}}` and `<…>` markers. Any marker found puts the
 * template in `placeholders` mode; a marker-free template falls back to
 * `sections` mode (heading-driven / best-guess planning).
 */
export function parseTemplate(text: string): ParsedTemplate {
  const segments: TemplateSegment[] = [];
  const placeholders: TemplateSegment[] = [];
  let cursor = 0;
  let counter = 0;
  MARKER_RE.lastIndex = 0;
  for (const match of text.matchAll(MARKER_RE)) {
    const [full, curly, diamond] = match;
    const instruction = curly !== undefined ? curly.trim() : diamond!.trim();
    if (curly === undefined && !isDiamondPlaceholder(diamond!)) continue;
    if (instruction.length === 0) continue;
    if (match.index! > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, match.index!) });
    }
    const placeholder: TemplateSegment = {
      kind: "placeholder",
      text: full,
      instruction,
      id: `ph-${++counter}`,
    };
    segments.push(placeholder);
    placeholders.push(placeholder);
    cursor = match.index! + full.length;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return {
    mode: placeholders.length > 0 ? "placeholders" : "sections",
    segments,
    placeholders,
  };
}

/** Reassemble a placeholders-mode template with fills; unfilled markers stay. */
export function assembleFilledTemplate(
  parsed: ParsedTemplate,
  fills: Map<string, string>,
): string {
  return parsed.segments
    .map((seg) =>
      seg.kind === "placeholder" && seg.id && fills.has(seg.id) ? fills.get(seg.id)! : seg.text,
    )
    .join("");
}

// ---- Prompts (shared by the live generator and agent task export) ----

const FILL_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { content: { type: "string" } },
  required: ["content"],
  additionalProperties: false,
};

const ARTEFACT_SYSTEM_PROMPT = [
  "You fill in a document template using the documentation of one or more",
  "code repositories. Base everything strictly on the provided repository",
  "documentation — never invent files, numbers, names, or behavior; where",
  "the documentation doesn't answer, say so briefly rather than guessing.",
  "Match the template's tone and format. Respond with JSON only, matching",
  "the schema.",
].join(" ");

/** Bounded copy of the template for prompt context. */
function templateExcerpt(templateText: string): string {
  return templateText.length > 12000 ? `${templateText.slice(0, 12000)}\n…(truncated)` : templateText;
}

/** Surrounding template text for one placeholder, so fills fit their spot. */
function surroundings(parsed: ParsedTemplate, id: string): { before: string; after: string } {
  const index = parsed.segments.findIndex((s) => s.id === id);
  const before = parsed.segments
    .slice(0, index)
    .map((s) => s.text)
    .join("")
    .slice(-300);
  const after = parsed.segments
    .slice(index + 1)
    .map((s) => s.text)
    .join("")
    .slice(0, 300);
  return { before, after };
}

/** The completion request that fills one placeholder. */
export function placeholderFillRequestFor(
  parsed: ParsedTemplate,
  placeholder: TemplateSegment,
  docName: string,
  context: string,
): LlmCompleteRequest {
  const { before, after } = surroundings(parsed, placeholder.id!);
  const prompt = [
    `Document: ${docName}`,
    "",
    "One placeholder in the document template must be replaced. The",
    "placeholder's instruction (what belongs there):",
    "",
    `  ${placeholder.instruction}`,
    "",
    "It sits between this text:",
    "```",
    `${before}⟪PLACEHOLDER⟫${after}`,
    "```",
    "",
    "Return only the replacement text in `content` — it is spliced in",
    "verbatim, so no surrounding quotes and no restating of the instruction.",
    "Match the inline/block shape of the spot (a phrase mid-sentence stays a",
    "phrase; a standalone marker can be full markdown).",
    "",
    "Full template for context:",
    "```",
    templateExcerpt(parsed.segments.map((s) => s.text).join("")),
    "```",
    "",
    "Repository documentation:",
    "",
    context,
  ].join("\n");
  return { system: ARTEFACT_SYSTEM_PROMPT, prompt, maxOutputTokens: 2500, jsonSchema: FILL_JSON_SCHEMA };
}

const PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          heading: { type: "string" },
          instruction: { type: "string", description: "What content belongs in this section" },
        },
        required: ["heading", "instruction"],
        additionalProperties: false,
      },
    },
  },
  required: ["sections"],
  additionalProperties: false,
};

/** Sections-mode step 1: plan the document's sections from the template. */
export function artefactPlanRequestFor(
  templateText: string,
  docName: string,
  context: string,
): LlmCompleteRequest {
  const prompt = [
    `Document: ${docName}`,
    "",
    "The template below has no explicit placeholders. Plan how to write the",
    "finished document: identify its sections — from the template's headings",
    "when it has them, otherwise propose a sensible structure for this kind",
    "of document — and for each section write an `instruction` describing",
    "exactly what content belongs there, grounded in what the repository",
    "documentation can answer. Keep the template's order and intent.",
    "",
    "Template:",
    "```",
    templateExcerpt(templateText),
    "```",
    "",
    "Repository documentation:",
    "",
    context,
  ].join("\n");
  return { system: ARTEFACT_SYSTEM_PROMPT, prompt, maxOutputTokens: 2000, jsonSchema: PLAN_JSON_SCHEMA };
}

const PlanResponse = z.object({
  sections: z.array(z.object({ heading: z.string().min(1), instruction: z.string().min(1) })),
});

export interface PlannedSection {
  id: string;
  heading: string;
  instruction: string;
}

/** Parse the plan response into capped, id-stamped sections. */
export function sectionsFromPlanResponse(text: string): PlannedSection[] {
  const parsed = PlanResponse.parse(JSON.parse(text));
  return parsed.sections
    .slice(0, MAX_FILL_TASKS)
    .map((s, i) => ({ id: `section-${i + 1}`, heading: s.heading, instruction: s.instruction }));
}

/**
 * Sections-mode fallback plan when no LLM is available at planning time
 * (agent task export): one section per markdown heading, or a single
 * whole-document section for heading-less templates.
 */
export function headingSections(templateText: string): PlannedSection[] {
  const withoutFences = templateText.replace(/```[\s\S]*?```/g, "");
  const headings = [...withoutFences.matchAll(/^#{1,3}\s+(.+?)\s*$/gm)].map((m) => m[1]!);
  if (headings.length === 0) {
    return [
      {
        id: "section-1",
        heading: "Document",
        instruction: "Write the complete document the template describes.",
      },
    ];
  }
  return headings.slice(0, MAX_FILL_TASKS).map((heading, i) => ({
    id: `section-${i + 1}`,
    heading,
    instruction: `Write the "${heading}" section, following any notes the template puts under that heading.`,
  }));
}

/** The completion request that writes one planned section. */
export function sectionFillRequestFor(
  section: PlannedSection,
  templateText: string,
  docName: string,
  context: string,
): LlmCompleteRequest {
  const prompt = [
    `Document: ${docName}`,
    "",
    `Write the "${section.heading}" section of the document. What belongs here:`,
    "",
    `  ${section.instruction}`,
    "",
    "Return the complete markdown for this section in `content`, starting",
    "with its heading. Sections are concatenated in order to form the final",
    "document, so don't repeat other sections' content.",
    "",
    "Template:",
    "```",
    templateExcerpt(templateText),
    "```",
    "",
    "Repository documentation:",
    "",
    context,
  ].join("\n");
  return { system: ARTEFACT_SYSTEM_PROMPT, prompt, maxOutputTokens: 2500, jsonSchema: FILL_JSON_SCHEMA };
}

const FillResponse = z.object({ content: z.string() });

/** Parse one fill response. Throws on malformed JSON. */
export function fillFromResponse(text: string): string {
  return FillResponse.parse(JSON.parse(text)).content;
}

// ---- Live generation ----

export interface ArtefactFillPlan {
  mode: ArtefactMode;
  parsed: ParsedTemplate;
  /** Sections mode only. */
  sections?: PlannedSection[];
}

export interface GenerateFillsResult {
  /** Task id (`ph-n` / `section-n`) → generated content. */
  fills: Map<string, string>;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  failures: { id: string; error: string }[];
  /** True when the token budget stopped generation early. */
  aborted: boolean;
}

/**
 * Run every fill task for a template against the live client, stopping at
 * the token budget (matching the overlay writer's policy: the in-flight call
 * may overshoot by one; the rest are reported as not filled).
 */
export async function generateArtefactFills(
  inputs: ScopeInput[],
  templateText: string,
  docName: string,
  client: LlmClient,
  options: { maxTokens?: number; planned?: PlannedSection[] } = {},
): Promise<GenerateFillsResult & { plan: ArtefactFillPlan }> {
  const context = scopeContext(inputs);
  const parsed = parseTemplate(templateText);
  const result: GenerateFillsResult = {
    fills: new Map(),
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    failures: [],
    aborted: false,
  };
  const spent = () => result.inputTokens + result.outputTokens;
  const budgetLeft = () => options.maxTokens === undefined || spent() < options.maxTokens;

  const complete = async (request: LlmCompleteRequest): Promise<string> => {
    const completion = await client.complete(request);
    result.calls++;
    result.inputTokens += completion.inputTokens;
    result.outputTokens += completion.outputTokens;
    return completion.text;
  };

  let sections: PlannedSection[] | undefined = options.planned;
  if (parsed.mode === "sections" && !sections) {
    sections = sectionsFromPlanResponse(
      await complete(artefactPlanRequestFor(templateText, docName, context)),
    );
  }

  const tasks =
    parsed.mode === "placeholders"
      ? parsed.placeholders.slice(0, MAX_FILL_TASKS).map((p) => ({
          id: p.id!,
          request: placeholderFillRequestFor(parsed, p, docName, context),
        }))
      : (sections ?? []).map((s) => ({
          id: s.id,
          request: sectionFillRequestFor(s, templateText, docName, context),
        }));

  for (const task of tasks) {
    if (!budgetLeft()) {
      result.aborted = true;
      break;
    }
    try {
      result.fills.set(task.id, fillFromResponse(await complete(task.request)));
    } catch (err) {
      result.failures.push({ id: task.id, error: (err as Error).message });
    }
  }

  return { ...result, plan: { mode: parsed.mode, parsed, sections } };
}

/** Assemble the final markdown for either mode. */
export function assembleArtefactMarkdown(plan: ArtefactFillPlan, fills: Map<string, string>): string {
  if (plan.mode === "placeholders") return assembleFilledTemplate(plan.parsed, fills);
  const parts = (plan.sections ?? [])
    .map((s) => fills.get(s.id))
    .filter((c): c is string => c !== undefined && c.trim().length > 0);
  return `${parts.join("\n\n").trim()}\n`;
}

// ---- Agent-mode tasks (no API key; mirrors llm/tasks.ts, decision 0016) ----

export const ARTEFACT_TASKS_FORMAT_VERSION = 1;

const TaskRequest = z.object({
  system: z.string().optional(),
  prompt: z.string(),
  maxOutputTokens: z.number().int().positive(),
  jsonSchema: z.record(z.unknown()).optional(),
});

export const ArtefactTaskFile = z.object({
  formatVersion: z.literal(ARTEFACT_TASKS_FORMAT_VERSION),
  kind: z.literal("artefact"),
  /** Original template filename. */
  name: z.string(),
  format: z.enum(["markdown", "docx"]),
  mode: z.enum(["placeholders", "sections"]),
  scope: z.enum(["repo", "multi", "global"]),
  repos: z.array(z.string()),
  /**
   * The template travels inside the task file so `--import-results` can
   * assemble without re-reading the original: text for markdown, base64 of
   * the original bytes for docx.
   */
  template: z.object({ text: z.string(), docxBase64: z.string().optional() }),
  /** Sections mode: the heading-derived plan the fills answer. */
  sections: z
    .array(z.object({ id: z.string(), heading: z.string(), instruction: z.string() }))
    .optional(),
  generatedAt: z.string(),
  instructions: z.string(),
  tasks: z.array(z.object({ id: z.string(), request: TaskRequest })),
});
export type ArtefactTaskFile = z.infer<typeof ArtefactTaskFile>;

export const ArtefactResultsFile = z.object({
  formatVersion: z.literal(ARTEFACT_TASKS_FORMAT_VERSION),
  name: z.string().optional(),
  model: z.string().optional(),
  results: z.array(z.object({ id: z.string(), output: z.unknown() })),
});
export type ArtefactResultsFile = z.infer<typeof ArtefactResultsFile>;

function artefactTaskInstructions(): string {
  return [
    "Complete every task: treat `request.system` as the system prompt and",
    "`request.prompt` as the user prompt, and produce one JSON object per",
    "task matching `request.jsonSchema` exactly ({ \"content\": \"…\" }).",
    "Ground everything in the repository documentation inside each prompt.",
    "Then write a results file (JSON) shaped like:",
    "",
    '  { "formatVersion": 1, "model": "<your model name>",',
    '    "results": [ { "id": "<task id>", "output": { "content": "…" } } ] }',
    "",
    "Include one result per task, echoing each task's `id` verbatim. Finally,",
    "apply it with:",
    "",
    "  necronomidoc artefact --import-results <results-file> --tasks <this file>",
  ].join("\n");
}

export interface BuildArtefactTaskFileOptions {
  name: string;
  format: "markdown" | "docx";
  scope: GenerationScope;
  /** Original docx bytes (docx templates only). */
  docxBytes?: Uint8Array;
  now?: () => string;
}

/**
 * Agent-mode step 1: package every fill task for offline completion. The
 * plan step has no LLM at export time, so sections mode uses the
 * heading-derived plan (`headingSections`) — placeholders mode is identical
 * to a live run.
 */
export function buildArtefactTaskFile(
  inputs: ScopeInput[],
  templateText: string,
  options: BuildArtefactTaskFileOptions,
): ArtefactTaskFile {
  const now = options.now ?? (() => new Date().toISOString());
  const context = scopeContext(inputs);
  const parsed = parseTemplate(templateText);
  const sections = parsed.mode === "sections" ? headingSections(templateText) : undefined;
  const tasks =
    parsed.mode === "placeholders"
      ? parsed.placeholders.slice(0, MAX_FILL_TASKS).map((p) => ({
          id: p.id!,
          request: placeholderFillRequestFor(parsed, p, options.name, context),
        }))
      : sections!.map((s) => ({
          id: s.id,
          request: sectionFillRequestFor(s, templateText, options.name, context),
        }));
  return {
    formatVersion: ARTEFACT_TASKS_FORMAT_VERSION,
    kind: "artefact",
    name: options.name,
    format: options.format,
    mode: parsed.mode,
    scope: options.scope,
    repos: inputs.map((i) => i.model.repo.slug),
    template: {
      text: templateText,
      docxBase64: options.docxBytes ? Buffer.from(options.docxBytes).toString("base64") : undefined,
    },
    sections,
    generatedAt: now(),
    instructions: artefactTaskInstructions(),
    tasks,
  };
}

export interface AppliedArtefactResults {
  fills: Map<string, string>;
  model: string;
  applied: number;
  failures: { id: string; error: string }[];
  unmatchedResults: string[];
  missingTasks: string[];
}

/**
 * Agent-mode step 2: validate the agent's results against the task file and
 * parse them through the same fill path a live run uses. Pure — assembly and
 * persistence stay with the caller.
 */
export function applyArtefactResults(
  taskFile: ArtefactTaskFile,
  resultsFile: ArtefactResultsFile,
): AppliedArtefactResults {
  const tasksById = new Set(taskFile.tasks.map((t) => t.id));
  const applied: AppliedArtefactResults = {
    fills: new Map(),
    model: resultsFile.model ?? "external-agent",
    applied: 0,
    failures: [],
    unmatchedResults: [],
    missingTasks: [],
  };
  for (const result of resultsFile.results) {
    if (!tasksById.has(result.id) || applied.fills.has(result.id)) {
      applied.unmatchedResults.push(result.id);
      continue;
    }
    const text = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
    try {
      applied.fills.set(result.id, fillFromResponse(text));
      applied.applied++;
    } catch (err) {
      applied.failures.push({ id: result.id, error: (err as Error).message });
    }
  }
  for (const task of taskFile.tasks) {
    if (!applied.fills.has(task.id) && !applied.failures.some((f) => f.id === task.id)) {
      applied.missingTasks.push(task.id);
    }
  }
  return applied;
}
