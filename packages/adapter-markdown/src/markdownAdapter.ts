import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  SCHEMA_VERSION,
  hashContent,
  makeFileId,
  makeSymbolId,
  slugify,
  slugifyAnchor,
  type AdapterConfig,
  type AdapterMatch,
  type DocAdapter,
  type DocFile,
  type DocModel,
  type DocSymbolShape,
} from "@necronomidoc/docmodel";

const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdx"];
const IGNORED_DIRS = new Set(["node_modules", "dist", "build", ".git", "vendor", "coverage"]);
/** Documents larger than this are truncated in the IR (keeps manifests sane). */
const MAX_CONTENT = 200_000;
const SUMMARY_MAX = 240;

interface Heading {
  level: number;
  text: string;
  line: number;
}

/** Strip inline markdown formatting for plain-text names/summaries. */
function stripInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim();
}

/** Parse headings (outside code fences), 1-based line numbers. */
function parseHeadings(lines: string[]): Heading[] {
  const headings: Heading[] = [];
  let fence: string | undefined;
  lines.forEach((line, i) => {
    const fenceMatch = /^(```+|~~~+)/.exec(line.trim());
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1]![0];
      else if (fenceMatch[1]![0] === fence) fence = undefined;
      return;
    }
    if (fence) return;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) headings.push({ level: m[1]!.length, text: stripInline(m[2]!), line: i + 1 });
  });
  return headings;
}

/** First paragraph of prose in a line range (skips headings, fences, tables). */
function firstParagraph(lines: string[], from: number, to: number): string | undefined {
  const collected: string[] = [];
  let fence = false;
  for (let i = from; i < to; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const isProse =
      trimmed !== "" && !/^#{1,6}\s/.test(trimmed) && !/^[|>-]/.test(trimmed) && !/^!\[/.test(trimmed);
    if (isProse) collected.push(trimmed);
    else if (collected.length > 0) break;
  }
  if (collected.length === 0) return undefined;
  const text = stripInline(collected.join(" "));
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text;
}

function sweep(dir: string, rel = "", out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".necronomidoc") continue;
    const abs = join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) sweep(abs, relPath, out);
    } else if (MARKDOWN_EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
      out.push(relPath);
    }
  }
  return out;
}

/** Extract one markdown file into a DocFile (headings h1–h3 become sections). */
export function extractMarkdownFile(repoSlug: string, relPath: string, raw: string): DocFile {
  const truncated = raw.length > MAX_CONTENT;
  const content = truncated ? `${raw.slice(0, MAX_CONTENT)}\n\n…(truncated)` : raw;
  const lines = raw.split("\n");
  const headings = parseHeadings(lines);

  const h1 = headings.find((h) => h.level === 1);
  const title = h1?.text ?? relPath.split("/").pop()!.replace(/\.(md|markdown|mdx)$/i, "");
  const intro = firstParagraph(lines, h1 ? h1.line : 0, headings.find((h) => h !== h1)?.line ?? lines.length);

  const sections = headings.filter((h) => h.level <= 3 && h !== h1);
  const anchorCounts = new Map<string, number>();
  const symbols: DocSymbolShape[] = sections.map((h, i) => {
    const anchor = slugifyAnchor(h.text) || "section";
    const seen = anchorCounts.get(anchor) ?? 0;
    anchorCounts.set(anchor, seen + 1);
    const end = sections[i + 1]?.line ? sections[i + 1]!.line - 1 : lines.length;
    const summary = firstParagraph(lines, h.line, end);
    return {
      id: makeSymbolId(repoSlug, relPath, anchor, seen > 0 ? seen : undefined),
      name: h.text,
      kind: "section",
      exported: false,
      location: { path: relPath, line: h.line, endLine: end },
      doc: summary ? { summary, params: [], examples: [], tags: [] } : undefined,
      contentHash: hashContent(lines.slice(h.line - 1, end).join("\n")),
    };
  });

  return {
    id: makeFileId(repoSlug, relPath),
    path: relPath,
    contentHash: hashContent(raw),
    format: "markdown",
    title,
    content,
    moduleDoc: intro ? { summary: intro, params: [], examples: [], tags: [] } : undefined,
    imports: [],
    exports: [],
    symbols,
  };
}

/**
 * Adapter that surfaces a repo's prose docs — READMEs, docs/ folders, any
 * markdown — as file-rooted entries in the same IR code flows through, so the
 * site, search, and MCP treat them like any other documented file.
 */
export class MarkdownAdapter implements DocAdapter {
  readonly language = "markdown";

  async detect(repoDir: string): Promise<AdapterMatch | null> {
    const found = sweep(repoDir);
    if (found.length === 0) return null;
    return {
      language: this.language,
      reason: `found ${found.length} markdown file(s)`,
      globs: MARKDOWN_EXTENSIONS.map((ext) => `**/*${ext}`),
    };
  }

  async extract(repoDir: string, config: AdapterConfig): Promise<DocModel> {
    const repoName = config.repoName ?? slugify(repoDir);
    const repoSlug = slugify(repoName);
    const files: DocFile[] = [];
    for (const relPath of sweep(repoDir).sort()) {
      const stat = statSync(join(repoDir, relPath));
      if (stat.size > 5_000_000) continue;
      const raw = readFileSync(join(repoDir, relPath), "utf8");
      files.push(extractMarkdownFile(repoSlug, relPath, raw));
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      repo: { name: repoName, slug: repoSlug, url: config.repoUrl, ref: config.ref, commit: config.commit },
      files,
      generatedAt: new Date().toISOString(),
    };
  }
}
