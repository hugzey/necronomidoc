import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Registry,
  SCHEMA_VERSION,
  type DocModel,
  type DocSymbolShape,
  type RegistryEntry,
} from "@necronomidoc/docmodel";
import { buildIndex, serializeIndex } from "./search.js";

/** Standard on-disk layout of the data dir (decision 0008). */
export const paths = {
  registry: (dataDir: string) => join(dataDir, "registry.json"),
  repoDir: (dataDir: string, slug: string) => join(dataDir, "repos", slug),
  docmodel: (repoDir: string) => join(repoDir, "docmodel.json"),
  searchIndex: (repoDir: string) => join(repoDir, "search.json"),
  llmsTxt: (repoDir: string) => join(repoDir, "llms.txt"),
};

function countSymbols(model: DocModel): number {
  let n = 0;
  const walk = (symbols: DocSymbolShape[]): void => {
    for (const s of symbols) {
      n++;
      if (s.members) walk(s.members);
    }
  };
  for (const f of model.files) walk(f.symbols);
  return n;
}

/** Build the registry summary entry for one repo. */
export function registryEntryFor(model: DocModel): RegistryEntry {
  return {
    name: model.repo.name,
    slug: model.repo.slug,
    fileCount: model.files.length,
    symbolCount: countSymbols(model),
    summary: model.files.find((f) => f.enrichment?.summary)?.enrichment?.summary,
    generatedAt: model.generatedAt,
  };
}

/** Render a `llms.txt` overview — a zero-server fallback for non-MCP agents. */
export function renderLlmsTxt(model: DocModel): string {
  const lines: string[] = [`# ${model.repo.name}`, ""];
  for (const file of model.files) {
    const purpose = file.enrichment?.summary ?? "";
    lines.push(`## ${file.path}`);
    if (purpose) lines.push(purpose);
    for (const s of file.symbols) {
      const sum = s.enrichment?.summary ?? s.doc?.summary ?? "";
      lines.push(`- \`${s.name}\` (${s.kind})${sum ? ` — ${sum}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Write one repo's manifests (doc model + serialized search index + llms.txt)
 * into `repoDir`. Callers build into a temp dir then atomically rename it into
 * place, so this never has to be transactional itself.
 */
export function writeRepoManifests(model: DocModel, repoDir: string): void {
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(paths.docmodel(repoDir), JSON.stringify(model, null, 2));
  writeFileSync(paths.searchIndex(repoDir), serializeIndex(buildIndex(model)));
  writeFileSync(paths.llmsTxt(repoDir), renderLlmsTxt(model));
}

/** Read the registry manifest, or an empty one if none exists yet. */
export function readRegistry(dataDir: string): Registry {
  const file = paths.registry(dataDir);
  if (!existsSync(file)) return { schemaVersion: SCHEMA_VERSION, repos: [] };
  return Registry.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** Upsert a repo's entry into the registry manifest. */
export function upsertRegistry(dataDir: string, entry: RegistryEntry): void {
  mkdirSync(dataDir, { recursive: true });
  const registry = readRegistry(dataDir);
  const others = registry.repos.filter((r) => r.slug !== entry.slug);
  const next: Registry = {
    schemaVersion: SCHEMA_VERSION,
    repos: [...others, entry].sort((a, b) => a.name.localeCompare(b.name)),
  };
  writeFileSync(paths.registry(dataDir), JSON.stringify(next, null, 2));
}
