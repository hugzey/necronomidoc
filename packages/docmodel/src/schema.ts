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

// ---- Manifests consumed by the site + MCP ----

/** One repo's summary line in the registry. */
export const RegistryEntry = z.object({
  name: z.string(),
  slug: z.string(),
  fileCount: z.number().int().nonnegative(),
  symbolCount: z.number().int().nonnegative(),
  summary: z.string().optional(),
  generatedAt: z.string().optional(),
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
  type: z.enum(["file", "symbol"]),
  repo: z.string(),
  path: z.string(),
  name: z.string(),
  kind: z.string().optional(),
  summary: z.string().optional(),
  text: z.string(),
});
export type SearchDoc = z.infer<typeof SearchDoc>;
