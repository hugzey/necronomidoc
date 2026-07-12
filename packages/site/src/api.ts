import type {
  DocFile,
  DocModel,
  DocSymbolShape,
  IngestStatusResponse,
  Registry,
  Subsystem,
  SubsystemsManifest,
} from "@necronomidoc/docmodel";

export type { DocFile, DocModel, DocSymbolShape, Registry, Subsystem, SubsystemsManifest };

/**
 * Static-export mode: a build script can inline the manifests as a global so
 * the whole site works as one self-contained HTML file with no server.
 */
interface InjectedData {
  registry: Registry;
  models: Record<string, DocModel>;
}
export function injectedData(): InjectedData | undefined {
  return (globalThis as { __NECRO_DATA__?: InjectedData }).__NECRO_DATA__;
}

const cache = new Map<string, unknown>();

async function getJson<T>(url: string): Promise<T> {
  if (cache.has(url)) return cache.get(url) as T;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  const data = (await res.json()) as T;
  cache.set(url, data);
  return data;
}

export function fetchRegistry(): Promise<Registry> {
  const injected = injectedData();
  if (injected) return Promise.resolve(injected.registry);
  return getJson<Registry>("/data/registry.json");
}

export function fetchModel(slug: string): Promise<DocModel> {
  const injected = injectedData();
  if (injected) {
    const model = injected.models[slug];
    return model ? Promise.resolve(model) : Promise.reject(new Error(`no model for ${slug}`));
  }
  return getJson<DocModel>(`/data/repos/${slug}/docmodel.json`);
}

/**
 * The repo's subsystem map (slice 3). Unavailable in static-export mode and
 * for repos built before slice 3 — both return undefined so the page can
 * degrade gracefully.
 */
export async function fetchSubsystems(slug: string): Promise<SubsystemsManifest | undefined> {
  if (injectedData()) return undefined;
  const res = await fetch(`/data/repos/${slug}/subsystems.json`);
  if (!res.ok) return undefined;
  return (await res.json()) as SubsystemsManifest;
}

// ---- Ingestion status (slice 2) ----

// The wire types live in docmodel, shared with the server that produces them.
export type StatusResponse = IngestStatusResponse;

/**
 * Live server status — never cached, and unavailable in static-export mode
 * (there is no server to ask). Returns undefined in that case.
 */
export async function fetchStatus(): Promise<StatusResponse | undefined> {
  if (injectedData()) return undefined;
  const res = await fetch("/api/status");
  if (!res.ok) throw new Error(`${res.status} fetching /api/status`);
  return (await res.json()) as StatusResponse;
}

/** Flatten a file's symbols (including members) for rendering. */
export function flattenSymbols(file: DocFile): DocSymbolShape[] {
  const out: DocSymbolShape[] = [];
  const walk = (symbols: DocSymbolShape[]) => {
    for (const s of symbols) {
      out.push(s);
      if (s.members) walk(s.members);
    }
  };
  walk(file.symbols);
  return out;
}
