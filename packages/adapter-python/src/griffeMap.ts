import {
  hashContent,
  makeFileId,
  makeSymbolId,
  normalizePath,
  type DocComment,
  type DocFile,
  type DocParam,
  type DocSymbolShape,
  type SymbolKind,
} from "@necronomidoc/docmodel";

// ---- griffe `dump --full` JSON shapes (the subset we consume) ----
// griffe's JSON is versionless; this mapper is the churn-absorbing boundary
// (research 02): unknown fields are ignored, missing ones degrade gracefully.

/** An annotation/default expression: plain string or a serialized expr tree. */
export type GriffeExpr = string | { cls: string; [key: string]: unknown } | null | undefined;

export interface GriffeParameter {
  name: string;
  annotation?: GriffeExpr;
  default?: GriffeExpr;
  /** "positional-only" | "positional or keyword" | "variadic positional" | "keyword-only" | "variadic keyword" */
  kind?: string;
}

export interface GriffeDocstring {
  value: string;
  lineno?: number;
  /** Present with `dump --full -d <style>`: structured sections. */
  parsed?: Array<{ kind: string; value: unknown }>;
}

export interface GriffeObject {
  kind: "module" | "class" | "function" | "attribute" | "alias" | string;
  name?: string;
  /** Dotted path, e.g. "pkg.mod.Class.method". */
  path?: string;
  /** Absolute path of the defining file (modules only in practice). */
  filepath?: string;
  lineno?: number;
  endlineno?: number;
  docstring?: GriffeDocstring | null;
  members?: Record<string, GriffeObject>;
  parameters?: GriffeParameter[];
  returns?: GriffeExpr;
  bases?: GriffeExpr[];
  annotation?: GriffeExpr;
  value?: GriffeExpr;
  labels?: string[];
  is_public?: boolean;
  is_special?: boolean;
  is_deprecated?: boolean;
}

export interface GriffeMapContext {
  repoSlug: string;
  /** Absolute module filepath → repo-relative path, or null when outside the repo. */
  toRelPath: (filepath: string) => string | null;
  /** Repo-relative path → raw file text (drives the file contentHash), or null. */
  readSource: (relPath: string) => string | null;
}

// ---- expression stringification (best-effort, for signatures) ----

/** Render a griffe expression tree back to readable Python source. */
export function exprToString(expr: GriffeExpr): string | undefined {
  if (expr === null || expr === undefined) return undefined;
  if (typeof expr === "string") return expr;
  const node = expr as Record<string, unknown>;
  const sub = (v: unknown): string => exprToString(v as GriffeExpr) ?? "…";
  switch (expr.cls) {
    case "ExprName":
      return String(node["name"] ?? "…");
    case "ExprAttribute": {
      const values = node["values"];
      if (Array.isArray(values)) return values.map(sub).join(".");
      return "…";
    }
    case "ExprConstant":
      return String(node["value"] ?? "…");
    case "ExprSubscript":
      return `${sub(node["left"])}[${sub(node["slice"])}]`;
    case "ExprTuple": {
      const elements = Array.isArray(node["elements"]) ? node["elements"].map(sub) : [];
      const inner = elements.join(", ");
      return node["implicit"] ? inner : `(${inner})`;
    }
    case "ExprList": {
      const elements = Array.isArray(node["elements"]) ? node["elements"].map(sub) : [];
      return `[${elements.join(", ")}]`;
    }
    case "ExprDict": {
      const keys = Array.isArray(node["keys"]) ? node["keys"] : [];
      const values = Array.isArray(node["values"]) ? node["values"] : [];
      const pairs = keys.map((k, i) => `${sub(k)}: ${sub(values[i])}`);
      return `{${pairs.join(", ")}}`;
    }
    case "ExprBinOp":
      return `${sub(node["left"])} ${String(node["operator"] ?? "?")} ${sub(node["right"])}`;
    case "ExprUnaryOp":
      return `${String(node["operator"] ?? "")}${sub(node["value"])}`;
    case "ExprCall": {
      const args = Array.isArray(node["arguments"]) ? node["arguments"].map(sub) : [];
      return `${sub(node["function"])}(${args.join(", ")})`;
    }
    case "ExprKeyword":
      return `${String(node["name"] ?? "…")}=${sub(node["value"])}`;
    default: {
      // Unknown node: salvage the most name-like field rather than failing.
      for (const key of ["name", "value", "left"]) {
        if (node[key] !== undefined) return sub(node[key]);
      }
      return "…";
    }
  }
}

// ---- signature rendering ----

function renderParameter(param: GriffeParameter): string {
  const prefix =
    param.kind === "variadic positional" ? "*" : param.kind === "variadic keyword" ? "**" : "";
  let out = `${prefix}${param.name}`;
  const annotation = exprToString(param.annotation);
  if (annotation) out += `: ${annotation}`;
  const dflt = exprToString(param.default);
  // griffe reports "()" as the implicit default of *args / **kwargs — noise.
  if (dflt !== undefined && prefix === "") out += annotation ? ` = ${dflt}` : `=${dflt}`;
  return out;
}

/** Render `name(params) -> returns` including `/` and `*` markers. */
export function functionSignature(fn: GriffeObject): string {
  const params = fn.parameters ?? [];
  const parts: string[] = [];
  let sawKeywordMarker = false;
  params.forEach((param, i) => {
    if (
      param.kind === "keyword-only" &&
      !sawKeywordMarker &&
      !params.some((p) => p.kind === "variadic positional")
    ) {
      parts.push("*");
      sawKeywordMarker = true;
    }
    parts.push(renderParameter(param));
    const next = params[i + 1];
    if (param.kind === "positional-only" && next?.kind !== "positional-only") parts.push("/");
  });
  const returns = exprToString(fn.returns);
  return `${fn.name}(${parts.join(", ")})${returns && returns !== "None" ? ` -> ${returns}` : ""}`;
}

function classSignature(cls: GriffeObject): string {
  const bases = (cls.bases ?? []).map((b) => exprToString(b) ?? "…");
  return `class ${cls.name}${bases.length > 0 ? `(${bases.join(", ")})` : ""}`;
}

function attributeSignature(attr: GriffeObject): string {
  let out = String(attr.name);
  const annotation = exprToString(attr.annotation);
  if (annotation) out += `: ${annotation}`;
  const value = exprToString(attr.value);
  if (value !== undefined) out += ` = ${value}`;
  return out;
}

// ---- docstring section mapping ----

function sectionText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["description", "text", "contents", "value"]) {
      if (typeof obj[key] === "string") return obj[key];
    }
  }
  return String(value ?? "");
}

/** Map a griffe docstring (parsed sections when available) to a DocComment. */
export function docstringToComment(doc: GriffeDocstring | null | undefined): DocComment | undefined {
  if (!doc?.value) return undefined;

  const comment: DocComment = { params: [], examples: [], tags: [] };
  const textBlocks: string[] = [];

  if (doc.parsed && doc.parsed.length > 0) {
    for (const section of doc.parsed) {
      const { kind, value } = section;
      if (kind === "text") {
        textBlocks.push(sectionText(value));
      } else if (kind === "parameters" || kind === "other parameters") {
        for (const item of asArray(value)) {
          const p = item as Record<string, unknown>;
          const param: DocParam = { name: String(p["name"] ?? "") };
          const type = exprToString(p["annotation"] as GriffeExpr);
          if (type) param.type = type;
          const text = typeof p["description"] === "string" ? p["description"] : undefined;
          if (text) param.text = text;
          comment.params.push(param);
        }
      } else if (kind === "returns" || kind === "yields") {
        const rendered = asArray(value)
          .map((item) => {
            const r = item as Record<string, unknown>;
            const desc = typeof r["description"] === "string" ? r["description"] : "";
            const type = exprToString(r["annotation"] as GriffeExpr);
            return desc || type || "";
          })
          .filter((s) => s.length > 0)
          .join("; ");
        if (kind === "returns" && rendered) comment.returns = rendered;
        else if (rendered) comment.tags.push({ tag: kind, text: rendered });
      } else if (kind === "raises" || kind === "warns") {
        for (const item of asArray(value)) {
          const r = item as Record<string, unknown>;
          const type = exprToString(r["annotation"] as GriffeExpr);
          const desc = typeof r["description"] === "string" ? r["description"] : "";
          comment.tags.push({ tag: kind, text: type ? `${type}: ${desc}` : desc });
        }
      } else if (kind === "examples") {
        for (const item of asArray(value)) {
          // Each example is (kind, text) — serialized as a 2-tuple or string.
          if (Array.isArray(item)) comment.examples.push(String(item[item.length - 1]));
          else comment.examples.push(sectionText(item));
        }
      } else if (kind === "deprecated") {
        comment.deprecated = sectionText(value);
      } else if (kind === "attributes") {
        for (const item of asArray(value)) {
          const a = item as Record<string, unknown>;
          const desc = typeof a["description"] === "string" ? a["description"] : "";
          comment.tags.push({ tag: "attribute", text: `${String(a["name"] ?? "")}: ${desc}` });
        }
      } else {
        const text = sectionText(value);
        if (text) comment.tags.push({ tag: kind, text });
      }
    }
  } else {
    textBlocks.push(doc.value);
  }

  const joined = textBlocks.join("\n\n").trim();
  if (joined) {
    const paragraphBreak = joined.indexOf("\n\n");
    if (paragraphBreak === -1) {
      comment.summary = joined;
    } else {
      comment.summary = joined.slice(0, paragraphBreak).trim();
      comment.remarks = joined.slice(paragraphBreak + 2).trim();
    }
  }

  const empty =
    !comment.summary &&
    !comment.remarks &&
    !comment.returns &&
    !comment.deprecated &&
    comment.params.length === 0 &&
    comment.examples.length === 0 &&
    comment.tags.length === 0;
  return empty ? undefined : comment;
}

// ---- symbol mapping ----

const ENUM_BASES = new Set(["Enum", "IntEnum", "StrEnum", "Flag", "IntFlag"]);

function isEnumClass(cls: GriffeObject): boolean {
  return (cls.bases ?? []).some((base) => {
    const name = exprToString(base);
    return name !== undefined && ENUM_BASES.has(name.split(".").pop() ?? "");
  });
}

function symbolKindFor(member: GriffeObject, insideClass: boolean): SymbolKind | null {
  switch (member.kind) {
    case "function":
      return insideClass ? "method" : "function";
    case "class":
      return isEnumClass(member) ? "enum" : "class";
    case "attribute":
      return insideClass ? "property" : "variable";
    default:
      return null; // aliases and submodules are handled by the caller
  }
}

function isPublic(member: GriffeObject): boolean {
  if (typeof member.is_public === "boolean") return member.is_public;
  return !(member.name ?? "").startsWith("_");
}

/** Sorted by source line so files read top-to-bottom, like the TS sweep. */
function sortedMembers(obj: GriffeObject): GriffeObject[] {
  return Object.values(obj.members ?? {}).sort((a, b) => (a.lineno ?? 0) - (b.lineno ?? 0));
}

function signatureFor(member: GriffeObject, kind: SymbolKind): string {
  if (member.kind === "function") return functionSignature(member);
  if (kind === "class" || kind === "enum") return classSignature(member);
  return attributeSignature(member);
}

function mapMember(
  member: GriffeObject,
  ctx: GriffeMapContext,
  relPath: string,
  parentPath: string,
  insideClass: boolean,
): DocSymbolShape | null {
  const kind = symbolKindFor(member, insideClass);
  if (kind === null) return null;
  // Dunders are Python plumbing, not documentation targets — except
  // __init__, which documents the constructor.
  if (member.is_special && member.name !== "__init__") return null;
  if (member.name === "__all__") return null;

  const name = member.name ?? "unknown";
  const symbolPath = parentPath ? `${parentPath}.${name}` : name;
  const signature = signatureFor(member, kind);
  const doc = docstringToComment(member.docstring);

  const children: DocSymbolShape[] = [];
  if (member.kind === "class") {
    for (const child of sortedMembers(member)) {
      const mapped = mapMember(child, ctx, relPath, symbolPath, true);
      if (mapped) children.push(mapped);
    }
  }

  const symbol: DocSymbolShape = {
    id: makeSymbolId(ctx.repoSlug, relPath, symbolPath),
    name,
    kind,
    exported: isPublic(member),
    signature,
    location: {
      path: relPath,
      line: member.lineno ?? 0,
      ...(member.endlineno !== undefined ? { endLine: member.endlineno } : {}),
    },
    ...(doc ? { doc } : {}),
    ...(children.length > 0 ? { members: children } : {}),
    contentHash: hashContent(
      JSON.stringify([name, kind, signature, member.docstring?.value ?? "", children.map((c) => c.contentHash)]),
    ),
  };
  if (member.is_deprecated && !symbol.doc?.deprecated) {
    symbol.doc = { ...(symbol.doc ?? { params: [], examples: [], tags: [] }), deprecated: "deprecated" };
  }
  return symbol;
}

// ---- module → DocFile mapping ----

/** Names a module re-exports or defines publicly (its `exports` list). */
function publicNames(module: GriffeObject): string[] {
  return sortedMembers(module)
    .filter((m) => m.kind !== "module" && isPublic(m) && m.name !== "__all__")
    .map((m) => m.name ?? "")
    .filter((n) => n.length > 0);
}

function mapModule(module: GriffeObject, ctx: GriffeMapContext): DocFile | null {
  if (!module.filepath) return null;
  const relPath = ctx.toRelPath(module.filepath);
  if (relPath === null) return null;
  const normalized = normalizePath(relPath);

  const symbols: DocSymbolShape[] = [];
  for (const member of sortedMembers(module)) {
    if (member.kind === "module") continue; // submodules become their own files
    const mapped = mapMember(member, ctx, normalized, "", false);
    if (mapped) symbols.push(mapped);
  }

  const source = ctx.readSource(normalized);
  const moduleDoc = docstringToComment(module.docstring);
  return {
    id: makeFileId(ctx.repoSlug, normalized),
    path: normalized,
    contentHash: hashContent(source ?? JSON.stringify([module.docstring?.value ?? "", symbols.map((s) => s.contentHash)])),
    format: "source",
    title: module.path ?? module.name,
    ...(moduleDoc ? { moduleDoc } : {}),
    imports: [],
    exports: publicNames(module),
    symbols,
  };
}

/**
 * Map one griffe-dumped package tree (the value under a top-level package
 * name in `griffe dump` output) to DocFiles — one per module inside the repo.
 */
export function mapGriffePackage(root: GriffeObject, ctx: GriffeMapContext): DocFile[] {
  const files: DocFile[] = [];
  const walk = (obj: GriffeObject): void => {
    if (obj.kind !== "module") return;
    const file = mapModule(obj, ctx);
    if (file) files.push(file);
    for (const member of Object.values(obj.members ?? {})) {
      if (member.kind === "module") walk(member);
    }
  };
  walk(root);
  return files;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
