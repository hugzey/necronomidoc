import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  SCHEMA_VERSION,
  Subsystem,
  slugify,
  type DocModel,
  type SubsystemsManifest,
} from "@necronomidoc/docmodel";
import type { LlmClient } from "./llm/client.js";

/**
 * Subsystem overviews (slice 3 §3). A subsystem is a named group of files with
 * a purpose statement, boundaries ("owns X, does not do Y"), entry points and
 * relationships. Sources, same precedence as all enrichment: human
 * `subsystems.yaml` > LLM-proposed > heuristic (top-level directories). The
 * highest-precedence source present defines the complete map — curated maps
 * replace the heuristic floor rather than merging with it.
 */

/** Candidate file names checked in each source directory. */
const HUMAN_FILES = ["subsystems.yaml", "subsystems.yml", "subsystems.json"];
export const LLM_SUBSYSTEMS_FILE = "subsystems.llm.json";

function parseSubsystemEntries(raw: string, isJson: boolean, source: string): Subsystem[] {
  const data: unknown = isJson ? JSON.parse(raw) : parseYaml(raw);
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

/**
 * Load human-curated subsystems from a list of directories (`subsystems.yaml`
 * next to the code or in the server's per-repo enrichment dir; later dirs
 * win). Provenance is forced to `human` — that's what these files mean.
 */
export function loadHumanSubsystems(dirs: string[]): Subsystem[] {
  let found: Subsystem[] = [];
  for (const dir of dirs) {
    for (const name of HUMAN_FILES) {
      const path = join(dir, name);
      if (!existsSync(path)) continue;
      const entries = parseSubsystemEntries(
        readFileSync(path, "utf8"),
        name.endsWith(".json"),
        path,
      );
      if (entries.length > 0) found = entries.map((s) => ({ ...s, provenance: "human" as const }));
    }
  }
  return found;
}

/** Load LLM-proposed subsystems written by a previous `enrich --subsystems`. */
export function loadLlmSubsystems(dir: string): Subsystem[] {
  const path = join(dir, LLM_SUBSYSTEMS_FILE);
  if (!existsSync(path)) return [];
  return parseSubsystemEntries(readFileSync(path, "utf8"), true, path).map((s) => ({
    ...s,
    provenance: "llm" as const,
  }));
}

/** The always-present floor: one subsystem per top-level directory. */
export function heuristicSubsystems(model: DocModel): Subsystem[] {
  const byDir = new Map<string, { count: number; entry?: string }>();
  for (const file of model.files) {
    const top = file.path.includes("/") ? file.path.split("/")[0]! : "(root)";
    const group = byDir.get(top) ?? { count: 0 };
    group.count++;
    // Barrel/index files are the best entry-point guess a heuristic can make.
    if (group.entry === undefined || /(^|\/)index\.[a-z]+$/.test(file.path)) {
      group.entry = file.path;
    }
    byDir.set(top, group);
  }
  return [...byDir.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dir, info]) => ({
      id: slugify(dir === "(root)" ? "root" : dir),
      name: dir,
      purpose: `Heuristic grouping: the ${info.count} file${info.count === 1 ? "" : "s"} under \`${dir}\`. Curate .necronomidoc/subsystems.yaml (or run \`necronomidoc enrich --subsystems\`) for real boundaries.`,
      owns: [],
      notOwns: [],
      entryPoints: info.entry ? [info.entry] : [],
      related: [],
      dirs: dir === "(root)" ? [] : [dir],
      provenance: "heuristic" as const,
    }));
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
  const llm = options.llmDir ? loadLlmSubsystems(options.llmDir) : [];
  const subsystems =
    human.length > 0 ? human : llm.length > 0 ? llm : heuristicSubsystems(model);
  return {
    schemaVersion: SCHEMA_VERSION,
    repo: model.repo.slug,
    subsystems,
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
  };
}

// ---- LLM subsystem proposals ----

const LlmSubsystemResponse = z.object({
  subsystems: z.array(
    z.object({
      name: z.string(),
      purpose: z.string(),
      owns: z.array(z.string()).default([]),
      notOwns: z.array(z.string()).default([]),
      entryPoints: z.array(z.string()).default([]),
      related: z.array(z.object({ name: z.string(), relation: z.string() })).default([]),
      dirs: z.array(z.string()).default([]),
    }),
  ),
});

const SUBSYSTEM_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
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
              properties: { name: { type: "string" }, relation: { type: "string" } },
              required: ["name", "relation"],
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
 * Ask the LLM to propose a subsystem map from the directory structure and
 * import graph. Proposals carry `provenance: llm` and are reviewed before
 * promotion to a human overlay (slice-3 risk mitigation) — they participate
 * in the map only until a human `subsystems.yaml` exists.
 */
export async function proposeSubsystems(
  model: DocModel,
  client: LlmClient,
): Promise<{ subsystems: Subsystem[]; inputTokens: number; outputTokens: number }> {
  const fileLines = model.files.map((f) => {
    const summary = f.enrichment?.summary ?? "";
    const imports = f.imports
      .map((i) => i.moduleSpecifier)
      .filter((m) => m.startsWith("."))
      .join(", ");
    return `- ${f.path}${summary ? ` — ${summary}` : ""}${imports ? ` [imports: ${imports}]` : ""}`;
  });
  const prompt = [
    `Repository: ${model.repo.name}`,
    "",
    "Propose a subsystem map for this repository: 2-10 named subsystems that",
    "partition the files below. For each, give a purpose statement, boundary",
    "statements (owns / notOwns — what belongs there and what must not go",
    "there), key entry points (file paths), relationships to other proposed",
    "subsystems, and the directory prefixes (dirs) that belong to it.",
    "Base everything on the actual files and their imports; do not invent.",
    "",
    "Files:",
    ...fileLines.slice(0, 400),
    fileLines.length > 400 ? `… (${fileLines.length - 400} more files)` : "",
  ].join("\n");

  const result = await client.complete({
    system:
      "You are a software architect mapping a codebase into subsystems for a documentation site. Respond with JSON only, matching the requested schema.",
    prompt,
    maxOutputTokens: 4000,
    jsonSchema: SUBSYSTEM_JSON_SCHEMA,
  });
  const parsed = LlmSubsystemResponse.parse(JSON.parse(result.text));
  const seen = new Set<string>();
  const subsystems = parsed.subsystems.map((s) => {
    let id = slugify(s.name);
    while (seen.has(id)) id = `${id}-2`;
    seen.add(id);
    return { ...s, id, provenance: "llm" as const };
  });
  return { subsystems, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}
