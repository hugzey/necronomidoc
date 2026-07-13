import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  slugify,
  type AdapterConfig,
  type CoreDocKind,
  type DocModel,
  type EnrichmentOverlay,
  type LlmCoreDoc,
} from "@necronomidoc/docmodel";
import {
  AnthropicLlmClient,
  CORE_DOCS_SUBDIR,
  CORE_DOC_KINDS,
  DEFAULT_MAX_TOKENS,
  LLM_CORE_DOCS_FILE,
  LLM_SUBSYSTEMS_FILE,
  generateCoreDocs,
  loadLlmCoreDocs,
  loadOverlays,
  mergeEnrichment,
  planCoreDocs,
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
  /**
   * Generate the four core docs (overview/conventions/packages/architecture)
   * for every kind not covered by a repo file or server override, cached
   * against the repo hash. Default true; `--no-core-docs` disables.
   */
  coreDocs?: boolean;
  /** Injected client (tests); defaults to the Anthropic API. */
  client?: LlmClient;
}

/** What the core-docs step of an enrich run did (or would do, on dry runs). */
export interface CoreDocsRunSummary {
  /** Kinds the LLM should write: not curated, no fresh cache entry. */
  planned: CoreDocKind[];
  /** Kinds owned by a repo file or server override (never LLM-written). */
  curated: number;
  /** Kinds whose cached LLM doc still matches the repo hash. */
  fresh: number;
  written: number;
  failures: { kind: CoreDocKind; error: string }[];
}

export interface EnrichResult {
  slug: string;
  report: EnrichmentRunReport;
  /** Set when `--subsystems` proposed a map. */
  subsystemsProposed?: number;
  /** Set unless core docs were disabled for the run. */
  coreDocs?: CoreDocsRunSummary;
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

/** Merge newly generated core docs into the server-side cache, keyed by kind. */
function persistLlmCoreDocs(enrichmentDir: string, docs: LlmCoreDoc[]): void {
  mkdirSync(enrichmentDir, { recursive: true });
  const byKind = new Map(loadLlmCoreDocs(enrichmentDir).map((d) => [d.kind, d]));
  for (const doc of docs) byKind.set(doc.kind, doc);
  const ordered = CORE_DOC_KINDS.map((kind) => byKind.get(kind)).filter(
    (d): d is LlmCoreDoc => d !== undefined,
  );
  writeFileSync(
    join(enrichmentDir, LLM_CORE_DOCS_FILE),
    JSON.stringify(ordered, null, 2) + "\n",
  );
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

    // Merged view (fresh overlays included) so file summaries inform the
    // subsystem map and core docs; computed at most once per run.
    let mergedCache: DocModel | undefined;
    const mergedView = (): DocModel =>
      (mergedCache ??= mergeEnrichment(model, {
        overlays: new Map([...overlays, ...newOverlays.map((o) => [o.targetId, o] as const)]),
      }));

    let subsystemsProposed: number | undefined;
    if (options.subsystems && !options.dryRun) {
      // Propose from the merged view so file summaries inform the map.
      const proposal = await proposeSubsystems(mergedView(), client);
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

    let coreDocs: CoreDocsRunSummary | undefined;
    if (options.coreDocs !== false) {
      const plan = planCoreDocs(model, {
        repoDocsDir: join(repoDir, ".necronomidoc", CORE_DOCS_SUBDIR),
        overrideDir: join(enrichmentDir, CORE_DOCS_SUBDIR),
        llmDir: enrichmentDir,
      });
      coreDocs = {
        planned: plan.needed,
        curated: plan.curated.length,
        fresh: plan.fresh.length,
        written: 0,
        failures: [],
      };
      // Core-doc calls draw from the same token budget the overlay writer
      // used: pass the remaining allowance so generation stops at the cap
      // instead of overshooting it (the leftover kinds regenerate next run).
      const remainingTokens =
        (options.maxTokens ?? DEFAULT_MAX_TOKENS) - (report.inputTokens + report.outputTokens);
      if (!options.dryRun && plan.needed.length > 0 && remainingTokens > 0) {
        const generated = await generateCoreDocs(mergedView(), client, plan.needed, {
          maxTokens: remainingTokens,
        });
        report.calls += generated.calls;
        report.inputTokens += generated.inputTokens;
        report.outputTokens += generated.outputTokens;
        coreDocs.written = generated.docs.length;
        coreDocs.failures = generated.failures;
        if (generated.docs.length > 0) persistLlmCoreDocs(enrichmentDir, generated.docs);
      }
    }

    let published = false;
    if (!options.dryRun) {
      if (newOverlays.length > 0) persistLlmOverlays(enrichmentDir, newOverlays);
      // Republish even when nothing changed: the report + subsystems refresh.
      publishModel(dataDir, model, repoDir);
      published = true;
    }

    return { slug, report, subsystemsProposed, coreDocs, published };
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
