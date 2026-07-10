import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { EnrichmentOverlay, type EnrichmentOverlay as Overlay } from "@necronomidoc/docmodel";

/** Recursively collect files under `dir` matching one of the extensions. */
function walk(dir: string, exts: string[]): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

/** Parse one overlay file into zero or more validated overlay entries. */
function parseOverlayFile(path: string): Overlay[] {
  const raw = readFileSync(path, "utf8");
  const data: unknown = path.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
  const entries = Array.isArray(data) ? data : [data];
  const out: Overlay[] = [];
  for (const entry of entries) {
    const parsed = EnrichmentOverlay.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
    else console.warn(`[enrichment] invalid overlay in ${path}: ${parsed.error.message}`);
  }
  return out;
}

/**
 * Load enrichment overlays from a set of directories, keyed by target id.
 * Later directories win, so callers pass lower-precedence dirs first. The two
 * standard sources: the source repo's `.necronomidoc/enrichment/` (curation
 * next to code) and the server's per-repo data dir.
 */
export function loadOverlays(dirs: string[]): Map<string, Overlay> {
  const byId = new Map<string, Overlay>();
  for (const dir of dirs) {
    for (const file of walk(dir, [".json", ".yaml", ".yml"])) {
      for (const overlay of parseOverlayFile(file)) {
        byId.set(overlay.targetId, overlay);
      }
    }
  }
  return byId;
}
