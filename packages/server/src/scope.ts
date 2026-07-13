import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  CoreDocsManifest,
  DocModel,
  SubsystemsManifest,
  repoContentHash,
  type GenerationScope,
} from "@necronomidoc/docmodel";
import type { ScopeInput } from "@necronomidoc/enrichment";
import { paths, readRegistry } from "@necronomidoc/mcp";

/**
 * Repo-scope selection for skill/artefact generation (slice 8): one repo, an
 * explicit list, or every documented repo. Scopes resolve against the
 * *published docs* in the data dir (`registry.json` + `repos/<slug>/`), so
 * generation only ever reads what a `build`/`enrich` run already produced —
 * no clones, no extraction.
 */
export interface ScopeSelection {
  /** Explicit repo slugs; mutually exclusive with `all`. */
  repos?: string[];
  /** Every repo in the docs registry. */
  all?: boolean;
}

/** A caller-fixable scope problem (unknown slug, empty selection/registry). */
export class ScopeError extends Error {}

/** Read + parse a caller-supplied JSON file with an actionable error. Shared
 * by the enrich/skills/artefact import pipelines. */
export function readJsonFile(path: string, what: string): unknown {
  const absolute = resolvePath(path);
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read ${what} ${absolute}: ${(err as Error).message}`);
  }
}

export interface ResolvedScope {
  scope: GenerationScope;
  inputs: ScopeInput[];
  /** slug → current repoContentHash, for caching/staleness. */
  sourceHashes: Record<string, string>;
}

function readManifest<T>(
  path: string,
  parse: (data: unknown) => T,
  what: string,
): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    console.warn(`[scope] ignoring unreadable ${what} at ${path}: ${(err as Error).message}`);
    return undefined;
  }
}

/** Load one published repo's model + core docs + subsystems. */
export function loadScopeInput(dataDir: string, slug: string): ScopeInput {
  const repoDir = paths.repoDir(dataDir, slug);
  const model = readManifest(paths.docmodel(repoDir), (d) => DocModel.parse(d), "doc model");
  if (!model) {
    throw new ScopeError(
      `Repo "${slug}" has no published docs under ${repoDir} — run \`necronomidoc build\` for it first.`,
    );
  }
  return {
    model,
    coreDocs: readManifest(paths.coreDocs(repoDir), (d) => CoreDocsManifest.parse(d), "core docs")
      ?.docs,
    subsystems: readManifest(
      paths.subsystems(repoDir),
      (d) => SubsystemsManifest.parse(d),
      "subsystems",
    )?.subsystems,
  };
}

/**
 * Resolve a scope selection to loaded inputs. Unknown slugs and an empty
 * registry are hard errors — silently generating from a partial scope would
 * mislabel the output.
 */
export function resolveScope(dataDir: string, selection: ScopeSelection): ResolvedScope {
  const registry = readRegistry(dataDir);
  const known = registry.repos.map((r) => r.slug);
  let slugs: string[];
  if (selection.all) {
    slugs = known;
    if (slugs.length === 0) {
      throw new ScopeError("No documented repos in the data dir — build at least one repo first.");
    }
  } else {
    slugs = [...new Set(selection.repos ?? [])];
    if (slugs.length === 0) {
      throw new ScopeError("No scope given — pass a repo slug, --repos <a,b,c>, or --all.");
    }
    const unknown = slugs.filter((s) => !known.includes(s));
    if (unknown.length > 0) {
      throw new ScopeError(
        `Unknown repo(s): ${unknown.join(", ")} — documented repos: ${known.join(", ") || "(none)"}.`,
      );
    }
  }
  const inputs = slugs.sort().map((slug) => loadScopeInput(dataDir, slug));
  const sourceHashes: Record<string, string> = {};
  for (const input of inputs) {
    sourceHashes[input.model.repo.slug] = repoContentHash(input.model.files);
  }
  const scope: GenerationScope = selection.all ? "global" : slugs.length === 1 ? "repo" : "multi";
  return { scope, inputs, sourceHashes };
}
