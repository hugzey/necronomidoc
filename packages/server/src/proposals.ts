import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AgentProposal,
  EnrichmentOverlay,
  PRODUCT_DOCS_DIR,
  SCHEMA_VERSION,
  productTypeOfId,
  type DocSymbolShape,
  type ProposalFinding,
} from "@necronomidoc/docmodel";
import { PRODUCT_OVERRIDE_SUBDIR, buildProduct, productDocPath, splitFrontmatter } from "@necronomidoc/enrichment";
import {
  ManifestStore,
  paths,
  type OverlayProposalInput,
  type ProductDocProposalInput,
  type ProposalSink,
  type ToolResult,
} from "@necronomidoc/mcp";

/**
 * Agent-written docs with verification (decision 0024). Agents submit overlay
 * or product-doc updates through MCP (admin token required); each is linted
 * with the same rules as human-written docs and stored as a draft under
 * `data/proposals/<slug>/<id>.json` — never served, never published until a
 * human accepts it (`necronomidoc proposals accept` or the REST API), which
 * writes it into the server-side curation tier for the next build.
 */

/** Per-repo cap on pending drafts, so a looping agent can't flood the queue. */
export const MAX_PENDING_PER_REPO = 200;
const SUMMARY_MAX = 300;
const FIELD_MAX = 2000;
const INVARIANT_MAX = 200;
const INVARIANTS_MAX = 20;
const PRODUCT_DOC_MAX = 100_000;
/** Server-side dir accepted overlays are written to (inside the overlay tier). */
export const ACCEPTED_OVERLAYS_SUBDIR = "accepted";

function newProposalId(): string {
  // Time-ordered (base36 ms) + random suffix.
  return `P-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function proposalFile(dataDir: string, slug: string, id: string): string {
  return join(paths.proposalsDir(dataDir, slug), `${id}.json`);
}

function writeProposal(dataDir: string, proposal: AgentProposal): void {
  const dir = paths.proposalsDir(dataDir, proposal.repo);
  mkdirSync(dir, { recursive: true });
  writeFileSync(proposalFile(dataDir, proposal.repo, proposal.id), JSON.stringify(proposal, null, 2));
}

/** Every stored proposal (optionally one repo / status), newest first. */
export function listProposals(dataDir: string, filter: { repo?: string; status?: string } = {}): AgentProposal[] {
  const root = join(resolve(dataDir), "proposals");
  if (!existsSync(root)) return [];
  const out: AgentProposal[] = [];
  for (const slug of readdirSync(root)) {
    if (filter.repo && slug !== filter.repo) continue;
    const dir = join(root, slug);
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".json"));
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const parsed = AgentProposal.safeParse(JSON.parse(readFileSync(join(dir, name), "utf8")));
        if (parsed.success && (!filter.status || parsed.data.status === filter.status)) out.push(parsed.data);
      } catch {
        // skip a corrupt draft
      }
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

/** One proposal by id (searched across repos). */
export function readProposal(dataDir: string, id: string): AgentProposal | undefined {
  if (!/^P-[a-z0-9]+-[a-f0-9]+$/.test(id)) return undefined;
  return listProposals(dataDir).find((p) => p.id === id);
}

function lintText(field: string, text: string | undefined, max: number, findings: ProposalFinding[]): void {
  if (text === undefined) return;
  if (!text.trim()) findings.push({ level: "error", code: "empty-field", message: `\`${field}\` is empty.` });
  if (text.length > max) findings.push({ level: "error", code: "too-long", message: `\`${field}\` is ${text.length} chars (max ${max}).` });
  if (/TODO\(doc\)|\bTODO\b|\bTBD\b|lorem ipsum/i.test(text)) {
    findings.push({ level: "error", code: "placeholder", message: `\`${field}\` still contains a placeholder (TODO/TBD).` });
  }
}

/** Resolve an overlay target from an id or path(+symbol) against the published model. */
function resolveTarget(
  store: ManifestStore,
  input: OverlayProposalInput,
): { id: string; contentHash: string; enrichment?: DocSymbolShape["enrichment"]; label: string } | { error: string } {
  const repo = store.getRepo(input.repo);
  if (!repo) return { error: `No repo "${input.repo}".` };
  if (input.targetId) {
    const id = input.targetId.includes(":") ? input.targetId : `${input.repo}:${input.targetId}`;
    if (!id.startsWith(`${input.repo}:`)) return { error: `targetId "${input.targetId}" is not in repo "${input.repo}".` };
    const sym = store.getSymbolById(id);
    if (sym) return { id, contentHash: sym.contentHash, enrichment: sym.enrichment, label: sym.name };
    const file = repo.filesById.get(id);
    if (file) return { id, contentHash: file.contentHash, enrichment: file.enrichment, label: file.path };
    return { error: `No file or symbol "${id}" is documented — check the id with search_docs.` };
  }
  if (!input.path) return { error: "Name the target: `targetId`, or `path` (+ `symbol`)." };
  const file = store.getFile(input.repo, input.path.replace(/^\.\//, ""));
  if (!file) return { error: `No file "${input.path}" in repo "${input.repo}".` };
  if (!input.symbol) return { id: file.id, contentHash: file.contentHash, enrichment: file.enrichment, label: file.path };
  const sym = store.getSymbolById(`${file.id}#${input.symbol}`);
  if (!sym) return { error: `No symbol "${input.symbol}" in ${file.path}.` };
  return { id: sym.id, contentHash: sym.contentHash, enrichment: sym.enrichment, label: sym.name };
}

const OVERLAY_FIELDS = ["summary", "purpose", "scope", "notes"] as const;

/**
 * The overlay a proposal would publish: the target's current curated fields
 * with the proposal's on top (so proposing only invariants never wipes a
 * human summary), stamped with the target's current content hash.
 */
function mergedOverlay(
  targetId: string,
  contentHash: string,
  current: DocSymbolShape["enrichment"] | undefined,
  input: Pick<OverlayProposalInput, (typeof OVERLAY_FIELDS)[number] | "invariants">,
  provenance: "human" | "llm",
): EnrichmentOverlay {
  const keep = current && current.provenance !== "heuristic" ? current : undefined;
  const overlay: EnrichmentOverlay = { targetId, provenance, sourceContentHash: contentHash, updatedAt: new Date().toISOString() };
  for (const field of OVERLAY_FIELDS) {
    const value = input[field] ?? keep?.[field];
    if (value) overlay[field] = value;
  }
  const invariants = input.invariants ?? keep?.invariants;
  if (invariants?.length) overlay.invariants = invariants;
  return overlay;
}

/** The MCP write-back sink backed by the data dir. */
export class ProposalStore implements ProposalSink {
  constructor(
    private readonly dataDir: string,
    private readonly store: ManifestStore,
  ) {}

  private pendingCount(repo: string): number {
    return listProposals(this.dataDir, { repo, status: "proposed" }).length;
  }

  proposeOverlay(input: OverlayProposalInput): ToolResult {
    const target = resolveTarget(this.store, input);
    if ("error" in target) return { accepted: false, error: target.error };
    const findings: ProposalFinding[] = [];
    const has = OVERLAY_FIELDS.some((f) => input[f] !== undefined) || (input.invariants?.length ?? 0) > 0;
    if (!has) findings.push({ level: "error", code: "empty-proposal", message: "Propose at least one of summary, purpose, scope, notes, invariants." });
    lintText("summary", input.summary, SUMMARY_MAX, findings);
    for (const f of ["purpose", "scope", "notes"] as const) lintText(f, input[f], FIELD_MAX, findings);
    if ((input.invariants?.length ?? 0) > INVARIANTS_MAX) {
      findings.push({ level: "error", code: "too-many-invariants", message: `At most ${INVARIANTS_MAX} invariants.` });
    }
    (input.invariants ?? []).forEach((text, i) => lintText(`invariants[${i}]`, text, INVARIANT_MAX, findings));
    if (input.summary && target.enrichment?.summary === input.summary) {
      findings.push({ level: "warn", code: "unchanged", message: "The proposed summary is identical to the published one." });
    }
    if (input.summary && input.summary.trim().toLowerCase() === target.label.toLowerCase()) {
      findings.push({ level: "error", code: "restates-name", message: "The summary only restates the name — say what it is for." });
    }
    if (!input.rationale) findings.push({ level: "info", code: "no-rationale", message: "No rationale given — reviewers decide faster with one." });
    const overlay = mergedOverlay(target.id, target.contentHash, target.enrichment, input, "llm");
    const parsed = EnrichmentOverlay.safeParse(overlay);
    if (!parsed.success) findings.push({ level: "error", code: "invalid-overlay", message: parsed.error.message });
    if (findings.some((f) => f.level === "error")) {
      return { accepted: false, findings, note: "Not stored — fix the errors and propose again." };
    }
    if (this.pendingCount(input.repo) >= MAX_PENDING_PER_REPO) {
      return { accepted: false, error: `${MAX_PENDING_PER_REPO} proposals are already awaiting review for "${input.repo}".` };
    }
    const proposal: AgentProposal = {
      schemaVersion: SCHEMA_VERSION,
      id: newProposalId(),
      repo: input.repo,
      kind: "overlay",
      status: "proposed",
      createdAt: new Date().toISOString(),
      author: input.author?.slice(0, 100),
      rationale: input.rationale?.slice(0, FIELD_MAX),
      overlay: parsed.data!,
      findings,
    };
    writeProposal(this.dataDir, proposal);
    return { accepted: true, id: proposal.id, status: "proposed", targetId: target.id, findings, note: "Stored as a draft — a human reviews it (necronomidoc proposals accept|reject) before it publishes." };
  }

  proposeProductDoc(input: ProductDocProposalInput): ToolResult {
    const repo = this.store.getRepo(input.repo);
    if (!repo) return { accepted: false, error: `No repo "${input.repo}".` };
    if (input.content.length > PRODUCT_DOC_MAX) return { accepted: false, error: `Document is over ${PRODUCT_DOC_MAX} chars.` };
    const front = splitFrontmatter(input.content);
    const data = (front.data ?? {}) as { id?: unknown; title?: unknown };
    const id = typeof data.id === "string" ? data.id : undefined;
    const type = id ? productTypeOfId(id) : undefined;
    if (front.error || !id || !type) {
      return { accepted: false, findings: [{ level: "error", code: "bad-frontmatter", message: front.error ?? "Frontmatter needs an `id` like SES-001 / STORY-001." }] };
    }
    const path = (input.path ?? productDocPath(type, id, typeof data.title === "string" ? data.title : id)).replace(/^\.\//, "");
    if (!path.startsWith(`${PRODUCT_DOCS_DIR}/`) || !/\.md$/.test(path) || path.includes("..") || path.split("/").some((s) => s.startsWith("_"))) {
      return { accepted: false, error: `Path must be a .md file under ${PRODUCT_DOCS_DIR}/ (no .., no _-prefixed segments).` };
    }
    // The same linter as `product lint`, against the published code.
    const serverDir = join(this.dataDir, "enrichment", input.repo);
    const manifest = buildProduct(repo.model, {
      overrideDir: join(serverDir, PRODUCT_OVERRIDE_SUBDIR),
      proposed: [{ path, content: input.content, provenance: "override" }],
      previous: this.store.getProduct(input.repo),
    });
    const findings: ProposalFinding[] = manifest.findings
      .filter((f) => (f.docId === id || f.path === path) && f.code !== "override-shadowed")
      .map((f) => ({ level: f.level, code: f.code, message: f.message }));
    if (findings.some((f) => f.level === "error")) {
      return { accepted: false, findings, note: "Not stored — fix the errors and propose again." };
    }
    if (this.pendingCount(input.repo) >= MAX_PENDING_PER_REPO) {
      return { accepted: false, error: `${MAX_PENDING_PER_REPO} proposals are already awaiting review for "${input.repo}".` };
    }
    const shipped = repo.product?.docs.find((d) => d.id === id && d.provenance === "repo");
    if (shipped) {
      findings.push({ level: "info", code: "repo-shipped", message: `The repo ships ${id} at ${shipped.path}; repo docs win over server overrides, so the accepted file must be committed there to take effect.` });
    }
    const proposal: AgentProposal = {
      schemaVersion: SCHEMA_VERSION,
      id: newProposalId(),
      repo: input.repo,
      kind: "product-doc",
      status: "proposed",
      createdAt: new Date().toISOString(),
      author: input.author?.slice(0, 100),
      rationale: input.rationale?.slice(0, FIELD_MAX),
      productDoc: { path, content: input.content, id },
      findings,
    };
    writeProposal(this.dataDir, proposal);
    return { accepted: true, id: proposal.id, status: "proposed", docId: id, path, findings, note: "Stored as a draft — a human reviews it before it publishes." };
  }

  listProposals(repo?: string, status?: string): ToolResult {
    return {
      proposals: listProposals(this.dataDir, { repo, status }).slice(0, 100).map((p) => ({
        id: p.id,
        repo: p.repo,
        kind: p.kind,
        status: p.status,
        createdAt: p.createdAt,
        target: p.overlay?.targetId ?? p.productDoc?.id,
        rationale: p.rationale,
        reviewNote: p.reviewNote,
      })),
    };
  }
}

/** Stable file name for a target's accepted overlay (one file per target). */
function acceptedOverlayFile(dataDir: string, slug: string, targetId: string): string {
  const name = createHash("sha256").update(targetId).digest("hex").slice(0, 16);
  return join(resolve(dataDir), "enrichment", slug, ACCEPTED_OVERLAYS_SUBDIR, `${name}.json`);
}

/**
 * Accept or reject a proposal. Accepting writes it into the server-side
 * curation tier (overlay → `enrichment/<slug>/accepted/`, product doc →
 * `enrichment/<slug>/product/…`) — it publishes on the repo's next build.
 * Accepted overlays become `human` provenance: a person approved them.
 */
export function reviewProposal(
  dataDir: string,
  id: string,
  decision: "accept" | "reject",
  options: { note?: string; store?: ManifestStore } = {},
): AgentProposal {
  const proposal = readProposal(dataDir, id);
  if (!proposal) throw new Error(`No proposal "${id}".`);
  if (proposal.status !== "proposed") throw new Error(`Proposal ${id} was already ${proposal.status}.`);
  const reviewed: AgentProposal = { ...proposal, reviewedAt: new Date().toISOString(), reviewNote: options.note };
  if (decision === "reject") {
    reviewed.status = "rejected";
  } else if (proposal.kind === "overlay" && proposal.overlay) {
    // Re-merge against what is published NOW (other edits may have landed
    // since submission), keeping the proposal's own fields on top.
    const store = options.store ?? (() => {
      const s = new ManifestStore(resolve(dataDir));
      s.reload();
      return s;
    })();
    const sym = store.getSymbolById(proposal.overlay.targetId);
    const file = store.getRepo(proposal.repo)?.filesById.get(proposal.overlay.targetId);
    const current = sym?.enrichment ?? file?.enrichment;
    const hash = sym?.contentHash ?? file?.contentHash ?? proposal.overlay.sourceContentHash ?? "";
    const overlay = mergedOverlay(proposal.overlay.targetId, hash, current, proposal.overlay, "human");
    const out = acceptedOverlayFile(dataDir, proposal.repo, proposal.overlay.targetId);
    mkdirSync(join(out, ".."), { recursive: true });
    writeFileSync(out, JSON.stringify(overlay, null, 2));
    reviewed.status = "accepted";
    reviewed.writtenTo = out;
  } else if (proposal.kind === "product-doc" && proposal.productDoc) {
    const rel = proposal.productDoc.path.slice(PRODUCT_DOCS_DIR.length + 1);
    const out = join(resolve(dataDir), "enrichment", proposal.repo, PRODUCT_OVERRIDE_SUBDIR, rel);
    mkdirSync(join(out, ".."), { recursive: true });
    writeFileSync(out, proposal.productDoc.content);
    reviewed.status = "accepted";
    reviewed.writtenTo = out;
  } else {
    throw new Error(`Proposal ${id} has no content to accept.`);
  }
  writeProposal(dataDir, reviewed);
  return reviewed;
}
