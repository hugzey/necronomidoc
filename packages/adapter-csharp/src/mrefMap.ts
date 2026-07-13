import {
  hashContent,
  makeFileId,
  makeSymbolId,
  normalizePath,
  type DocComment,
  type DocFile,
  type DocSymbolShape,
  type SymbolKind,
} from "@necronomidoc/docmodel";

// ---- DocFX ManagedReference shapes (the subset we consume) ----
// docfx metadata emits `### YamlMime:ManagedReference` YAML per type
// (https://dotnet.github.io/docfx/docs/dotnet-yaml-format.html). This mapper
// is the churn-absorbing boundary: unknown fields are ignored.

export interface MrefSource {
  id?: string;
  /** Relative to the docfx.json directory the metadata run used. */
  path?: string;
  /** 0-based. */
  startLine?: number;
}

export interface MrefParameter {
  id?: string;
  type?: string;
  description?: string;
}

export interface MrefItem {
  uid: string;
  id?: string;
  parent?: string;
  children?: string[];
  name?: string;
  nameWithType?: string;
  fullName?: string;
  /** Class | Interface | Struct | Enum | Delegate | Method | Constructor | Property | Field | Event | Operator | Namespace */
  type?: string;
  source?: MrefSource;
  namespace?: string;
  summary?: string;
  remarks?: string;
  example?: string[];
  syntax?: {
    content?: string;
    parameters?: MrefParameter[];
    typeParameters?: MrefParameter[];
    return?: { type?: string; description?: string };
  };
  exceptions?: Array<{ type?: string; description?: string }>;
  inheritance?: string[];
}

export interface MrefReference {
  uid: string;
  name?: string;
  fullName?: string;
}

export interface MrefDocument {
  items?: MrefItem[];
  references?: MrefReference[];
}

export interface MrefMapContext {
  repoSlug: string;
  /** Directory the docfx.json lived in — `source.path` is relative to it. */
  resolveSourcePath: (docfxRelativePath: string) => string | null;
  /** Repo-relative path → raw file text (drives the file contentHash), or null. */
  readSource: (relPath: string) => string | null;
}

// ---- HTML cleanup (docfx renders XML doc tags to HTML fragments) ----

/** Strip docfx's HTML fragments down to readable text with backtick code. */
export function cleanDocText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const cleaned = text
    // <xref href="Some.Uid" ...></xref> → Uid (last dotted segment)
    .replace(/<xref href="([^"]*)"[^>]*>\s*<\/xref>/g, (_m, href: string) => {
      const uid = decodeURIComponent(String(href)).replace(/%60/g, "`");
      return uid.split("(")[0]!.split(".").pop() ?? uid;
    })
    .replace(/<\/?(?:code|c)\b[^>]*>/g, "`")
    .replace(/<\/?pre\b[^>]*>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Render a uid like `System.Collections.Generic.IEnumerable{System.String}` readably. */
export function prettyTypeRef(uid: string | undefined, refs: Map<string, MrefReference>): string | undefined {
  if (!uid) return undefined;
  const ref = refs.get(uid);
  if (ref?.name) return ref.name;
  return uid
    .replace(/\{/g, "<")
    .replace(/\}/g, ">")
    .split("<")
    .map((part) => part.split(".").pop() ?? part)
    .join("<");
}

// ---- item → symbol mapping ----

const TYPE_KINDS: Record<string, SymbolKind> = {
  Class: "class",
  Interface: "interface",
  Struct: "class",
  Enum: "enum",
  Delegate: "type",
};

const MEMBER_KINDS: Record<string, SymbolKind> = {
  Method: "method",
  Constructor: "method",
  Operator: "method",
  Property: "property",
  Field: "property",
  Event: "property",
};

function isTypeItem(item: MrefItem): boolean {
  return item.type !== undefined && item.type in TYPE_KINDS;
}

function isExported(item: MrefItem): boolean {
  const content = item.syntax?.content ?? "";
  return /^\s*(?:\[[^\]]*\]\s*)*(?:public|protected)\b/m.test(content);
}

/** Simple member name: `Greet(System.String)` → `Greet`, `#ctor(...)` → `ctor`. */
function simpleName(item: MrefItem): string {
  const raw = item.source?.id ?? item.id ?? item.uid;
  const base = raw.split("(")[0]!;
  return base.replace(/^[#.]/, "").replace(/^ctor$/, "ctor") || item.uid;
}

function docCommentFor(item: MrefItem, refs: Map<string, MrefReference>): DocComment | undefined {
  const comment: DocComment = { params: [], examples: [], tags: [] };
  comment.summary = cleanDocText(item.summary);
  comment.remarks = cleanDocText(item.remarks);
  for (const param of item.syntax?.parameters ?? []) {
    if (!param.id) continue;
    const entry: { name: string; type?: string; text?: string } = { name: param.id };
    const type = prettyTypeRef(param.type, refs);
    if (type) entry.type = type;
    const text = cleanDocText(param.description);
    if (text) entry.text = text;
    comment.params.push(entry);
  }
  const returnDesc = cleanDocText(item.syntax?.return?.description);
  if (returnDesc) comment.returns = returnDesc;
  for (const exception of item.exceptions ?? []) {
    const type = prettyTypeRef(exception.type, refs) ?? "";
    const desc = cleanDocText(exception.description) ?? "";
    comment.tags.push({ tag: "raises", text: type ? `${type}: ${desc}` : desc });
  }
  for (const example of item.example ?? []) {
    const text = cleanDocText(example);
    if (text) comment.examples.push(text);
  }

  const empty =
    !comment.summary &&
    !comment.remarks &&
    !comment.returns &&
    comment.params.length === 0 &&
    comment.examples.length === 0 &&
    comment.tags.length === 0;
  return empty ? undefined : comment;
}

interface PlacedItem {
  item: MrefItem;
  relPath: string;
  line: number;
}

function place(item: MrefItem, ctx: MrefMapContext): PlacedItem | null {
  const sourcePath = item.source?.path;
  if (!sourcePath) return null;
  const relPath = ctx.resolveSourcePath(sourcePath);
  if (relPath === null) return null;
  return { item, relPath: normalizePath(relPath), line: (item.source?.startLine ?? 0) + 1 };
}

function symbolFor(
  placed: PlacedItem,
  symbolPath: string,
  refs: Map<string, MrefReference>,
  ctx: MrefMapContext,
  usedIds: Set<string>,
  children: DocSymbolShape[] = [],
): DocSymbolShape {
  const { item, relPath, line } = placed;
  const kind = TYPE_KINDS[item.type ?? ""] ?? MEMBER_KINDS[item.type ?? ""] ?? "unknown";
  const signature = item.syntax?.content;
  const doc = docCommentFor(item, refs);

  // Overloads share a dotted path; disambiguate with ~n like the other adapters.
  let id = makeSymbolId(ctx.repoSlug, relPath, symbolPath);
  for (let n = 1; usedIds.has(id); n++) id = makeSymbolId(ctx.repoSlug, relPath, symbolPath, n);
  usedIds.add(id);

  return {
    id,
    name: simpleName(item),
    kind,
    exported: isExported(item),
    ...(signature ? { signature } : {}),
    location: { path: relPath, line },
    ...(doc ? { doc } : {}),
    ...(children.length > 0 ? { members: children } : {}),
    contentHash: hashContent(
      JSON.stringify([item.uid, kind, signature ?? "", item.summary ?? "", children.map((c) => c.contentHash)]),
    ),
  };
}

/**
 * Map a set of parsed ManagedReference documents to DocFiles — one per C#
 * source file the items point at (partial classes span several files; each
 * file gets the members defined in it).
 */
export function mapManagedReference(documents: MrefDocument[], ctx: MrefMapContext): DocFile[] {
  const refs = new Map<string, MrefReference>();
  const typeItems = new Map<string, PlacedItem>();
  const memberItems: PlacedItem[] = [];

  for (const doc of documents) {
    for (const ref of doc.references ?? []) refs.set(ref.uid, ref);
    for (const item of doc.items ?? []) {
      if (item.type === "Namespace") continue;
      const placed = place(item, ctx);
      if (!placed) continue; // compiler-generated or outside the repo
      if (isTypeItem(item)) typeItems.set(item.uid, placed);
      else memberItems.push(placed);
    }
  }

  // Group members under their parent type when it lives in the same file;
  // otherwise (partial class in another file) they surface as top-level
  // symbols of their own file under the dotted type name.
  const childrenOf = new Map<string, PlacedItem[]>();
  const looseMembers: PlacedItem[] = [];
  for (const member of memberItems) {
    const parent = member.item.parent !== undefined ? typeItems.get(member.item.parent) : undefined;
    if (parent && parent.relPath === member.relPath) {
      const list = childrenOf.get(parent.item.uid) ?? [];
      list.push(member);
      childrenOf.set(parent.item.uid, list);
    } else {
      looseMembers.push(member);
    }
  }

  const byFile = new Map<string, DocSymbolShape[]>();
  const fileTitles = new Map<string, string>();
  const usedIds = new Set<string>();
  const push = (relPath: string, symbol: DocSymbolShape): void => {
    const list = byFile.get(relPath) ?? [];
    list.push(symbol);
    byFile.set(relPath, list);
  };

  const sortedTypes = [...typeItems.values()].sort((a, b) => a.line - b.line);
  for (const type of sortedTypes) {
    const typePath = type.item.name ?? simpleName(type.item);
    const children = (childrenOf.get(type.item.uid) ?? [])
      .sort((a, b) => a.line - b.line)
      .map((member) => symbolFor(member, `${typePath}.${simpleName(member.item)}`, refs, ctx, usedIds));
    push(type.relPath, symbolFor(type, typePath, refs, ctx, usedIds, children));
    if (!fileTitles.has(type.relPath) && type.item.fullName) {
      fileTitles.set(type.relPath, type.item.fullName);
    }
  }
  for (const member of looseMembers.sort((a, b) => a.line - b.line)) {
    const parentName = member.item.parent?.split(".").pop();
    const symbolPath = parentName ? `${parentName}.${simpleName(member.item)}` : simpleName(member.item);
    push(member.relPath, symbolFor(member, symbolPath, refs, ctx, usedIds));
  }

  const files: DocFile[] = [];
  for (const [relPath, symbols] of byFile) {
    const source = ctx.readSource(relPath);
    const title = fileTitles.get(relPath);
    files.push({
      id: makeFileId(ctx.repoSlug, relPath),
      path: relPath,
      contentHash: hashContent(source ?? JSON.stringify(symbols.map((s) => s.contentHash))),
      format: "source",
      ...(title ? { title } : {}),
      imports: [],
      exports: symbols.filter((s) => s.exported).map((s) => s.name),
      symbols,
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}
