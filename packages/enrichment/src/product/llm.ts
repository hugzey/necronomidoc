import { z } from "zod";
import {
  PRODUCT_DOCS_DIR,
  repoContentHash,
  type DocModel,
  type LlmProductFile,
  type LlmProductSet,
} from "@necronomidoc/docmodel";
import { coreDocContext } from "../coredocs.js";
import type { LlmClient, LlmCompleteRequest } from "../llm/client.js";
import { detectSurfaces, loadLlmProductSet, overrideProductFiles, repoProductFiles } from "./build.js";
import { productDocPath, renderProductMarkdown } from "./templates.js";

/**
 * LLM-proposed product docs (`necronomidoc enrich --product`, decision 0023).
 * The model drafts personas, jobs, intent interaction sessions (with steps
 * bound to real code refs from the extraction), stories with Gherkin/EARS
 * criteria, and journeys. Responses are rendered into the SAME markdown files
 * a human would write, cached in `product.llm.json`, and published through
 * the same parser — so `necronomidoc product export` can drop them into
 * `docs/product/` verbatim for review and promotion.
 */

const str = z.string().optional();
const strs = z.array(z.string()).default([]);

const LlmResponse = z.object({
  overview: str,
  personas: z
    .array(z.object({ id: z.string(), title: z.string(), summary: z.string(), role: str, goals: strs, frustrations: strs, context: str, permissions: strs }))
    .default([]),
  jobs: z
    .array(z.object({ id: z.string(), title: z.string(), personas: strs, situation: z.string(), motivation: z.string(), outcome: z.string(), importance: str, successMetrics: strs }))
    .default([]),
  sessions: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        persona: z.string(),
        job: z.string(),
        intent: z.string(),
        trigger: str,
        entry: z.object({ channel: str, auth: str, preconditions: strs }).partial().default({}),
        steps: z.array(
          z.object({
            id: z.string(),
            actor: str,
            action: z.string(),
            surface: str,
            system: str,
            expects: str,
            code: strs,
            emotion: z.number().int().min(1).max(5).optional(),
            next: str,
            outcome: str,
            branches: z.array(z.object({ when: z.string(), goto: z.string() })).default([]),
          }),
        ),
        outcomes: z.array(z.object({ id: z.string(), kind: z.string(), title: z.string(), criteria: strs })),
        stories: strs,
        narrative: str,
      }),
    )
    .default([]),
  stories: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        persona: z.string(),
        want: z.string(),
        soThat: z.string(),
        jobs: strs,
        activity: str,
        step: str,
        release: str,
        priority: str,
        code: strs,
        acceptance: z.array(z.object({ id: z.string(), title: z.string(), gherkin: z.string() })).default([]),
        requirements: z.array(z.object({ id: z.string(), text: z.string() })).default([]),
      }),
    )
    .default([]),
  journeys: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        persona: z.string(),
        jobs: strs,
        stages: z.array(
          z.object({
            name: z.string(),
            goal: str,
            actions: strs,
            touchpoints: strs,
            thoughts: strs,
            emotion: z.number().int().min(1).max(5).optional(),
            painPoints: strs,
            opportunities: strs,
            sessions: strs,
            stories: strs,
          }),
        ),
      }),
    )
    .default([]),
});

const S = { type: "string" };
const SA = { type: "array", items: S };
const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const PRODUCT_JSON_SCHEMA: Record<string, unknown> = obj(
  {
    overview: S,
    personas: {
      type: "array",
      items: obj({ id: S, title: S, summary: S, role: S, goals: SA, frustrations: SA, context: S, permissions: SA }, ["id", "title", "summary", "goals"]),
    },
    jobs: {
      type: "array",
      items: obj(
        { id: S, title: S, personas: SA, situation: S, motivation: S, outcome: S, importance: { type: "string", enum: ["low", "medium", "high", "critical"] }, successMetrics: SA },
        ["id", "title", "personas", "situation", "motivation", "outcome"],
      ),
    },
    sessions: {
      type: "array",
      items: obj(
        {
          id: S,
          title: S,
          persona: S,
          job: S,
          intent: S,
          trigger: S,
          entry: obj({ channel: S, auth: S, preconditions: SA }, []),
          steps: {
            type: "array",
            items: obj(
              {
                id: S,
                actor: S,
                action: S,
                surface: S,
                system: S,
                expects: S,
                code: SA,
                emotion: { type: "integer", minimum: 1, maximum: 5 },
                next: S,
                outcome: S,
                branches: { type: "array", items: obj({ when: S, goto: S }, ["when", "goto"]) },
              },
              ["id", "action"],
            ),
          },
          outcomes: {
            type: "array",
            items: obj(
              { id: S, kind: { type: "string", enum: ["fulfilled", "partial", "diverted", "abandoned", "failed"] }, title: S, criteria: SA },
              ["id", "kind", "title", "criteria"],
            ),
          },
          stories: SA,
          narrative: S,
        },
        ["id", "title", "persona", "job", "intent", "steps", "outcomes"],
      ),
    },
    stories: {
      type: "array",
      items: obj(
        {
          id: S,
          title: S,
          persona: S,
          want: S,
          soThat: S,
          jobs: SA,
          activity: S,
          step: S,
          release: S,
          priority: { type: "string", enum: ["must", "should", "could", "wont"] },
          code: SA,
          acceptance: { type: "array", items: obj({ id: S, title: S, gherkin: S }, ["id", "title", "gherkin"]) },
          requirements: { type: "array", items: obj({ id: S, text: S }, ["id", "text"]) },
        },
        ["id", "title", "persona", "want", "soThat", "jobs", "acceptance"],
      ),
    },
    journeys: {
      type: "array",
      items: obj(
        {
          id: S,
          title: S,
          persona: S,
          jobs: SA,
          stages: {
            type: "array",
            items: obj(
              { name: S, goal: S, actions: SA, touchpoints: SA, thoughts: SA, emotion: { type: "integer", minimum: 1, maximum: 5 }, painPoints: SA, opportunities: SA, sessions: SA, stories: SA },
              ["name", "actions"],
            ),
          },
        },
        ["id", "title", "persona", "stages"],
      ),
    },
  },
  ["personas", "jobs", "sessions", "stories"],
);

const SYSTEM_PROMPT = [
  "You are a product analyst documenting what a software product is FOR, from its users' point of view,",
  "for a documentation site read by humans and coding agents. Base every claim on the provided",
  "extraction data — files, exported symbols, API operations, screens, README. Never invent features",
  "the code does not show. Respond with JSON only, matching the schema.",
].join(" ");

const INSTRUCTIONS = [
  "Draft the product documentation set for this repository:",
  "",
  "- personas (1-4): who uses it. Ids PER-001, PER-002, …",
  "- jobs (2-8): jobs-to-be-done — the INTENTS users arrive with, as",
  '  situation ("When …"), motivation ("I want to …"), outcome ("so I can …"). Ids JOB-001, …',
  "- sessions (2-8): INTENT INTERACTION SESSIONS — one persona arriving with one job's intent,",
  "  followed end to end. Each has: intent (the user's own words), trigger, entry (channel, auth,",
  "  preconditions), ordered steps S1, S2, … (action, surface, system response, expects = what the",
  "  user observes), at least one `fulfilled` outcome and the realistic alternatives (abandoned,",
  "  partial, failed) reached through step `branches` ({ when, goto: step or outcome id }).",
  "  The final step of a path sets `outcome`. Outcome ids OUT-1, OUT-2, … Session ids SES-001, …",
  "  Bind each step's `code` to entries from the CODE REFERENCES list below — copy them exactly.",
  "- stories (4-20): user stories (persona, want, soThat, jobs) with story-map placement (activity,",
  "  step, release) and acceptance criteria as Gherkin scenarios: `gherkin` holds the Given/When/Then",
  "  lines only (no Scenario keyword), ids AC-1, AC-2 … per story. Optional EARS requirements",
  '  ("WHEN <trigger> THE <system> SHALL <response>"), ids REQ-1 … Story ids STORY-001, …',
  "- journeys (0-3): journey maps across stages with emotion 1-5, pain points, opportunities, and",
  "  the sessions/stories realizing each stage. Ids JRN-001, …",
  "- overview: one paragraph — who the product serves and the intents it exists to fulfil.",
  "",
  "Every reference (persona, job, jobs, stories, sessions) must use an id defined in this response.",
].join("\n");

const CODE_REFS_MAX = 250;

/** The full completion request — shared by the live run and the agent task export. */
export function productRequestFor(model: DocModel): LlmCompleteRequest {
  const surfaces = detectSurfaces(model);
  const refs: string[] = [];
  for (const s of surfaces) refs.push(s.kind === "api" ? s.name : `${s.path}#${s.name}`);
  for (const file of model.files) {
    if (file.format !== "source") continue;
    for (const s of file.symbols) {
      if (refs.length >= CODE_REFS_MAX) break;
      if (s.exported && s.kind !== "section") {
        const ref = `${file.path}#${s.name}`;
        if (!refs.includes(ref)) refs.push(ref);
      }
    }
  }
  const prompt = [
    INSTRUCTIONS,
    "",
    coreDocContext(model),
    "",
    `Interaction surfaces (${surfaces.length}):`,
    ...surfaces.slice(0, 120).map((s) => `- [${s.kind}] ${s.name} — ${s.path}`),
    "",
    "CODE REFERENCES (valid values for step/story `code`):",
    ...refs.map((r) => `- ${r}`),
  ].join("\n");
  return { system: SYSTEM_PROMPT, prompt, maxOutputTokens: 16000, jsonSchema: PRODUCT_JSON_SCHEMA };
}

function gherkinBlock(acceptance: { id: string; title: string; gherkin: string }[]): string {
  const scenarios = acceptance.map((ac) => {
    const steps = ac.gherkin
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^(Scenario|Feature)/i.test(l))
      .map((l) => `  ${l}`);
    return [`@${ac.id.toUpperCase()}`, `Scenario: ${ac.title}`, ...steps].join("\n");
  });
  return ["```gherkin", scenarios.join("\n\n"), "```"].join("\n");
}

/** Keep an enum-ish model value only when it is one of the allowed values. */
function oneOf(value: string | undefined, allowed: string[]): string | undefined {
  const v = value?.toLowerCase();
  return v && allowed.includes(v) ? v : undefined;
}

/**
 * Parse one product-proposal response into rendered markdown files under
 * `docs/product/` — status `proposed`, so nothing reads as accepted until a
 * human promotes it. Throws on malformed JSON.
 */
export function productFilesFromResponse(text: string): LlmProductFile[] {
  const r = LlmResponse.parse(JSON.parse(text));
  const files: LlmProductFile[] = [];
  const add = (type: Parameters<typeof productDocPath>[0], id: string, title: string, fields: Record<string, unknown>, body: string): void => {
    files.push({
      path: productDocPath(type, id, title),
      content: renderProductMarkdown({ id, title, status: "proposed", ...fields }, body),
    });
  };
  if (r.overview) files.push({ path: `${PRODUCT_DOCS_DIR}/README.md`, content: `# Product documentation\n\n${r.overview.trim()}\n` });
  for (const p of r.personas) {
    const { id, title, ...fields } = p;
    add("persona", id, title, fields, `# ${title}`);
  }
  for (const j of r.jobs) {
    const { id, title, importance, ...fields } = j;
    add("job", id, title, { ...fields, importance: oneOf(importance, ["low", "medium", "high", "critical"]) }, `# ${title}`);
  }
  for (const s of r.stories) {
    const { id, title, acceptance, requirements, priority, ...fields } = s;
    (fields as Record<string, unknown>).priority = oneOf(priority, ["must", "should", "could", "wont"]);
    const body = [`# ${title}`, "", "## Acceptance criteria", "", gherkinBlock(acceptance)];
    if (requirements.length > 0) {
      body.push("", "## Requirements (EARS)", "", ...requirements.map((q) => `- **${q.id.toUpperCase()}** ${q.text}`));
    }
    add("story", id, title, fields, body.join("\n"));
  }
  for (const s of r.sessions) {
    const { id, title, narrative, steps, ...fields } = s;
    const cleanSteps = steps.map((step) => Object.fromEntries(Object.entries(step).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))));
    add("session", id, title, { ...fields, steps: cleanSteps }, `# ${title}\n\n## Narrative\n\n${narrative ?? ""}`);
  }
  for (const j of r.journeys) {
    const { id, title, ...fields } = j;
    add("journey", id, title, fields, `# ${title}`);
  }
  return files;
}

export interface ProposeProductResult {
  set: LlmProductSet;
  inputTokens: number;
  outputTokens: number;
}

/** Live proposal: one call, cached against the repo hash. */
export async function proposeProductDocs(
  model: DocModel,
  client: LlmClient,
  options: { now?: () => string } = {},
): Promise<ProposeProductResult> {
  const completion = await client.complete(productRequestFor(model));
  return {
    set: {
      sourceRepoHash: repoContentHash(model.files),
      model: client.model,
      updatedAt: (options.now ?? (() => new Date().toISOString()))(),
      files: productFilesFromResponse(completion.text),
    },
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens,
  };
}

export interface ProductPlan {
  /** Should an enrich run (re)draft the product set? */
  needed: boolean;
  /** curated: docs exist in the repo/override (never LLM-written); fresh: cache matches; missing/stale: draft. */
  reason: "curated" | "fresh" | "missing" | "stale";
}

/** Decide whether `enrich --product` should call the model. */
export function planProductDocs(
  model: DocModel,
  options: { overrideDir?: string; llmDir?: string },
): ProductPlan {
  const curated =
    repoProductFiles(model).some((f) => /^---/.test(f.content.trimStart())) ||
    (options.overrideDir ? overrideProductFiles(options.overrideDir).length > 0 : false);
  if (curated) return { needed: false, reason: "curated" };
  const cached = options.llmDir ? loadLlmProductSet(options.llmDir) : undefined;
  if (!cached || cached.files.length === 0) return { needed: true, reason: "missing" };
  return cached.sourceRepoHash === repoContentHash(model.files)
    ? { needed: false, reason: "fresh" }
    : { needed: true, reason: "stale" };
}
