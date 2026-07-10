import { describe, expect, it } from "vitest";
import { DocFile } from "@necronomidoc/docmodel";
import { extractMarkdownFile } from "./markdownAdapter.js";

const SAMPLE = `# My Project

The **best** project. See [docs](./docs/guide.md).

## Getting Started

Install it first.

\`\`\`bash
# this heading-looking comment must be ignored
npm install
\`\`\`

## Getting Started

Second section with a duplicate title.

#### Too deep

Not a section.
`;

describe("extractMarkdownFile", () => {
  const file = extractMarkdownFile("repo", "README.md", SAMPLE);

  it("emits a schema-valid markdown DocFile with title and intro", () => {
    expect(() => DocFile.parse(file)).not.toThrow();
    expect(file.format).toBe("markdown");
    expect(file.title).toBe("My Project");
    expect(file.moduleDoc?.summary).toBe("The best project. See docs.");
    expect(file.content).toContain("npm install");
  });

  it("turns h2/h3 headings into section symbols, skipping fenced code", () => {
    expect(file.symbols.map((s) => s.kind)).toEqual(["section", "section"]);
    expect(file.symbols[0]!.name).toBe("Getting Started");
    expect(file.symbols[0]!.doc?.summary).toBe("Install it first.");
    expect(file.symbols[0]!.location.line).toBe(5);
  });

  it("disambiguates duplicate heading anchors in symbol ids", () => {
    expect(file.symbols[0]!.id).toBe("repo:README.md#getting-started");
    expect(file.symbols[1]!.id).toBe("repo:README.md#getting-started~1");
  });

  it("falls back to the filename when there is no h1", () => {
    const bare = extractMarkdownFile("repo", "docs/notes.md", "just some text\n");
    expect(bare.title).toBe("notes");
    expect(bare.moduleDoc?.summary).toBe("just some text");
  });
});
