import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, type DocModel } from "@necronomidoc/docmodel";
import { mergeEnrichment } from "./merge.js";

function model(): DocModel {
  return {
    schemaVersion: SCHEMA_VERSION,
    repo: { name: "r", slug: "r" },
    files: [
      {
        id: "r:src/a.ts",
        path: "src/a.ts",
        contentHash: "hash-file",
        imports: [],
        exports: ["doThing"],
        symbols: [
          {
            id: "r:src/a.ts#doThing",
            name: "doThing",
            kind: "function",
            exported: true,
            location: { path: "src/a.ts", line: 1 },
            contentHash: "hash-sym",
          },
        ],
      },
    ],
  };
}

describe("mergeEnrichment", () => {
  it("falls back to a heuristic when no overlay exists", () => {
    const merged = mergeEnrichment(model());
    const sym = merged.files[0]!.symbols[0]!;
    expect(sym.enrichment?.provenance).toBe("heuristic");
    expect(sym.enrichment?.summary).toContain("doThing");
  });

  it("prefers a human overlay over the heuristic", () => {
    const overlays = new Map([
      [
        "r:src/a.ts#doThing",
        { targetId: "r:src/a.ts#doThing", provenance: "human" as const, summary: "Human says." },
      ],
    ]);
    const merged = mergeEnrichment(model(), { overlays });
    const sym = merged.files[0]!.symbols[0]!;
    expect(sym.enrichment?.provenance).toBe("human");
    expect(sym.enrichment?.summary).toBe("Human says.");
    expect(sym.enrichment?.stale).toBe(false);
  });

  it("marks an overlay stale when the source hash no longer matches", () => {
    const overlays = new Map([
      [
        "r:src/a.ts#doThing",
        {
          targetId: "r:src/a.ts#doThing",
          provenance: "human" as const,
          summary: "Was true once.",
          sourceContentHash: "OLD",
        },
      ],
    ]);
    const merged = mergeEnrichment(model(), { overlays });
    const sym = merged.files[0]!.symbols[0]!;
    expect(sym.enrichment?.stale).toBe(true);
    expect(sym.enrichment?.summary).toBe("Was true once."); // content kept
  });
});
