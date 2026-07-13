import { z } from "zod";

/**
 * DocModel schema version. Bump on breaking changes; additive changes keep the
 * same version. Every persisted artifact carries this so consumers can refuse
 * or migrate incompatible data.
 */
export const SCHEMA_VERSION = 1 as const;

/** Where enrichment content came from, in precedence order (human wins). */
export const Provenance = z.enum(["human", "llm", "heuristic"]);
export type Provenance = z.infer<typeof Provenance>;

/** Kinds of documentable declaration the IR can carry (facts only). */
export const SymbolKind = z.enum([
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "variable",
  "component",
  "hook",
  "method",
  "property",
  "endpoint",
  "section",
  "unknown",
]);
export type SymbolKind = z.infer<typeof SymbolKind>;

/** A location in a source file (1-based line/column). */
export const SourceLocation = z.object({
  path: z.string(),
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative().optional(),
  endLine: z.number().int().nonnegative().optional(),
});
export type SourceLocation = z.infer<typeof SourceLocation>;

/** One documented parameter, as written in the doc comment. */
export const DocParam = z.object({
  name: z.string(),
  type: z.string().optional(),
  text: z.string().optional(),
});
export type DocParam = z.infer<typeof DocParam>;

/** A JSDoc/TSDoc block parsed into its parts. All fields "as written". */
export const DocComment = z.object({
  summary: z.string().optional(),
  remarks: z.string().optional(),
  params: z.array(DocParam).default([]),
  returns: z.string().optional(),
  examples: z.array(z.string()).default([]),
  deprecated: z.string().optional(),
  tags: z.array(z.object({ tag: z.string(), text: z.string() })).default([]),
});
export type DocComment = z.infer<typeof DocComment>;

/** A single React component prop. */
export const PropDoc = z.object({
  name: z.string(),
  type: z.string().optional(),
  required: z.boolean().default(false),
  defaultValue: z.string().optional(),
  description: z.string().optional(),
});
export type PropDoc = z.infer<typeof PropDoc>;

/**
 * Enrichment attached to a file or symbol after the merge step. Not produced by
 * adapters — this is the overlay layer's contribution, carried inline on the
 * merged model so site + MCP read one artifact.
 */
export const AttachedEnrichment = z.object({
  summary: z.string().optional(),
  purpose: z.string().optional(),
  scope: z.string().optional(),
  notes: z.string().optional(),
  provenance: Provenance,
  /** True when the underlying code changed since this enrichment was written. */
  stale: z.boolean().default(false),
});
export type AttachedEnrichment = z.infer<typeof AttachedEnrichment>;

/** A documented declaration. Symbols may nest (class/interface members). */
export const DocSymbol: z.ZodType<DocSymbolShape, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    kind: SymbolKind,
    exported: z.boolean().default(false),
    signature: z.string().optional(),
    location: SourceLocation,
    doc: DocComment.optional(),
    props: z.array(PropDoc).optional(),
    members: z.array(DocSymbol).optional(),
    contentHash: z.string(),
    enrichment: AttachedEnrichment.optional(),
  }),
);
export interface DocSymbolShape {
  id: string;
  name: string;
  kind: SymbolKind;
  exported: boolean;
  signature?: string;
  location: SourceLocation;
  doc?: DocComment;
  props?: PropDoc[];
  members?: DocSymbolShape[];
  contentHash: string;
  enrichment?: AttachedEnrichment;
}

/** A single import statement's normalized form. */
export const ImportRef = z.object({
  moduleSpecifier: z.string(),
  names: z.array(z.string()).default([]),
  isTypeOnly: z.boolean().default(false),
});
export type ImportRef = z.infer<typeof ImportRef>;

/** A source file and everything the adapter found in it. */
export const DocFile = z.object({
  id: z.string(),
  path: z.string(),
  contentHash: z.string(),
  /**
   * How to interpret the file: `source` (code; symbols are declarations),
   * `markdown` (prose; `content` carries the document, symbols are `section`
   * headings), or `openapi` (an API spec; `content` carries the bundled spec
   * as JSON, symbols are `endpoint` operations). Additive in schema v1 —
   * absent means `source`.
   */
  format: z.enum(["source", "markdown", "openapi"]).default("source"),
  /** Document title (markdown: first h1; openapi: info.title; else filename). */
  title: z.string().optional(),
  /** Full document text for prose/spec formats; omitted for source files. */
  content: z.string().optional(),
  moduleDoc: DocComment.optional(),
  imports: z.array(ImportRef).default([]),
  exports: z.array(z.string()).default([]),
  symbols: z.array(DocSymbol).default([]),
  enrichment: AttachedEnrichment.optional(),
});
export type DocFile = z.infer<typeof DocFile>;

/** Identity of the repo a doc model describes. */
export const RepoInfo = z.object({
  name: z.string(),
  slug: z.string(),
  url: z.string().optional(),
  ref: z.string().optional(),
  commit: z.string().optional(),
});
export type RepoInfo = z.infer<typeof RepoInfo>;

/** The whole file-rooted intermediate representation for one repo. */
export const DocModel = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  repo: RepoInfo,
  files: z.array(DocFile).default([]),
  generatedAt: z.string().optional(),
});
export type DocModel = z.infer<typeof DocModel>;

/**
 * An enrichment overlay file entry. Teams author these (or an LLM writes them
 * in a later slice) to add purpose/scope on top of extracted facts.
 */
export const EnrichmentOverlay = z.object({
  targetId: z.string(),
  summary: z.string().optional(),
  purpose: z.string().optional(),
  scope: z.string().optional(),
  notes: z.string().optional(),
  provenance: Provenance.default("human"),
  /** Content hash of the target when the overlay was written (staleness). */
  sourceContentHash: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type EnrichmentOverlay = z.infer<typeof EnrichmentOverlay>;

// ---- Subsystems (slice 3) ----

/**
 * A named group of files/directories with a purpose statement and explicit
 * boundaries — the separation-of-concerns context agents need to avoid
 * duplicate implementations. Sourced with the usual precedence: human
 * `subsystems.yaml` > LLM-proposed > heuristic (top-level directories).
 */
export const Subsystem = z.object({
  /** Stable slug id, unique within a repo. */
  id: z.string(),
  name: z.string(),
  /** What this subsystem is for. */
  purpose: z.string(),
  /** Boundary statements: what this subsystem owns / is responsible for. */
  owns: z.array(z.string()).default([]),
  /** Boundary statements: what does NOT belong in this subsystem. */
  notOwns: z.array(z.string()).default([]),
  /** Key entry points (file paths or exported symbol names). */
  entryPoints: z.array(z.string()).default([]),
  /** Relationships to other subsystems. */
  related: z.array(z.object({ name: z.string(), relation: z.string() })).default([]),
  /** Directory prefixes (repo-relative) whose files belong to this subsystem. */
  dirs: z.array(z.string()).default([]),
  provenance: Provenance.default("heuristic"),
});
export type Subsystem = z.infer<typeof Subsystem>;

/** The per-repo subsystems manifest, published next to the doc model. */
export const SubsystemsManifest = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  repo: z.string(),
  subsystems: z.array(Subsystem).default([]),
  generatedAt: z.string().optional(),
});
export type SubsystemsManifest = z.infer<typeof SubsystemsManifest>;

// ---- Core docs (slice 7) ----

/** The four core documents every repo publishes. */
export const CoreDocKind = z.enum(["overview", "conventions", "packages", "architecture"]);
export type CoreDocKind = z.infer<typeof CoreDocKind>;

/**
 * Where a core doc came from, in precedence order (repo wins): a file the
 * source repo ships (`.necronomidoc/docs/<kind>.md`), a server-side override
 * (`data/enrichment/<slug>/docs/<kind>.md`), the LLM writer, or the
 * always-present heuristic floor derived from the extracted model.
 */
export const CoreDocProvenance = z.enum(["repo", "override", "llm", "heuristic"]);
export type CoreDocProvenance = z.infer<typeof CoreDocProvenance>;

/** One resolved core document (markdown body, highest-precedence source). */
export const CoreDoc = z.object({
  kind: CoreDocKind,
  title: z.string(),
  /** Markdown. The architecture doc carries a mermaid or ASCII diagram. */
  content: z.string(),
  provenance: CoreDocProvenance,
  /** True when the repo's code changed since this (llm) doc was written. */
  stale: z.boolean().default(false),
  updatedAt: z.string().optional(),
});
export type CoreDoc = z.infer<typeof CoreDoc>;

/** The per-repo core docs manifest, published next to the doc model. */
export const CoreDocsManifest = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  repo: z.string(),
  docs: z.array(CoreDoc).default([]),
  generatedAt: z.string().optional(),
});
export type CoreDocsManifest = z.infer<typeof CoreDocsManifest>;

/** An LLM-written core doc cached server-side, keyed to the repo hash. */
export const LlmCoreDoc = z.object({
  kind: CoreDocKind,
  title: z.string(),
  content: z.string(),
  /** `repoContentHash` of the model this doc was written from (staleness). */
  sourceRepoHash: z.string(),
  model: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type LlmCoreDoc = z.infer<typeof LlmCoreDoc>;

// ---- Enrichment/staleness report (slice 3) ----

/** One stale overlay flagged in a build's enrichment report. */
export const StaleOverlayEntry = z.object({
  targetId: z.string(),
  path: z.string(),
  /** Whether the target is a file or a symbol within one. */
  kind: z.enum(["file", "symbol"]),
  name: z.string().optional(),
  provenance: Provenance,
});
export type StaleOverlayEntry = z.infer<typeof StaleOverlayEntry>;

/** Aggregate enrichment coverage counts for one repo build. */
export const EnrichmentTotals = z.object({
  targets: z.number().int().nonnegative(),
  human: z.number().int().nonnegative(),
  llm: z.number().int().nonnegative(),
  heuristic: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  staleHuman: z.number().int().nonnegative(),
  staleLlm: z.number().int().nonnegative(),
});
export type EnrichmentTotals = z.infer<typeof EnrichmentTotals>;

/**
 * Written on every rebuild so the status API, site, and `enrich --review-stale`
 * can list overlays whose underlying code changed (decision 0004: stale human
 * overlays are flagged for review, never overwritten).
 */
export const EnrichmentReport = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  repo: z.string(),
  totals: EnrichmentTotals,
  stale: z.array(StaleOverlayEntry).default([]),
  generatedAt: z.string().optional(),
});
export type EnrichmentReport = z.infer<typeof EnrichmentReport>;

// ---- Manifests consumed by the site + MCP ----

/** One repo's summary line in the registry. */
export const RegistryEntry = z.object({
  name: z.string(),
  slug: z.string(),
  fileCount: z.number().int().nonnegative(),
  symbolCount: z.number().int().nonnegative(),
  summary: z.string().optional(),
  generatedAt: z.string().optional(),
  /** Enrichment coverage + staleness counts (slice 3; additive). */
  enrichment: EnrichmentTotals.optional(),
});
export type RegistryEntry = z.infer<typeof RegistryEntry>;

/** The top-level registry manifest listing every documented repo. */
export const Registry = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  repos: z.array(RegistryEntry).default([]),
});
export type Registry = z.infer<typeof Registry>;

/** One row in the serialized search corpus. */
export const SearchDoc = z.object({
  id: z.string(),
  type: z.enum(["file", "symbol", "subsystem", "coredoc"]),
  repo: z.string(),
  path: z.string(),
  name: z.string(),
  kind: z.string().optional(),
  summary: z.string().optional(),
  text: z.string(),
});
export type SearchDoc = z.infer<typeof SearchDoc>;
