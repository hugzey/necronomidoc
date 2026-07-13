import { z } from "zod";
import {
  CoreDocKind,
  repoContentHash,
  type DocModel,
  type EnrichmentOverlay,
  type LlmCoreDoc,
  type Subsystem,
} from "@necronomidoc/docmodel";
import {
  coreDocContext,
  coreDocRequestFor,
  llmCoreDocFromResponse,
} from "../coredocs.js";
import { subsystemsFromResponse, subsystemsRequestFor } from "../subsystems.js";
import type { LlmCompleteRequest } from "./client.js";
import {
  enrichmentRequestFor,
  overlaysFromEnrichmentResponse,
  planEnrichment,
  targetMetaFor,
  type EnrichmentPlan,
} from "./writer.js";

/**
 * Agent-mode enrichment (decision 0016): instead of calling a provider API,
 * `enrich --export-tasks` writes every planned completion — the exact same
 * prompts the live pipeline would send — to a task file. A local coding agent
 * (Claude Code, Codex CLI, …) completes the tasks under its own model and
 * subscription, writes a results file, and `enrich --import-results` validates
 * and publishes them through the same overlay/core-doc/subsystem machinery.
 * No API key ever touches this path.
 */
export const ENRICH_TASKS_FORMAT_VERSION = 1;

const TaskRequest = z.object({
  system: z.string().optional(),
  prompt: z.string(),
  maxOutputTokens: z.number().int().positive(),
  jsonSchema: z.record(z.unknown()).optional(),
});

const TargetMeta = z.object({
  fileId: z.string(),
  fileContentHash: z.string(),
  enrichFile: z.boolean(),
  symbols: z.array(z.object({ id: z.string(), contentHash: z.string() })),
});

export const EnrichmentTask = z.object({
  id: z.string(),
  kind: z.enum(["file-summary", "core-doc", "subsystems"]),
  request: TaskRequest,
  /** file-summary tasks: ids + hashes needed to stamp overlays at import. */
  target: TargetMeta.optional(),
  /** core-doc tasks: which document, and the repo hash it caches against. */
  coreDoc: z.object({ kind: CoreDocKind, sourceRepoHash: z.string() }).optional(),
});
export type EnrichmentTask = z.infer<typeof EnrichmentTask>;

export const EnrichmentTaskFile = z.object({
  formatVersion: z.literal(ENRICH_TASKS_FORMAT_VERSION),
  repo: z.object({ slug: z.string(), name: z.string() }),
  generatedAt: z.string(),
  /** Human/agent-readable contract: how to complete tasks and shape results. */
  instructions: z.string(),
  tasks: z.array(EnrichmentTask),
});
export type EnrichmentTaskFile = z.infer<typeof EnrichmentTaskFile>;

export const EnrichmentResultsFile = z.object({
  formatVersion: z.literal(ENRICH_TASKS_FORMAT_VERSION),
  repo: z.string().optional(),
  /** Label recorded as the writing model (e.g. the agent's model name). */
  model: z.string().optional(),
  results: z.array(
    z.object({
      id: z.string(),
      /** The completion: the JSON object itself, or it JSON-encoded as a string. */
      output: z.unknown(),
    }),
  ),
});
export type EnrichmentResultsFile = z.infer<typeof EnrichmentResultsFile>;

/** Model label recorded when a results file doesn't name one. */
export const DEFAULT_AGENT_MODEL_LABEL = "external-agent";

function buildInstructions(repoName: string): string {
  return [
    `Complete these documentation-enrichment tasks for the repository "${repoName}".`,
    "For each entry in `tasks`: treat `request.system` as the system prompt and",
    "`request.prompt` as the user prompt, and produce the completion — a single",
    "JSON object that matches `request.jsonSchema` exactly. Describe only what",
    "the provided code/data actually shows; never invent behavior. Then write a",
    "results file (JSON) shaped like:",
    "",
    '  { "formatVersion": 1, "repo": "<repo slug>", "model": "<your model name>",',
    '    "results": [ { "id": "<task id>", "output": { ... the JSON object ... } } ] }',
    "",
    "Include one result per task, echoing each task's `id` verbatim. Finally,",
    "apply the results with:",
    "",
    "  necronomidoc enrich <target> --import-results <results-file> --tasks <this file>",
  ].join("\n");
}

export interface BuildTaskFileOptions {
  /** Existing overlays keyed by target id (from `loadOverlays`). */
  overlays: Map<string, EnrichmentOverlay>;
  /** Read a repo file's source text; return undefined when unavailable. */
  readSource: (path: string) => string | undefined;
  maxFiles?: number;
  /** Core-doc kinds to include (from `planCoreDocs().needed`); none by default. */
  coreDocKinds?: CoreDocKind[];
  /** Also include a subsystem-map proposal task. */
  subsystems?: boolean;
  now?: () => string;
}

/**
 * Build the agent task file for one extracted repo: the same plan, prompts,
 * and caps as a live `enrich` run, packaged for offline completion.
 */
export function buildEnrichmentTaskFile(
  model: DocModel,
  options: BuildTaskFileOptions,
): { taskFile: EnrichmentTaskFile; plan: EnrichmentPlan } {
  const now = options.now ?? (() => new Date().toISOString());
  const plan = planEnrichment(model, options.overlays, options.maxFiles);
  const tasks: EnrichmentTask[] = [];

  for (const item of plan.work) {
    tasks.push({
      id: `file:${item.file.path}`,
      kind: "file-summary",
      request: enrichmentRequestFor(item, model.repo.name, options.readSource(item.file.path)),
      target: targetMetaFor(item),
    });
  }

  if (options.coreDocKinds && options.coreDocKinds.length > 0) {
    const repoHash = repoContentHash(model.files);
    const context = coreDocContext(model);
    for (const kind of options.coreDocKinds) {
      tasks.push({
        id: `core-doc:${kind}`,
        kind: "core-doc",
        request: coreDocRequestFor(kind, context),
        coreDoc: { kind, sourceRepoHash: repoHash },
      });
    }
  }

  if (options.subsystems) {
    tasks.push({ id: "subsystems", kind: "subsystems", request: subsystemsRequestFor(model) });
  }

  return {
    taskFile: {
      formatVersion: ENRICH_TASKS_FORMAT_VERSION,
      repo: { slug: model.repo.slug, name: model.repo.name },
      generatedAt: now(),
      instructions: buildInstructions(model.repo.name),
      tasks,
    },
    plan,
  };
}

export interface AppliedResults {
  overlays: EnrichmentOverlay[];
  coreDocs: LlmCoreDoc[];
  subsystems?: Subsystem[];
  /** Results that matched a task and parsed cleanly. */
  applied: number;
  failures: { id: string; error: string }[];
  /** Result ids that matched no task in the task file. */
  unmatchedResults: string[];
  /** Task ids the results file left uncompleted. */
  missingTasks: string[];
}

/**
 * Validate an agent's results against the task file and turn them into the
 * artifacts a live run would have produced. Pure — persistence and publishing
 * stay with the caller (the server's import pipeline).
 */
export function applyEnrichmentResults(
  taskFile: EnrichmentTaskFile,
  resultsFile: EnrichmentResultsFile,
  options: { now?: () => string } = {},
): AppliedResults {
  const now = options.now ?? (() => new Date().toISOString());
  const modelLabel = resultsFile.model ?? DEFAULT_AGENT_MODEL_LABEL;
  const tasksById = new Map(taskFile.tasks.map((t) => [t.id, t]));
  const applied: AppliedResults = {
    overlays: [],
    coreDocs: [],
    applied: 0,
    failures: [],
    unmatchedResults: [],
    missingTasks: [],
  };

  const seen = new Set<string>();
  for (const result of resultsFile.results) {
    const task = tasksById.get(result.id);
    if (!task || seen.has(result.id)) {
      applied.unmatchedResults.push(result.id);
      continue;
    }
    seen.add(result.id);
    // Agents sometimes hand back the object, sometimes a JSON string — both
    // funnel through the same text path the live pipeline parses.
    const text = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
    try {
      if (task.kind === "file-summary") {
        // Task files always carry `target` for file-summary tasks; a
        // hand-edited file that dropped it is a validation failure.
        if (!task.target) throw new Error("task has no target metadata");
        applied.overlays.push(...overlaysFromEnrichmentResponse(task.target, text, now));
      } else if (task.kind === "core-doc") {
        if (!task.coreDoc) throw new Error("task has no coreDoc metadata");
        applied.coreDocs.push(
          llmCoreDocFromResponse(task.coreDoc.kind, text, {
            sourceRepoHash: task.coreDoc.sourceRepoHash,
            model: modelLabel,
            now,
          }),
        );
      } else {
        applied.subsystems = subsystemsFromResponse(text);
      }
      applied.applied++;
    } catch (err) {
      applied.failures.push({ id: result.id, error: (err as Error).message });
    }
  }

  for (const task of taskFile.tasks) {
    if (!seen.has(task.id)) applied.missingTasks.push(task.id);
  }
  return applied;
}
