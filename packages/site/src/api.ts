import type { DocFile, DocModel, DocSymbolShape, Registry } from "@necronomidoc/docmodel";

export type { DocFile, DocModel, DocSymbolShape, Registry };

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
  return getJson<Registry>("/data/registry.json");
}

export function fetchModel(slug: string): Promise<DocModel> {
  return getJson<DocModel>(`/data/repos/${slug}/docmodel.json`);
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
