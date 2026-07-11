import {
  SCHEMA_VERSION,
  type DocFile,
  type DocModel,
  type DocSymbolShape,
  type EnrichmentOverlay,
  type EnrichmentReport,
  type StaleOverlayEntry,
} from "@necronomidoc/docmodel";

/**
 * Staleness workflow (slice 3 §2). Every rebuild computes this report from the
 * merged model so stale overlays surface on `/api/status`, the site, and
 * `enrich --review-stale`. Policy: stale `llm` overlays regenerate on the next
 * enrich run; stale `human` overlays are flagged here and never auto-touched.
 */
export function computeEnrichmentReport(merged: DocModel, now?: () => string): EnrichmentReport {
  const totals = {
    targets: 0,
    human: 0,
    llm: 0,
    heuristic: 0,
    stale: 0,
    staleHuman: 0,
    staleLlm: 0,
  };
  const stale: StaleOverlayEntry[] = [];

  const visit = (
    enrichment: DocFile["enrichment"],
    entry: Omit<StaleOverlayEntry, "provenance">,
  ): void => {
    totals.targets++;
    if (!enrichment) return;
    totals[enrichment.provenance]++;
    if (enrichment.stale) {
      totals.stale++;
      if (enrichment.provenance === "human") totals.staleHuman++;
      if (enrichment.provenance === "llm") totals.staleLlm++;
      stale.push({ ...entry, provenance: enrichment.provenance });
    }
  };

  for (const file of merged.files) {
    visit(file.enrichment, { targetId: file.id, path: file.path, kind: "file" });
    const walk = (symbols: DocSymbolShape[]): void => {
      for (const s of symbols) {
        visit(s.enrichment, { targetId: s.id, path: file.path, kind: "symbol", name: s.name });
        if (s.members) walk(s.members);
      }
    };
    walk(file.symbols);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    repo: merged.repo.slug,
    totals,
    stale,
    generatedAt: (now ?? (() => new Date().toISOString()))(),
  };
}

/**
 * Render the `enrich --review-stale` report: for every stale *human* overlay,
 * show the curated summary next to what the code looks like now, so a human
 * can re-curate quickly (old summary vs current signature/doc). LLM overlays
 * are listed but need no review — they regenerate automatically.
 */
export function renderStaleReview(
  merged: DocModel,
  overlays: Map<string, EnrichmentOverlay>,
): string {
  const report = computeEnrichmentReport(merged);
  if (report.stale.length === 0) return "No stale overlays — everything matches the current code.";

  const symbolById = new Map<string, DocSymbolShape>();
  const fileById = new Map<string, DocFile>();
  for (const file of merged.files) {
    fileById.set(file.id, file);
    const walk = (symbols: DocSymbolShape[]): void => {
      for (const s of symbols) {
        symbolById.set(s.id, s);
        if (s.members) walk(s.members);
      }
    };
    walk(file.symbols);
  }

  const lines: string[] = [];
  const human = report.stale.filter((s) => s.provenance === "human");
  const llm = report.stale.filter((s) => s.provenance !== "human");

  lines.push(`Stale overlays: ${report.stale.length} (${human.length} human, ${llm.length} llm)`);
  if (human.length > 0) {
    lines.push("", "Human overlays needing review (never auto-overwritten):", "");
    for (const entry of human) {
      const overlay = overlays.get(entry.targetId);
      lines.push(`■ ${entry.targetId}`);
      lines.push(`  where: ${entry.path}${entry.name ? ` › ${entry.name}` : ""}`);
      lines.push(`  overlay summary: ${overlay?.summary ?? "(none)"}`);
      if (overlay?.purpose) lines.push(`  overlay purpose: ${overlay.purpose}`);
      const current =
        entry.kind === "symbol" ? symbolById.get(entry.targetId) : undefined;
      if (current?.signature) lines.push(`  code now:        ${current.signature.slice(0, 160)}`);
      const docNow =
        entry.kind === "symbol"
          ? current?.doc?.summary
          : fileById.get(entry.targetId)?.moduleDoc?.summary;
      if (docNow) lines.push(`  doc comment now: ${docNow}`);
      lines.push(`  written against hash ${overlay?.sourceContentHash ?? "?"}; code has changed.`);
      lines.push("");
    }
  }
  if (llm.length > 0) {
    lines.push(
      `LLM overlays stale (auto-regenerate on next \`necronomidoc enrich\`): ${llm.length}`,
    );
    for (const entry of llm) lines.push(`- ${entry.targetId}`);
  }
  return lines.join("\n");
}
