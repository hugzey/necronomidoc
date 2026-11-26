import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DocFile, DocModel } from "@necronomidoc/docmodel";
import { buildAgentManifest, loadCuratedRecipes, loadSynonyms, mergeSynonymsFile, mineRecipes, mineUsageExamples } from "./agent.js";
import { findRefsInText, resolveTestImport, scanTests, testImportSpecifiers } from "./product/testrefs.js";

function file(path: string, symbols: { name: string; kind?: string; line?: number; endLine?: number; exported?: boolean }[], imports: { from: string; names: string[] }[] = []): DocFile {
  return {
    id: `r:${path}`,
    path,
    contentHash: path,
    format: "source",
    imports: imports.map((i) => ({ moduleSpecifier: i.from, names: i.names, isTypeOnly: false })),
    exports: symbols.filter((s) => s.exported !== false).map((s) => s.name),
    symbols: symbols.map((s) => ({
      id: `r:${path}#${s.name}`,
      name: s.name,
      kind: (s.kind ?? "function") as DocFile["symbols"][number]["kind"],
      exported: s.exported !== false,
      signature: `${s.name}()`,
      location: { path, line: s.line ?? 1, endLine: s.endLine },
      contentHash: s.name,
    })),
  };
}

const SOURCES: Record<string, string> = {
  "src/pages/CartPage.tsx": [
    'import { formatPrice } from "../utils/money";',
    "",
    "/** formatPrice is mentioned in a comment first. */",
    "export function CartPage() {",
    "  return <p>{formatPrice(",
    "    10, \"EUR\")}</p>;",
    "}",
  ].join("\n"),
  "src/pages/OrderPage.tsx": [
    "import {",
    "  formatPrice,",
    '} from "../utils/money";',
    "export function OrderPage() {",
    "  const total = formatPrice(5, \"USD\");",
    "  return <p>{total}</p>;",
    "}",
  ].join("\n"),
  "src/pages/HomePage.tsx": ["export function HomePage() {", "  return <main />;", "}"].join("\n"),
  "src/router.tsx": [
    'import { CartPage } from "./pages/CartPage";',
    'import { OrderPage } from "./pages/OrderPage";',
    'import { HomePage } from "./pages/HomePage";',
    "export const routes = [CartPage, OrderPage, HomePage];",
  ].join("\n"),
  "src/utils/money.ts": "export function formatPrice(amount: number, currency: string) {\n  return `${amount} ${currency}`;\n}",
};

const model: DocModel = {
  schemaVersion: 1,
  repo: { name: "r", slug: "r" },
  files: [
    file("src/pages/CartPage.tsx", [{ name: "CartPage", kind: "component", line: 4, endLine: 7 }], [{ from: "../utils/money", names: ["formatPrice"] }]),
    file("src/pages/OrderPage.tsx", [{ name: "OrderPage", kind: "component", line: 4, endLine: 7 }], [{ from: "../utils/money", names: ["formatPrice"] }]),
    file("src/pages/HomePage.tsx", [{ name: "HomePage", kind: "component", line: 1, endLine: 3 }]),
    file("src/router.tsx", [{ name: "routes", kind: "variable" }], [
      { from: "./pages/CartPage", names: ["CartPage"] },
      { from: "./pages/OrderPage", names: ["OrderPage"] },
      { from: "./pages/HomePage", names: ["HomePage"] },
    ]),
    file("src/utils/money.ts", [{ name: "formatPrice", line: 1, endLine: 3 }]),
  ],
};
const read = (p: string) => SOURCES[p];

describe("usage examples from real call sites", () => {
  it("finds up to two call sites per exported symbol, skipping imports and comments, spanning a multi-line call", () => {
    const usages = mineUsageExamples(model, read);
    const sites = usages["r:src/utils/money.ts#formatPrice"]!;
    expect(sites).toHaveLength(2);
    expect(sites[0]).toEqual({ path: "src/pages/CartPage.tsx", line: 5, snippet: 'return <p>{formatPrice(\n10, "EUR")}</p>;' });
    // The multi-line import block is skipped; the call on line 5 is used.
    expect(sites[1]).toMatchObject({ path: "src/pages/OrderPage.tsx", line: 5 });
    expect(usages["r:src/pages/CartPage.tsx#CartPage"]![0]!.snippet).toContain("routes = [CartPage");
  });

  it("yields nothing without readable sources", () => {
    expect(mineUsageExamples(model, () => undefined)).toEqual({});
  });
});

describe("recipes mined from repeated patterns", () => {
  it("detects the *Page pattern with a canonical example, its registration site and steps", () => {
    const recipes = mineRecipes(model, { read, tests: [{ path: "tests/pages.test.tsx", cites: [], exercises: ["src/pages/HomePage.tsx"] }] });
    const page = recipes.find((r) => r.title === "Add a page")!;
    expect(page).toBeDefined();
    expect(page.pattern).toBe("src/pages/*Page.tsx");
    expect(page.instances).toHaveLength(3);
    expect(page.example!.snippet.split("\n").length).toBeLessThanOrEqual(5);
    expect(page.files).toContain("src/router.tsx");
    expect(page.files).toContain("tests/pages.test.tsx");
    expect(page.steps[0]).toContain("src/pages/<Name>Page.tsx");
    expect(page.steps.some((s) => s.includes("Register it in `src/router.tsx`"))).toBe(true);
    // A lone util file is not a pattern.
    expect(recipes.some((r) => r.instances.includes("src/utils/money.ts"))).toBe(false);
  });
});

describe("curated recipes and synonyms", () => {
  const dir = mkdtempSync(join(tmpdir(), "necro-agent-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("loads recipes.yaml (curated wins on the same id) and synonyms.yaml", () => {
    writeFileSync(
      join(dir, "recipes.yaml"),
      "recipes:\n  - id: add-a-page-src-pages\n    title: Add a page\n    steps: [Copy HomePage, Add a route]\n  - title: Add a migration\n    steps: [Run make migration]\n",
    );
    writeFileSync(join(dir, "synonyms.yaml"), "Currency: [formatPrice, money]\nlogin: signIn\n");
    const curated = loadCuratedRecipes([dir]);
    expect(curated.map((r) => r.id)).toEqual(["add-a-page-src-pages", "add-a-migration"]);
    expect(curated.every((r) => r.provenance === "human")).toBe(true);
    expect(loadSynonyms([dir])).toEqual({ currency: ["formatPrice", "money"], login: ["signIn"] });

    const manifest = buildAgentManifest(model, { read, curatedDirs: [dir] });
    const pages = manifest.recipes.filter((r) => r.id === "add-a-page-src-pages");
    expect(pages).toHaveLength(1);
    expect(pages[0]!.provenance).toBe("human");
    expect(manifest.testsScanned).toBe(false);
  });

  it("merges new synonyms into synonyms.yaml without duplicating keys", () => {
    const { added } = mergeSynonymsFile(dir, { currency: ["money", "formatMoney"], price: ["formatPrice"] });
    expect(added).toBe(2);
    expect(loadSynonyms([dir])).toMatchObject({ currency: ["formatPrice", "money", "formatMoney"], price: ["formatPrice"] });
    expect(readFileSync(join(dir, "synonyms.yaml"), "utf8")).toContain("decision 0024");
  });
});

describe("test-to-code bindings", () => {
  it("parses JS/TS and Python imports", () => {
    expect(testImportSpecifiers('import { a } from "../src/a";\nconst b = require("./b");\nvi.mock("../src/c.js");\nimport "./d";', "t.test.ts")).toEqual(["../src/a", "./b", "../src/c.js", "./d"]);
    expect(testImportSpecifiers("from app.models import User\nimport app.views\n", "tests/test_x.py")).toEqual(["app.models", "app.views"]);
  });

  it("resolves relative, aliased and dotted-module imports to documented files", () => {
    const known = new Set(["src/a.ts", "src/c.ts", "src/lib/index.ts", "src/app/models.py", "pkg/__init__.py"]);
    expect(resolveTestImport("tests/a.test.ts", "../src/a", known)).toBe("src/a.ts");
    expect(resolveTestImport("tests/a.test.ts", "../src/c.js", known)).toBe("src/c.ts");
    expect(resolveTestImport("tests/a.test.ts", "@/lib", known)).toBe("src/lib/index.ts");
    expect(resolveTestImport("tests/test_m.py", "app.models", known)).toBe("src/app/models.py");
    expect(resolveTestImport("tests/a.test.ts", "vitest", known)).toBeUndefined();
  });

  it("scans tests once for citations and the files they exercise", () => {
    const repo = mkdtempSync(join(tmpdir(), "necro-tests-"));
    try {
      mkdirSync(join(repo, "tests"), { recursive: true });
      writeFileSync(
        join(repo, "tests", "money.test.ts"),
        'import { formatPrice } from "../src/utils/money";\nit("[STORY-1.AC-2] formats", () => {});\nit.skip("[STORY-1.AC-3] pending", () => {});\n',
      );
      const scan = scanTests(repo, new Set(model.files.map((f) => f.path)));
      expect(scan.refs.map((r) => r.ref)).toEqual(["STORY-1.AC-2"]);
      expect(scan.bindings).toEqual([{ path: "tests/money.test.ts", cites: ["STORY-1.AC-2"], exercises: ["src/utils/money.ts"] }]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not count skipped / pending tests as citations", () => {
    const text = [
      'test.fixme("[SES-1.OUT-1] skeleton", async () => {});',
      'xit("[STORY-2.AC-1] off", () => {});',
      'it("[STORY-2.AC-2] real", () => {});',
      "@wip @STORY-3.AC-1 Scenario: draft",
    ].join("\n");
    expect(findRefsInText(text, "t.test.ts").map((r) => r.ref)).toEqual(["STORY-2.AC-2"]);
  });
});
