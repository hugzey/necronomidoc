import type {
  AttachedEnrichment,
  DocFile,
  DocModel,
  DocSymbolShape,
  EnrichmentOverlay,
} from "@necronomidoc/docmodel";
import { heuristicForFile, heuristicForSymbol } from "./heuristic.js";
import { loadOverlays } from "./overlays.js";

export interface MergeOptions {
  /** Directories to load overlays from (lower precedence first). */
  overlayDirs?: string[];
  /** Pre-loaded overlays, keyed by target id (takes precedence over dirs). */
  overlays?: Map<string, EnrichmentOverlay>;
}

/**
 * Fold overlays and heuristics onto a raw DocModel, returning the merged model
 * that both the site and the MCP manifests read. Precedence per target:
 * human/LLM overlay > heuristic. The heuristic itself folds in existing doc
 * comments, so a hand-written JSDoc summary still surfaces when no overlay
 * exists. Overlays carrying a stale source hash keep their content but are
 * flagged `stale: true`.
 */
export function mergeEnrichment(model: DocModel, options: MergeOptions = {}): DocModel {
  const overlays =
    options.overlays ?? loadOverlays(options.overlayDirs ?? []);

  const resolve = (
    targetId: string,
    contentHash: string,
    base: AttachedEnrichment,
  ): AttachedEnrichment => {
    const overlay = overlays.get(targetId);
    if (!overlay) return base;
    return {
      summary: overlay.summary ?? base.summary,
      purpose: overlay.purpose,
      scope: overlay.scope,
      notes: overlay.notes,
      provenance: overlay.provenance,
      stale: overlay.sourceContentHash
        ? overlay.sourceContentHash !== contentHash
        : false,
    };
  };

  const enrichSymbol = (symbol: DocSymbolShape): DocSymbolShape => ({
    ...symbol,
    enrichment: resolve(symbol.id, symbol.contentHash, heuristicForSymbol(symbol)),
    members: symbol.members?.map(enrichSymbol),
  });

  const enrichFile = (file: DocFile): DocFile => ({
    ...file,
    enrichment: resolve(file.id, file.contentHash, heuristicForFile(file)),
    symbols: file.symbols.map(enrichSymbol),
  });

  return {
    ...model,
    files: model.files.map(enrichFile),
  };
}
