import { parse as parseYaml } from "yaml";
import type { AcceptanceCriterion, EarsPattern, EarsRequirement } from "@necronomidoc/docmodel";

/**
 * Text-level parsing for product docs (decision 0023): YAML frontmatter,
 * Gherkin acceptance scenarios, and EARS requirement statements. Pure string
 * functions — no filesystem, no doc model — so the CLI linter, the build, and
 * the LLM renderer all share one definition of the format.
 */

export interface SplitFrontmatter {
  /** Parsed YAML, or undefined when the file has no frontmatter block. */
  data?: unknown;
  /** Markdown after the closing fence (the whole text when there is none). */
  body: string;
  /** 1-based line the body starts on (for line-accurate findings). */
  bodyLine: number;
  /** YAML parse error message, when the block exists but is invalid. */
  error?: string;
}

/**
 * Split `---\nyaml\n---\nbody`. The closing fence may also be `...` (YAML's
 * document-end marker). A file not starting with `---` has no frontmatter.
 */
export function splitFrontmatter(raw: string): SplitFrontmatter {
  const text = raw.replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { body: text, bodyLine: 1 };
  const end = lines.findIndex((l, i) => i > 0 && (l.trim() === "---" || l.trim() === "..."));
  if (end === -1) return { body: text, bodyLine: 1, error: "frontmatter has no closing `---`" };
  const yamlText = lines.slice(1, end).join("\n");
  const body = lines.slice(end + 1).join("\n");
  try {
    return { data: parseYaml(yamlText) ?? {}, body, bodyLine: end + 2 };
  } catch (err) {
    return { body, bodyLine: end + 2, error: (err as Error).message.split("\n")[0] };
  }
}

/** Fenced-code languages treated as Gherkin. */
const GHERKIN_LANGS = new Set(["gherkin", "feature", "cucumber"]);

interface FencedBlock {
  lang: string;
  text: string;
}

function fencedBlocks(markdown: string): FencedBlock[] {
  const out: FencedBlock[] = [];
  const lines = markdown.split(/\r?\n/);
  let open: { fence: string; lang: string; lines: string[] } | undefined;
  for (const line of lines) {
    const m = /^\s*(`{3,}|~{3,})\s*([\w-]*)/.exec(line);
    if (!open && m) {
      open = { fence: m[1]!, lang: m[2]!.toLowerCase(), lines: [] };
      continue;
    }
    if (open) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1]![0] === open.fence[0] && close[1]!.length >= open.fence.length) {
        out.push({ lang: open.lang, text: open.lines.join("\n") });
        open = undefined;
      } else {
        open.lines.push(line);
      }
    }
  }
  return out;
}

export interface GherkinParse {
  criteria: AcceptanceCriterion[];
  /** Scenario titles that carried no `@AC-n` tag (assigned an id anyway). */
  untagged: string[];
  /** Criterion ids whose scenario has no `Then` step. */
  missingThen: string[];
  /** Ids used by more than one scenario. */
  duplicates: string[];
}

const SCENARIO_RE = /^\s*(Scenario Outline|Scenario Template|Scenario|Example):\s*(.*)$/i;
const BOUNDARY_RE = /^\s*(Feature|Rule|Background|Scenario Outline|Scenario Template|Scenario|Example):/i;

/**
 * Pull acceptance criteria out of ```gherkin blocks. Each scenario is one
 * criterion; its id comes from an `@AC-n` tag on the line(s) above the
 * `Scenario:` keyword. Untagged scenarios get the next free `AC-n` so they
 * still trace, and are reported so authors can pin the id.
 */
export function parseGherkin(markdown: string): GherkinParse {
  const result: GherkinParse = { criteria: [], untagged: [], missingThen: [], duplicates: [] };
  const drafts: { id?: string; title: string; text: string[]; outline: boolean; tags: string[] }[] = [];
  for (const block of fencedBlocks(markdown)) {
    if (!GHERKIN_LANGS.has(block.lang)) continue;
    let pendingTags: string[] = [];
    let current: (typeof drafts)[number] | undefined;
    for (const line of block.text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("@")) {
        // Tags belong to the NEXT scenario, not the one being collected.
        pendingTags.push(...trimmed.split(/\s+/).filter((t) => t.startsWith("@")));
        continue;
      }
      const scenario = SCENARIO_RE.exec(line);
      if (scenario) {
        const idTag = pendingTags.find((t) => /^@AC-\d+$/i.test(t));
        current = {
          id: idTag ? idTag.slice(1).toUpperCase() : undefined,
          title: scenario[2]!.trim(),
          text: [...(pendingTags.length ? [pendingTags.join(" ")] : []), trimmed],
          outline: /outline|template/i.test(scenario[1]!),
          tags: pendingTags.filter((t) => t !== idTag),
        };
        drafts.push(current);
        pendingTags = [];
        continue;
      }
      if (BOUNDARY_RE.test(line)) {
        current = undefined;
        pendingTags = [];
        continue;
      }
      if (current && trimmed !== "") current.text.push(`  ${trimmed}`);
    }
  }

  const used = new Set(drafts.filter((d) => d.id).map((d) => d.id!));
  const seen = new Set<string>();
  let next = 1;
  for (const draft of drafts) {
    let id = draft.id;
    if (!id) {
      while (used.has(`AC-${next}`)) next++;
      id = `AC-${next}`;
      used.add(id);
      result.untagged.push(draft.title);
    }
    if (seen.has(id)) result.duplicates.push(id);
    seen.add(id);
    if (!draft.text.some((l) => /^\s*Then\b/i.test(l))) result.missingThen.push(id);
    result.criteria.push({
      id,
      title: draft.title,
      text: draft.text.join("\n"),
      outline: draft.outline,
      tags: draft.tags,
    });
  }
  return result;
}

/**
 * EARS requirement lines: a list item whose first token is a `REQ-n` id,
 * optionally bolded or followed by a colon — `- **REQ-1** WHEN … THE SYSTEM SHALL …`.
 * Lines inside fenced code are ignored.
 */
const EARS_LINE = /^\s*[-*+]\s+(?:\*\*|__)?(REQ-\d+)(?:\*\*|__)?\s*[:.—–-]?\s*(.+)$/i;

export function classifyEars(text: string): EarsPattern {
  const t = text.trim().toUpperCase();
  if (!/\bSHALL\b/.test(t)) return "unrecognized";
  const keys = ["WHILE", "WHEN", "WHERE", "IF"].filter((k) => new RegExp(`(^|[,;]\\s*)${k}\\b`).test(t));
  if (keys.length > 1) return "complex";
  if (keys.length === 0) return "ubiquitous";
  if (keys[0] === "IF") return /\bTHEN\b/.test(t) ? "unwanted-behaviour" : "unrecognized";
  return ({ WHILE: "state-driven", WHEN: "event-driven", WHERE: "optional-feature" } as const)[
    keys[0] as "WHILE" | "WHEN" | "WHERE"
  ];
}

export function parseEars(markdown: string): { requirements: EarsRequirement[]; duplicates: string[] } {
  const requirements: EarsRequirement[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();
  let fence: string | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1]![0];
      else if (f[1]![0] === fence) fence = undefined;
      continue;
    }
    if (fence) continue;
    const m = EARS_LINE.exec(line);
    if (!m) continue;
    const id = m[1]!.toUpperCase();
    if (seen.has(id)) duplicates.push(id);
    seen.add(id);
    const text = m[2]!.trim();
    requirements.push({ id, text, pattern: classifyEars(text) });
  }
  return { requirements, duplicates };
}

/** First `# heading` of a markdown body, ignoring fenced code. */
export function firstHeading(markdown: string): string | undefined {
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, "");
  return withoutFences.match(/^#\s+(.+?)\s*$/m)?.[1];
}
