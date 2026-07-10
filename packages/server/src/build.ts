import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TypeScriptAdapter, type AdapterConfig, type DocAdapter } from "@necronomidoc/adapter-ts";
import { slugify, type DocModel, type RegistryEntry } from "@necronomidoc/docmodel";
import { mergeEnrichment } from "@necronomidoc/enrichment";
import { paths, registryEntryFor, upsertRegistry, writeRepoManifests } from "@necronomidoc/mcp";

/** Adapters tried in order; the first that detects the repo wins. */
const ADAPTERS: DocAdapter[] = [new TypeScriptAdapter()];

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

function isLocalDir(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function looksLikeGitUrl(target: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(target) || target.endsWith(".git");
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

/**
 * Run the full pipeline for one repo: resolve target → adapter extract →
 * enrichment merge → manifests, published with an atomic per-repo swap so
 * readers never see a half-written repo dir (slice-1 acceptance criterion).
 */
export async function buildRepo(options: BuildOptions): Promise<BuildResult> {
  const dataDir = resolve(options.dataDir);
  let repoDir = options.target;
  let cleanup: (() => void) | undefined;
  let repoUrl: string | undefined;

  if (isLocalDir(options.target)) {
    repoDir = resolve(options.target);
  } else if (looksLikeGitUrl(options.target)) {
    repoUrl = options.target;
    [repoDir, cleanup] = cloneRepo(options.target, options.ref);
  } else {
    throw new Error(`Target is neither a directory nor a git URL: ${options.target}`);
  }

  try {
    const repoName = options.name ?? slugify(repoUrl ?? repoDir);
    let adapter: DocAdapter | undefined;
    for (const candidate of ADAPTERS) {
      if (await candidate.detect(repoDir)) {
        adapter = candidate;
        break;
      }
    }
    if (!adapter) throw new Error(`No adapter recognized the repo at ${repoDir}.`);

    const model = await adapter.extract(repoDir, {
      repoName,
      repoUrl,
      ref: options.ref,
      ...options.adapterConfig,
    });

    const merged = mergeEnrichment(model, {
      overlayDirs: [
        join(repoDir, ".necronomidoc", "enrichment"),
        // Server-side curation, kept outside the atomically-swapped repo dir so
        // rebuilds don't wipe it.
        join(dataDir, "enrichment", model.repo.slug),
      ],
    });

    publishAtomically(dataDir, merged);
    const entry = registryEntryFor(merged);
    upsertRegistry(dataDir, entry);

    return { model: merged, entry, adapter: adapter.language };
  } finally {
    cleanup?.();
  }
}

/** Write manifests to a temp dir then swap it into place. */
function publishAtomically(dataDir: string, model: DocModel): void {
  const finalDir = paths.repoDir(dataDir, model.repo.slug);
  const tmpDir = `${finalDir}.tmp`;
  const oldDir = `${finalDir}.old`;
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(oldDir, { recursive: true, force: true });

  writeRepoManifests(model, tmpDir);

  if (existsSync(finalDir)) renameSync(finalDir, oldDir);
  renameSync(tmpDir, finalDir);
  rmSync(oldDir, { recursive: true, force: true });
}
