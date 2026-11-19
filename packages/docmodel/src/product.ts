import { z } from "zod";
import { SCHEMA_VERSION } from "./schema.js";

/**
 * Product documentation (decision 0023): personas, jobs-to-be-done (intents),
 * epics, user stories with Gherkin/EARS acceptance criteria, journey maps, and
 * **intent interaction sessions** — one user arriving with one preconceived
 * intent, followed end to end through the product to an outcome.
 *
 * Authors (humans or coding agents) write one markdown file per document under
 * `docs/product/<type-dir>/` with the structured fields in YAML frontmatter
 * (the `*Frontmatter` schemas below — also exported as JSON Schema) and prose,
 * Gherkin scenarios and EARS requirements in the body. The build resolves them
 * into a `ProductManifest`: validated, cross-linked both ways, bound to the
 * code they exercise (with drift detection), traced to the tests that cite
 * their ids, and diagrammed.
 */

/** The repo-relative directory product docs live in. */
export const PRODUCT_DOCS_DIR = "docs/product";

export const PRODUCT_DOC_TYPES = ["persona", "job", "epic", "story", "journey", "session"] as const;
export const ProductDocType = z.enum(PRODUCT_DOC_TYPES);
export type ProductDocType = z.infer<typeof ProductDocType>;

/** Id prefix per document type: `PER-001`, `JOB-003`, `SES-012`, … */
export const PRODUCT_ID_PREFIX: Record<ProductDocType, string> = {
  persona: "PER",
  job: "JOB",
  epic: "EPIC",
  story: "STORY",
  journey: "JRN",
  session: "SES",
};

/** Sub-directory of `docs/product/` per document type. */
export const PRODUCT_TYPE_DIRS: Record<ProductDocType, string> = {
  persona: "personas",
  job: "jobs",
  epic: "epics",
  story: "stories",
  journey: "journeys",
  session: "sessions",
};

/** `PER-001`-style document id (prefix, dash, digits). */
export const PRODUCT_ID_PATTERN = /^(PER|JOB|EPIC|STORY|JRN|SES)-\d+$/;

/** The document type an id's prefix declares, or undefined when it has none. */
export function productTypeOfId(id: string): ProductDocType | undefined {
  const prefix = id.split("-")[0];
  return PRODUCT_DOC_TYPES.find((t) => PRODUCT_ID_PREFIX[t] === prefix);
}

/**
 * Canonical comparison form of a product reference: numeric parts lose
 * leading zeros so `STORY-007.AC-02` in a test matches `STORY-7` / `AC-2` in
 * the docs. Accepts `.`, `/`, `:` or `_` between a doc id and its sub-id.
 */
export function normalizeProductRef(ref: string): string {
  const m = /^([A-Z]+)-0*(\d+)(?:[./:_]([A-Z]+)-?0*(\d+))?$/i.exec(ref.trim());
  if (!m) return ref.trim();
  const head = `${m[1]!.toUpperCase()}-${m[2]}`;
  return m[3] ? `${head}.${m[3]!.toUpperCase()}-${m[4]}` : head;
}

/** Lifecycle of a product document. Coverage/drift gates apply from `accepted`. */
export const ProductStatus = z.enum(["draft", "proposed", "accepted", "implemented", "deprecated"]);
export type ProductStatus = z.infer<typeof ProductStatus>;

/** A single id or a list of ids — authors write whichever reads naturally. */
const IdList = z.preprocess(
  (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]),
  z.array(z.string()),
);
const StrList = z.preprocess(
  (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]),
  z.array(z.string()),
);
/** 1 (frustrated) … 5 (delighted) — the scale Mermaid `journey` diagrams use. */
const Emotion = z.number().int().min(1).max(5);

const BaseFrontmatter = {
  id: z.string().regex(PRODUCT_ID_PATTERN, "id must look like PER-001 / JOB-001 / EPIC-001 / STORY-001 / JRN-001 / SES-001"),
  /** Optional; when present it must agree with the id prefix. */
  type: ProductDocType.optional(),
  title: z.string().min(1),
  status: ProductStatus.default("draft"),
  owner: z.string().optional(),
  tags: StrList,
  /**
   * Date (or note) of the last human review against the code. Editing it
   * re-baselines code-binding drift: "I checked, the doc still holds."
   */
  verified: z.string().optional(),
};

/** Who uses the product: a role with goals, context and permissions. */
export const PersonaFrontmatter = z.object({
  ...BaseFrontmatter,
  /** One sentence: who this is. */
  summary: z.string(),
  /** The role/permission set they hold in the system (e.g. `admin`). */
  role: z.string().optional(),
  goals: StrList,
  frustrations: StrList,
  /** Environment, devices, constraints, how often they use the product. */
  context: z.string().optional(),
  expertise: z.enum(["novice", "intermediate", "expert"]).optional(),
  permissions: StrList,
});
export type PersonaFrontmatter = z.infer<typeof PersonaFrontmatter>;

/**
 * A job-to-be-done — the durable, solution-agnostic **intent** a user arrives
 * with: "When <situation>, I want to <motivation>, so I can <outcome>".
 */
export const JobFrontmatter = z.object({
  ...BaseFrontmatter,
  personas: IdList,
  situation: z.string(),
  motivation: z.string(),
  outcome: z.string(),
  importance: z.enum(["low", "medium", "high", "critical"]).optional(),
  /** Measurable signals that the job got done. */
  successMetrics: StrList,
});
export type JobFrontmatter = z.infer<typeof JobFrontmatter>;

/** A body of work grouping stories under one or more jobs. */
export const EpicFrontmatter = z.object({
  ...BaseFrontmatter,
  summary: z.string(),
  jobs: IdList,
});
export type EpicFrontmatter = z.infer<typeof EpicFrontmatter>;

/**
 * A user story: "As a <persona>, I want <want>, so that <soThat>". Acceptance
 * criteria live in the body as tagged Gherkin scenarios (`@AC-1`), optional
 * system requirements as EARS statements (`- **REQ-1** WHEN … THE SYSTEM SHALL …`).
 */
export const StoryFrontmatter = z.object({
  ...BaseFrontmatter,
  persona: z.string(),
  want: z.string(),
  soThat: z.string(),
  jobs: IdList,
  epic: z.string().optional(),
  /** Story-map backbone activity (a column of the map). */
  activity: z.string().optional(),
  /** Story-map step within the activity. */
  step: z.string().optional(),
  /** Release slice (row of the story map), e.g. `MVP`, `R2`. */
  release: z.string().optional(),
  priority: z.enum(["must", "should", "could", "wont"]).optional(),
  /** Code the story is implemented by — `path`, `path#Symbol`, `Symbol`, or `METHOD /path`. */
  code: StrList,
});
export type StoryFrontmatter = z.infer<typeof StoryFrontmatter>;

/** One stage of a journey map. */
export const JourneyStage = z.object({
  name: z.string(),
  goal: z.string().optional(),
  actions: StrList,
  touchpoints: StrList,
  thoughts: StrList,
  emotion: Emotion.optional(),
  painPoints: StrList,
  opportunities: StrList,
  /** Sessions that realize this stage. */
  sessions: IdList,
  stories: IdList,
});
export type JourneyStage = z.infer<typeof JourneyStage>;

/** A journey map: a persona's experience across stages, with emotion and pain. */
export const JourneyFrontmatter = z.object({
  ...BaseFrontmatter,
  persona: z.string(),
  jobs: IdList,
  stages: z.array(JourneyStage).min(1),
});
export type JourneyFrontmatter = z.infer<typeof JourneyFrontmatter>;

/** An alternative path out of a session step. */
export const SessionBranch = z.object({
  /** The condition, as the user would experience it. */
  when: z.string(),
  /** A step id (`S4`) or outcome id (`OUT-2`). */
  goto: z.string(),
});
export type SessionBranch = z.infer<typeof SessionBranch>;

/** One step of an interaction session. */
export const SessionStep = z.object({
  id: z.string().regex(/^S\d+$/, "step ids look like S1, S2, …"),
  /** Who acts: `user` (default), `system`, or a named external actor. */
  actor: z.string().default("user"),
  /** What the actor does, in the user's language. */
  action: z.string(),
  /** Where: screen / route / CLI command / MCP tool / email … */
  surface: z.string().optional(),
  /** What the system does in response: endpoint, command, event, job. */
  system: z.string().optional(),
  /** What the user observes that tells them it worked (the evidence). */
  expects: z.string().optional(),
  /** Code exercised by this step — `path`, `path#Symbol`, `Symbol`, `METHOD /path`. */
  code: StrList,
  emotion: Emotion.optional(),
  /** Successor step or outcome id; defaults to the following step. */
  next: z.string().optional(),
  /** Terminal: this step ends the session in the given outcome. */
  outcome: z.string().optional(),
  branches: z.array(SessionBranch).default([]),
});
export type SessionStep = z.infer<typeof SessionStep>;

/** How a session can end, relative to the user's intent. */
export const OutcomeKind = z.enum(["fulfilled", "partial", "diverted", "abandoned", "failed"]);
export type OutcomeKind = z.infer<typeof OutcomeKind>;

export const SessionOutcome = z.object({
  id: z.string().regex(/^OUT-\d+$/, "outcome ids look like OUT-1, OUT-2, …"),
  kind: OutcomeKind,
  title: z.string(),
  /** Observable success criteria — what must be true when this outcome is reached. */
  criteria: StrList,
});
export type SessionOutcome = z.infer<typeof SessionOutcome>;

/**
 * An **intent interaction session**: a persona arrives (logs in, opens the
 * CLI, connects an agent) with one preconceived intent, and the session
 * follows that intent end to end — entry state, every step through the
 * product, branches, and the outcomes it can end in. Steps bind to real code
 * so drift is detectable, and outcomes are what tests verify.
 */
export const SessionFrontmatter = z.object({
  ...BaseFrontmatter,
  persona: z.string(),
  /** The job (JOB-…) this session is an attempt to get done. */
  job: z.string(),
  /** The intent in the user's own words, as held on arrival. */
  intent: z.string(),
  /** What happened just before — why the session starts now. */
  trigger: z.string().optional(),
  entry: z
    .object({
      /** web | cli | mcp | api | mobile | email | … */
      channel: z.string().optional(),
      /** Authentication/role state on entry, e.g. `signed in as admin`. */
      auth: z.string().optional(),
      preconditions: StrList,
    })
    .default({}),
  steps: z.array(SessionStep).min(1),
  outcomes: z.array(SessionOutcome).min(1),
  stories: IdList,
  /** The journey this session realizes, optionally with the stage name. */
  journey: z
    .union([z.string(), z.object({ id: z.string(), stage: z.string().optional() })])
    .optional(),
  /** Session-level measures, e.g. "intent fulfilled in ≤ 4 steps". */
  metrics: StrList,
});
export type SessionFrontmatter = z.infer<typeof SessionFrontmatter>;

/** Frontmatter schema per document type. */
export const PRODUCT_FRONTMATTER_SCHEMAS = {
  persona: PersonaFrontmatter,
  job: JobFrontmatter,
  epic: EpicFrontmatter,
  story: StoryFrontmatter,
  journey: JourneyFrontmatter,
  session: SessionFrontmatter,
} as const;

// ---- Resolved documents (published in product.json) ----

/** One Gherkin scenario from a story/session body, tagged `@AC-n`. */
export const AcceptanceCriterion = z.object({
  id: z.string(),
  title: z.string(),
  /** The scenario text as written (tags, keyword line, steps, examples). */
  text: z.string(),
  outline: z.boolean().default(false),
  /** Gherkin tags other than the `@AC-n` id tag. */
  tags: z.array(z.string()).default([]),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;

/** EARS requirement patterns (Mavin et al.): which template a statement uses. */
export const EarsPattern = z.enum([
  "ubiquitous",
  "event-driven",
  "state-driven",
  "unwanted-behaviour",
  "optional-feature",
  "complex",
  "unrecognized",
]);
export type EarsPattern = z.infer<typeof EarsPattern>;

export const EarsRequirement = z.object({
  id: z.string(),
  text: z.string(),
  pattern: EarsPattern,
});
export type EarsRequirement = z.infer<typeof EarsRequirement>;

/**
 * A reference from a product doc to code, resolved against the extracted doc
 * model. `state`: `ok` (resolves, unchanged since the doc was last edited or
 * verified), `changed` (the code changed since — review the doc), `broken`
 * (the target no longer exists — the doc has drifted from the product).
 */
export const CodeBinding = z.object({
  ref: z.string(),
  /** The session step it belongs to (absent for doc-level `code`). */
  step: z.string().optional(),
  /** Picked up from backticked text rather than an explicit `code` entry. */
  inferred: z.boolean().default(false),
  target: z
    .object({
      kind: z.enum(["file", "symbol", "dir"]),
      /** DocModel file/symbol id (dir bindings use `slug:dir/`). */
      id: z.string(),
      path: z.string(),
      name: z.string().optional(),
    })
    .optional(),
  /** Content hash of the target now. */
  hash: z.string().optional(),
  /** Content hash of the target when the doc was last edited/verified. */
  baselineHash: z.string().optional(),
  state: z.enum(["ok", "changed", "broken"]),
});
export type CodeBinding = z.infer<typeof CodeBinding>;

/** A place in the repo's tests that cites a product id (traceability). */
export const ProductTestRef = z.object({
  /** Normalized reference, e.g. `STORY-7.AC-2`, `SES-3.OUT-1`, `STORY-7`. */
  ref: z.string(),
  path: z.string(),
  line: z.number().int().positive(),
});
export type ProductTestRef = z.infer<typeof ProductTestRef>;

/** An inbound link: document `id` references this one through field `rel`. */
export const ProductLink = z.object({ id: z.string(), rel: z.string() });
export type ProductLink = z.infer<typeof ProductLink>;

/** Mermaid diagrams generated per document. */
export const ProductDiagrams = z.object({
  /** Session: flowchart of steps, branches and outcomes. */
  flow: z.string().optional(),
  /** Session: sequence of user ↔ surface ↔ system interactions. */
  sequence: z.string().optional(),
  /** Journey/session: Mermaid `journey` emotion curve. */
  journey: z.string().optional(),
});
export type ProductDiagrams = z.infer<typeof ProductDiagrams>;

/** Which tier a product document came from (repo wins). */
export const ProductProvenance = z.enum(["repo", "override", "llm"]);
export type ProductProvenance = z.infer<typeof ProductProvenance>;

const ResolvedCommon = {
  /** Repo-relative path of the source file (LLM drafts: the path `product export` writes). */
  path: z.string(),
  provenance: ProductProvenance,
  /** LLM drafts: repo changed since written. Curated: a code binding changed. */
  stale: z.boolean().default(false),
  /** Hash of the source file — the drift baseline key. */
  docHash: z.string(),
  /** Markdown body without frontmatter. */
  body: z.string().default(""),
  acceptance: z.array(AcceptanceCriterion).default([]),
  requirements: z.array(EarsRequirement).default([]),
  bindings: z.array(CodeBinding).default([]),
  diagrams: ProductDiagrams.default({}),
  referencedBy: z.array(ProductLink).default([]),
  /** Test references citing this doc or its sub-ids (AC-n, REQ-n, OUT-n). */
  tests: z.array(ProductTestRef).default([]),
};

const typed = <T extends z.ZodRawShape, K extends ProductDocType>(shape: T, type: K) =>
  z.object({ ...shape, ...ResolvedCommon, type: z.literal(type) });

export const PersonaDoc = typed(PersonaFrontmatter.shape, "persona");
export const JobDoc = typed(JobFrontmatter.shape, "job");
export const EpicDoc = typed(EpicFrontmatter.shape, "epic");
export const StoryDoc = typed(StoryFrontmatter.shape, "story");
export const JourneyDoc = typed(JourneyFrontmatter.shape, "journey");
export const SessionDoc = typed(SessionFrontmatter.shape, "session");

/** One resolved product document, discriminated by `type`. */
export const ProductDoc = z.discriminatedUnion("type", [
  PersonaDoc,
  JobDoc,
  EpicDoc,
  StoryDoc,
  JourneyDoc,
  SessionDoc,
]);
export type ProductDoc = z.infer<typeof ProductDoc>;
export type PersonaDoc = z.infer<typeof PersonaDoc>;
export type JobDoc = z.infer<typeof JobDoc>;
export type EpicDoc = z.infer<typeof EpicDoc>;
export type StoryDoc = z.infer<typeof StoryDoc>;
export type JourneyDoc = z.infer<typeof JourneyDoc>;
export type SessionDoc = z.infer<typeof SessionDoc>;

/** One validation / drift / coverage finding. */
export const ProductFinding = z.object({
  level: z.enum(["error", "warn", "info"]),
  /** Stable machine code, e.g. `dangling-ref`, `broken-binding`, `uncovered-criteria`. */
  code: z.string(),
  message: z.string(),
  docId: z.string().optional(),
  path: z.string().optional(),
});
export type ProductFinding = z.infer<typeof ProductFinding>;

/**
 * An interaction surface detected in the code — an API operation or a
 * screen-like component — and the sessions whose steps touch it. Surfaces no
 * session covers are intents the docs haven't described yet.
 */
export const ProductSurface = z.object({
  kind: z.enum(["api", "screen"]),
  /** DocModel symbol id. */
  id: z.string(),
  name: z.string(),
  path: z.string(),
  coveredBy: z.array(z.string()).default([]),
});
export type ProductSurface = z.infer<typeof ProductSurface>;

/** Coverage counters for the traceability summary. */
export const ProductCoverage = z.object({
  criteria: z.number().int().nonnegative(),
  criteriaTested: z.number().int().nonnegative(),
  requirements: z.number().int().nonnegative(),
  requirementsTested: z.number().int().nonnegative(),
  outcomes: z.number().int().nonnegative(),
  outcomesTested: z.number().int().nonnegative(),
  surfaces: z.number().int().nonnegative(),
  surfacesCovered: z.number().int().nonnegative(),
  bindings: z.number().int().nonnegative(),
  bindingsBroken: z.number().int().nonnegative(),
  bindingsChanged: z.number().int().nonnegative(),
  /** False when tests could not be scanned (pre-extracted IR, no working tree). */
  testsScanned: z.boolean(),
});
export type ProductCoverage = z.infer<typeof ProductCoverage>;

/** The per-repo product manifest (`repos/<slug>/product.json`). */
export const ProductManifest = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  repo: z.string(),
  /**
   * Which tier defined the set: curated files (`repo`/`override`, merged by
   * id), an LLM-proposed draft set (`llm`), or nothing yet (`none`).
   */
  source: z.enum(["curated", "llm", "none"]),
  /** LLM set only: the repo changed since the drafts were written. */
  stale: z.boolean().default(false),
  /** `docs/product/README.md` body — the product narrative, when present. */
  overview: z.string().optional(),
  docs: z.array(ProductDoc).default([]),
  surfaces: z.array(ProductSurface).default([]),
  findings: z.array(ProductFinding).default([]),
  coverage: ProductCoverage,
  /** Mermaid map of personas → jobs → sessions → stories. */
  diagram: z.string().optional(),
  generatedAt: z.string().optional(),
});
export type ProductManifest = z.infer<typeof ProductManifest>;

/** One source file of an LLM-drafted product set (rendered markdown). */
export const LlmProductFile = z.object({ path: z.string(), content: z.string() });
export type LlmProductFile = z.infer<typeof LlmProductFile>;

/** The server-side cache of an LLM-proposed product doc set. */
export const LlmProductSet = z.object({
  sourceRepoHash: z.string(),
  model: z.string().optional(),
  updatedAt: z.string().optional(),
  files: z.array(LlmProductFile).default([]),
});
export type LlmProductSet = z.infer<typeof LlmProductSet>;
