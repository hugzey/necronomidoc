import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  normalizeProductRef,
  repoContentHash,
  type DocFile,
  type DocModel,
  type SessionDoc,
} from "@necronomidoc/docmodel";
import { buildEnrichmentTaskFile, applyEnrichmentResults } from "../llm/tasks.js";
import { LLM_PRODUCT_FILE, buildProduct } from "./build.js";
import { productFilesFromResponse, planProductDocs } from "./llm.js";
import { classifyEars, parseEars, parseGherkin, splitFrontmatter } from "./parse.js";
import { PRODUCT_TEMPLATES, fillTemplate, nextProductId, renderProductMarkdown } from "./templates.js";
import { findRefsInText, isTestPath } from "./testrefs.js";

/** Example ids are assembled at runtime so this repo's own traceability scan
 * (necronomidoc dogfoods product docs) doesn't read them as citations. */
const S = "STO" + "RY";
const tmp = mkdtempSync(join(tmpdir(), "necro-product-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function md(path: string, content: string): DocFile {
  return {
    id: `demo:${path}`,
    path,
    contentHash: `h-${content.length}-${path}`,
    format: "markdown",
    content,
    imports: [],
    exports: [],
    symbols: [],
  };
}

function source(path: string, symbols: { name: string; hash?: string; kind?: "function" | "component" }[]): DocFile {
  return {
    id: `demo:${path}`,
    path,
    contentHash: `h-${path}-${symbols.map((s) => s.hash ?? "").join("")}`,
    format: "source",
    imports: [],
    exports: symbols.map((s) => s.name),
    symbols: symbols.map((s) => ({
      id: `demo:${path}#${s.name}`,
      name: s.name,
      kind: s.kind ?? "function",
      exported: true,
      location: { path, line: 1 },
      contentHash: s.hash ?? `sh-${s.name}`,
    })),
  };
}

const PERSONA = `---
id: PER-001
title: Shopper
status: accepted
summary: Buys things.
---
# Shopper
`;
const JOB = `---
id: JOB-001
title: Buy an item
personas: PER-001
situation: I need something
motivation: buy it fast
outcome: I can move on
---
`;
const session = (extra = "", stepCode = "[src/cart.ts#checkout]") => `---
id: SES-001
title: Buy
status: accepted
persona: PER-001
job: JOB-001
intent: "Just let me pay"
steps:
  - id: S1
    action: Opens \`CartPage\`
  - id: S2
    action: Pays
    code: ${stepCode}
    outcome: OUT-1
    branches:
      - when: Declined
        goto: OUT-2
outcomes:
  - id: OUT-1
    kind: fulfilled
    title: Paid
  - id: OUT-2
    kind: abandoned
    title: Gave up
${extra}---
# Buy
`;

function model(files: DocFile[]): DocModel {
  return { schemaVersion: 1, repo: { name: "demo", slug: "demo" }, files };
}

const baseFiles = (sessionText = session()) => [
  md("docs/product/personas/PER-001-shopper.md", PERSONA),
  md("docs/product/jobs/JOB-001-buy.md", JOB),
  md("docs/product/sessions/SES-001-buy.md", sessionText),
  source("src/cart.ts", [{ name: "checkout" }]),
  source("src/pages/CartPage.tsx", [{ name: "CartPage", kind: "component" }]),
];

describe("product parsing", () => {
  it("splits YAML frontmatter from the body, reporting bad YAML", () => {
    const ok = splitFrontmatter("---\nid: PER-1\ntitle: x\n---\n# Body\n");
    expect(ok.data).toEqual({ id: "PER-1", title: "x" });
    expect(ok.body).toBe("# Body\n");
    expect(splitFrontmatter("# No frontmatter").data).toBeUndefined();
    expect(splitFrontmatter("---\nid: [unclosed\n---\n").error).toBeDefined();
  });

  it("extracts tagged Gherkin scenarios and flags untagged / Then-less ones", () => {
    const result = parseGherkin(
      [
        "```gherkin",
        "Feature: x",
        "  @AC-2 @smoke",
        "  Scenario: tagged",
        "    Given a",
        "    When b",
        "    Then c",
        "",
        "  Scenario Outline: untagged",
        "    Given <a>",
        "    When b",
        "```",
      ].join("\n"),
    );
    expect(result.criteria.map((c) => c.id)).toEqual(["AC-2", "AC-1"]);
    expect(result.criteria[0]!.tags).toEqual(["@smoke"]);
    expect(result.criteria[1]!.outline).toBe(true);
    expect(result.untagged).toEqual(["untagged"]);
    expect(result.missingThen).toEqual(["AC-1"]);
  });

  it("classifies EARS requirement templates", () => {
    expect(classifyEars("THE system SHALL log in")).toBe("ubiquitous");
    expect(classifyEars("WHEN a user clicks THE app SHALL save")).toBe("event-driven");
    expect(classifyEars("WHILE offline THE app SHALL queue writes")).toBe("state-driven");
    expect(classifyEars("IF the token expires, THEN THE api SHALL return 401")).toBe("unwanted-behaviour");
    expect(classifyEars("WHERE SSO is enabled THE app SHALL redirect")).toBe("optional-feature");
    expect(classifyEars("WHILE offline, WHEN saving THE app SHALL queue")).toBe("complex");
    expect(classifyEars("the app is fast")).toBe("unrecognized");
    const { requirements } = parseEars("- **REQ-1** THE app SHALL x\n```\n- REQ-9 ignored in code\n```\n- REQ-2: WHEN y THE app SHALL z");
    expect(requirements.map((r) => r.id)).toEqual(["REQ-1", "REQ-2"]);
  });

  it("normalizes ids and finds test citations in any naming style", () => {
    expect(normalizeProductRef(`${S}-007.AC-02`)).toBe(`${S}-7.AC-2`);
    expect(normalizeProductRef("ses-3/out-1")).toBe("SES-3.OUT-1");
    const refs = findRefsInText(
      `it("[${S}-012.AC-2] x")\ndef test_${S.toLowerCase()}_12_ac_3(): pass\n@SE${"S"}-3 history_12 [${"SE"}S-9.OUT-1, ${S}-4] ${S}-5 not cited\n`,
      "t.py",
    ).map((r) => `${r.ref}@${r.line}`);
    expect(refs).toEqual([`${S}-12.AC-2@1`, `${S}-12.AC-3@2`, "SE" + "S-3@3", "SE" + "S-9.OUT-1@3", `${S}-4@3`]);
    expect(isTestPath("src/a.test.ts")).toBe(true);
    expect(isTestPath("tests/test_api.py")).toBe(true);
    expect(isTestPath("src/a.ts")).toBe(false);
  });

  it("ships templates that parse, and allocates the next id", () => {
    for (const type of Object.keys(PRODUCT_TEMPLATES) as (keyof typeof PRODUCT_TEMPLATES)[]) {
      const filled = fillTemplate(type, "X-001", 'Title with "quotes"');
      const split = splitFrontmatter(filled);
      expect(split.error, type).toBeUndefined();
      expect((split.data as { title: string }).title).toBe('Title with "quotes"');
    }
    expect(nextProductId("story", [`${S}-002`, `${S}-010-x.md`, "JOB-099"])).toBe(`${S}-011`);
  });
});

describe("buildProduct", () => {
  it("resolves a curated set with backlinks, bindings, diagrams and coverage", () => {
    const manifest = buildProduct(model(baseFiles()), {
      testRefs: [{ ref: "SES-1.OUT-1", path: "tests/a.test.ts", line: 3 }],
    });
    expect(manifest.source).toBe("curated");
    expect(manifest.docs.map((d) => d.id)).toEqual(["PER-001", "JOB-001", "SES-001"]);
    const persona = manifest.docs.find((d) => d.id === "PER-001")!;
    expect(persona.referencedBy).toEqual([
      { id: "JOB-001", rel: "personas" },
      { id: "SES-001", rel: "persona" },
    ]);
    const ses = manifest.docs.find((d) => d.id === "SES-001") as SessionDoc;
    expect(ses.bindings.map((b) => `${b.step}:${b.ref}:${b.state}:${b.inferred}`)).toEqual([
      "S1:CartPage:ok:true",
      "S2:src/cart.ts#checkout:ok:false",
    ]);
    expect(ses.diagrams.flow).toContain("S2 -.->|\"Declined\"| OUT_2");
    expect(ses.diagrams.sequence).toContain("actor U as Shopper");
    expect(ses.tests).toHaveLength(1);
    expect(manifest.coverage).toMatchObject({ outcomes: 2, outcomesTested: 1, surfaces: 1, surfacesCovered: 1 });
    expect(manifest.findings.map((f) => f.code)).toEqual(["untested-outcomes"]);
    expect(manifest.diagram).toContain("PER_001");
  });

  it("validates references and the session graph", () => {
    const bad = session(
      `stories: [${S}-404]\n`,
    ).replace("goto: OUT-2", "goto: S9").replace("kind: fulfilled", "kind: partial");
    const manifest = buildProduct(model([...baseFiles(bad)]));
    const codes = manifest.findings.map((f) => f.code);
    expect(codes).toContain("dangling-ref");
    expect(codes).toContain("unknown-target");
    expect(codes).toContain("no-fulfilled-outcome");
    expect(codes).toContain("unreachable-outcome");
  });

  it("reports schema errors and wrong-typed references without dropping the rest", () => {
    const manifest = buildProduct(
      model([
        ...baseFiles(),
        md("docs/product/stories/STORY-001-x.md", "---\nid: STORY-001\ntitle: x\npersona: JOB-001\nwant: a\nsoThat: b\nbogus: 1\n---\n"),
        md("docs/product/stories/STORY-002-x.md", "---\nid: STORY-002\ntitle: missing want\n---\n"),
        md("docs/product/glossary.md", "# Glossary\n"),
        md("docs/product/_templates/story.md", PRODUCT_TEMPLATES.story),
      ]),
    );
    const codes = manifest.findings.map((f) => f.code);
    expect(codes).toContain("wrong-ref-type");
    expect(codes).toContain("unknown-field");
    expect(codes).toContain("schema");
    expect(manifest.docs.map((d) => d.id)).toContain("STORY-001");
    expect(manifest.docs.map((d) => d.id)).not.toContain("STORY-002");
  });

  it("detects drift: broken targets, changed targets, and re-baselines when the doc is edited", () => {
    const first = buildProduct(model(baseFiles()));
    // The code under S2 changes; the doc does not → changed + stale.
    const changedModel = model(baseFiles().map((f) => (f.path === "src/cart.ts" ? source("src/cart.ts", [{ name: "checkout", hash: "v2" }]) : f)));
    const second = buildProduct(changedModel, { previous: first });
    const ses = second.docs.find((d) => d.id === "SES-001")!;
    expect(ses.bindings.find((b) => b.step === "S2")!.state).toBe("changed");
    expect(ses.stale).toBe(true);
    expect(second.findings.some((f) => f.code === "changed-binding")).toBe(true);
    // Still changed on the next build — the baseline persists until reviewed.
    const third = buildProduct(changedModel, { previous: second });
    expect(third.docs.find((d) => d.id === "SES-001")!.stale).toBe(true);
    // Bumping `verified:` edits the doc → re-baselined, fresh.
    const verified = model(
      changedModel.files.map((f) => (f.path.includes("SES-001") ? md(f.path, session("verified: 2026-11-19\n")) : f)),
    );
    const fourth = buildProduct(verified, { previous: third });
    expect(fourth.docs.find((d) => d.id === "SES-001")!.stale).toBe(false);
    // The target disappears → broken, an error on an accepted doc.
    const broken = buildProduct(model(baseFiles(session("", "[src/gone.ts#nope]"))));
    expect(broken.findings.find((f) => f.code === "broken-binding")?.level).toBe("error");
  });

  it("falls back to an LLM draft set only when nothing is curated, flagging staleness", () => {
    const llmDir = join(tmp, "llm");
    mkdirSync(llmDir, { recursive: true });
    const files = productFilesFromResponse(
      JSON.stringify({
        overview: "A shop.",
        personas: [{ id: "PER-001", title: "Shopper", summary: "Buys.", goals: ["buy"] }],
        jobs: [{ id: "JOB-001", title: "Buy", personas: ["PER-001"], situation: "s", motivation: "m", outcome: "o", importance: "HUGE" }],
        stories: [
          {
            id: "STORY-001",
            title: "Pay",
            persona: "PER-001",
            want: "to pay",
            soThat: "I own it",
            jobs: ["JOB-001"],
            priority: "must",
            acceptance: [{ id: "AC-1", title: "pays", gherkin: "Given a cart\nWhen I pay\nThen I own it" }],
            requirements: [{ id: "REQ-1", text: "WHEN paid THE shop SHALL email a receipt" }],
          },
        ],
        sessions: [
          {
            id: "SES-001",
            title: "Buy",
            persona: "PER-001",
            job: "JOB-001",
            intent: "pay",
            steps: [{ id: "S1", action: "Pays", code: ["src/cart.ts#checkout"], outcome: "OUT-1" }],
            outcomes: [{ id: "OUT-1", kind: "fulfilled", title: "Paid", criteria: ["receipt"] }],
            stories: ["STORY-001"],
            narrative: "They pay.",
          },
        ],
      }),
    );
    expect(files.some((f) => f.path === "docs/product/README.md")).toBe(true);
    const code = [source("src/cart.ts", [{ name: "checkout" }])];
    const hash = repoContentHash(code);
    writeFileSync(join(llmDir, LLM_PRODUCT_FILE), JSON.stringify({ sourceRepoHash: hash, files }));

    const fresh = buildProduct(model(code), { llmDir });
    expect(fresh.source).toBe("llm");
    expect(fresh.stale).toBe(false);
    expect(fresh.overview).toBe("A shop.");
    expect(fresh.findings.filter((f) => f.level === "error")).toEqual([]);
    const story = fresh.docs.find((d) => d.id === "STORY-001")!;
    expect(story.provenance).toBe("llm");
    expect(story.status).toBe("proposed");
    expect(story.acceptance[0]!.text).toContain("Then I own it");
    expect(story.requirements[0]!.pattern).toBe("event-driven");
    expect(planProductDocs(model(code), { llmDir })).toEqual({ needed: false, reason: "fresh" });

    const changed = [source("src/cart.ts", [{ name: "checkout", hash: "v2" }])];
    expect(buildProduct(model(changed), { llmDir }).stale).toBe(true);
    expect(planProductDocs(model(changed), { llmDir }).reason).toBe("stale");

    // Any curated doc replaces the whole draft set.
    const curated = buildProduct(model([...changed, md("docs/product/personas/PER-009.md", PERSONA.replace("PER-001", "PER-009"))]), { llmDir });
    expect(curated.source).toBe("curated");
    expect(curated.docs.map((d) => d.id)).toEqual(["PER-009"]);
  });

  it("merges server overrides by id, with the repo file winning a clash", () => {
    const overrideDir = join(tmp, "override");
    mkdirSync(join(overrideDir, "personas"), { recursive: true });
    writeFileSync(join(overrideDir, "personas", "PER-001.md"), PERSONA.replace("Shopper", "Override shopper"));
    writeFileSync(join(overrideDir, "personas", "PER-002.md"), PERSONA.replace("PER-001", "PER-002"));
    const manifest = buildProduct(model(baseFiles()), { overrideDir });
    expect(manifest.docs.find((d) => d.id === "PER-001")!.title).toBe("Shopper");
    expect(manifest.docs.find((d) => d.id === "PER-002")!.provenance).toBe("override");
    expect(manifest.findings.some((f) => f.code === "override-shadowed")).toBe(true);
  });
});

describe("product rendering + agent tasks", () => {
  it("renders frontmatter without empty fields", () => {
    const text = renderProductMarkdown({ id: "PER-1", title: "x", goals: [], role: undefined }, "# x");
    expect(text).toBe("---\nid: PER-1\ntitle: x\n---\n\n# x\n");
  });

  it("exports a product task and applies its result as a draft set", () => {
    const m = model([source("src/cart.ts", [{ name: "checkout" }])]);
    const { taskFile } = buildEnrichmentTaskFile(m, { overlays: new Map(), readSource: () => undefined, product: true, maxFiles: 0 });
    const task = taskFile.tasks.find((t) => t.kind === "product")!;
    expect(task.request.prompt).toContain("src/cart.ts#checkout");
    const applied = applyEnrichmentResults(taskFile, {
      formatVersion: 1,
      model: "agent",
      results: [
        {
          id: "product",
          output: { personas: [{ id: "PER-001", title: "P", summary: "s" }], jobs: [], sessions: [], stories: [] },
        },
      ],
    });
    expect(applied.product?.files.map((f) => f.path)).toEqual(["docs/product/personas/PER-001-p.md"]);
    expect(applied.product?.sourceRepoHash).toBe(repoContentHash(m.files));
  });
});
