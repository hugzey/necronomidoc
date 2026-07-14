import type {
  ArtefactIndex,
  ArtefactMode,
  ArtefactRecord,
  CoreDoc,
  CoreDocKind,
  CoreDocsManifest,
  DocFile,
  DocModel,
  DocSymbolShape,
  DocVersionEntry,
  GenerationScope,
  IngestStatusResponse,
  Registry,
  SkillSet,
  SkillSetIndex,
  SourcesManifest,
  Subsystem,
  SubsystemsManifest,
  VersionsManifest,
} from "@necronomidoc/docmodel";

export type {
  ArtefactIndex,
  ArtefactMode,
  ArtefactRecord,
  CoreDoc,
  CoreDocKind,
  CoreDocsManifest,
  DocFile,
  DocModel,
  DocSymbolShape,
  DocVersionEntry,
  GenerationScope,
  Registry,
  SkillSet,
  SkillSetIndex,
  SourcesManifest,
  Subsystem,
  SubsystemsManifest,
  VersionsManifest,
};

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

/**
 * The repo's core docs manifest (slice 7). Unavailable in static-export mode
 * and for repos built before slice 7 — both return undefined so the page can
 * degrade gracefully.
 */
export async function fetchCoreDocs(slug: string): Promise<CoreDocsManifest | undefined> {
  if (injectedData()) return undefined;
  const res = await fetch(`/data/repos/${slug}/coredocs.json`);
  if (!res.ok) return undefined;
  return (await res.json()) as CoreDocsManifest;
}

/**
 * The repo's source-snapshot index (decision 0020). Unavailable in
 * static-export mode and for repos built before the source viewer shipped —
 * both return undefined so the "View source" button simply doesn't render.
 */
export async function fetchSources(slug: string): Promise<SourcesManifest | undefined> {
  if (injectedData()) return undefined;
  return getOptionalJson<SourcesManifest>(`/data/repos/${slug}/sources.json`);
}

/**
 * The repo's documentation version journal (decision 0021). Same graceful
 * degradation as the other optional manifests.
 */
export async function fetchVersions(slug: string): Promise<VersionsManifest | undefined> {
  if (injectedData()) return undefined;
  return getOptionalJson<VersionsManifest>(`/data/repos/${slug}/versions.json`);
}

/**
 * `getJson`, but a manifest that legitimately doesn't exist (404 — repo built
 * before the feature, or a path the server doesn't publish) degrades to
 * undefined. Real failures (5xx, network) still throw so callers can tell
 * "not published" apart from "couldn't load".
 */
async function getOptionalJson<T>(url: string): Promise<T | undefined> {
  if (cache.has(url)) return cache.get(url) as T;
  const res = await fetch(url);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  const data = (await res.json()) as T;
  cache.set(url, data);
  return data;
}

/**
 * Source texts are up to 512 KiB each, so unlike the small JSON manifests
 * they get a bounded cache: browsing a large repo must not pin every visited
 * file's text in memory for the life of the tab.
 */
const sourceTextCache = new Map<string, string>();
const SOURCE_TEXT_CACHE_MAX = 20;

/**
 * One snapshotted source file's text, for the source viewer. Undefined when
 * the snapshot is missing (pre-viewer build, size-capped file, static export).
 */
export async function fetchSourceText(slug: string, path: string): Promise<string | undefined> {
  if (injectedData()) return undefined;
  const url = `/data/repos/${slug}/sources/${path.split("/").map(encodeURIComponent).join("/")}`;
  const cached = sourceTextCache.get(url);
  if (cached !== undefined) return cached;
  const res = await fetch(url);
  if (!res.ok) return undefined;
  const text = await res.text();
  if (sourceTextCache.size >= SOURCE_TEXT_CACHE_MAX) {
    // Maps iterate in insertion order — drop the oldest entry.
    sourceTextCache.delete(sourceTextCache.keys().next().value!);
  }
  sourceTextCache.set(url, text);
  return text;
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

// ---- Skills & artefacts (slice 8) ----

/**
 * Generated skill sets live on the server — unavailable in static-export mode,
 * which returns undefined so the page can degrade gracefully. Never cached:
 * the index changes after each generation.
 */
export async function fetchSkillSets(): Promise<SkillSetIndex | undefined> {
  if (injectedData()) return undefined;
  const res = await fetch("/api/skills");
  if (!res.ok) throw new Error(`${res.status} fetching /api/skills`);
  return (await res.json()) as SkillSetIndex;
}

export async function fetchSkillSet(id: string): Promise<SkillSet> {
  const res = await fetch(`/api/skills/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`${res.status} fetching skill set ${id}`);
  return (await res.json()) as SkillSet;
}

/** Generated artefacts — same server-only, uncached contract as skill sets. */
export async function fetchArtefacts(): Promise<ArtefactIndex | undefined> {
  if (injectedData()) return undefined;
  const res = await fetch("/api/artefacts");
  if (!res.ok) throw new Error(`${res.status} fetching /api/artefacts`);
  return (await res.json()) as ArtefactIndex;
}

export async function fetchArtefact(id: string): Promise<ArtefactRecord> {
  const res = await fetch(`/api/artefacts/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`${res.status} fetching artefact ${id}`);
  return (await res.json()) as ArtefactRecord;
}

// Generation result shapes mirror the server's SkillsResult/ArtefactResult by
// hand — the site doesn't depend on the server package.
export interface SkillsGenerateResult {
  setId: string;
  scope: GenerationScope;
  repos: string[];
  cached: boolean;
  staleRepos: string[];
  skillsWritten: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ArtefactGenerateResult {
  record: ArtefactRecord;
  outputPath: string;
  mode: ArtefactMode;
  tasks: number;
  filled: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  failures: { id: string; error: string }[];
  aborted: boolean;
  markdownFallback: boolean;
}

/** POST and surface the server's `{ error }` payload as the thrown message. */
async function postForResult<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const message = (data as { error?: string } | undefined)?.error;
    throw new Error(message ?? `${res.status} posting ${url}`);
  }
  return data as T;
}

export function generateSkills(
  body: { repos?: string[]; all?: boolean; force?: boolean },
  token: string,
): Promise<SkillsGenerateResult> {
  return postForResult("/api/skills/generate", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function generateArtefact(form: FormData, token: string): Promise<ArtefactGenerateResult> {
  return postForResult("/api/artefacts/generate", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
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
