import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  Node,
  Project,
  SyntaxKind,
  ts,
  type ClassDeclaration,
  type InterfaceDeclaration,
  type SourceFile,
} from "ts-morph";
import {
  SCHEMA_VERSION,
  hashContent,
  makeFileId,
  makeSymbolId,
  normalizePath,
  slugify,
  type DocFile,
  type DocModel,
  type DocSymbolShape,
  type ImportRef,
  type PropDoc,
  type SymbolKind,
} from "@necronomidoc/docmodel";
import type { AdapterConfig, AdapterMatch, DocAdapter } from "./adapter.js";
import { parseJsDoc } from "./jsdoc.js";

const DEFAULT_GLOBS = ["**/*.ts", "**/*.tsx"];
const DEFAULT_IGNORES = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.git/**",
  "**/*.d.ts",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.spec.ts",
  "**/*.spec.tsx",
];

const MAX_SIG = 300;

function truncate(text: string, max = MAX_SIG): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? collapsed.slice(0, max - 1) + "…" : collapsed;
}

function isPascalCase(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function isHookName(name: string): boolean {
  return /^use[A-Z0-9]/.test(name);
}

function hasJsx(node: Node): boolean {
  return (
    node.getFirstDescendantByKind(SyntaxKind.JsxElement) !== undefined ||
    node.getFirstDescendantByKind(SyntaxKind.JsxSelfClosingElement) !== undefined ||
    node.getFirstDescendantByKind(SyntaxKind.JsxFragment) !== undefined
  );
}

/** Concatenate a declaration's JSDoc blocks into one raw comment string. */
function rawJsDoc(node: Node): string | undefined {
  if (!("getJsDocs" in node) || typeof (node as { getJsDocs?: unknown }).getJsDocs !== "function") {
    return undefined;
  }
  const docs = (node as unknown as { getJsDocs(): { getText(): string }[] }).getJsDocs();
  if (!docs.length) return undefined;
  return docs.map((d) => d.getText()).join("\n");
}

/** Resolve a component's props type into a prop table, best-effort & syntactic. */
function extractProps(sourceFile: SourceFile, paramTypeText: string | undefined, typeNode: Node | undefined): PropDoc[] | undefined {
  if (!typeNode) return undefined;

  const readMembers = (decl: InterfaceDeclaration | Node): PropDoc[] => {
    const props: PropDoc[] = [];
    const properties = decl.getKind() === SyntaxKind.InterfaceDeclaration
      ? (decl as InterfaceDeclaration).getProperties()
      : decl.getChildrenOfKind(SyntaxKind.PropertySignature);
    for (const p of properties) {
      const name = p.getName();
      const doc = parseJsDoc(rawJsDoc(p));
      props.push({
        name,
        type: p.getTypeNode()?.getText(),
        required: !p.hasQuestionToken(),
        description: doc?.summary,
      });
    }
    return props;
  };

  // Inline object type: `(props: { a: string })`
  if (typeNode.getKind() === SyntaxKind.TypeLiteral) {
    return readMembers(typeNode);
  }
  // Named type reference: look up an interface/type alias in the same file.
  const refName = (paramTypeText ?? typeNode.getText()).replace(/<.*$/, "").trim();
  const iface = sourceFile.getInterface(refName);
  if (iface) return readMembers(iface);
  const alias = sourceFile.getTypeAlias(refName);
  if (alias) {
    const aliasType = alias.getTypeNode();
    if (aliasType && aliasType.getKind() === SyntaxKind.TypeLiteral) return readMembers(aliasType);
  }
  return undefined;
}

interface SymbolDraft {
  name: string;
  kind: SymbolKind;
  node: Node;
  exported: boolean;
  signature: string;
  props?: PropDoc[];
  members?: DocSymbolShape[];
}

function classifyFunctionLike(name: string, node: Node): SymbolKind {
  if (isPascalCase(name) && hasJsx(node)) return "component";
  if (isHookName(name)) return "hook";
  return "function";
}

function renderFunctionSignature(name: string, node: Node): string {
  // Each Parameter node's own text already carries name + optional type +
  // default, and handles destructuring patterns correctly.
  const params = node
    .getChildrenOfKind(SyntaxKind.Parameter)
    .map((p) => p.getText())
    .join(", ");
  return truncate(`${name}(${params})`);
}

export class TypeScriptAdapter implements DocAdapter {
  readonly language = "typescript";

  async detect(repoDir: string): Promise<AdapterMatch | null> {
    const hasTsconfig = existsSync(resolve(repoDir, "tsconfig.json"));
    let hasReact = false;
    let hasTsDep = false;
    const pkgPath = resolve(repoDir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        hasReact = "react" in deps;
        hasTsDep = "typescript" in deps;
      } catch {
        /* ignore malformed package.json */
      }
    }
    if (!hasTsconfig && !hasTsDep && !hasReact) return null;
    const reasons: string[] = [];
    if (hasTsconfig) reasons.push("tsconfig.json");
    if (hasTsDep) reasons.push("typescript dependency");
    if (hasReact) reasons.push("react dependency");
    return { language: this.language, reason: `found ${reasons.join(", ")}`, globs: DEFAULT_GLOBS };
  }

  async extract(repoDir: string, config: AdapterConfig): Promise<DocModel> {
    const root = resolve(repoDir);
    const globs = config.globs ?? DEFAULT_GLOBS;
    const ignores = [...DEFAULT_IGNORES, ...(config.ignore ?? [])];

    const project = new Project({
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
      compilerOptions: {
        allowJs: false,
        jsx: ts.JsxEmit.ReactJSX,
        noEmit: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2022,
      },
    });

    const patterns = [
      ...globs.map((g) => normalizePath(resolve(root, g))),
      ...ignores.map((g) => `!${normalizePath(resolve(root, g))}`),
    ];
    project.addSourceFilesAtPaths(patterns);

    const repoName = config.repoName ?? root.split(/[\\/]/).filter(Boolean).pop() ?? "repo";
    const slug = slugify(repoName);
    const files: DocFile[] = [];

    for (const sourceFile of project.getSourceFiles()) {
      try {
        const file = this.extractFile(sourceFile, root, slug);
        if (file) files.push(file);
      } catch (err) {
        // One malformed file must not abort the whole extraction.
        const rel = normalizePath(relative(root, sourceFile.getFilePath()));
        // eslint-disable-next-line no-console
        console.warn(`[adapter-ts] skipped ${rel}: ${(err as Error).message}`);
      }
    }

    files.sort((a, b) => a.path.localeCompare(b.path));

    return {
      schemaVersion: SCHEMA_VERSION,
      repo: {
        name: repoName,
        slug,
        url: config.repoUrl,
        ref: config.ref,
        commit: config.commit,
      },
      files,
      generatedAt: new Date().toISOString(),
    };
  }

  private extractFile(sourceFile: SourceFile, root: string, slug: string): DocFile | null {
    const rel = normalizePath(relative(root, sourceFile.getFilePath()));
    const fullText = sourceFile.getFullText();
    const symbols: DocSymbolShape[] = [];
    const disambig = new Map<string, number>();

    const nextId = (symbolPath: string): string => {
      const seen = disambig.get(symbolPath);
      if (seen === undefined) {
        disambig.set(symbolPath, 0);
        return makeSymbolId(slug, rel, symbolPath);
      }
      const n = seen + 1;
      disambig.set(symbolPath, n);
      return makeSymbolId(slug, rel, symbolPath, n);
    };

    const drafts: SymbolDraft[] = [];

    // Functions
    for (const fn of sourceFile.getFunctions()) {
      const name = fn.getName();
      if (!name) continue;
      drafts.push({
        name,
        kind: classifyFunctionLike(name, fn),
        node: fn,
        exported: fn.isExported(),
        signature: renderFunctionSignature(name, fn),
        props: undefined,
      });
    }

    // Variable declarations (arrow-fn components/hooks, consts, etc.)
    for (const stmt of sourceFile.getVariableStatements()) {
      const exported = stmt.isExported();
      for (const decl of stmt.getDeclarations()) {
        const name = decl.getName();
        const init = decl.getInitializer();
        const isFnLike =
          init !== undefined &&
          (Node.isArrowFunction(init) || Node.isFunctionExpression(init));
        let kind: SymbolKind = "variable";
        let signature: string;
        if (isFnLike && init) {
          kind = classifyFunctionLike(name, init);
          signature = renderFunctionSignature(name, init);
        } else {
          const typeNode = decl.getTypeNode();
          signature = truncate(typeNode ? `${name}: ${typeNode.getText()}` : `${name}`);
        }
        drafts.push({ name, kind, node: decl, exported, signature });
      }
    }

    // Classes
    for (const cls of sourceFile.getClasses()) {
      const name = cls.getName();
      if (!name) continue;
      drafts.push({
        name,
        kind: "class",
        node: cls,
        exported: cls.isExported(),
        signature: truncate(classHeader(cls)),
        members: extractClassMembers(cls, slug, rel),
      });
    }

    // Interfaces
    for (const iface of sourceFile.getInterfaces()) {
      const name = iface.getName();
      drafts.push({
        name,
        kind: "interface",
        node: iface,
        exported: iface.isExported(),
        signature: truncate(`interface ${name}`),
        members: extractInterfaceMembers(iface, slug, rel),
      });
    }

    // Type aliases
    for (const alias of sourceFile.getTypeAliases()) {
      const name = alias.getName();
      drafts.push({
        name,
        kind: "type",
        node: alias,
        exported: alias.isExported(),
        signature: truncate(alias.getText().replace(/^export\s+/, "")),
      });
    }

    // Enums
    for (const en of sourceFile.getEnums()) {
      const name = en.getName();
      drafts.push({
        name,
        kind: "enum",
        node: en,
        exported: en.isExported(),
        signature: truncate(`enum ${name}`),
      });
    }

    for (const draft of drafts) {
      const id = nextId(draft.name);
      let props = draft.props;
      if (draft.kind === "component") {
        const fnNode = draft.node;
        const firstParam = fnNode.getFirstDescendantByKind(SyntaxKind.Parameter);
        const typeNode = firstParam?.getTypeNode();
        props = extractProps(sourceFile, typeNode?.getText(), typeNode);
      }
      symbols.push({
        id,
        name: draft.name,
        kind: draft.kind,
        exported: draft.exported,
        signature: draft.signature,
        location: {
          path: rel,
          line: draft.node.getStartLineNumber(),
        },
        doc: parseJsDoc(rawJsDoc(draft.node)),
        props,
        members: draft.members,
        contentHash: hashContent(draft.node.getText()),
      });
    }

    // Imports
    const imports: ImportRef[] = sourceFile.getImportDeclarations().map((imp) => {
      const names: string[] = [];
      const def = imp.getDefaultImport();
      if (def) names.push(def.getText());
      const ns = imp.getNamespaceImport();
      if (ns) names.push(`* as ${ns.getText()}`);
      for (const named of imp.getNamedImports()) names.push(named.getName());
      return {
        moduleSpecifier: imp.getModuleSpecifierValue(),
        names,
        isTypeOnly: imp.isTypeOnly(),
      };
    });

    // Exports (named export declarations + exported symbols)
    const exportNames = new Set<string>();
    for (const s of symbols) if (s.exported) exportNames.add(s.name);
    for (const exp of sourceFile.getExportDeclarations()) {
      for (const named of exp.getNamedExports()) exportNames.add(named.getName());
    }

    const moduleDoc = extractModuleDoc(sourceFile);

    // Skip files that contribute nothing at all.
    if (symbols.length === 0 && !moduleDoc && imports.length === 0) return null;

    return {
      id: makeFileId(slug, rel),
      path: rel,
      contentHash: hashContent(fullText),
      moduleDoc,
      imports,
      exports: [...exportNames].sort(),
      symbols,
    };
  }
}

function classHeader(cls: ClassDeclaration): string {
  const text = cls.getText().replace(/^export\s+/, "");
  const brace = text.indexOf("{");
  return brace === -1 ? text : text.slice(0, brace);
}

function extractClassMembers(cls: ClassDeclaration, slug: string, rel: string): DocSymbolShape[] {
  const out: DocSymbolShape[] = [];
  for (const m of cls.getMethods()) {
    out.push(memberSymbol(m.getName(), "method", m, slug, rel, cls.getName() ?? "default"));
  }
  for (const p of cls.getProperties()) {
    out.push(memberSymbol(p.getName(), "property", p, slug, rel, cls.getName() ?? "default"));
  }
  return out;
}

function extractInterfaceMembers(iface: InterfaceDeclaration, slug: string, rel: string): DocSymbolShape[] {
  const out: DocSymbolShape[] = [];
  const owner = iface.getName();
  for (const m of iface.getMethods()) {
    out.push(memberSymbol(m.getName(), "method", m, slug, rel, owner));
  }
  for (const p of iface.getProperties()) {
    out.push(memberSymbol(p.getName(), "property", p, slug, rel, owner));
  }
  return out;
}

function memberSymbol(
  name: string,
  kind: SymbolKind,
  node: Node,
  slug: string,
  rel: string,
  owner: string,
): DocSymbolShape {
  return {
    id: makeSymbolId(slug, rel, `${owner}.${name}`),
    name,
    kind,
    exported: false,
    signature: truncate(node.getText()),
    location: { path: rel, line: node.getStartLineNumber() },
    doc: parseJsDoc(rawJsDoc(node)),
    contentHash: hashContent(node.getText()),
  };
}

/**
 * A file-level module comment: the first `/** *\/` block at the top of the
 * file, recognized either because the first statement is an import (imports
 * rarely carry their own JSDoc) or because it uses a file-level tag.
 */
function extractModuleDoc(sourceFile: SourceFile) {
  const first = sourceFile.getStatements()[0];
  if (!first) return undefined;
  const ranges = first.getLeadingCommentRanges();
  for (const range of ranges) {
    const text = range.getText();
    if (!text.startsWith("/**")) continue;
    const isFileTag = /@(file|fileoverview|module|packageDocumentation)\b/.test(text);
    if (isFileTag || first.getKind() === SyntaxKind.ImportDeclaration) {
      return parseJsDoc(text);
    }
  }
  return undefined;
}
