import MiniSearch from "minisearch";
import type {
  DocModel,
  DocSymbolShape,
  SearchDoc,
  SubsystemsManifest,
} from "@necronomidoc/docmodel";

/** MiniSearch config — must be identical at build time and load time. */
export const SEARCH_OPTIONS = {
  idField: "id",
  fields: ["name", "path", "summary", "text"],
  storeFields: ["id", "type", "repo", "path", "name", "kind", "summary"],
  searchOptions: {
    boost: { name: 3, summary: 2 },
    prefix: true,
    fuzzy: 0.2,
  },
};

/**
 * Flatten a merged DocModel into search corpus rows (files + symbols, plus
 * subsystem overviews when a manifest is provided — slice 3 §3).
 */
export function buildCorpusDocs(model: DocModel, subsystems?: SubsystemsManifest): SearchDoc[] {
  const docs: SearchDoc[] = [];
  const repo = model.repo.slug;

  const symbolText = (s: DocSymbolShape): string =>
    [s.name, s.signature, s.doc?.summary, s.enrichment?.summary, s.enrichment?.purpose]
      .filter(Boolean)
      .join(" ");

  for (const file of model.files) {
    const fileSummary = file.enrichment?.summary ?? file.moduleDoc?.summary;
    docs.push({
      id: file.id,
      type: "file",
      repo,
      path: file.path,
      name: file.path.split("/").pop() ?? file.path,
      summary: fileSummary,
      text: [
        file.path,
        file.title,
        fileSummary,
        file.enrichment?.purpose,
        file.symbols.map((s) => s.name).join(" "),
        // Prose documents are searchable by their body (bounded to keep the
        // serialized index proportionate to the corpus).
        file.content?.slice(0, 4000),
      ]
        .filter(Boolean)
        .join(" "),
    });

    const walk = (symbols: DocSymbolShape[]): void => {
      for (const s of symbols) {
        docs.push({
          id: s.id,
          type: "symbol",
          repo,
          path: file.path,
          name: s.name,
          kind: s.kind,
          summary: s.enrichment?.summary ?? s.doc?.summary,
          text: symbolText(s),
        });
        if (s.members) walk(s.members);
      }
    };
    walk(file.symbols);
  }

  for (const sub of subsystems?.subsystems ?? []) {
    docs.push({
      id: `${repo}:subsystem:${sub.id}`,
      type: "subsystem",
      repo,
      path: sub.dirs[0] ?? "",
      name: sub.name,
      summary: sub.purpose,
      text: [
        sub.name,
        sub.purpose,
        ...sub.owns,
        ...sub.notOwns,
        ...sub.entryPoints,
        ...sub.dirs,
        ...sub.related.map((r) => `${r.name} ${r.relation}`),
      ]
        .filter(Boolean)
        .join(" "),
    });
  }
  return docs;
}

/** Build an in-memory MiniSearch index for a repo's corpus. */
export function buildIndex(model: DocModel, subsystems?: SubsystemsManifest): MiniSearch<SearchDoc> {
  const mini = new MiniSearch<SearchDoc>(SEARCH_OPTIONS);
  mini.addAll(buildCorpusDocs(model, subsystems));
  return mini;
}

/** Serialize an index to a JSON string for the manifest. */
export function serializeIndex(index: MiniSearch<SearchDoc>): string {
  return JSON.stringify(index);
}

/** Load a serialized index back into a queryable MiniSearch instance. */
export function loadIndex(json: string): MiniSearch<SearchDoc> {
  return MiniSearch.loadJSON<SearchDoc>(json, SEARCH_OPTIONS);
}
