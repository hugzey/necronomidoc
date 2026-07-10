import MiniSearch from "minisearch";
import type { DocModel } from "./api.js";

export interface SiteSearchDoc {
  id: string;
  type: "file" | "symbol";
  path: string;
  name: string;
  kind?: string;
  summary?: string;
  text: string;
}

/**
 * Build a client-side search index from the doc model. We index in the browser
 * rather than shipping the server's serialized index so the site stays
 * decoupled from the MCP package's index format (decision 0005 fallback path).
 */
export function buildSiteIndex(model: DocModel): MiniSearch<SiteSearchDoc> {
  const docs: SiteSearchDoc[] = [];
  for (const file of model.files) {
    docs.push({
      id: file.id,
      type: "file",
      path: file.path,
      name: file.path.split("/").pop() ?? file.path,
      summary: file.enrichment?.summary,
      text: [
        file.path,
        file.title,
        file.enrichment?.summary,
        file.enrichment?.purpose,
        file.content?.slice(0, 4000),
      ]
        .filter(Boolean)
        .join(" "),
    });
    const walk = (symbols: typeof file.symbols) => {
      for (const s of symbols) {
        docs.push({
          id: s.id,
          type: "symbol",
          path: file.path,
          name: s.name,
          kind: s.kind,
          summary: s.enrichment?.summary ?? s.doc?.summary,
          text: [s.name, s.signature, s.enrichment?.summary, s.doc?.summary].filter(Boolean).join(" "),
        });
        if (s.members) walk(s.members);
      }
    };
    walk(file.symbols);
  }

  const mini = new MiniSearch<SiteSearchDoc>({
    idField: "id",
    fields: ["name", "path", "summary", "text"],
    storeFields: ["id", "type", "path", "name", "kind", "summary"],
    searchOptions: { boost: { name: 3, summary: 2 }, prefix: true, fuzzy: 0.2 },
  });
  mini.addAll(docs);
  return mini;
}
