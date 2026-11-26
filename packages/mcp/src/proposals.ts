import type { ToolResult } from "./tools.js";

/**
 * Agent-written documentation (decision 0024): the write-back seam the MCP
 * server calls. The server package implements it — validating with the same
 * linter as human-written docs and storing a draft for human review — so
 * this package stays free of the enrichment pipeline.
 */

export interface OverlayProposalInput {
  repo: string;
  /** DocModel file or symbol id (`slug:path` / `slug:path#Name`), or `path` + `symbol`. */
  targetId?: string;
  path?: string;
  symbol?: string;
  summary?: string;
  purpose?: string;
  scope?: string;
  notes?: string;
  invariants?: string[];
  rationale?: string;
  author?: string;
}

export interface ProductDocProposalInput {
  repo: string;
  /** Markdown with YAML frontmatter, as it would live under docs/product/. */
  content: string;
  /** Repo-relative path; derived from the id and title when omitted. */
  path?: string;
  rationale?: string;
  author?: string;
}

export interface ProposalSink {
  proposeOverlay(input: OverlayProposalInput): ToolResult;
  proposeProductDoc(input: ProductDocProposalInput): ToolResult;
  listProposals(repo?: string, status?: string): ToolResult;
}
