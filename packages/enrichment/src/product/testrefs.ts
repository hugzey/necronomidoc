import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PRODUCT_DOCS_DIR, normalizeProductRef, type ProductTestRef, type TestFileBinding } from "@necronomidoc/docmodel";

/**
 * Traceability by id (decision 0023): tests cite the product ids they verify
 * and the build scans the working tree for those citations. Works with any
 * framework because it only reads text — but only DELIBERATE citations count,
 * so ids that merely appear in assertions or test data never fake coverage:
 *
 *   it("[STORY-012.AC-2] rejects an expired token", …)   // [bracketed] in a title
 *   @SES-003.OUT-1 Scenario: …                          // @tag (Gherkin, JUnit…)
 *   def test_story_12_ac_2_rejects_expired_token(): …   // identifier form (_story_12_ac_2)
 *
 * Only stories and sessions are traced — they are what tests verify
 * (criteria AC-n, requirements REQ-n, outcomes OUT-n).
 */

/** Test data of OTHER projects (fixtures) isn't evidence about this one. */
export const FIXTURE_DIRS = new Set(["fixtures", "__fixtures__", "testdata", "test-fixtures"]);

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", "vendor", ".venv", "venv", "__pycache__", "bin", "obj", "target"]);
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_REFS = 5000;

/** Paths that look like tests in the common ecosystems. */
export function isTestPath(path: string): boolean {
  const lower = path.toLowerCase();
  const base = lower.split("/").pop()!;
  return (
    /(^|\/)(tests?|__tests__|specs?|e2e|integration|features|cypress|playwright)\//.test(lower) ||
    /\.(test|spec|e2e)\.[a-z0-9]+$/.test(base) ||
    /^test_.*\.py$/.test(base) ||
    /_test\.(py|go|rb|exs?)$/.test(base) ||
    /tests?\.(cs|java|kt|swift)$/.test(base) ||
    base.endsWith(".feature")
  );
}

const CODE_EXT = /\.(m?[jt]sx?|cjs|py|cs|java|kt|go|rb|exs?|swift|php|rs|feature|robot|ya?ml)$/i;

/** `[STORY-12.AC-2]`, `[SES-3, STORY-4]`, `@SES-3.OUT-1` — bracketed or tagged. */
const CITED_RE = /(?:(?<=\[)|(?<=@)|(?<=\[[^\]\n]{0,80}[,\s]))(STORY|SES)-(\d+)(?:[./:](AC|REQ|OUT)-(\d+))?(?![A-Za-z0-9])/gi;
/** `test_story_12_ac_2` — the identifier form for names that can't hold `-`/`.`. */
const IDENT_RE = /(?<=_)(story|ses)_(\d+)(?:_(ac|req|out)_?(\d+))?(?![a-z0-9])/gi;

/**
 * A skipped / pending test declaration (`it.skip(`, `test.fixme(`, `xit(`,
 * `@pytest.mark.skip`…): its title citation is a TODO, not verification, so
 * it does not count as coverage. Generated session-check skeletons rely on
 * this (decision 0024).
 */
const SKIPPED_RE = /\b(?:it|test|describe|context|scenario)\.(?:skip|todo|fixme)\s*\(|\bx(?:it|test|describe)\s*\(|@pytest\.mark\.skip|\[Ignore|@Disabled|@(?:skip|wip|ignore)\b/i;

/** Every product-id citation in one file's text. */
export function findRefsInText(text: string, path: string): ProductTestRef[] {
  const out: ProductTestRef[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (SKIPPED_RE.test(line)) return;
    for (const re of [CITED_RE, IDENT_RE]) {
      for (const m of line.matchAll(re)) {
        const raw = `${m[1]}-${m[2]}${m[3] ? `.${m[3]}-${m[4]}` : ""}`;
        out.push({ ref: normalizeProductRef(raw), path, line: i + 1 });
      }
    }
  });
  return out;
}

/**
 * Visit every test file in a working tree (bounded: file count and size), the
 * shared walk behind citation scanning and test-to-code bindings. The product
 * docs themselves and fixture trees are never visited.
 */
export function walkTestFiles(repoDir: string, visit: (relPath: string, text: string) => boolean | void): void {
  let files = 0;
  let stop = false;
  const walk = (abs: string, rel: string): void => {
    if (stop || files >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (stop) return;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || FIXTURE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        if (relPath === PRODUCT_DOCS_DIR) continue;
        walk(join(abs, entry.name), relPath);
      } else if (entry.isFile() && isTestPath(relPath) && CODE_EXT.test(entry.name)) {
        if (files >= MAX_FILES) return;
        const full = join(abs, entry.name);
        let text: string;
        try {
          if (statSync(full).size > MAX_FILE_BYTES) continue;
          text = readFileSync(full, "utf8");
        } catch {
          continue; // unreadable file — skip
        }
        files++;
        if (visit(relPath, text) === false) stop = true;
      }
    }
  };
  walk(repoDir, "");
}

/**
 * Scan a working tree's test files for product-id citations. Bounded (file
 * count, file size, total refs) so a huge monorepo can't stall a build; the
 * product docs themselves are never counted as tests.
 */
export function scanTestRefs(repoDir: string): ProductTestRef[] {
  return scanTests(repoDir).refs;
}

/** `import … from "x"`, `import "x"`, `require("x")`, `import("x")`, `vi.mock("x")`. */
const JS_IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\b(?:vi|jest)\.mock\s*\(\s*)["'`]([^"'`\n]+)["'`]/g;
/** `from pkg.mod import x` / `import pkg.mod` (Python). */
const PY_IMPORT_RE = /^\s*(?:from\s+([.\w]+)\s+import\b|import\s+([\w.]+))/gm;

/** Module specifiers a test file imports, in source order (deduplicated). */
export function testImportSpecifiers(text: string, path: string): string[] {
  const out = new Set<string>();
  if (path.endsWith(".py")) {
    for (const m of text.matchAll(PY_IMPORT_RE)) out.add((m[1] ?? m[2])!);
  } else {
    for (const m of text.matchAll(JS_IMPORT_RE)) out.add(m[1]!);
  }
  return [...out];
}

/** Normalize `a/./b/../c` without touching the filesystem. */
function joinSegments(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

const RESOLVE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".cs"];

/**
 * Resolve a test's import specifier to a documented repo file: relative
 * specifiers (any JS/TS extension or index convention), `@/` / `~/` aliases
 * onto `src/`, and dotted Python modules (optionally under `src/`). Bare
 * package specifiers resolve to nothing — they are not repo code.
 */
export function resolveTestImport(fromPath: string, specifier: string, known: Set<string>): string | undefined {
  const candidatesFor = (base: string): string[] => [
    base,
    ...RESOLVE_EXTS.map((e) => `${base}${e}`),
    ...RESOLVE_EXTS.map((e) => `${base}/index${e}`),
    `${base}/__init__.py`,
    base.replace(/\.jsx?$/, ".ts"),
    base.replace(/\.jsx?$/, ".tsx"),
  ];
  const pick = (base: string): string | undefined => candidatesFor(base).find((c) => known.has(c));
  if (fromPath.endsWith(".py") && !specifier.includes("/")) {
    const rel = specifier.startsWith(".");
    const dots = rel ? /^\.+/.exec(specifier)![0].length : 0;
    const mod = specifier.slice(dots).replace(/\./g, "/");
    if (rel) {
      const dir = fromPath.split("/").slice(0, -1);
      const base = joinSegments([...dir.slice(0, dir.length - (dots - 1)), mod].join("/"));
      return pick(base);
    }
    return pick(mod) ?? pick(`src/${mod}`);
  }
  if (specifier.startsWith(".")) {
    const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
    return pick(joinSegments(`${dir}/${specifier}`));
  }
  const alias = /^[@~]\/(.+)$/.exec(specifier);
  if (alias) return pick(`src/${alias[1]}`) ?? pick(alias[1]!);
  return undefined;
}

export interface TestScan {
  refs: ProductTestRef[];
  bindings: TestFileBinding[];
}

/**
 * One walk over the test files producing both the product-id citations
 * (traceability) and the test-to-code bindings (which repo files each test
 * imports). `knownPaths` is the doc model's file set; without it bindings
 * carry no `exercises`.
 */
export function scanTests(repoDir: string, knownPaths: Set<string> = new Set()): TestScan {
  const refs: ProductTestRef[] = [];
  const bindings: TestFileBinding[] = [];
  walkTestFiles(repoDir, (relPath, text) => {
    const fileRefs = findRefsInText(text, relPath);
    for (const ref of fileRefs) {
      if (refs.length >= MAX_REFS) break;
      refs.push(ref);
    }
    const exercises = new Set<string>();
    for (const spec of testImportSpecifiers(text, relPath)) {
      const hit = resolveTestImport(relPath, spec, knownPaths);
      if (hit && hit !== relPath) exercises.add(hit);
    }
    bindings.push({
      path: relPath,
      cites: [...new Set(fileRefs.map((r) => r.ref))],
      exercises: [...exercises].sort(),
    });
    return refs.length < MAX_REFS;
  });
  return { refs, bindings };
}
