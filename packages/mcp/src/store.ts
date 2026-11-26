import { existsSync, readFileSync } from "node:fs";
import type MiniSearch from "minisearch";
import { join } from "node:path";
import {
  AgentManifest,
  CoreDocsManifest,
  DocModel,
  ProductManifest,
  SubsystemsManifest,
  VersionsManifest,
  fileIdOfSymbol,
  type CodeBinding,
  type DocFile,
  type DocSymbolShape,
  type RegistryEntry,
  type SearchDoc,
  type Subsystem,
} from "@necronomidoc/docmodel";
import { paths, readRegistry } from "./manifests.js";
import { loadIndex } from "./search.js";
import { trustScore, type Trust } from "./trust.js";

/** Read + validate one optional JSON manifest; undefined when absent or invalid. */
function readOptional<T>(file: string, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** A past published state, loaded from the per-version archive (decision 0021). */
export interface ArchivedState {
  version: number;
  model: DocModel;
  product?: ProductManifest;
  subsystems?: SubsystemsManifest;
}

/** Resolve a relative import to a file path in `known` (mirrors the build-time resolver). */
function resolveRelative(fromPath: string, specifier: string, known: Map<string, DocFile>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const out: string[] = [];
  for (const seg of `${dir}/${specifier}`.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  const base = out.join("/");
  const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"];
  const candidates = [
    base,
    ...exts.map((e) => `${base}${e}`),
    ...exts.map((e) => `${base}/index${e}`),
    `${base}/__init__.py`,
    base.replace(/\.jsx?$/, ".ts"),
    base.replace(/\.jsx?$/, ".tsx"),
  ];
  return candidates.find((c) => known.has(c));
}

interface LoadedRepo {
  entry: RegistryEntry;
  model: DocModel;
  index: MiniSearch<SearchDoc>;
  subsystems?: SubsystemsManifest;
  coreDocs?: CoreDocsManifest;
  product?: ProductManifest;
  agent?: AgentManifest;
  versions?: VersionsManifest;
  /** file id -> file, symbol id -> symbol, for O(1) lookups. */
  filesById: Map<string, DocFile>;
  filesByPath: Map<string, DocFile>;
  symbolsById: Map<string, DocSymbolShape>;
  /** path -> files importing it (reverse import graph). */
  importersOf: Map<string, Set<string>>;
  /** path -> files it imports (internal, resolved). */
  importsOf: Map<string, Set<string>>;
  /** path -> test files exercising it (from agent.json test bindings). */
  testsByPath: Map<string, Set<string>>;
  /** path -> product-doc code bindings that target it (or a dir containing it). */
  bindingsByPath: Map<string, CodeBinding[]>;
}

export interface SearchHit {
  id: string;
  type: SearchDoc["type"];
  repo: string;
  path: string;
  name: string;
  kind?: string;
  summary?: string;
  score: number;
  /** Query terms that matched this hit (after fuzzy/prefix expansion). */
  matchedTerms: string[];
}

/**
 * In-memory view over the on-disk manifests. Loaded once at server start and
 * hot-reloaded after each rebuild — every MCP request is answered from here,
 * with no per-request disk reads (decision 0008, stateless handler).
 */
export class ManifestStore {
  private repos = new Map<string, LoadedRepo>();

  constructor(private readonly dataDir: string) {}

  /** (Re)load all manifests from disk. Safe to call after a rebuild. */
  reload(): void {
    const next = new Map<string, LoadedRepo>();
    if (existsSync(paths.registry(this.dataDir))) {
      for (const entry of readRegistry(this.dataDir).repos) {
        const repoDir = paths.repoDir(this.dataDir, entry.slug);
        const modelPath = paths.docmodel(repoDir);
        const indexPath = paths.searchIndex(repoDir);
        if (!existsSync(modelPath) || !existsSync(indexPath)) continue;
        const model = DocModel.parse(JSON.parse(readFileSync(modelPath, "utf8")));
        const index = loadIndex(readFileSync(indexPath, "utf8"));
        const subsystems = readOptional(paths.subsystems(repoDir), SubsystemsManifest);
        const coreDocs = readOptional(paths.coreDocs(repoDir), CoreDocsManifest);
        const product = readOptional(paths.product(repoDir), ProductManifest);
        const agent = readOptional(paths.agent(repoDir), AgentManifest);
        const versions = readOptional(paths.versions(repoDir), VersionsManifest);
        const filesById = new Map<string, DocFile>();
        const filesByPath = new Map<string, DocFile>();
        const symbolsById = new Map<string, DocSymbolShape>();
        for (const file of model.files) {
          filesById.set(file.id, file);
          filesByPath.set(file.path, file);
          const walk = (symbols: DocSymbolShape[]): void => {
            for (const s of symbols) {
              symbolsById.set(s.id, s);
              if (s.members) walk(s.members);
            }
          };
          walk(file.symbols);
        }
        const importersOf = new Map<string, Set<string>>();
        const importsOf = new Map<string, Set<string>>();
        for (const file of model.files) {
          const out = new Set<string>();
          for (const imp of file.imports) {
            const target = resolveRelative(file.path, imp.moduleSpecifier, filesByPath);
            if (!target || target === file.path) continue;
            out.add(target);
            const set = importersOf.get(target) ?? new Set<string>();
            set.add(file.path);
            importersOf.set(target, set);
          }
          importsOf.set(file.path, out);
        }
        const testsByPath = new Map<string, Set<string>>();
        for (const test of agent?.tests ?? []) {
          for (const path of test.exercises) {
            const set = testsByPath.get(path) ?? new Set<string>();
            set.add(test.path);
            testsByPath.set(path, set);
          }
        }
        const bindingsByPath = new Map<string, CodeBinding[]>();
        for (const doc of product?.docs ?? []) {
          for (const b of doc.bindings) {
            const t = b.target;
            if (!t) continue;
            const hits = t.kind === "dir" ? [...filesByPath.keys()].filter((p) => p.startsWith(`${t.path}/`)) : [t.path];
            for (const path of hits) {
              const list = bindingsByPath.get(path) ?? [];
              list.push(b);
              bindingsByPath.set(path, list);
            }
          }
        }
        next.set(entry.slug, {
          entry,
          model,
          index,
          subsystems,
          coreDocs,
          product,
          agent,
          versions,
          filesById,
          filesByPath,
          symbolsById,
          importersOf,
          importsOf,
          testsByPath,
          bindingsByPath,
        });
      }
    }
    this.repos = next;
    this.archiveCache.clear();
  }

  private archiveCache = new Map<string, ArchivedState>();

  listRepos(): RegistryEntry[] {
    return [...this.repos.values()].map((r) => r.entry);
  }

  getRepo(slug: string): LoadedRepo | undefined {
    return this.repos.get(slug);
  }

  /** Search across all repos (or one), ranked by score. */
  search(query: string, repoFilter?: string): SearchHit[] {
    const hits: SearchHit[] = [];
    for (const repo of this.repos.values()) {
      if (repoFilter && repo.entry.slug !== repoFilter) continue;
      for (const r of repo.index.search(query)) {
        hits.push({
          id: String(r.id),
          type: r.type as SearchDoc["type"],
          repo: r.repo,
          path: r.path,
          name: r.name,
          kind: r.kind,
          summary: r.summary,
          score: r.score,
          matchedTerms: (r.queryTerms as string[] | undefined) ?? [],
        });
      }
    }
    return hits.sort((a, b) => b.score - a.score);
  }

  getFile(slug: string, path: string): DocFile | undefined {
    return this.repos.get(slug)?.filesByPath.get(path);
  }

  getSymbolById(id: string): DocSymbolShape | undefined {
    const slug = id.split(":")[0];
    if (!slug) return undefined;
    return this.repos.get(slug)?.symbolsById.get(id);
  }

  /** Find a symbol by bare name within a repo (first match). */
  findSymbolByName(slug: string, name: string): DocSymbolShape | undefined {
    const repo = this.repos.get(slug);
    if (!repo) return undefined;
    // Endpoint names embed an HTTP method ("GET /users/{id}") — accept any
    // casing for those so agents can ask for "get /users/{id}" too. Code
    // symbols stay exact-match (`User` vs `user` are distinct declarations).
    const lower = name.toLowerCase();
    let endpointMatch: DocSymbolShape | undefined;
    for (const s of repo.symbolsById.values()) {
      if (s.name === name) return s;
      if (!endpointMatch && s.kind === "endpoint" && s.name.toLowerCase() === lower) {
        endpointMatch = s;
      }
    }
    return endpointMatch;
  }

  fileOfSymbol(id: string): DocFile | undefined {
    const slug = id.split(":")[0];
    if (!slug) return undefined;
    return this.repos.get(slug)?.filesById.get(fileIdOfSymbol(id));
  }

  listFiles(slug: string): DocFile[] {
    const repo = this.repos.get(slug);
    return repo ? [...repo.filesByPath.values()].sort((a, b) => a.path.localeCompare(b.path)) : [];
  }

  /** The repo's curated/heuristic subsystem map, if it was published. */
  getSubsystems(slug: string): SubsystemsManifest | undefined {
    return this.repos.get(slug)?.subsystems;
  }

  /** The repo's product docs manifest (decision 0023), if it was published. */
  getProduct(slug: string): ProductManifest | undefined {
    return this.repos.get(slug)?.product;
  }

  /** The repo's resolved core docs manifest, if it was published. */
  getCoreDocs(slug: string): CoreDocsManifest | undefined {
    return this.repos.get(slug)?.coreDocs;
  }

  /** The repo's agent manifest (recipes, usages, test bindings, synonyms), if published. */
  getAgent(slug: string): AgentManifest | undefined {
    return this.repos.get(slug)?.agent;
  }

  /** The repo's documentation version journal, newest first. */
  getVersions(slug: string): VersionsManifest | undefined {
    return this.repos.get(slug)?.versions;
  }

  /**
   * Load an archived past version (doc model + product + subsystems). Disk
   * read on demand — the one MCP path that touches disk — cached per
   * (repo, version) until the next reload.
   */
  loadArchive(slug: string, version: number): ArchivedState | undefined {
    const key = `${slug}@${version}`;
    const cached = this.archiveCache.get(key);
    if (cached) return cached;
    const dir = paths.versionArchiveDir(paths.repoDir(this.dataDir, slug), version);
    const model = readOptional(join(dir, "docmodel.json"), DocModel);
    if (!model) return undefined;
    const state: ArchivedState = {
      version,
      model,
      product: readOptional(join(dir, "product.json"), ProductManifest),
      subsystems: readOptional(join(dir, "subsystems.json"), SubsystemsManifest),
    };
    if (this.archiveCache.size >= 4) this.archiveCache.delete(this.archiveCache.keys().next().value!);
    this.archiveCache.set(key, state);
    return state;
  }

  /** Resolve a relative import written in `from` to a documented file path. */
  resolveImport(slug: string, from: string, specifier: string): string | undefined {
    const repo = this.repos.get(slug);
    return repo ? resolveRelative(from, specifier, repo.filesByPath) : undefined;
  }

  /** Files that import `path` (reverse import graph). */
  importersOf(slug: string, path: string): string[] {
    return [...(this.repos.get(slug)?.importersOf.get(path) ?? [])].sort();
  }

  /** Internal files `path` imports. */
  importsOf(slug: string, path: string): string[] {
    return [...(this.repos.get(slug)?.importsOf.get(path) ?? [])].sort();
  }

  /** Test files whose imports exercise `path` directly. */
  testsFor(slug: string, path: string): string[] {
    return [...(this.repos.get(slug)?.testsByPath.get(path) ?? [])].sort();
  }

  /** Product-doc code bindings targeting `path` (optionally one symbol in it). */
  bindingsFor(slug: string, path: string, symbol?: string): CodeBinding[] {
    const all = this.repos.get(slug)?.bindingsByPath.get(path) ?? [];
    if (!symbol) return all;
    return all.filter((b) => b.target?.kind !== "symbol" || b.target.name === symbol || b.target.name?.startsWith(`${symbol}.`));
  }

  /** The subsystem owning `path` (longest matching dir; dir-less ones own root files). */
  subsystemOf(slug: string, path: string): Subsystem | undefined {
    const map = this.repos.get(slug)?.subsystems;
    if (!map) return undefined;
    let best: { s: Subsystem; len: number } | undefined;
    for (const s of map.subsystems) {
      if (s.dirs.length === 0) {
        if (!path.includes("/") && !best) best = { s, len: 0 };
        continue;
      }
      for (const d of s.dirs) {
        const dir = d.replace(/\/+$/, "");
        if ((path === dir || path.startsWith(`${dir}/`)) && (!best || dir.length > best.len)) best = { s, len: dir.length };
      }
    }
    return best?.s;
  }

  /**
   * One trust score for an answer about a file or symbol (decision 0024):
   * provenance × staleness × binding drift × test coverage.
   */
  trustFor(slug: string, path: string, symbol?: DocSymbolShape): Trust {
    const file = this.getFile(slug, path);
    const enrichment = symbol?.enrichment ?? file?.enrichment;
    const bindings = this.bindingsFor(slug, path, symbol?.name.split(".")[0]);
    const directTests = this.testsFor(slug, path);
    const cited = bindings.length > 0 && this.getProduct(slug)?.docs.some((d) => d.tests.length > 0 && d.bindings.some((b) => bindings.includes(b)));
    return trustScore({
      provenance: enrichment?.provenance,
      stale: enrichment?.stale,
      documented: Boolean(symbol?.doc?.summary ?? file?.moduleDoc?.summary),
      bindings: bindings.map((b) => b.state),
      tested: directTests.length > 0 || cited === true,
    });
  }

  /**
   * Gotchas/invariants that apply to a file or symbol: the symbol's own, its
   * file's, and its subsystem's (prefixed with the subsystem name).
   */
  invariantsFor(slug: string, path: string, symbol?: DocSymbolShape): string[] {
    const out: string[] = [];
    for (const text of symbol?.enrichment?.invariants ?? []) out.push(text);
    for (const text of this.getFile(slug, path)?.enrichment?.invariants ?? []) out.push(text);
    const sub = this.subsystemOf(slug, path);
    for (const text of sub?.invariants ?? []) out.push(`(${sub!.name}) ${text}`);
    return [...new Set(out)];
  }
}
