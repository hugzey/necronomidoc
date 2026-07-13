import JSZip from "jszip";

/**
 * Minimal docx template support (slice 8, decision 0018): a .docx file is a
 * zip whose main document lives at `word/document.xml`. We read/replace text
 * at the paragraph level — enough to extract a template's text for
 * placeholder scanning and to splice fills back in while preserving all
 * styling, headers, images, and everything else in the package. No general
 * docx generation: sections-mode outputs for docx templates fall back to
 * markdown (documented limitation).
 */

const DOCUMENT_XML = "word/document.xml";

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

function encodeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const PARAGRAPH_RE = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
const TEXT_RUN_RE = /<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g;

/** Concatenated text of one paragraph's `<w:t>` runs, entities decoded. */
function paragraphText(paragraphXml: string): string {
  let text = "";
  TEXT_RUN_RE.lastIndex = 0;
  for (const match of paragraphXml.matchAll(TEXT_RUN_RE)) text += decodeXml(match[2]!);
  return text;
}

async function documentXmlOf(docx: Uint8Array): Promise<{ zip: JSZip; xml: string }> {
  const zip = await JSZip.loadAsync(docx);
  const entry = zip.file(DOCUMENT_XML);
  if (!entry) throw new Error(`Not a .docx file: missing ${DOCUMENT_XML}`);
  return { zip, xml: await entry.async("string") };
}

/**
 * The template's readable text: one line per paragraph. This is what the
 * placeholder scanner and the LLM prompts see for docx templates.
 */
export async function extractDocxText(docx: Uint8Array): Promise<string> {
  const { xml } = await documentXmlOf(docx);
  const paragraphs = xml.match(PARAGRAPH_RE) ?? [];
  return paragraphs.map(paragraphText).join("\n");
}

/**
 * Rewrite one paragraph so its combined run text becomes `newText`: the
 * first `<w:t>` carries the whole replacement (line breaks become `<w:br/>`
 * so multi-line fills render), later runs are emptied. The first run's
 * formatting applies to the fill — a deliberate, documented simplification.
 */
function replaceParagraphText(paragraphXml: string, newText: string): string {
  const encodedLines = newText.split("\n").map(encodeXml);
  const first = `<w:t xml:space="preserve">${encodedLines.join('</w:t><w:br/><w:t xml:space="preserve">')}</w:t>`;
  let used = false;
  TEXT_RUN_RE.lastIndex = 0;
  return paragraphXml.replace(TEXT_RUN_RE, () => {
    if (used) return '<w:t xml:space="preserve"></w:t>';
    used = true;
    return first;
  });
}

/**
 * Replace placeholder marker strings inside a docx, preserving everything
 * else in the package byte-for-byte. Markers split across paragraphs are not
 * found (a marker must live inside one paragraph); markers split across
 * *runs* within a paragraph are handled, because matching happens on the
 * paragraph's combined text.
 */
export async function fillDocxPlaceholders(
  docx: Uint8Array,
  replacements: Map<string, string>,
): Promise<Uint8Array> {
  const { zip, xml } = await documentXmlOf(docx);
  const markers = [...replacements.keys()];
  const newXml = xml.replace(PARAGRAPH_RE, (paragraphXml) => {
    const original = paragraphText(paragraphXml);
    // Most paragraphs carry no marker — skip the replacement loop for them.
    if (!markers.some((marker) => original.includes(marker))) return paragraphXml;
    let replaced = original;
    for (const [marker, content] of replacements) {
      replaced = replaced.split(marker).join(content);
    }
    return replaceParagraphText(paragraphXml, replaced);
  });
  zip.file(DOCUMENT_XML, newXml);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
