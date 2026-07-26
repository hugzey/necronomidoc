import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  SCHEMA_VERSION,
  Provenance,
  Subsystem,
  slugify,
  type DocModel,
  type RelatedSubsystem,
  type SubsystemsManifest,
} from "@necronomidoc/docmodel";
import type { LlmClient, LlmCompleteRequest } from "./llm/client.js";

/**
 * Subsystem overviews (slice 3 §3, enhanced). A subsystem is a named group of
 * files with a purpose statement, boundaries ("owns X, does not do Y"), entry
 * points and relationships to other subsystems. The published map also carries
 * a repo-level `overview` narrative and an architecture `diagram` (Mermaid).
 *
 * Sources, same precedence as all enrichment: human `subsystems.yaml` >
 * LLM-proposed > heuristic (import-graph clustering). The highest-precedence
 * source present defines the complete map — curated maps replace the heuristic
 * floor rather than merging with it.
 */

/** Candidate file names checked in each source directory. */
const HUMAN_FILES = ["subsystems.yaml", "subsystems.yml", "subsystems.json"];
export const LLM_SUBSYSTEMS_FILE = "subsystems.llm.json";

/** A resolved subsystem map plus its repo-level narrative/diagram overrides. */
export interface SubsystemSource {
  subsystems: Subsystem[];
  /** Repo-level narrative, when the source supplies one. */
  overview?: string;
  /** Curated Mermaid diagram that overrides the generated one. */
  diagram?: string;
}

/** Validate the subsystem entries out of an already-parsed source document. */
function subsystemsFrom(data: unknown, source: string): Subsystem[] {
  const list = Array.isArray(data)
    ? data
    : (data as { subsystems?: unknown[] })?.subsystems ?? [];
  const out: Subsystem[] = [];
  for (const entry of list) {
    const parsed = Subsystem.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
    else console.warn(`[enrichment] invalid subsystem in ${source}: ${parsed.error.message}`);
  }
  return out;
}

/** Pull the optional repo-level `overview`/`diagram` out of the object form. */
function extrasFrom(data: unknown): Pick<SubsystemSource, "overview" | "diagram"> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return {};
  const obj = data as { overview?: unknown; diagram?: unknown };
  return {
    overview: typeof obj.overview === "string" ? obj.overview : undefined,
    diagram: typeof obj.diagram === "string" ? obj.diagram : undefined,
  };
}

/**
 * Load human-curated subsystems from a list of directories (`subsystems.yaml`
 * next to the code or in the server's per-repo enrichment dir; later dirs
 * win). Provenance is forced to `human` — that's what these files mean. A file
 * that carries `overview`/`diagram` but no valid subsystems still contributes
 * those extras, so a curator's narrative is never silently dropped.
 */
export function loadHumanSubsystems(dirs: string[]): SubsystemSource {
  let found: SubsystemSource = { subsystems: [] };
  for (const dir of dirs) {
    for (const name of HUMAN_FILES) {
      const path = join(dir, name);
      if (!existsSync(path)) continue;
      // Parse the source document exactly once, then read both views of it.
      const data: unknown = name.endsWith(".json")
        ? JSON.parse(readFileSync(path, "utf8"))
        : parseYaml(readFileSync(path, "utf8"));
      const entries = subsystemsFrom(data, path);
      const extras = extrasFrom(data);
      if (entries.length > 0 || extras.overview !== undefined || extras.diagram !== undefined) {
        found = {
          subsystems: entries.map((s) => ({ ...s, provenance: "human" as const })),
          ...extras,
        };
      }
    }
  }
  return found;
}

/** Load LLM-proposed subsystems written by a previous `enrich --subsystems`. */
export function loadLlmSubsystems(dir: string): SubsystemSource {
  const path = join(dir, LLM_SUBSYSTEMS_FILE);
  if (!existsSync(path)) return { subsystems: [] };
  const raw = readFileSync(path, "utf8");
  const data: unknown = JSON.parse(raw);
  // Backward compatible: older runs wrote a bare array; newer ones write an
  // object with `subsystems` plus the `overview` narrative.
  const list = Array.isArray(data) ? data : ((data as { subsystems?: unknown[] })?.subsystems ?? []);
  const overview =
    !Array.isArray(data) && typeof (data as { overview?: unknown }).overview === "string"
      ? (data as { overview: string }).overview
      : undefined;
  const subsystems: Subsystem[] = [];
  for (const entry of list) {
    const parsed = Subsystem.safeParse(entry);
    if (parsed.success) subsystems.push({ ...parsed.data, provenance: "llm" as const });
    else console.warn(`[enrichment] invalid LLM subsystem in ${path}: ${parsed.error.message}`);
  }
  return { subsystems, overview };
}

// ---- Import-graph clustering (the always-present heuristic floor) ----

/** Directory names that hold sibling packages rather than a subsystem's code. */
const CONTAINER_DIRS = new Set(["packages", "apps", "services", "libs", "modules", "plugins"]);

/** Collapse `.`/`..` segments in a joined path (no filesystem access). */
function normalizeSegments(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/**
 * Resolve a relative import specifier to a file path present in the model,
 * trying the extension/index conventions of every language we extract. Returns
 * undefined for bare/package specifiers (not part of the internal graph).
 */
export function resolveModule(
  fromPath: string,
  specifier: string,
  byPath: Set<string>,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const base = normalizeSegments(`${dir}/${specifier}`);
  const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"];
  const candidates = [
    base,
    ...exts.map((e) => `${base}${e}`),
    ...exts.map((e) => `${base}/index${e}`),
    `${base}/__init__.py`,
    base.replace(/\.jsx?$/, ".ts"),
    base.replace(/\.jsx?$/, ".tsx"),
  ];
  return candidates.find((c) => byPath.has(c));
}

/** Group key for a file: monorepo container dirs recurse one level deeper. */
function groupKeyFor(path: string, containers: Set<string>): string {
  const segs = path.split("/");
  if (segs.length === 1) return "(root)";
  const top = segs[0]!;
  // A file two levels under a container (e.g. packages/mcp/x.ts) groups by the
  // package; a file directly in it (packages/index.ts) groups by the container.
  if (containers.has(top) && segs.length > 2) return `${top}/${segs[1]}`;
  return top;
}

/**
 * The always-present floor: cluster files by the import graph. Membership is
 * seeded by directory (the strongest cohesion signal), while the relationships,
 * entry points and diagram are all derived from actual imports — so even a repo
 * nobody has curated gets logical groupings with real edges between them.
 */
export function heuristicSubsystems(model: DocModel): Subsystem[] {
  const byPath = new Set(model.files.map((f) => f.path));

  // Which top-level dirs act as package containers (recurse one level in).
  const childDirs = new Map<string, Set<string>>();
  for (const f of model.files) {
    const segs = f.path.split("/");
    if (segs.length > 2) {
      const set = childDirs.get(segs[0]!) ?? new Set<string>();
      set.add(segs[1]!);
      childDirs.set(segs[0]!, set);
    }
  }
  const containers = new Set<string>();
  for (const [top, kids] of childDirs) {
    if (CONTAINER_DIRS.has(top) || kids.size >= 3) containers.add(top);
  }

  // Assign every file to a group and index membership.
  const groupOf = new Map<string, string>(); // file path -> group key
  const groups = new Map<string, string[]>(); // group key -> file paths
  for (const f of model.files) {
    const key = groupKeyFor(f.path, containers);
    groupOf.set(f.path, key);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(f.path);
  }

  // Walk imports once: tally cross-group edges and per-file external in-degree.
  const edges = new Map<string, Map<string, number>>(); // src group -> dst group -> count
  const externalInDegree = new Map<string, number>(); // file path -> imported-from-outside count
  for (const f of model.files) {
    const src = groupOf.get(f.path)!;
    for (const imp of f.imports) {
      const target = resolveModule(f.path, imp.moduleSpecifier, byPath);
      if (!target) continue;
      const dst = groupOf.get(target)!;
      if (dst === src) continue;
      const row = edges.get(src) ?? edges.set(src, new Map()).get(src)!;
      row.set(dst, (row.get(dst) ?? 0) + 1);
      externalInDegree.set(target, (externalInDegree.get(target) ?? 0) + 1);
    }
  }

  const keyToId = new Map<string, string>();
  const seenIds = new Set<string>();
  for (const key of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    let id = slugify(key === "(root)" ? "root" : key);
    while (seenIds.has(id)) id = `${id}-2`;
    seenIds.add(id);
    keyToId.set(key, id);
  }

  const EDGES_MAX = 6;
  const ENTRY_MAX = 3;
  const isIndex = (p: string): boolean => /(^|\/)(index|__init__)\.[a-z]+$/.test(p);
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, paths]) => {
      // Entry points: files most depended on from outside this group; ties break
      // toward a barrel/index file. Fall back to any index file, then the
      // alphabetically first file when nothing is imported externally.
      const ranked = [...paths].sort(
        (a, b) =>
          (externalInDegree.get(b) ?? 0) - (externalInDegree.get(a) ?? 0) ||
          Number(isIndex(b)) - Number(isIndex(a)) ||
          a.localeCompare(b),
      );
      let entryPoints = ranked.filter((p) => (externalInDegree.get(p) ?? 0) > 0).slice(0, ENTRY_MAX);
      if (entryPoints.length === 0) {
        const index = paths.find(isIndex);
        entryPoints = index ? [index] : paths.length > 0 ? [[...paths].sort()[0]!] : [];
      }

      const related: RelatedSubsystem[] = [...(edges.get(key) ?? new Map<string, number>())]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, EDGES_MAX)
        .map(([dstKey, count]) => ({
          to: keyToId.get(dstKey)!,
          relation: `imports from (${count} reference${count === 1 ? "" : "s"})`,
        }));

      const label = key === "(root)" ? "(root)" : key;
      // A container-root group (loose files directly under `packages/` etc.)
      // must own those files by their exact paths, not by the `packages/`
      // prefix — otherwise it would double-claim every per-package subsystem.
      const isContainerRoot = !key.includes("/") && containers.has(key);
      const dirs = key === "(root)" ? [] : isContainerRoot ? [...paths] : [key];
      return {
        id: keyToId.get(key)!,
        name: label,
        purpose: `Import-graph grouping: the ${paths.length} file${paths.length === 1 ? "" : "s"} under \`${label}\`, with relationships inferred from imports. Curate .necronomidoc/subsystems.yaml (or run \`necronomidoc enrich --subsystems\`) for real boundaries.`,
        owns: [],
        notOwns: [],
        entryPoints,
        related,
        dirs,
        provenance: "heuristic" as const,
      };
    });
}

// ---- Architecture diagram ----

/** A Mermaid-safe node id derived from a subsystem id. */
function mermaidNodeId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z]/.test(safe) ? safe : `n_${safe}`;
}

/**
 * Strip characters that would break a Mermaid label: `"` (closes a quoted
 * label) and `|` (Mermaid's edge-label delimiter), plus newlines. Node and
 * edge labels are emitted double-quoted, which already tolerates `[]()`.
 */
function mermaidLabel(text: string): string {
  return text.replace(/["|\r\n]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Generate a Mermaid flowchart from the relationship graph so every published
 * map — curated or not — carries an architecture diagram. Only internal edges
 * (`related.to` pointing at a known subsystem) become arrows; external,
 * name-only relationships are left to the prose to avoid inventing nodes.
 */
export function generateSubsystemDiagram(subsystems: Subsystem[]): string {
  if (subsystems.length === 0) return "";
  const ids = new Set(subsystems.map((s) => s.id));
  const lines = ["graph LR"];
  for (const s of subsystems) {
    lines.push(`  ${mermaidNodeId(s.id)}["${mermaidLabel(s.name)}"]`);
  }
  const seen = new Set<string>();
  for (const s of subsystems) {
    for (const r of s.related) {
      if (!r.to || !ids.has(r.to)) continue;
      const key = `${s.id}->${r.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const from = mermaidNodeId(s.id);
      const to = mermaidNodeId(r.to);
      const rel = r.relation ? mermaidLabel(r.relation) : "";
      lines.push(rel ? `  ${from} -->|"${rel}"| ${to}` : `  ${from} --> ${to}`);
    }
  }
  return lines.join("\n");
}

export interface BuildSubsystemsOptions {
  /** Dirs searched for human `subsystems.yaml` (lower precedence first). */
  humanDirs: string[];
  /** Server-side per-repo enrichment dir holding LLM proposals. */
  llmDir?: string;
  now?: () => string;
}

/** Resolve the repo's subsystem map by source precedence and package it. */
export function buildSubsystems(
  model: DocModel,
  options: BuildSubsystemsOptions,
): SubsystemsManifest {
  const human = loadHumanSubsystems(options.humanDirs);
  const llm = options.llmDir ? loadLlmSubsystems(options.llmDir) : { subsystems: [] as Subsystem[] };

  // The MAP is chosen by precedence on subsystem presence (whole-map-wins).
  const mapSource: SubsystemSource =
    human.subsystems.length > 0
      ? human
      : llm.subsystems.length > 0
        ? llm
        : { subsystems: heuristicSubsystems(model) };
  const subsystems = mapSource.subsystems;

  // The overview and a curated diagram are resolved independently, each by its
  // own precedence — so a human narrative is honoured even when it accompanies
  // a map that fell back to the heuristic (e.g. its entries failed validation).
  const overviewFrom: { text: string; prov: Provenance } | undefined =
    human.overview !== undefined
      ? { text: human.overview, prov: "human" }
      : llm.overview !== undefined
        ? { text: llm.overview, prov: "llm" }
        : undefined;
  const diagramOverride: { text: string; prov: Provenance } | undefined =
    human.diagram !== undefined
      ? { text: human.diagram, prov: "human" }
      : llm.diagram !== undefined
        ? { text: llm.diagram, prov: "llm" }
        : undefined;

  // A curated diagram wins; otherwise generate one from the relationship graph.
  // A generated diagram is always `heuristic` — it is machine-drawn regardless
  // of who authored the edges it draws.
  const generated = generateSubsystemDiagram(subsystems);
  const diagram = diagramOverride?.text ?? (generated || undefined);
  const diagramProvenance: Provenance | undefined =
    diagram === undefined ? undefined : (diagramOverride?.prov ?? "heuristic");

  return {
    schemaVersion: SCHEMA_VERSION,
    repo: model.repo.slug,
    subsystems,
    overview: overviewFrom?.text,
    overviewProvenance: overviewFrom?.prov,
    diagram,
    diagramProvenance,
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
  };
}

// ---- LLM subsystem proposals ----

const LlmRelated = z.object({
  to: z.string().optional(),
  name: z.string().optional(),
  relation: z.string(),
});

const LlmSubsystemResponse = z.object({
  overview: z.string().optional(),
  subsystems: z.array(
    z.object({
      name: z.string(),
      purpose: z.string(),
      owns: z.array(z.string()).default([]),
      notOwns: z.array(z.string()).default([]),
      entryPoints: z.array(z.string()).default([]),
      related: z.array(LlmRelated).default([]),
      dirs: z.array(z.string()).default([]),
    }),
  ),
});

const SUBSYSTEM_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    overview: { type: "string" },
    subsystems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          purpose: { type: "string" },
          owns: { type: "array", items: { type: "string" } },
          notOwns: { type: "array", items: { type: "string" } },
          entryPoints: { type: "array", items: { type: "string" } },
          related: {
            type: "array",
            items: {
              type: "object",
              properties: {
                to: { type: "string" },
                name: { type: "string" },
                relation: { type: "string" },
              },
              // Every relationship must name a target — `to` (a subsystem) or
              // `name` (something external); a bare `relation` points nowhere.
              required: ["relation"],
              anyOf: [{ required: ["to"] }, { required: ["name"] }],
              additionalProperties: false,
            },
          },
          dirs: { type: "array", items: { type: "string" } },
        },
        required: ["name", "purpose", "dirs"],
        additionalProperties: false,
      },
    },
  },
  required: ["subsystems"],
  additionalProperties: false,
};

/**
 * The full subsystem-proposal completion request — shared by the live proposer
 * below and the agent task export, so both send identical prompts. Feeds the
 * model each file's purpose summary, its internal imports and its exported
 * symbols, so the map is grounded in how the code actually depends on itself.
 */
export function subsystemsRequestFor(model: DocModel): LlmCompleteRequest {
  const fileLines = model.files.map((f) => {
    const summary = f.enrichment?.summary ?? f.moduleDoc?.summary ?? "";
    const imports = f.imports
      .map((i) => i.moduleSpecifier)
      .filter((m) => m.startsWith("."))
      .join(", ");
    const exportsList = f.symbols
      .filter((s) => s.exported)
      .slice(0, 8)
      .map((s) => `${s.name}(${s.kind})`)
      .join(", ");
    return [
      `- ${f.path}`,
      summary ? ` — ${summary}` : "",
      exportsList ? ` [exports: ${exportsList}]` : "",
      imports ? ` [imports: ${imports}]` : "",
    ].join("");
  });
  const prompt = [
    `Repository: ${model.repo.name}`,
    "",
    "Propose a subsystem map for this repository: 2-10 named subsystems that",
    "partition the files below. For each, give a purpose statement, boundary",
    "statements (owns / notOwns — what belongs there and what must not go",
    "there), key entry points (file paths), the directory prefixes (dirs) that",
    "belong to it, and relationships to OTHER subsystems in your map. Express a",
    "relationship as { to: <the exact `name` of the related subsystem>,",
    'relation: "<how they interact>" }; use a free-text `name` instead of `to`',
    "only for relationships to something outside this repo.",
    "",
    "Also write a short `overview` (3-5 sentences) explaining how the subsystems",
    "fit together into the larger architecture.",
    "",
    "Base everything on the actual files, their exported symbols and their",
    "imports; do not invent. Group by how the code depends on itself, not just",
    "by directory.",
    "",
    "Files:",
    ...fileLines.slice(0, 400),
    fileLines.length > 400 ? `… (${fileLines.length - 400} more files)` : "",
  ].join("\n");

  return {
    system:
      "You are a software architect mapping a codebase into subsystems for a documentation site. Respond with JSON only, matching the requested schema.",
    prompt,
    maxOutputTokens: 4000,
    jsonSchema: SUBSYSTEM_JSON_SCHEMA,
  };
}

/**
 * Parse one subsystem-proposal response into `provenance: llm` subsystems with
 * unique slug ids, plus the repo-level `overview`. Relationship targets the
 * model expressed by subsystem name are resolved to the generated ids so the
 * links and diagram edges are internal. Shared by the live proposer and the
 * agent results import. Throws on malformed JSON.
 */
export function subsystemsFromResponse(text: string): SubsystemSource {
  const parsed = LlmSubsystemResponse.parse(JSON.parse(text));
  const seen = new Set<string>();
  const withIds = parsed.subsystems.map((s) => {
    let id = slugify(s.name);
    while (seen.has(id)) id = `${id}-2`;
    seen.add(id);
    return { ...s, id };
  });

  // Resolve `to`/`name` references (which the model expresses by subsystem
  // name) to ids so relationships stay internal and bidirectional. Match on
  // exact id, exact name, then a slugified form — this absorbs the common
  // near-misses (case, punctuation, spacing) so a real internal edge is not
  // demoted to an unlinked label.
  const byId = new Set(withIds.map((s) => s.id));
  const byName = new Map(withIds.map((s) => [s.name.toLowerCase(), s.id]));
  const bySlug = new Map(withIds.map((s) => [slugify(s.name), s.id]));
  const resolveRef = (ref: string | undefined): string | undefined => {
    if (!ref) return undefined;
    if (byId.has(ref)) return ref;
    return byName.get(ref.toLowerCase()) ?? bySlug.get(slugify(ref));
  };
  const subsystems: Subsystem[] = withIds.map((s) => ({
    ...s,
    related: s.related.flatMap((r): RelatedSubsystem[] => {
      const resolvedId = resolveRef(r.to) ?? resolveRef(r.name);
      if (resolvedId) return [{ to: resolvedId, relation: r.relation }];
      const name = r.name ?? r.to;
      // A relationship that names nothing points nowhere — drop it rather than
      // render a meaningless "→ external" edge.
      return name ? [{ name, relation: r.relation }] : [];
    }),
    provenance: "llm" as const,
  }));

  return { subsystems, overview: parsed.overview };
}

export async function proposeSubsystems(
  model: DocModel,
  client: LlmClient,
): Promise<SubsystemSource & { inputTokens: number; outputTokens: number }> {
  const result = await client.complete(subsystemsRequestFor(model));
  const source = subsystemsFromResponse(result.text);
  return {
    ...source,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}
