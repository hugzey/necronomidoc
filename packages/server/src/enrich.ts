import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { slugify, type AdapterConfig, type EnrichmentOverlay } from "@necronomidoc/docmodel";
import {
  AnthropicLlmClient,
  LLM_SUBSYSTEMS_FILE,
  loadOverlays,
  mergeEnrichment,
  proposeSubsystems,
  renderStaleReview,
  runLlmEnrichment,
  type EnrichmentRunReport,
  type LlmClient,
} from "@necronomidoc/enrichment";
import {
  extractRepoModel,
  materializeTarget,
  overlayDirsFor,
  publishModel,
  type MaterializedTarget,
} from "./build.js";
import { fetchSource } from "./ingest/fetch.js";
import { getSourceRepo } from "./ingest/registry.js";

/**
 * The `necronomidoc enrich` pipeline (slice 3): extract the repo, run the LLM
 * overlay writer over everything lacking a human overlay (or with a stale llm
 * one), persist the new overlays server-side, and republish the docs. The
 * writer's content-hash cache makes re-runs on unchanged code free.
 */
export interface EnrichOptions {
  dataDir: string;
  /** Registered repo id, local path, or git URL. */
  target: string;
  name?: string;
  ref?: string;
  model?: string;
  maxFiles?: number;
  maxTokens?: number;
  /** Report what would be summarized without calling the LLM or publishing. */
  dryRun?: boolean;
  /** Also ask the LLM to propose a subsystem map (reviewed, provenance llm). */
  subsystems?: boolean;
  /** Injected client (tests); defaults to the Anthropic API. */
  client?: LlmClient;
}

export interface EnrichResult {
  slug: string;
  report: EnrichmentRunReport;
  /** Set when `--subsystems` proposed a map. */
  subsystemsProposed?: number;
  published: boolean;
}

/** Resolve target → working tree: registered repo id, local dir, or git URL. */
async function materializeEnrichTarget(
  options: EnrichOptions,
): Promise<MaterializedTarget & { name: string }> {
  const registered = getSourceRepo(options.dataDir, options.target);
  if (registered) {
    const fetched = await fetchSource(registered, options.dataDir);
    return { repoDir: fetched.dir, name: registered.id, repoUrl: registered.url };
  }
  const mat = materializeTarget(options.target, options.ref);
  return { ...mat, name: options.name ?? slugify(mat.repoUrl ?? mat.repoDir) };
}

/** Merge new llm overlays into the server-side per-repo `llm.json`. */
function persistLlmOverlays(
  enrichmentDir: string,
  overlays: EnrichmentOverlay[],
): void {
  mkdirSync(enrichmentDir, { recursive: true });
  const file = join(enrichmentDir, "llm.json");
  const existing: EnrichmentOverlay[] = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as EnrichmentOverlay[])
    : [];
  const byId = new Map(existing.map((o) => [o.targetId, o]));
  for (const overlay of overlays) byId.set(overlay.targetId, overlay);
  writeFileSync(
    file,
    JSON.stringify(
      [...byId.values()].sort((a, b) => a.targetId.localeCompare(b.targetId)),
      null,
      2,
    ) + "\n",
  );
}

export async function enrichRepo(options: EnrichOptions): Promise<EnrichResult> {
  const dataDir = resolve(options.dataDir);
  const { repoDir, repoUrl, cleanup, name } = await materializeEnrichTarget(options);

  try {
    const config: AdapterConfig = { repoName: name, repoUrl, ref: options.ref };
    const { model } = await extractRepoModel(repoDir, config);
    const slug = model.repo.slug;
    const enrichmentDir = join(dataDir, "enrichment", slug);
    const overlays = loadOverlays(overlayDirsFor(dataDir, repoDir, slug));

    const client =
      options.client ?? new AnthropicLlmClient({ model: options.model });
    const { overlays: newOverlays, report } = await runLlmEnrichment(model, {
      client,
      overlays,
      readSource: (path) => {
        try {
          return readFileSync(join(repoDir, path), "utf8");
        } catch {
          return undefined;
        }
      },
      maxFiles: options.maxFiles,
      maxTokens: options.maxTokens,
      dryRun: options.dryRun,
    });

    let subsystemsProposed: number | undefined;
    if (options.subsystems && !options.dryRun) {
      // Propose from the merged view so file summaries inform the map.
      const merged = mergeEnrichment(model, {
        overlays: new Map([...overlays, ...newOverlays.map((o) => [o.targetId, o] as const)]),
      });
      const proposal = await proposeSubsystems(merged, client);
      report.calls++;
      report.inputTokens += proposal.inputTokens;
      report.outputTokens += proposal.outputTokens;
      mkdirSync(enrichmentDir, { recursive: true });
      writeFileSync(
        join(enrichmentDir, LLM_SUBSYSTEMS_FILE),
        JSON.stringify(proposal.subsystems, null, 2) + "\n",
      );
      subsystemsProposed = proposal.subsystems.length;
    }

    let published = false;
    if (!options.dryRun) {
      if (newOverlays.length > 0) persistLlmOverlays(enrichmentDir, newOverlays);
      // Republish even when nothing changed: the report + subsystems refresh.
      publishModel(dataDir, model, repoDir);
      published = true;
    }

    return { slug, report, subsystemsProposed, published };
  } finally {
    cleanup?.();
  }
}

/** The `enrich --review-stale` report (no LLM calls, nothing written). */
export async function reviewStale(options: {
  dataDir: string;
  target: string;
  name?: string;
  ref?: string;
}): Promise<string> {
  const dataDir = resolve(options.dataDir);
  const { repoDir, repoUrl, cleanup, name } = await materializeEnrichTarget({
    dataDir,
    target: options.target,
    name: options.name,
    ref: options.ref,
  });
  try {
    const { model } = await extractRepoModel(repoDir, { repoName: name, repoUrl });
    const overlays = loadOverlays(overlayDirsFor(dataDir, repoDir, model.repo.slug));
    const merged = mergeEnrichment(model, { overlays });
    return renderStaleReview(merged, overlays);
  } finally {
    cleanup?.();
  }
}
