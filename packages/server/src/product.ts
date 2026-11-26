import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  PRODUCT_DOCS_DIR,
  PRODUCT_DOC_TYPES,
  PRODUCT_TYPE_DIRS,
  ProductDocType,
  ProductManifest,
  productFrontmatterJsonSchema,
  type DocModel,
  slugify,
} from "@necronomidoc/docmodel";
import {
  PRODUCT_GLOSSARY_TEMPLATE,
  PRODUCT_README_TEMPLATE,
  PRODUCT_TEMPLATES,
  buildProduct,
  fillTemplate,
  loadLlmProductSet,
  nextProductId,
  productDocPath,
  scanTestRefs,
  splitFrontmatter,
} from "@necronomidoc/enrichment";
import { paths } from "@necronomidoc/mcp";
import { combineModels, listAdapters } from "./build.js";

/**
 * Repo-side tooling for the product-doc standard (decision 0023), behind the
 * `necronomidoc product` CLI: scaffold `docs/product/`, create a document
 * with the next free id, lint a working tree (CI-friendly exit codes), and
 * export LLM drafts as files for review and promotion.
 */

export interface ProductScaffoldResult {
  dir: string;
  written: string[];
  skipped: string[];
}

/**
 * Scaffold `docs/product/`: README (the product narrative), glossary, one
 * template per type under `_templates/` (never published), the type folders,
 * and `schema.json` (frontmatter JSON Schema — always refreshed, since it is
 * generated and must match this necronomidoc version).
 */
export function initProductDocs(repoDir: string, options: { force?: boolean } = {}): ProductScaffoldResult {
  const root = resolve(repoDir);
  if (!existsSync(root)) throw new Error(`No such directory: ${root}`);
  const dir = join(root, PRODUCT_DOCS_DIR);
  const result: ProductScaffoldResult = { dir, written: [], skipped: [] };
  const write = (rel: string, content: string, always = false): void => {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && !options.force && !always) {
      result.skipped.push(rel);
      return;
    }
    writeFileSync(path, content);
    result.written.push(rel);
  };
  write("README.md", PRODUCT_README_TEMPLATE);
  write("glossary.md", PRODUCT_GLOSSARY_TEMPLATE);
  for (const type of PRODUCT_DOC_TYPES) {
    write(`_templates/${type}.md`, PRODUCT_TEMPLATES[type]);
    mkdirSync(join(dir, PRODUCT_TYPE_DIRS[type]), { recursive: true });
  }
  write("schema.json", JSON.stringify(productFrontmatterJsonSchema(), null, 2) + "\n", true);
  return result;
}

/** Ids already used by files of one type (frontmatter `id`, else filename prefix). */
function existingIds(repoDir: string, type: ProductDocType): string[] {
  const dir = join(resolve(repoDir), PRODUCT_DOCS_DIR, PRODUCT_TYPE_DIRS[type]);
  if (!existsSync(dir)) return [];
  const ids: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!/\.(md|markdown)$/i.test(name)) continue;
    const split = splitFrontmatter(readFileSync(join(dir, name), "utf8"));
    const id = (split.data as { id?: unknown } | undefined)?.id;
    ids.push(typeof id === "string" ? id : name);
  }
  return ids;
}

/** Create a new document from its template with the next free id. */
export function newProductDoc(
  repoDir: string,
  type: string,
  title: string,
): { id: string; path: string } {
  const parsedType = ProductDocType.safeParse(type);
  if (!parsedType.success) {
    throw new Error(`Unknown product doc type "${type}" — one of: ${PRODUCT_DOC_TYPES.join(", ")}.`);
  }
  if (!title.trim()) throw new Error("A --title is required.");
  const id = nextProductId(parsedType.data, existingIds(repoDir, parsedType.data));
  const rel = productDocPath(parsedType.data, id, title);
  const abs = join(resolve(repoDir), rel);
  if (existsSync(abs)) throw new Error(`${rel} already exists.`);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, fillTemplate(parsedType.data, id, title.trim()));
  return { id, path: rel };
}

/**
 * Lint a working tree's product docs exactly as a build would publish them —
 * extraction (for code bindings), test scan (traceability), and every
 * validation. Override/LLM tiers are ignored: this checks the repo's files.
 */
export async function lintProduct(repoDir: string): Promise<ProductManifest> {
  const root = resolve(repoDir);
  // Unlike a build, a lint must not die because one language's toolchain is
  // missing on this machine: skip that adapter and say so. Bindings into its
  // files then report as broken, which the info finding explains.
  const models: DocModel[] = [];
  const skipped: string[] = [];
  for (const adapter of listAdapters()) {
    if (!(await adapter.detect(root))) continue;
    try {
      models.push(await adapter.extract(root, { repoName: slugify(root) }));
    } catch (err) {
      skipped.push(`${adapter.language} adapter skipped: ${(err as Error).message.split(/\.\s/)[0]}`);
    }
  }
  if (models.length === 0) throw new Error(`No adapter could extract ${root}.`);
  const manifest = buildProduct(combineModels(models), { repoOnly: true, testRefs: scanTestRefs(root) });
  for (const reason of skipped) {
    manifest.findings.push({
      level: "info",
      code: "adapter-skipped",
      message: `${reason} — bindings into those files can't be checked on this machine.`,
    });
  }
  return manifest;
}

/**
 * Write a repo's LLM-drafted product set (from `enrich --product`) into a
 * directory laid out like `docs/product/` so a human can review, edit and
 * commit it — promotion makes it curated, and the LLM never rewrites it.
 */
export function exportProductDrafts(
  dataDir: string,
  slug: string,
  outDir: string,
  options: { force?: boolean } = {},
): { written: string[]; skipped: string[]; stale: boolean } {
  const set = loadLlmProductSet(join(resolve(dataDir), "enrichment", slugify(slug)));
  if (!set || set.files.length === 0) {
    throw new Error(`No drafted product docs for "${slug}" — run \`necronomidoc enrich ${slug} --product\` first.`);
  }
  const published = paths.product(paths.repoDir(resolve(dataDir), slugify(slug)));
  let stale = false;
  if (existsSync(published)) {
    const parsed = ProductManifest.safeParse(JSON.parse(readFileSync(published, "utf8")));
    stale = parsed.success && parsed.data.source === "llm" && parsed.data.stale;
  }
  const out = resolve(outDir);
  const result = { written: [] as string[], skipped: [] as string[], stale };
  for (const file of set.files) {
    const rel = file.path.startsWith(`${PRODUCT_DOCS_DIR}/`) ? file.path.slice(PRODUCT_DOCS_DIR.length + 1) : file.path;
    const target = resolve(out, rel);
    // The file paths come from model output: never let one escape the target dir.
    if (relative(out, target).startsWith("..") || !target.startsWith(out + sep)) {
      result.skipped.push(`${rel} (outside the output dir)`);
      continue;
    }
    if (existsSync(target) && !options.force) {
      result.skipped.push(rel);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
    result.written.push(rel);
  }
  return result;
}

/** Read a repo's published product manifest from the data dir (doctor). */
export function readPublishedProductManifest(dataDir: string, slug: string): ProductManifest | undefined {
  const file = paths.product(paths.repoDir(resolve(dataDir), slugify(slug)));
  if (!existsSync(file)) return undefined;
  try {
    const parsed = ProductManifest.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
