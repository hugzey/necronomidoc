import { z } from "zod";
import { EnrichmentOverlay, Provenance, SCHEMA_VERSION } from "./schema.js";

/**
 * Agent-facing build artefacts (decision 0024): knowledge mined from the code
 * at build time so the MCP tools can answer task-shaped questions in one call
 * instead of an agent reverse-engineering it from several files — "how do I
 * add a page here?", "what does a real call to this look like?", "which tests
 * exercise this file?". Published per repo as `repos/<slug>/agent.json`.
 */

/** One real call site of an exported symbol, taken from the import graph. */
export const UsageExample = z.object({
  /** Repo-relative path of the calling file. */
  path: z.string(),
  /** 1-based line of the call. */
  line: z.number().int().positive(),
  /** The call as written (one to three lines, trimmed, bounded). */
  snippet: z.string(),
});
export type UsageExample = z.infer<typeof UsageExample>;

/**
 * A precomputed "how do I…" recipe: a repeated pattern in the code (several
 * sibling files of the same shape) with a short canonical example and the
 * files a new instance has to touch. Mined heuristically, or curated in
 * `.necronomidoc/recipes.yaml` (curated wins on the same id).
 */
export const Recipe = z.object({
  /** Stable slug id, unique within a repo. */
  id: z.string(),
  /** Task phrasing, e.g. "Add a page". */
  title: z.string(),
  /** Extra words an agent's task might use for this recipe ("screen", "route"). */
  keywords: z.array(z.string()).default([]),
  /** Where new instances go and how they are named, e.g. `src/pages/*Page.tsx`. */
  pattern: z.string().optional(),
  /** What kind of declaration each instance exports (component, hook, …). */
  kind: z.string().optional(),
  /** Ordered steps (each one line). */
  steps: z.array(z.string()).default([]),
  /** A short canonical example drawn from a real instance. */
  example: z
    .object({
      path: z.string(),
      line: z.number().int().positive().optional(),
      snippet: z.string(),
    })
    .optional(),
  /** Files a new instance typically touches (registration sites, barrels, tests). */
  files: z.array(z.string()).default([]),
  /** Existing instances of the pattern (bounded). */
  instances: z.array(z.string()).default([]),
  provenance: Provenance.default("heuristic"),
});
export type Recipe = z.infer<typeof Recipe>;

/**
 * Test-to-code binding: one test file, the product ids it cites, and the
 * repo files it exercises (resolved from its imports). Makes "which tests
 * should I run for this change?" a lookup instead of the whole suite.
 */
export const TestFileBinding = z.object({
  path: z.string(),
  /** Normalized product refs cited by the file (`STORY-1.AC-2`, `SES-1.OUT-1`). */
  cites: z.array(z.string()).default([]),
  /** Repo files the test imports (directly), resolved against the doc model. */
  exercises: z.array(z.string()).default([]),
});
export type TestFileBinding = z.infer<typeof TestFileBinding>;

/** A concept agents searched for that the docs could not answer. */
export const UndocumentedConcept = z.object({
  /** The query as asked, or its hash when the miss log runs in hashed mode. */
  query: z.string(),
  hashed: z.boolean().default(false),
  count: z.number().int().positive(),
  tools: z.array(z.string()).default([]),
  lastSeen: z.string(),
});
export type UndocumentedConcept = z.infer<typeof UndocumentedConcept>;

/** The per-repo agent manifest (`repos/<slug>/agent.json`). */
export const AgentManifest = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  repo: z.string(),
  recipes: z.array(Recipe).default([]),
  /** symbol id → up to two real call sites. */
  usages: z.record(z.array(UsageExample)).default({}),
  tests: z.array(TestFileBinding).default([]),
  /** False when tests could not be scanned (pre-extracted IR, no working tree). */
  testsScanned: z.boolean().default(false),
  /**
   * Search synonyms: a term agents use → the words the code uses
   * (`currency: [formatMoney, money]`). Curated in `synonyms.yaml`.
   */
  synonyms: z.record(z.array(z.string())).default({}),
  /** Concepts agents asked for that returned nothing useful (from the miss log). */
  undocumented: z.array(UndocumentedConcept).default([]),
  generatedAt: z.string().optional(),
});
export type AgentManifest = z.infer<typeof AgentManifest>;

// ---- Agent-written documentation proposals ----

export const ProposalKind = z.enum(["overlay", "product-doc"]);
export type ProposalKind = z.infer<typeof ProposalKind>;

export const ProposalStatus = z.enum(["proposed", "accepted", "rejected"]);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

/** One lint finding attached to a proposal at submission time. */
export const ProposalFinding = z.object({
  level: z.enum(["error", "warn", "info"]),
  code: z.string(),
  message: z.string(),
});
export type ProposalFinding = z.infer<typeof ProposalFinding>;

/**
 * A documentation update an agent submitted through MCP (decision 0024).
 * Validated by the same rules as human-written docs at submission; lands as a
 * draft that a human accepts (written into the server-side curation tier) or
 * rejects. Stored under `data/proposals/<slug>/<id>.json` — never served.
 */
export const AgentProposal = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string(),
  repo: z.string(),
  kind: ProposalKind,
  status: ProposalStatus.default("proposed"),
  createdAt: z.string(),
  /** Client-supplied name of the submitting agent, if any. */
  author: z.string().optional(),
  /** Why the agent believes the docs are wrong or missing. */
  rationale: z.string().optional(),
  /** kind = overlay: the overlay to curate (sourceContentHash stamped server-side). */
  overlay: EnrichmentOverlay.optional(),
  /** kind = product-doc: repo-relative `docs/product/…` path and markdown. */
  productDoc: z.object({ path: z.string(), content: z.string(), id: z.string().optional() }).optional(),
  findings: z.array(ProposalFinding).default([]),
  reviewedAt: z.string().optional(),
  reviewNote: z.string().optional(),
  /** Where an accepted proposal was written (server-side curation path). */
  writtenTo: z.string().optional(),
});
export type AgentProposal = z.infer<typeof AgentProposal>;
