import type { DocComment } from "@necronomidoc/docmodel";

/** Strip the `/** *\/` wrapper and per-line `*` gutter from a raw JSDoc block. */
function stripCommentMarkers(raw: string): string {
  return raw
    .replace(/^\s*\/\*\*?/, "")
    .replace(/\*\/\s*$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*?\s?/, ""))
    .join("\n")
    .trim();
}

/**
 * Parse a raw JSDoc/TSDoc comment into structured parts. Everything is kept
 * "as written" — no summarizing (decision 0006, facts only).
 */
export function parseJsDoc(raw: string | undefined): DocComment | undefined {
  if (!raw || !raw.trim()) return undefined;
  const body = stripCommentMarkers(raw);
  if (!body) return undefined;

  const summaryLines: string[] = [];
  const params: { name: string; type?: string; text?: string }[] = [];
  const examples: string[] = [];
  const tags: { tag: string; text: string }[] = [];
  let remarks: string | undefined;
  let returns: string | undefined;
  let deprecated: string | undefined;

  // Split into blocks that each start with an @tag (or the leading description).
  const tokens = body.split(/\n(?=@\w)/);
  for (const token of tokens) {
    const tagMatch = token.match(/^@(\w+)\s*([\s\S]*)$/);
    if (!tagMatch) {
      summaryLines.push(token);
      continue;
    }
    const tag = tagMatch[1]!;
    const rest = (tagMatch[2] ?? "").trim();
    switch (tag) {
      case "param":
      case "arg":
      case "argument": {
        // @param {type} name description  |  @param name description
        const m = rest.match(/^(?:\{([^}]*)\}\s*)?(\[?[\w.$]+\]?)\s*-?\s*([\s\S]*)$/);
        if (m) {
          params.push({
            name: m[2]!.replace(/[[\]]/g, ""),
            type: m[1]?.trim() || undefined,
            text: m[3]?.trim() || undefined,
          });
        }
        break;
      }
      case "returns":
      case "return":
        returns = rest || undefined;
        break;
      case "remarks":
        remarks = rest || undefined;
        break;
      case "example":
        examples.push(rest);
        break;
      case "deprecated":
        deprecated = rest || "";
        break;
      case "file":
      case "fileoverview":
      case "module":
      case "packageDocumentation":
        // File-level description tags contribute to the summary.
        if (rest) summaryLines.push(rest);
        break;
      default:
        tags.push({ tag, text: rest });
    }
  }

  const summary = summaryLines.join("\n").trim() || undefined;
  const hasContent =
    summary || remarks || returns || deprecated || params.length || examples.length || tags.length;
  if (!hasContent) return undefined;

  return {
    summary,
    remarks,
    params,
    returns,
    examples,
    deprecated,
    tags,
  };
}
