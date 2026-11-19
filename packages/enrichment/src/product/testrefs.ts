import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PRODUCT_DOCS_DIR, normalizeProductRef, type ProductTestRef } from "@necronomidoc/docmodel";

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

/** Every product-id citation in one file's text. */
export function findRefsInText(text: string, path: string): ProductTestRef[] {
  const out: ProductTestRef[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
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
 * Scan a working tree's test files for product-id citations. Bounded (file
 * count, file size, total refs) so a huge monorepo can't stall a build; the
 * product docs themselves are never counted as tests.
 */
export function scanTestRefs(repoDir: string): ProductTestRef[] {
  const out: ProductTestRef[] = [];
  let files = 0;
  const walk = (abs: string, rel: string): void => {
    if (files >= MAX_FILES || out.length >= MAX_REFS) return;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || FIXTURE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        if (relPath === PRODUCT_DOCS_DIR) continue;
        walk(join(abs, entry.name), relPath);
      } else if (entry.isFile() && isTestPath(relPath) && CODE_EXT.test(entry.name)) {
        if (files >= MAX_FILES) return;
        const full = join(abs, entry.name);
        try {
          if (statSync(full).size > MAX_FILE_BYTES) continue;
          files++;
          for (const ref of findRefsInText(readFileSync(full, "utf8"), relPath)) {
            if (out.length >= MAX_REFS) return;
            out.push(ref);
          }
        } catch {
          // unreadable file — skip
        }
      }
    }
  };
  walk(repoDir, "");
  return out;
}
