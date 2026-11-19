import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProductManifest } from "@necronomidoc/docmodel";
import type { LlmClient } from "@necronomidoc/enrichment";
import { ManifestStore, paths, tools } from "@necronomidoc/mcp";
import { buildRepo } from "./build.js";
import { enrichRepo } from "./enrich.js";
import { exportProductDrafts, initProductDocs, lintProduct, newProductDoc } from "./product.js";

const fixture = fileURLToPath(new URL("../../../fixtures/sample-product", import.meta.url));

function readProduct(dataDir: string, slug: string): ProductManifest {
  return ProductManifest.parse(JSON.parse(readFileSync(paths.product(paths.repoDir(dataDir, slug)), "utf8")));
}

describe("product docs through the build, MCP and CLI helpers", () => {
  let dataDir: string;
  let work: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "necro-product-e2e-"));
    work = mkdtempSync(join(tmpdir(), "necro-product-repo-"));
    cpSync(fixture, work, { recursive: true });
  });
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  it("[STORY-001.AC-1] publishes product.json with bindings, test traceability and a search/llms.txt presence", async () => {
    await buildRepo({ dataDir, target: work, name: "shop" });
    const product = readProduct(dataDir, "shop");
    expect(product.source).toBe("curated");
    expect(product.docs.map((d) => d.id)).toEqual(["PER-001", "JOB-001", "STORY-001", "JRN-001", "SES-001"]);
    expect(product.coverage).toMatchObject({ testsScanned: true, criteriaTested: 2, outcomesTested: 1, bindingsBroken: 1 });
    expect(product.overview).toMatch(/^The shop serves/);

    const store = new ManifestStore(dataDir);
    store.reload();
    const hits = tools.search_docs(store, { query: "returning shopper", repo: "shop" }) as { hits: { type: string }[] };
    expect(hits.hits.some((h) => h.type === "product")).toBe(true);
    const llms = readFileSync(paths.llmsTxt(paths.repoDir(dataDir, "shop")), "utf8");
    expect(llms).toContain("JOB-001 Buy a known item: When I already know which item I need");
  });

  it("[STORY-004.AC-1] answers the product MCP tools, including which intents run through a file", () => {
    const store = new ManifestStore(dataDir);
    store.reload();
    const overview = tools.get_product_overview(store, { repo: "shop" }) as { sessions: { id: string }[]; findings: { errors: number } };
    expect(overview.sessions.map((s) => s.id)).toEqual(["SES-001"]);
    expect(overview.findings.errors).toBe(1);

    const doc = tools.get_product_doc(store, { repo: "shop", id: "ses-1" }) as { id: string; statement: string; referencedBy: { id: string }[] };
    expect(doc.id).toBe("SES-001");
    expect(doc.statement).toContain("just let me pay");
    expect(doc.referencedBy.map((l) => l.id)).toEqual(["JRN-001"]);

    const intents = tools.find_intents_for_code(store, { repo: "shop", path: "src/api/cart.ts", symbol: "checkout" }) as {
      intents: { id: string; steps?: { id: string }[]; acceptanceToPreserve?: { id: string }[] }[];
    };
    expect(intents.intents.map((i) => i.id)).toEqual(["STORY-001", "SES-001"]);
    expect(intents.intents.find((i) => i.id === "SES-001")!.steps!.map((s) => s.id)).toEqual(["S3"]);
    expect(intents.intents.find((i) => i.id === "STORY-001")!.acceptanceToPreserve!.map((a) => a.id)).toContain("STORY-001.AC-1");
  });

  it("[SES-001.OUT-1] an agent finds existing code by concept and reads its signature", () => {
    const store = new ManifestStore(dataDir);
    store.reload();
    const search = tools.search_docs(store, { query: "pay for the cart create an order", repo: "shop" }) as {
      hits: { id: string; type: string; name: string }[];
    };
    const hit = search.hits.find((h) => h.type === "symbol" && h.name === "checkout");
    expect(hit).toBeDefined();
    const doc = tools.get_function_doc(store, { repo: "shop", id: hit!.id }) as { signature?: string; path?: string };
    expect(doc.signature).toBe("checkout()");
    expect(doc.path).toBe("src/api/cart.ts");
  });

  it("[SES-001.OUT-2] an agent learns where new code belongs from subsystem boundaries", () => {
    const store = new ManifestStore(dataDir);
    store.reload();
    const overview = tools.get_subsystem_overview(store, { repo: "shop" }) as {
      subsystems: { dirs: string[]; files: { path: string }[] }[];
    };
    expect(overview.subsystems.length).toBeGreaterThan(0);
    expect(overview.subsystems.some((s) => s.files.some((f) => f.path === "src/api/cart.ts"))).toBe(true);
  });

  it("[STORY-003.AC-2] flags drift across rebuilds when bound code changes under an unchanged doc", async () => {
    const cart = join(work, "src/api/cart.ts");
    writeFileSync(cart, readFileSync(cart, "utf8").replace('method: "POST" });\n  return', 'method: "POST", credentials: "include" });\n  return'));
    await buildRepo({ dataDir, target: work, name: "shop" });
    const product = readProduct(dataDir, "shop");
    const ses = product.docs.find((d) => d.id === "SES-001")!;
    expect(ses.stale).toBe(true);
    expect(ses.bindings.find((b) => b.ref === "src/api/cart.ts#checkout")?.state).toBe("changed");
    expect(product.coverage.bindingsChanged).toBeGreaterThan(0);
  });

  it("[STORY-003.AC-1] [STORY-003.REQ-1] [SES-003.OUT-1] [SES-003.OUT-2] lints a working tree, scaffolds docs/product and allocates ids", async () => {
    const lint = await lintProduct(work);
    expect(lint.findings.some((f) => f.code === "broken-binding" && f.level === "error")).toBe(true);
    expect(lint.findings.some((f) => f.code === "orphan-test-ref")).toBe(true);

    const fresh = mkdtempSync(join(tmpdir(), "necro-product-init-"));
    try {
      const scaffold = initProductDocs(fresh);
      expect(scaffold.written).toContain("_templates/session.md");
      expect(existsSync(join(fresh, "docs/product/schema.json"))).toBe(true);
      const first = newProductDoc(fresh, "session", "Admin rotates a key");
      const second = newProductDoc(fresh, "session", "Another");
      expect(first).toEqual({ id: "SES-001", path: "docs/product/sessions/SES-001-admin-rotates-a-key.md" });
      expect(second.id).toBe("SES-002");
      expect(() => newProductDoc(fresh, "widget", "x")).toThrow(/Unknown product doc type/);
      // A fresh scaffold lints with only TODO/dangling findings from the new docs.
      const scaffoldLint = await lintProduct(fresh);
      expect(scaffoldLint.docs.map((d) => d.id)).toEqual(["SES-001", "SES-002"]);
      expect(scaffoldLint.findings.some((f) => f.code === "todo-marker")).toBe(true);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("drafts product docs with enrich --product when none are curated, and exports them", async () => {
    const bare = mkdtempSync(join(tmpdir(), "necro-product-bare-"));
    const out = mkdtempSync(join(tmpdir(), "necro-product-out-"));
    try {
      cpSync(fixture, bare, { recursive: true });
      rmSync(join(bare, "docs"), { recursive: true, force: true });
      const draft = {
        personas: [{ id: "PER-001", title: "Shopper", summary: "Buys things." }],
        jobs: [{ id: "JOB-001", title: "Buy", personas: ["PER-001"], situation: "s", motivation: "m", outcome: "o" }],
        stories: [],
        sessions: [
          {
            id: "SES-001",
            title: "Buy",
            persona: "PER-001",
            job: "JOB-001",
            intent: "pay",
            steps: [{ id: "S1", action: "Pays", code: ["src/api/cart.ts#checkout"], outcome: "OUT-1" }],
            outcomes: [{ id: "OUT-1", kind: "fulfilled", title: "Paid", criteria: [] }],
          },
        ],
      };
      const client: LlmClient = {
        model: "fake",
        async complete(request) {
          const schema = request.jsonSchema as { properties?: Record<string, unknown> } | undefined;
          if (schema?.properties && "personas" in schema.properties) {
            return { text: JSON.stringify(draft), inputTokens: 10, outputTokens: 10 };
          }
          // Overlay requests: answer with empty summaries.
          return { text: JSON.stringify({ file: { summary: "s" }, symbols: [] }), inputTokens: 1, outputTokens: 1 };
        },
      };
      const result = await enrichRepo({ dataDir, target: bare, name: "bare", client, product: true, coreDocs: false });
      expect(result.product).toEqual({ reason: "missing", written: 3 });
      const product = readProduct(dataDir, "bare");
      expect(product.source).toBe("llm");
      expect(product.docs.every((d) => d.provenance === "llm" && d.status === "proposed")).toBe(true);

      // A second run with unchanged code makes no product call.
      const again = await enrichRepo({ dataDir, target: bare, name: "bare", client, product: true, coreDocs: false });
      expect(again.product?.reason).toBe("fresh");

      const exported = exportProductDrafts(dataDir, "bare", out);
      expect(exported.written).toContain("sessions/SES-001-buy.md");
      expect(readFileSync(join(out, "sessions/SES-001-buy.md"), "utf8")).toContain("status: proposed");
    } finally {
      rmSync(bare, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });
});
