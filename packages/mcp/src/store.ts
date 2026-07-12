import { existsSync, readFileSync } from "node:fs";
import type MiniSearch from "minisearch";
import {
  DocModel,
  SubsystemsManifest,
  fileIdOfSymbol,
  type DocFile,
  type DocSymbolShape,
  type RegistryEntry,
  type SearchDoc,
} from "@necronomidoc/docmodel";
import { paths, readRegistry } from "./manifests.js";
import { loadIndex } from "./search.js";

interface LoadedRepo {
  entry: RegistryEntry;
  model: DocModel;
  index: MiniSearch<SearchDoc>;
  subsystems?: SubsystemsManifest;
  /** file id -> file, symbol id -> symbol, for O(1) lookups. */
  filesById: Map<string, DocFile>;
  filesByPath: Map<string, DocFile>;
  symbolsById: Map<string, DocSymbolShape>;
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
        const subsystemsPath = paths.subsystems(repoDir);
        let subsystems: SubsystemsManifest | undefined;
        if (existsSync(subsystemsPath)) {
          const parsed = SubsystemsManifest.safeParse(
            JSON.parse(readFileSync(subsystemsPath, "utf8")),
          );
          if (parsed.success) subsystems = parsed.data;
        }
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
        next.set(entry.slug, {
          entry,
          model,
          index,
          subsystems,
          filesById,
          filesByPath,
          symbolsById,
        });
      }
    }
    this.repos = next;
  }

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
    for (const s of repo.symbolsById.values()) if (s.name === name) return s;
    return undefined;
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
}
