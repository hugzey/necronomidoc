import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CSharpAdapter } from "@necronomidoc/adapter-csharp";
import { MarkdownAdapter } from "@necronomidoc/adapter-markdown";
import { OpenApiAdapter } from "@necronomidoc/adapter-openapi";
import { PythonAdapter } from "@necronomidoc/adapter-python";
import { TypeScriptAdapter } from "@necronomidoc/adapter-ts";
import {
  SCHEMA_VERSION,
  slugify,
  type AdapterConfig,
  type DocAdapter,
  type DocModel,
  type Registry,
  type RegistryEntry,
} from "@necronomidoc/docmodel";
import {
  buildSubsystems,
  computeEnrichmentReport,
  mergeEnrichment,
} from "@necronomidoc/enrichment";
import { paths, readRegistry, registryEntryFor, upsertRegistry, writeRepoManifests } from "@necronomidoc/mcp";

/** Every adapter that detects the repo runs; their file lists are combined. */
const ADAPTERS: DocAdapter[] = [
  new TypeScriptAdapter(),
  new PythonAdapter(),
  new CSharpAdapter(),
  new OpenApiAdapter(),
  new MarkdownAdapter(),
];

/** The registered adapters, in detection order (for `necronomidoc doctor`). */
export function listAdapters(): readonly DocAdapter[] {
  return ADAPTERS;
}

/** Combine per-adapter models into one (first adapter wins on path clashes). */
function combineModels(models: DocModel[]): DocModel {
  const [base, ...rest] = models;
  const files = [...base!.files];
  const seen = new Set(files.map((f) => f.path));
  for (const model of rest) {
    for (const file of model.files) {
      if (!seen.has(file.path)) {
        seen.add(file.path);
        files.push(file);
      }
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { ...base!, files };
}

export interface BuildOptions {
  dataDir: string;
  /** Local path or git URL. */
  target: string;
  /** Override the repo name (defaults to the dir/url basename). */
  name?: string;
  /** Git ref to check out when cloning a URL. */
  ref?: string;
  adapterConfig?: Partial<AdapterConfig>;
}

export interface BuildResult {
  model: DocModel;
  entry: RegistryEntry;
  adapter: string;
}

/** Is the target an existing local directory (build in place, no clone)? */
export function isLocalDir(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Does the target look like a remote git URL (clone required)? */
export function looksLikeGitUrl(target: string): boolean {
  return /^(https?:\/\/|file:\/\/|git@|ssh:\/\/|git:\/\/)/.test(target) || target.endsWith(".git");
}

/** Shallow-clone a repo to a temp dir. Returns [dir, cleanup]. */
function cloneRepo(url: string, ref?: string): [string, () => void] {
  const dir = mkdtempSync(join(tmpdir(), "necronomidoc-clone-"));
  const args = ["clone", "--depth", "1"];
  if (ref) args.push("--branch", ref);
  args.push(url, dir);
  execFileSync("git", args, { stdio: "pipe" });
  return [dir, () => rmSync(dir, { recursive: true, force: true })];
}

export interface MaterializedTarget {
  repoDir: string;
  repoUrl?: string;
  cleanup?: () => void;
}

/** Resolve a build/enrich target to a working tree on disk. */
export function materializeTarget(target: string, ref?: string): MaterializedTarget {
  if (isLocalDir(target)) return { repoDir: resolve(target) };
  if (looksLikeGitUrl(target)) {
    const [repoDir, cleanup] = cloneRepo(target, ref);
    return { repoDir, repoUrl: target, cleanup };
  }
  throw new Error(`Target is neither a directory nor a git URL: ${target}`);
}

/** Run every adapter that detects the repo and combine their models. */
export async function extractRepoModel(
  repoDir: string,
  config: AdapterConfig,
): Promise<{ model: DocModel; adapter: string }> {
  const models: DocModel[] = [];
  const languages: string[] = [];
  for (const candidate of ADAPTERS) {
    if (await candidate.detect(repoDir)) {
      models.push(await candidate.extract(repoDir, config));
      languages.push(candidate.language);
    }
  }
  if (models.length === 0) throw new Error(`No adapter recognized the repo at ${repoDir}.`);
  return { model: combineModels(models), adapter: languages.join("+") };
}

/** The two standard overlay sources for a repo (decision 0004). */
export function overlayDirsFor(dataDir: string, repoDir: string, slug: string): string[] {
  return [
    join(repoDir, ".necronomidoc", "enrichment"),
    // Server-side curation + LLM overlays, kept outside the atomically-swapped
    // repo dir so rebuilds don't wipe them.
    join(dataDir, "enrichment", slug),
  ];
}

/**
 * Merge overlays onto an extracted model and publish everything for one repo:
 * doc model, search index, llms.txt, subsystems map, enrichment report, and
 * the registry entry. Shared by `buildRepo` and `enrichRepo`.
 */
export function publishModel(
  dataDir: string,
  model: DocModel,
  /** Omitted for pre-extracted IR (POST /api/ir): only server-side overlays apply. */
  repoDir?: string,
): { model: DocModel; entry: RegistryEntry } {
  const serverEnrichmentDir = join(dataDir, "enrichment", model.repo.slug);
  const merged = mergeEnrichment(model, {
    overlayDirs: repoDir
      ? overlayDirsFor(dataDir, repoDir, model.repo.slug)
      : [serverEnrichmentDir],
  });

  const subsystems = buildSubsystems(merged, {
    humanDirs: repoDir ? [join(repoDir, ".necronomidoc"), serverEnrichmentDir] : [serverEnrichmentDir],
    llmDir: serverEnrichmentDir,
  });
  const report = computeEnrichmentReport(merged);

  publishAtomically(dataDir, merged, { subsystems, enrichmentReport: report });
  const entry = registryEntryFor(merged, report);
  upsertRegistry(dataDir, entry);
  return { model: merged, entry };
}

/**
 * Run the full pipeline for one repo: resolve target → adapter extract →
 * enrichment merge → manifests (+ subsystems map + staleness report),
 * published with an atomic per-repo swap so readers never see a half-written
 * repo dir (slice-1 acceptance criterion).
 */
export async function buildRepo(options: BuildOptions): Promise<BuildResult> {
  const dataDir = resolve(options.dataDir);
  const { repoDir, repoUrl, cleanup } = materializeTarget(options.target, options.ref);

  try {
    const repoName = options.name ?? slugify(repoUrl ?? repoDir);
    const config: AdapterConfig = {
      repoName,
      repoUrl,
      ref: options.ref,
      ...options.adapterConfig,
    };
    const { model, adapter } = await extractRepoModel(repoDir, config);
    const { model: merged, entry } = publishModel(dataDir, model, repoDir);
    return { model: merged, entry, adapter };
  } finally {
    cleanup?.();
  }
}

/** Remove a repo's published docs: its manifests dir + docs-registry entry. */
export function purgeRepoDocs(dataDir: string, idOrSlug: string): void {
  // Docs publish under slugify(name); legacy ids may not be slug-stable.
  const slug = slugify(idOrSlug);
  rmSync(paths.repoDir(dataDir, slug), { recursive: true, force: true });
  const registry = readRegistry(dataDir);
  const next: Registry = {
    schemaVersion: SCHEMA_VERSION,
    repos: registry.repos.filter((r) => r.slug !== slug),
  };
  if (existsSync(paths.registry(dataDir))) {
    writeFileSync(paths.registry(dataDir), JSON.stringify(next, null, 2));
  }
}

/** Write manifests to a temp dir then swap it into place. */
function publishAtomically(
  dataDir: string,
  model: DocModel,
  extras: Parameters<typeof writeRepoManifests>[2] = {},
): void {
  const finalDir = paths.repoDir(dataDir, model.repo.slug);
  const tmpDir = `${finalDir}.tmp`;
  const oldDir = `${finalDir}.old`;
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(oldDir, { recursive: true, force: true });

  writeRepoManifests(model, tmpDir, extras);

  if (existsSync(finalDir)) renameSync(finalDir, oldDir);
  renameSync(tmpDir, finalDir);
  rmSync(oldDir, { recursive: true, force: true });
}
