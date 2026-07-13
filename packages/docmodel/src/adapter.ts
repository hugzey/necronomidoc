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
 * External tools an adapter needs at extraction time (decision 0013).
 * Declarative so `necronomidoc doctor`, the status API, and docs can render
 * the requirement without running the adapter.
 */
export interface ToolchainRequirements {
  /** Tool name → version range, e.g. { python: ">=3.9" } or { dotnet: ">=8" }. */
  tools: Record<string, string>;
  /** Python packages needed inside the interpreter's environment. */
  pip?: string[];
  /** .NET global tools needed on PATH. */
  dotnetTools?: string[];
}

/** Result of probing an adapter's toolchain on this host. */
export interface ToolchainStatus {
  ok: boolean;
  /** What was found, e.g. "Python 3.11.15, griffe 2.1.0". */
  details?: string;
  /** Human-readable missing pieces when not ok. */
  missing?: string[];
  /** Actionable instruction to make the toolchain available. */
  fix?: string;
}

/**
 * Thrown by `extract()` when a required toolchain is unavailable. The build
 * pipeline turns this into a failed per-repo build status with the `fix`
 * attached — never a server crash (slice-5 acceptance criterion 3).
 */
export class ToolchainError extends Error {
  readonly fix: string;
  constructor(message: string, fix: string) {
    super(`${message} Fix: ${fix}`);
    this.name = "ToolchainError";
    this.fix = fix;
  }
}

/**
 * The contract every language adapter implements (decision 0007). Adapters do
 * static analysis only — they never execute target-repo code. Lives in
 * docmodel (not any one adapter package) because it is the shared boundary,
 * like the IR itself (decision 0006).
 *
 * Adapters whose extraction shells out to an external toolchain (Python,
 * .NET, …) declare it via `requires` and implement `checkToolchain()` so
 * `necronomidoc doctor` can report missing toolchains per host, and throw
 * `ToolchainError` from `extract()` when the toolchain is absent.
 */
export interface DocAdapter {
  readonly language: string;
  readonly requires?: ToolchainRequirements;
  detect(repoDir: string): Promise<AdapterMatch | null>;
  extract(repoDir: string, config: AdapterConfig): Promise<DocModel>;
  checkToolchain?(): Promise<ToolchainStatus>;
}
