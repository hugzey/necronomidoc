import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractDocxText, fillDocxPlaceholders } from "./docx.js";

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

function docxWith(bodyXml: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

function p(...runs: string[]): string {
  return `<w:p>${runs.map((t) => `<w:r><w:t>${t}</w:t></w:r>`).join("")}</w:p>`;
}

async function documentXml(docx: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(docx);
  return zip.file("word/document.xml")!.async("string");
}

describe("extractDocxText", () => {
  it("joins paragraph run text with entities decoded", async () => {
    const docx = await docxWith(
      p("Hello ", "world.") + p("&lt;Fill this section in&gt; &amp; more"),
    );
    expect(await extractDocxText(docx)).toBe("Hello world.\n<Fill this section in> & more");
  });

  it("rejects a zip that is not a docx", async () => {
    const zip = new JSZip();
    zip.file("readme.txt", "nope");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(extractDocxText(bytes)).rejects.toThrow(/word\/document\.xml/);
  });
});

describe("fillDocxPlaceholders", () => {
  it("replaces a marker split across runs, preserving other paragraphs", async () => {
    const docx = await docxWith(
      p("Report for {{the ", "project", " name}}") + p("Untouched paragraph."),
    );
    const filled = await fillDocxPlaceholders(
      docx,
      new Map([["{{the project name}}", "necronomidoc"]]),
    );
    const xml = await documentXml(filled);
    expect(xml).toContain("Report for necronomidoc");
    expect(xml).not.toContain("{{");
    // The untouched paragraph keeps its original runs.
    expect(xml).toContain("<w:t>Untouched paragraph.</w:t>");
    expect(await extractDocxText(filled)).toContain("Report for necronomidoc");
  });

  it("encodes XML-sensitive fill content and renders newlines as breaks", async () => {
    const docx = await docxWith(p("{{x}}"));
    const filled = await fillDocxPlaceholders(docx, new Map([["{{x}}", "a < b & c\nline two"]]));
    const xml = await documentXml(filled);
    expect(xml).toContain("a &lt; b &amp; c");
    expect(xml).toContain("<w:br/>");
    expect(await extractDocxText(filled)).toBe("a < b & cline two");
  });

  it("replaces diamond markers that appear entity-encoded in the XML", async () => {
    const docx = await docxWith(p("&lt;Describe the architecture&gt;"));
    const filled = await fillDocxPlaceholders(
      docx,
      new Map([["<Describe the architecture>", "It is modular."]]),
    );
    expect(await extractDocxText(filled)).toBe("It is modular.");
  });
});
