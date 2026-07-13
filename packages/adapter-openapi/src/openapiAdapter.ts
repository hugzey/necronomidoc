import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { bundle, compileErrors, validate } from "@readme/openapi-parser";
import {
  SCHEMA_VERSION,
  hashContent,
  makeFileId,
  makeSymbolId,
  slugify,
  slugifyEndpointAnchor,
  type AdapterConfig,
  type AdapterMatch,
  type DocAdapter,
  type DocComment,
  type DocFile,
  type DocModel,
  type DocParam,
  type DocSymbolShape,
} from "@necronomidoc/docmodel";

const SPEC_EXTENSIONS = [".json", ".yaml", ".yml"];
const IGNORED_DIRS = new Set(["node_modules", "dist", "build", ".git", "vendor", "coverage"]);
/** Specs whose bundled JSON exceeds this are published without `content`. */
const MAX_CONTENT = 1_500_000;
const SUMMARY_MAX = 240;
/** HTTP methods in render order (the OpenAPI path-item operation keys). */
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

/** Loosely-typed OpenAPI nodes — the parser has already validated the shape. */
type SpecNode = Record<string, unknown>;

/** Does the head of the file look like an OpenAPI 3.x / Swagger 2.0 spec? */
export function sniffSpec(head: string): "openapi3" | "swagger2" | undefined {
  if (/["']?openapi["']?\s*:\s*["']?3/.test(head)) return "openapi3";
  if (/["']?swagger["']?\s*:\s*["']?2/.test(head)) return "swagger2";
  return undefined;
}

function sweep(dir: string, rel = "", out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const abs = join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) sweep(abs, relPath, out);
    } else if (SPEC_EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
      try {
        if (statSync(abs).size > 5_000_000) continue;
        if (sniffSpec(readFileSync(abs, "utf8").slice(0, 4096))) out.push(relPath);
      } catch {
        // unreadable file — not a spec we can document
      }
    }
  }
  return out;
}

function truncate(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const oneLine = text.trim().replace(/\s+/g, " ");
  if (!oneLine) return undefined;
  return oneLine.length > SUMMARY_MAX ? `${oneLine.slice(0, SUMMARY_MAX - 1)}…` : oneLine;
}

/** Resolve an internal `#/…` JSON pointer against the bundled document. */
function resolvePointer(doc: SpecNode, ref: string): SpecNode | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = doc;
  for (const seg of ref.slice(2).split("/")) {
    const key = seg.replace(/~1/g, "/").replace(/~0/g, "~");
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as SpecNode)[key];
  }
  return typeof node === "object" && node !== null ? (node as SpecNode) : undefined;
}

/** Follow at most a few levels of `$ref` indirection (bundled docs are flat). */
function deref(doc: SpecNode, node: unknown): SpecNode | undefined {
  let current = node;
  for (let i = 0; i < 4; i++) {
    if (typeof current !== "object" || current === null) return undefined;
    const ref = (current as SpecNode)["$ref"];
    if (typeof ref !== "string") return current as SpecNode;
    current = resolvePointer(doc, ref);
  }
  return undefined;
}

/** Short human label for a schema: its type, or the $ref target name. */
function schemaLabel(schema: unknown): string | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;
  const s = schema as SpecNode;
  if (typeof s["$ref"] === "string") return (s["$ref"] as string).split("/").pop();
  if (s["type"] === "array") {
    const item = schemaLabel(s["items"]);
    return item ? `${item}[]` : "array";
  }
  return typeof s["type"] === "string" ? (s["type"] as string) : undefined;
}

/** Merge path-item and operation parameters (operation wins on name+in). */
function mergedParams(doc: SpecNode, pathItem: SpecNode, op: SpecNode): DocParam[] {
  const byKey = new Map<string, DocParam>();
  for (const list of [pathItem["parameters"], op["parameters"]]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const p = deref(doc, raw);
      if (!p || typeof p["name"] !== "string") continue;
      const where = typeof p["in"] === "string" ? (p["in"] as string) : "query";
      const type = schemaLabel(p["schema"]);
      byKey.set(`${where}:${p["name"]}`, {
        name: p["name"] as string,
        type: type ? `${type} (${where})` : `(${where})`,
        text: [p["required"] === true ? "required." : undefined, truncate(p["description"] as string | undefined)]
          .filter(Boolean)
          .join(" ") || undefined,
      });
    }
  }
  return [...byKey.values()];
}

/** `200 — OK; 404 — Not found` from an operation's responses map. */
function responsesSummary(doc: SpecNode, op: SpecNode): string | undefined {
  const responses = op["responses"];
  if (typeof responses !== "object" || responses === null) return undefined;
  const parts = Object.entries(responses as SpecNode).map(([code, raw]) => {
    const resp = deref(doc, raw);
    const description = truncate(resp?.["description"] as string | undefined);
    return description ? `${code} — ${description}` : code;
  });
  return parts.length > 0 ? parts.join("; ") : undefined;
}

/** Request-body one-liner: `application/json: CreateUser (required)`. */
function requestBodySummary(doc: SpecNode, op: SpecNode): string | undefined {
  const body = deref(doc, op["requestBody"]);
  if (!body) return undefined;
  const content = body["content"];
  const types =
    typeof content === "object" && content !== null
      ? Object.entries(content as SpecNode).map(([mime, media]) => {
          const label = schemaLabel((media as SpecNode | null)?.["schema"]);
          return label ? `${mime}: ${label}` : mime;
        })
      : [];
  const suffix = body["required"] === true ? " (required)" : "";
  return types.length > 0 ? `${types.join(", ")}${suffix}` : undefined;
}

/** 1-based line of a path key (and its method key) in the raw spec text. */
function findOperationLine(lines: string[], pathKey: string, method: string): number {
  const escaped = pathKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pathRe = new RegExp(`^\\s*(['"]?)${escaped}\\1\\s*:`);
  const methodRe = new RegExp(`^\\s*(['"]?)${method}\\1\\s*:`, "i");
  const pathLine = lines.findIndex((l) => pathRe.test(l));
  if (pathLine === -1) return 1;
  const pathIndent = /^\s*/.exec(lines[pathLine]!)![0].length;
  for (let i = pathLine + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    // Leaving the path item's block (YAML/pretty-JSON: anything back at the
    // path key's indentation, e.g. the next path) ends the search — otherwise
    // we could attribute another path's method line to this operation.
    if (/^\s*/.exec(line)![0].length <= pathIndent) break;
    if (methodRe.test(line)) return i + 1;
  }
  return pathLine + 1;
}

/** Map one operation to an `endpoint` DocSymbol. */
function operationSymbol(
  repoSlug: string,
  relPath: string,
  rawLines: string[],
  doc: SpecNode,
  pathKey: string,
  pathItem: SpecNode,
  method: string,
  op: SpecNode,
  disambiguator?: number,
): DocSymbolShape {
  const name = `${method.toUpperCase()} ${pathKey}`;
  const tags: DocComment["tags"] = [];
  if (Array.isArray(op["tags"])) {
    for (const t of op["tags"]) if (typeof t === "string") tags.push({ tag: "tag", text: t });
  }
  if (typeof op["operationId"] === "string") {
    tags.push({ tag: "operationId", text: op["operationId"] as string });
  }
  const requestBody = requestBodySummary(doc, op);
  if (requestBody) tags.push({ tag: "requestBody", text: requestBody });

  const docComment: DocComment = {
    summary: truncate(op["summary"] as string | undefined),
    remarks: truncate(op["description"] as string | undefined),
    params: mergedParams(doc, pathItem, op),
    returns: responsesSummary(doc, op),
    examples: [],
    deprecated: op["deprecated"] === true ? "This operation is deprecated." : undefined,
    tags,
  };
  const hasDoc =
    docComment.summary || docComment.remarks || docComment.params.length > 0 || docComment.returns || tags.length > 0;

  return {
    id: makeSymbolId(repoSlug, relPath, slugifyEndpointAnchor(name), disambiguator),
    name,
    kind: "endpoint",
    exported: true,
    signature: name,
    location: { path: relPath, line: findOperationLine(rawLines, pathKey, method) },
    doc: hasDoc ? docComment : undefined,
    contentHash: hashContent(JSON.stringify(op)),
  };
}

/** A spec that failed validation still gets a page explaining why. */
function errorFile(repoSlug: string, relPath: string, raw: string, message: string): DocFile {
  return {
    id: makeFileId(repoSlug, relPath),
    path: relPath,
    contentHash: hashContent(raw),
    format: "openapi",
    title: relPath.split("/").pop(),
    moduleDoc: { summary: truncate(message), params: [], examples: [], tags: [] },
    imports: [],
    exports: [],
    symbols: [],
  };
}

/**
 * Extract one OpenAPI 3.x spec into a DocFile: the file carries the bundled
 * spec as JSON `content` for rich rendering, and every operation becomes an
 * `endpoint` symbol so search, enrichment, and MCP treat it like a function
 * (decision 0006 — OpenAPI is just another adapter).
 */
/** Does the filename alone announce a spec (vs a content-sniff hit)? */
function specishName(relPath: string): boolean {
  return /openapi|swagger|api.?spec|spec.?api/i.test(relPath.split("/").pop() ?? relPath);
}

export async function extractSpecFile(
  repoSlug: string,
  repoDir: string,
  relPath: string,
): Promise<DocFile | null> {
  const abs = join(repoDir, relPath);
  const raw = readFileSync(abs, "utf8");

  // Content sniffing can false-positive (a package.json pinning a dependency
  // named "openapi" to 3.x, a config mentioning a spec version). A file that
  // fails to parse as a spec only earns an explanatory error page when its
  // NAME says it's a spec; sniff-only candidates are quietly dropped instead
  // of publishing a bogus broken "API Reference" entry.
  const errorOrSkip = (message: string): DocFile | null =>
    specishName(relPath) ? errorFile(repoSlug, relPath, raw, message) : null;

  if (sniffSpec(raw.slice(0, 4096)) === "swagger2") {
    return errorOrSkip(
      "Unsupported Swagger 2.0 spec — convert it to OpenAPI 3.x to document it here.",
    );
  }

  let bundled: SpecNode;
  try {
    const result = await validate(abs);
    if (!result.valid) return errorOrSkip(compileErrors(result));
    bundled = (await bundle(abs)) as SpecNode;
  } catch (err) {
    return errorOrSkip(`Failed to parse spec: ${(err as Error).message}`);
  }

  const rawLines = raw.split("\n");
  const info = (bundled["info"] ?? {}) as SpecNode;
  const symbols: DocSymbolShape[] = [];
  const paths = (bundled["paths"] ?? {}) as SpecNode;
  // Distinct paths can slug to one anchor (`/a-b` vs `/a.b`) — disambiguate
  // like the markdown adapter so symbol ids stay unique (the search index
  // rejects duplicate ids, which would fail the whole build).
  const anchorCounts = new Map<string, number>();
  for (const [pathKey, rawItem] of Object.entries(paths)) {
    const pathItem = deref(bundled, rawItem);
    if (!pathItem) continue;
    for (const method of METHODS) {
      const op = pathItem[method];
      if (typeof op !== "object" || op === null) continue;
      const anchor = slugifyEndpointAnchor(`${method.toUpperCase()} ${pathKey}`);
      const seen = anchorCounts.get(anchor) ?? 0;
      anchorCounts.set(anchor, seen + 1);
      symbols.push(
        operationSymbol(
          repoSlug,
          relPath,
          rawLines,
          bundled,
          pathKey,
          pathItem,
          method,
          op as SpecNode,
          seen > 0 ? seen : undefined,
        ),
      );
    }
  }

  const content = JSON.stringify(bundled);
  const intro = truncate(
    (info["summary"] as string | undefined) ?? (info["description"] as string | undefined),
  );
  return {
    id: makeFileId(repoSlug, relPath),
    path: relPath,
    contentHash: hashContent(raw),
    format: "openapi",
    title: typeof info["title"] === "string" ? (info["title"] as string) : relPath.split("/").pop(),
    content: content.length <= MAX_CONTENT ? content : undefined,
    moduleDoc: intro ? { summary: intro, params: [], examples: [], tags: [] } : undefined,
    imports: [],
    exports: symbols.map((s) => s.name),
    symbols,
  };
}

/**
 * Adapter that documents a repo's REST surface from its OpenAPI 3.x specs.
 * Specs are found by filename-agnostic sniffing (any `.json`/`.yaml`/`.yml`
 * with an `openapi: 3…` key), validated and bundled with
 * `@readme/openapi-parser`, and mapped into the same file-rooted IR code
 * flows through. Swagger 2.0 and invalid specs publish an explanatory page
 * instead of failing the whole repo build (mixed repos keep their code docs).
 */
export class OpenApiAdapter implements DocAdapter {
  readonly language = "openapi";

  async detect(repoDir: string): Promise<AdapterMatch | null> {
    const found = sweep(repoDir);
    if (found.length === 0) return null;
    return {
      language: this.language,
      reason: `found ${found.length} OpenAPI/Swagger spec(s): ${found.slice(0, 3).join(", ")}`,
      globs: SPEC_EXTENSIONS.map((ext) => `**/*${ext}`),
    };
  }

  async extract(repoDir: string, config: AdapterConfig): Promise<DocModel> {
    const repoName = config.repoName ?? slugify(repoDir);
    const repoSlug = slugify(repoName);
    const files: DocFile[] = [];
    for (const relPath of sweep(repoDir).sort()) {
      const file = await extractSpecFile(repoSlug, repoDir, relPath);
      if (file) files.push(file);
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      repo: { name: repoName, slug: repoSlug, url: config.repoUrl, ref: config.ref, commit: config.commit },
      files,
      generatedAt: new Date().toISOString(),
    };
  }
}
