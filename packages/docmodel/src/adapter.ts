import type { DocModel } from "./schema.js";

/** What an adapter reports when it recognizes a repo. */
export interface AdapterMatch {
  language: string;
  /** Human-readable reason, e.g. "found tsconfig.json". */
  reason: string;
  /** Default source globs the adapter will sweep. */
  globs: string[];
}

/** Per-repo adapter configuration (overrides detection defaults). */
export interface AdapterConfig {
  /** Source globs relative to the repo dir. */
  globs?: string[];
  /** Globs to ignore in addition to the built-in ignores. */
  ignore?: string[];
  /** Repo identity to stamp on the emitted model. */
  repoName?: string;
  repoUrl?: string;
  ref?: string;
  commit?: string;
}

/**
 * The contract every language adapter implements (decision 0007). Adapters do
 * static analysis only — they never execute target-repo code. Lives in
 * docmodel (not any one adapter package) because it is the shared boundary,
 * like the IR itself (decision 0006).
 */
export interface DocAdapter {
  readonly language: string;
  detect(repoDir: string): Promise<AdapterMatch | null>;
  extract(repoDir: string, config: AdapterConfig): Promise<DocModel>;
}
