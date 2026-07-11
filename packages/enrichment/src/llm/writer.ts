import { z } from "zod";
import type {
  DocFile,
  DocModel,
  DocSymbolShape,
  EnrichmentOverlay,
} from "@necronomidoc/docmodel";
import type { LlmClient } from "./client.js";

/**
 * The LLM overlay writer (slice 3 §1): for each file/symbol lacking a human
 * overlay (or whose llm overlay is stale), batch one prompt per file and write
 * `provenance: llm` overlay entries. Content-hash caching is the cost control —
 * a target is only re-summarized when its hash changes, so re-running on an
 * unchanged repo makes zero LLM calls (acceptance criterion 1).
 */

/** Default budget caps — deliberately conservative; override per run. */
export const DEFAULT_MAX_FILES = 200;
export const DEFAULT_MAX_TOKENS = 400_000;

/** Source text beyond this is truncated in the prompt (cost control). */
const MAX_SOURCE_CHARS = 16_000;

export interface EnrichmentWorkItem {
  file: DocFile;
  /** Does the file itself need a summary (vs only some of its symbols)? */
  enrichFile: boolean;
  /** Symbols (including nested members) needing a summary. */
  symbols: DocSymbolShape[];
}

export interface EnrichmentPlan {
  work: EnrichmentWorkItem[];
  /** Targets skipped because a human overlay owns them (never overwritten). */
  skippedHuman: number;
  /** Targets skipped because their llm overlay matches the current hash. */
  skippedFresh: number;
  /** Files needing work but dropped by the max-files cap. */
  filesOverCap: number;
}

export interface EnrichmentRunOptions {
  client: LlmClient;
  /** Existing overlays keyed by target id (from `loadOverlays`). */
  overlays: Map<string, EnrichmentOverlay>;
  /** Read a repo file's source text; return undefined when unavailable. */
  readSource: (path: string) => string | undefined;
  maxFiles?: number;
  /** Total token budget (input + output) for the whole run. */
  maxTokens?: number;
  /** Plan and report, but make no LLM calls and write nothing. */
  dryRun?: boolean;
  now?: () => string;
}

export interface EnrichmentRunReport {
  model: string;
  dryRun: boolean;
  /** Files/targets the plan selected for summarization. */
  plannedFiles: number;
  plannedFileSummaries: number;
  plannedSymbolSummaries: number;
  skippedHuman: number;
  skippedFresh: number;
  filesOverCap: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  overlaysWritten: number;
  failures: { path: string; error: string }[];
  /** True when the token budget stopped the run before the plan finished. */
  aborted: boolean;
}

export interface EnrichmentRunResult {
  overlays: EnrichmentOverlay[];
  report: EnrichmentRunReport;
}

function walkSymbols(symbols: DocSymbolShape[], visit: (s: DocSymbolShape) => void): void {
  for (const s of symbols) {
    visit(s);
    if (s.members) walkSymbols(s.members, visit);
  }
}

type Need = "yes" | "human" | "fresh";

/** Does this target need an LLM summary, per decision-0004 precedence? */
function needsSummary(
  overlays: Map<string, EnrichmentOverlay>,
  targetId: string,
  contentHash: string,
): Need {
  const overlay = overlays.get(targetId);
  if (!overlay) return "yes";
  if (overlay.provenance === "human") return "human"; // never overwritten
  if (overlay.provenance === "llm" && overlay.sourceContentHash === contentHash) return "fresh";
  return "yes"; // stale llm (or lower-provenance entry) — regenerate
}

/** Select the files/symbols that need summarization, applying the file cap. */
export function planEnrichment(
  model: DocModel,
  overlays: Map<string, EnrichmentOverlay>,
  maxFiles: number = DEFAULT_MAX_FILES,
): EnrichmentPlan {
  const work: EnrichmentWorkItem[] = [];
  let skippedHuman = 0;
  let skippedFresh = 0;
  let filesOverCap = 0;

  for (const file of model.files) {
    // Prose documents are their own documentation; source files only.
    if (file.format === "markdown") continue;

    const fileNeed = needsSummary(overlays, file.id, file.contentHash);
    if (fileNeed === "human") skippedHuman++;
    if (fileNeed === "fresh") skippedFresh++;

    const symbols: DocSymbolShape[] = [];
    walkSymbols(file.symbols, (s) => {
      const need = needsSummary(overlays, s.id, s.contentHash);
      if (need === "yes") symbols.push(s);
      else if (need === "human") skippedHuman++;
      else skippedFresh++;
    });

    if (fileNeed !== "yes" && symbols.length === 0) continue;
    if (work.length >= maxFiles) {
      filesOverCap++;
      continue;
    }
    work.push({ file, enrichFile: fileNeed === "yes", symbols });
  }
  return { work, skippedHuman, skippedFresh, filesOverCap };
}

/** Shape the model must return for one file batch. */
const LlmFileResponse = z.object({
  file: z.object({
    summary: z.string(),
    purpose: z.string().optional(),
  }),
  symbols: z
    .array(z.object({ id: z.string(), summary: z.string() }))
    .default([]),
});

/** JSON Schema mirror of `LlmFileResponse` for structured-output providers. */
const RESPONSE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    file: {
      type: "object",
      properties: {
        summary: { type: "string" },
        purpose: { type: "string" },
      },
      required: ["summary"],
      additionalProperties: false,
    },
    symbols: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          summary: { type: "string" },
        },
        required: ["id", "summary"],
        additionalProperties: false,
      },
    },
  },
  required: ["file", "symbols"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = [
  "You write terse, accurate purpose summaries for a code documentation site",
  "used by both humans and coding agents. Describe only what the code in front",
  "of you actually does — never speculate, never invent behavior. Summaries are",
  "one plain-English sentence; the optional file `purpose` field may add one to",
  "three sentences of scope/boundary context (what belongs here, what does not).",
  "Respond with JSON only, matching the requested schema exactly.",
].join(" ");

function buildPrompt(item: EnrichmentWorkItem, repoName: string, source: string | undefined): string {
  const { file } = item;
  const lines: string[] = [
    `Repository: ${repoName}`,
    `File: ${file.path}`,
    "",
    item.enrichFile
      ? "Summarize the file's purpose (field `file`) and each listed symbol."
      : "Summarize each listed symbol. (Set `file.summary` anyway; it may be ignored.)",
    "",
  ];
  if (file.imports.length > 0) {
    lines.push(`Imports: ${file.imports.map((i) => i.moduleSpecifier).join(", ")}`, "");
  }
  if (item.symbols.length > 0) {
    lines.push("Symbols to summarize (echo each `id` verbatim):");
    for (const s of item.symbols) {
      const sig = s.signature ? ` — \`${s.signature.slice(0, 200)}\`` : "";
      lines.push(`- id: ${s.id} | ${s.kind} ${s.name}${sig}`);
    }
    lines.push("");
  }
  if (source) {
    const truncated =
      source.length > MAX_SOURCE_CHARS
        ? `${source.slice(0, MAX_SOURCE_CHARS)}\n… (truncated)`
        : source;
    lines.push("Source:", "```", truncated, "```");
  } else {
    lines.push("(Source text unavailable — summarize from the signatures above.)");
  }
  return lines.join("\n");
}

/**
 * Run the LLM overlay writer over one extracted repo model. Returns the new
 * `provenance: llm` overlay entries (with `sourceContentHash` stamped for
 * staleness tracking) plus a cost/coverage report. Budget caps abort
 * gracefully: overlays generated before the cap are still returned.
 */
export async function runLlmEnrichment(
  model: DocModel,
  options: EnrichmentRunOptions,
): Promise<EnrichmentRunResult> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const now = options.now ?? (() => new Date().toISOString());
  const plan = planEnrichment(model, options.overlays, maxFiles);

  const report: EnrichmentRunReport = {
    model: options.client.model,
    dryRun: options.dryRun ?? false,
    plannedFiles: plan.work.length,
    plannedFileSummaries: plan.work.filter((w) => w.enrichFile).length,
    plannedSymbolSummaries: plan.work.reduce((n, w) => n + w.symbols.length, 0),
    skippedHuman: plan.skippedHuman,
    skippedFresh: plan.skippedFresh,
    filesOverCap: plan.filesOverCap,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    overlaysWritten: 0,
    failures: [],
    aborted: false,
  };
  if (report.dryRun) return { overlays: [], report };

  const overlays: EnrichmentOverlay[] = [];
  for (const item of plan.work) {
    if (report.inputTokens + report.outputTokens >= maxTokens) {
      report.aborted = true;
      break;
    }
    const prompt = buildPrompt(item, model.repo.name, options.readSource(item.file.path));
    const maxOutputTokens = Math.min(300 + item.symbols.length * 80, 4000);
    try {
      const result = await options.client.complete({
        system: SYSTEM_PROMPT,
        prompt,
        maxOutputTokens,
        jsonSchema: RESPONSE_JSON_SCHEMA,
      });
      report.calls++;
      report.inputTokens += result.inputTokens;
      report.outputTokens += result.outputTokens;

      const parsed = LlmFileResponse.parse(JSON.parse(result.text));
      const stamp = { provenance: "llm" as const, updatedAt: now() };
      if (item.enrichFile) {
        overlays.push({
          targetId: item.file.id,
          summary: parsed.file.summary,
          purpose: parsed.file.purpose,
          sourceContentHash: item.file.contentHash,
          ...stamp,
        });
      }
      const wanted = new Map(item.symbols.map((s) => [s.id, s]));
      for (const entry of parsed.symbols) {
        const symbol = wanted.get(entry.id);
        if (!symbol) continue; // hallucinated or duplicate id — drop it
        overlays.push({
          targetId: symbol.id,
          summary: entry.summary,
          sourceContentHash: symbol.contentHash,
          ...stamp,
        });
        wanted.delete(entry.id);
      }
    } catch (err) {
      report.failures.push({ path: item.file.path, error: (err as Error).message });
    }
  }
  report.overlaysWritten = overlays.length;
  return { overlays, report };
}
