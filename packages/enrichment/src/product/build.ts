import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  LlmProductSet,
  PRODUCT_DOCS_DIR,
  PRODUCT_FRONTMATTER_SCHEMAS,
  PRODUCT_TYPE_DIRS,
  SCHEMA_VERSION,
  hashContent,
  normalizeProductRef,
  productTypeOfId,
  repoContentHash,
  type CodeBinding,
  type DocModel,
  type ProductCoverage,
  type ProductDoc,
  type ProductDocType,
  type ProductFinding,
  type ProductManifest,
  type ProductSurface,
  type ProductTestRef,
  type SessionFrontmatter,
} from "@necronomidoc/docmodel";
import { bindingKey, backtickedRefs, createBindingResolver, resolveBindings } from "./bindings.js";
import {
  intentMapDiagram,
  journeyDiagram,
  sessionEmotionDiagram,
  sessionFlowDiagram,
  sessionSequenceDiagram,
  stepSuccessor,
} from "./diagrams.js";
import { parseEars, parseGherkin, splitFrontmatter } from "./parse.js";
import { FIXTURE_DIRS } from "./testrefs.js";

/**
 * Resolve a repo's product documentation (decision 0023) into the published
 * `ProductManifest`. Source precedence mirrors core docs:
 *
 *   repo      `docs/product/**` in the source repo (read from the doc model's
 *             markdown files, so pre-extracted IR works too)
 *   override  `data/enrichment/<slug>/product/**` — server-side curation,
 *             merged with repo docs by id (repo wins on a clash)
 *   llm       `product.llm.json` — an LLM-proposed draft set, used only when
 *             no curated document exists (whole-set semantics, like subsystems)
 *
 * Every document is validated (schema, cross-references, session graph),
 * bound to the code it exercises (drift: broken / changed), traced to tests
 * citing its ids, linked both ways, and diagrammed.
 */

/** Server-side override dir under `data/enrichment/<slug>/`. */
export const PRODUCT_OVERRIDE_SUBDIR = "product";
/** Server-side cache of the LLM-proposed product set. */
export const LLM_PRODUCT_FILE = "product.llm.json";

export interface ProductSourceFile {
  /** Repo-relative path (`docs/product/sessions/SES-001-x.md`). */
  path: string;
  content: string;
  provenance: "repo" | "override" | "llm";
}

export interface BuildProductOptions {
  /** `data/enrichment/<slug>/product/` override tree. */
  overrideDir?: string;
  /** `data/enrichment/<slug>/` holding the LLM cache. */
  llmDir?: string;
  /** Test citations from `scanTestRefs`; undefined = tests not scanned. */
  testRefs?: ProductTestRef[];
  /** The previously published manifest — the code-binding drift baseline. */
  previous?: ProductManifest;
  /** Ignore the override and LLM tiers (the CLI linter checks repo files only). */
  repoOnly?: boolean;
  /**
   * Candidate docs to lint in place (agent proposals, decision 0024): they
   * replace any source at the same path and win over every tier on their id.
   */
  proposed?: ProductSourceFile[];
  now?: () => string;
}

/** Is this repo-relative path a product doc source (not a template/README)? */
function isProductPath(path: string): boolean {
  if (!path.startsWith(`${PRODUCT_DOCS_DIR}/`)) return false;
  const rest = path.slice(PRODUCT_DOCS_DIR.length + 1);
  return /\.(md|markdown)$/i.test(rest) && !rest.split("/").some((seg) => seg.startsWith("_"));
}

/** Product doc sources shipped in the repo, taken from the extracted model. */
export function repoProductFiles(model: DocModel): ProductSourceFile[] {
  return model.files
    .filter((f) => f.format === "markdown" && f.content !== undefined && isProductPath(f.path))
    .map((f) => ({ path: f.path, content: f.content!, provenance: "repo" as const }));
}

/** Read a server-side override tree (`…/product/**.md`) as product sources. */
export function overrideProductFiles(dir: string): ProductSourceFile[] {
  const out: ProductSourceFile[] = [];
  const walk = (abs: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(abs, entry.name), relPath);
      else if (entry.isFile()) {
        const path = `${PRODUCT_DOCS_DIR}/${relPath}`;
        if (isProductPath(path)) {
          out.push({ path, content: readFileSync(join(abs, entry.name), "utf8"), provenance: "override" });
        }
      }
    }
  };
  if (existsSync(dir)) walk(dir, "");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Load the LLM-proposed product set cache, tolerating a corrupt file. */
export function loadLlmProductSet(dir: string): LlmProductSet | undefined {
  const path = join(dir, LLM_PRODUCT_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = LlmProductSet.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (parsed.success) return parsed.data;
    console.warn(`[enrichment] invalid ${path}: ${parsed.error.message}`);
  } catch (err) {
    console.warn(`[enrichment] ignoring unreadable ${path}: ${(err as Error).message}`);
  }
  return undefined;
}

// ---- Parsing one source file ----

interface ParsedDoc {
  doc: ProductDoc;
  /** Raw content (TODO scan). */
  content: string;
}

const KNOWN_KEYS: Record<ProductDocType, Set<string>> = Object.fromEntries(
  Object.entries(PRODUCT_FRONTMATTER_SCHEMAS).map(([type, schema]) => [type, new Set(Object.keys(schema.shape))]),
) as Record<ProductDocType, Set<string>>;

function parseSource(
  file: ProductSourceFile,
  findings: ProductFinding[],
): ParsedDoc | { overview: string } | undefined {
  const split = splitFrontmatter(file.content);
  const rest = file.path.slice(PRODUCT_DOCS_DIR.length + 1);
  const inTypeDir = Object.values(PRODUCT_TYPE_DIRS).includes(rest.split("/")[0]!);
  // README is the product narrative; its own `# title` is page chrome, not content.
  if (/^readme\.(md|markdown)$/i.test(rest)) {
    return { overview: split.body.replace(/^\s*#\s+.*\n?/, "").trim() };
  }

  if (split.error) {
    findings.push({ level: "error", code: "frontmatter-invalid", message: `YAML frontmatter does not parse: ${split.error}`, path: file.path });
    return undefined;
  }
  const data = split.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.id !== "string") {
    // Free-form pages (glossary.md, notes) are fine outside the type dirs.
    if (inTypeDir) {
      findings.push({ level: "error", code: "frontmatter-missing", message: "product doc has no frontmatter `id` — start the file with a `---` YAML block (see _templates/).", path: file.path });
    }
    return undefined;
  }
  const id = data.id;
  const type = productTypeOfId(id);
  if (!type) {
    findings.push({ level: "error", code: "bad-id", message: `id "${id}" has no known prefix (PER, JOB, EPIC, STORY, JRN, SES).`, path: file.path, docId: id });
    return undefined;
  }
  if (data.type !== undefined && data.type !== type) {
    findings.push({ level: "error", code: "id-type-mismatch", message: `\`type: ${String(data.type)}\` contradicts the ${id} prefix (${type}).`, path: file.path, docId: id });
    return undefined;
  }
  const dir = rest.split("/")[0];
  if (inTypeDir && dir !== PRODUCT_TYPE_DIRS[type]) {
    findings.push({ level: "warn", code: "id-dir-mismatch", message: `${id} is a ${type} but lives in ${dir}/ — move it to ${PRODUCT_TYPE_DIRS[type]}/.`, path: file.path, docId: id });
  }

  const parsed = PRODUCT_FRONTMATTER_SCHEMAS[type].safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 6)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    findings.push({ level: "error", code: "schema", message: `frontmatter does not match the ${type} schema — ${issues}`, path: file.path, docId: id });
    return undefined;
  }
  const unknown = Object.keys(data).filter((k) => !KNOWN_KEYS[type].has(k));
  if (unknown.length > 0) {
    findings.push({ level: "warn", code: "unknown-field", message: `unknown frontmatter field(s) ${unknown.map((k) => `\`${k}\``).join(", ")} — ignored (typo?).`, path: file.path, docId: id });
  }

  const body = split.body.replace(/^\s*\n/, "");
  const withCriteria = type === "story" || type === "session";
  const gherkin = withCriteria ? parseGherkin(body) : undefined;
  const ears = withCriteria ? parseEars(body) : undefined;
  if (gherkin) {
    for (const title of gherkin.untagged) {
      findings.push({ level: "warn", code: "untagged-scenario", message: `scenario "${title}" has no @AC-n tag — an id was assigned, but pin it so tests can cite it stably.`, path: file.path, docId: id });
    }
    for (const acId of gherkin.missingThen) {
      findings.push({ level: "warn", code: "scenario-no-then", message: `${acId} has no \`Then\` step — a criterion needs an observable result.`, path: file.path, docId: id });
    }
    for (const acId of gherkin.duplicates) {
      findings.push({ level: "error", code: "duplicate-criterion", message: `${acId} is used by more than one scenario.`, path: file.path, docId: id });
    }
  }
  if (ears) {
    for (const req of ears.requirements.filter((r) => r.pattern === "unrecognized")) {
      findings.push({ level: "warn", code: "ears-pattern", message: `${req.id} doesn't follow an EARS template ("[WHILE …] [WHEN …] THE <system> SHALL …").`, path: file.path, docId: id });
    }
    for (const reqId of ears.duplicates) {
      findings.push({ level: "error", code: "duplicate-requirement", message: `${reqId} is defined more than once.`, path: file.path, docId: id });
    }
  }

  const doc = {
    ...parsed.data,
    type,
    path: file.path,
    provenance: file.provenance,
    stale: false,
    docHash: hashContent(file.content),
    body,
    acceptance: gherkin?.criteria ?? [],
    requirements: ears?.requirements ?? [],
    bindings: [],
    diagrams: {},
    referencedBy: [],
    tests: [],
  } as ProductDoc;
  return { doc, content: file.content };
}

// ---- Cross-document validation ----

type RefField = { rel: string; ids: string[]; expect: ProductDocType };

/** Every outbound id reference a document makes, with the type it must name. */
function outboundRefs(doc: ProductDoc): RefField[] {
  switch (doc.type) {
    case "persona":
      return [];
    case "job":
      return [{ rel: "personas", ids: doc.personas, expect: "persona" }];
    case "epic":
      return [{ rel: "jobs", ids: doc.jobs, expect: "job" }];
    case "story":
      return [
        { rel: "persona", ids: [doc.persona], expect: "persona" },
        { rel: "jobs", ids: doc.jobs, expect: "job" },
        { rel: "epic", ids: doc.epic ? [doc.epic] : [], expect: "epic" },
      ];
    case "journey":
      return [
        { rel: "persona", ids: [doc.persona], expect: "persona" },
        { rel: "jobs", ids: doc.jobs, expect: "job" },
        { rel: "stage.sessions", ids: doc.stages.flatMap((s) => s.sessions), expect: "session" },
        { rel: "stage.stories", ids: doc.stages.flatMap((s) => s.stories), expect: "story" },
      ];
    case "session":
      return [
        { rel: "persona", ids: [doc.persona], expect: "persona" },
        { rel: "job", ids: [doc.job], expect: "job" },
        { rel: "stories", ids: doc.stories, expect: "story" },
        { rel: "journey", ids: doc.journey ? [typeof doc.journey === "string" ? doc.journey : doc.journey.id] : [], expect: "journey" },
      ];
  }
}

/** Validate a session's step graph: targets exist, everything reachable, a path to fulfilment. */
function checkSessionGraph(session: SessionFrontmatter & { path: string }, findings: ProductFinding[]): void {
  const push = (level: ProductFinding["level"], code: string, message: string): void => {
    findings.push({ level, code, message, docId: session.id, path: session.path });
  };
  const stepIds = new Set<string>();
  for (const step of session.steps) {
    if (stepIds.has(step.id)) push("error", "duplicate-step", `step ${step.id} is defined twice.`);
    stepIds.add(step.id);
  }
  const outcomeIds = new Set<string>();
  for (const outcome of session.outcomes) {
    if (outcomeIds.has(outcome.id)) push("error", "duplicate-outcome", `outcome ${outcome.id} is defined twice.`);
    outcomeIds.add(outcome.id);
  }
  const exists = (target: string): boolean => stepIds.has(target) || outcomeIds.has(target);

  const edges = new Map<string, string[]>();
  session.steps.forEach((step, i) => {
    const out: string[] = [];
    if (step.outcome && !outcomeIds.has(step.outcome)) {
      push("error", "unknown-target", `${step.id} ends in \`outcome: ${step.outcome}\`, which is not one of this session's outcomes.`);
    }
    if (step.next && !exists(step.next)) {
      push("error", "unknown-target", `${step.id} has \`next: ${step.next}\`, which is neither a step nor an outcome.`);
    }
    const succ = stepSuccessor(session, i);
    if (succ && exists(succ)) out.push(succ);
    if (!succ) push("warn", "dead-end-step", `${step.id} is the last step but declares no \`outcome\` — how does the session end?`);
    for (const branch of step.branches) {
      if (!exists(branch.goto)) push("error", "unknown-target", `${step.id} branch "${branch.when}" goes to ${branch.goto}, which is neither a step nor an outcome.`);
      else out.push(branch.goto);
    }
    edges.set(step.id, out);
  });

  const reached = new Set<string>();
  const queue = session.steps[0] ? [session.steps[0].id] : [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (reached.has(node)) continue;
    reached.add(node);
    for (const next of edges.get(node) ?? []) queue.push(next);
  }
  for (const step of session.steps) {
    if (!reached.has(step.id)) push("warn", "unreachable-step", `${step.id} can't be reached from ${session.steps[0]!.id}.`);
  }
  for (const outcome of session.outcomes) {
    if (!reached.has(outcome.id)) push("warn", "unreachable-outcome", `${outcome.id} (${outcome.kind}) is never reached by any step.`);
  }
  const fulfilled = session.outcomes.filter((o) => o.kind === "fulfilled");
  if (fulfilled.length === 0) {
    push("error", "no-fulfilled-outcome", "an intent session needs at least one `fulfilled` outcome — the path where the user gets what they came for.");
  } else if (!fulfilled.some((o) => reached.has(o.id))) {
    push("error", "intent-unreachable", "no path from the first step reaches a `fulfilled` outcome — the intent can't be completed as documented.");
  }
}

const GATED: ReadonlySet<string> = new Set(["accepted", "implemented"]);

// ---- Surfaces ----

const SCREEN_NAME = /(Page|View|Screen|Route|Dialog|Modal)$/;
const SCREEN_DIR = /(^|\/)(pages|routes|screens|views)\//;
const SURFACES_MAX = 500;

/** API operations and screen-like components: the places users interact. */
export function detectSurfaces(model: DocModel): ProductSurface[] {
  const out: ProductSurface[] = [];
  for (const file of model.files) {
    // Fixture projects nested in the repo are someone else's product.
    if (file.path.split("/").some((seg) => FIXTURE_DIRS.has(seg))) continue;
    for (const s of file.symbols) {
      if (out.length >= SURFACES_MAX) return out;
      if (s.kind === "endpoint") {
        out.push({ kind: "api", id: s.id, name: s.name, path: file.path, coveredBy: [] });
      } else if (s.kind === "component" && s.exported && (SCREEN_NAME.test(s.name) || SCREEN_DIR.test(file.path))) {
        out.push({ kind: "screen", id: s.id, name: s.name, path: file.path, coveredBy: [] });
      }
    }
  }
  return out;
}

function bindingTouches(binding: CodeBinding, surface: ProductSurface): boolean {
  const t = binding.target;
  if (!t) return false;
  if (t.kind === "symbol") return t.id === surface.id;
  if (t.kind === "file") return t.path === surface.path;
  return surface.path.startsWith(`${t.path}/`);
}

// ---- Build ----

export function buildProduct(model: DocModel, options: BuildProductOptions = {}): ProductManifest {
  const findings: ProductFinding[] = [];
  const now = options.now ?? (() => new Date().toISOString());

  // 1. Gather curated sources (repo wins over override on the same id).
  const proposedPaths = new Set((options.proposed ?? []).map((f) => f.path));
  const curatedSources = [
    ...(options.proposed ?? []),
    ...[
      ...repoProductFiles(model),
      ...(options.repoOnly || !options.overrideDir ? [] : overrideProductFiles(options.overrideDir)),
    ].filter((f) => !proposedPaths.has(f.path)),
  ];
  let overview: string | undefined;
  const byId = new Map<string, ParsedDoc>();
  const collect = (sources: ProductSourceFile[]): void => {
    for (const file of sources) {
      const result = parseSource(file, findings);
      if (!result) continue;
      if ("overview" in result) {
        overview ??= result.overview || undefined;
        continue;
      }
      const key = normalizeProductRef(result.doc.id);
      const existing = byId.get(key);
      if (existing) {
        if (existing.doc.provenance === result.doc.provenance) {
          findings.push({ level: "error", code: "duplicate-id", message: `${result.doc.id} is defined in both ${existing.doc.path} and ${file.path}.`, docId: result.doc.id, path: file.path });
        } else {
          findings.push({ level: "info", code: "override-shadowed", message: `server override for ${result.doc.id} is shadowed by the repo's own ${existing.doc.path}.`, docId: result.doc.id, path: file.path });
        }
        continue;
      }
      byId.set(key, result);
    }
  };
  collect(curatedSources);

  // 2. No curated docs → fall back to the LLM draft set (whole-set semantics).
  let source: ProductManifest["source"] = byId.size > 0 ? "curated" : "none";
  let setStale = false;
  if (byId.size === 0 && !options.repoOnly && options.llmDir) {
    const llm = loadLlmProductSet(options.llmDir);
    if (llm && llm.files.length > 0) {
      collect(llm.files.map((f) => ({ ...f, provenance: "llm" as const })));
      if (byId.size > 0) {
        source = "llm";
        setStale = llm.sourceRepoHash !== repoContentHash(model.files);
      }
    }
  }
  const parsed = [...byId.values()];
  const docs = parsed.map((p) => p.doc);
  const lookup = new Map(docs.map((d) => [normalizeProductRef(d.id), d]));
  const titleOf = (id: string): string | undefined => lookup.get(normalizeProductRef(id))?.title;

  // 3. Cross references + backlinks.
  for (const doc of docs) {
    for (const field of outboundRefs(doc)) {
      for (const ref of field.ids) {
        const target = lookup.get(normalizeProductRef(ref));
        if (!target) {
          findings.push({ level: "error", code: "dangling-ref", message: `\`${field.rel}\` references ${ref}, which doesn't exist.`, docId: doc.id, path: doc.path });
          continue;
        }
        if (target.type !== field.expect) {
          findings.push({ level: "error", code: "wrong-ref-type", message: `\`${field.rel}\` must name a ${field.expect}, but ${ref} is a ${target.type}.`, docId: doc.id, path: doc.path });
          continue;
        }
        if (!target.referencedBy.some((l) => l.id === doc.id && l.rel === field.rel)) {
          target.referencedBy.push({ id: doc.id, rel: field.rel });
        }
      }
    }
    if (doc.type === "session" && doc.journey && typeof doc.journey !== "string" && doc.journey.stage) {
      const journey = lookup.get(normalizeProductRef(doc.journey.id));
      if (journey?.type === "journey" && !journey.stages.some((s) => s.name === (doc.journey as { stage: string }).stage)) {
        findings.push({ level: "warn", code: "unknown-stage", message: `journey ${journey.id} has no stage "${doc.journey.stage}".`, docId: doc.id, path: doc.path });
      }
    }
  }

  // 4. Per-document checks, bindings, diagrams, test traceability.
  const resolver = createBindingResolver(model);
  const previousDocs = new Map((options.previous?.docs ?? []).map((d) => [normalizeProductRef(d.id), d]));
  const testsByDoc = new Map<string, ProductTestRef[]>();
  for (const ref of options.testRefs ?? []) {
    const docKey = ref.ref.split(".")[0]!;
    const list = testsByDoc.get(docKey) ?? [];
    list.push(ref);
    testsByDoc.set(docKey, list);
  }

  for (const { doc, content } of parsed) {
    if (content.includes("TODO(doc)")) {
      findings.push({ level: "warn", code: "todo-marker", message: "still contains TODO(doc) template markers.", docId: doc.id, path: doc.path });
    }

    const refs: { ref: string; step?: string; inferred: boolean }[] = [];
    if (doc.type === "story") for (const ref of doc.code) refs.push({ ref, inferred: false });
    if (doc.type === "session") {
      checkSessionGraph(doc, findings);
      for (const step of doc.steps) {
        for (const ref of step.code) refs.push({ ref, step: step.id, inferred: false });
        for (const text of [step.action, step.surface, step.system, step.expects]) {
          for (const ref of backtickedRefs(text)) refs.push({ ref, step: step.id, inferred: true });
        }
      }
    }
    const prev = previousDocs.get(normalizeProductRef(doc.id));
    const prevBaseline = prev
      ? new Map(prev.bindings.filter((b) => b.baselineHash).map((b) => [bindingKey(b.step, b.ref), b.baselineHash!]))
      : undefined;
    doc.bindings = resolveBindings(resolver, refs, prevBaseline, prev?.docHash === doc.docHash);
    const gated = GATED.has(doc.status);
    for (const b of doc.bindings) {
      if (b.state === "broken") {
        findings.push({
          level: gated ? "error" : "warn",
          code: "broken-binding",
          message: `${b.step ? `${b.step}: ` : ""}\`${b.ref}\` no longer resolves to any file, symbol or endpoint — the documented behaviour has drifted from the code.`,
          docId: doc.id,
          path: doc.path,
        });
      } else if (b.state === "changed") {
        findings.push({
          level: "warn",
          code: "changed-binding",
          message: `${b.step ? `${b.step}: ` : ""}\`${b.ref}\` changed since this doc was last edited — review it, then bump \`verified:\`.`,
          docId: doc.id,
          path: doc.path,
        });
      }
    }
    if (doc.provenance === "llm") doc.stale = setStale;
    else doc.stale = doc.bindings.some((b) => b.state === "changed");

    const personaTitle = "persona" in doc ? titleOf(doc.persona) : undefined;
    if (doc.type === "session") {
      doc.diagrams = {
        flow: sessionFlowDiagram(doc),
        sequence: sessionSequenceDiagram(doc, personaTitle),
        journey: sessionEmotionDiagram(doc, personaTitle),
      };
    } else if (doc.type === "journey") {
      doc.diagrams = { journey: journeyDiagram(doc, personaTitle) };
    }

    doc.tests = testsByDoc.get(normalizeProductRef(doc.id)) ?? [];
    if (options.testRefs && gated) {
      const cited = new Set(doc.tests.map((t) => t.ref));
      const base = normalizeProductRef(doc.id);
      if (doc.type === "story") {
        if (doc.acceptance.length + doc.requirements.length === 0) {
          findings.push({ level: "warn", code: "no-acceptance", message: `${doc.status} story has no acceptance criteria (tagged Gherkin scenarios or EARS requirements).`, docId: doc.id, path: doc.path });
        }
        const untested = [...doc.acceptance, ...doc.requirements]
          .map((c) => c.id)
          .filter((sub) => !cited.has(normalizeProductRef(`${base}.${sub}`)));
        if (untested.length > 0) {
          findings.push({ level: "warn", code: "untested-criteria", message: `no test cites ${untested.map((s) => `${doc.id}.${s}`).join(", ")}.`, docId: doc.id, path: doc.path });
        }
      }
      if (doc.type === "session") {
        const untested = doc.outcomes
          .map((o) => o.id)
          .filter((sub) => !cited.has(normalizeProductRef(`${base}.${sub}`)));
        if (untested.length > 0) {
          findings.push({ level: "warn", code: "untested-outcomes", message: `no test cites ${untested.map((s) => `${doc.id}.${s}`).join(", ")} — verify each way the session can end.`, docId: doc.id, path: doc.path });
        }
      }
    }
  }

  // Tests citing ids that don't exist point at deleted or mistyped docs.
  if (options.testRefs && docs.length > 0) {
    const orphans = options.testRefs.filter((t) => !lookup.has(t.ref.split(".")[0]!));
    for (const ref of orphans.slice(0, 20)) {
      findings.push({ level: "warn", code: "orphan-test-ref", message: `line ${ref.line} cites ${ref.ref}, which no product doc defines.`, path: ref.path });
    }
  }

  // 5. Surfaces and coverage.
  const surfaces = detectSurfaces(model);
  for (const doc of docs) {
    if (doc.type !== "session") continue;
    for (const surface of surfaces) {
      if (doc.bindings.some((b) => bindingTouches(b, surface)) && !surface.coveredBy.includes(doc.id)) {
        surface.coveredBy.push(doc.id);
      }
    }
  }
  const uncovered = surfaces.filter((s) => s.coveredBy.length === 0);
  if (docs.length > 0 && uncovered.length > 0) {
    findings.push({
      level: "info",
      code: "uncovered-surfaces",
      message: `${uncovered.length} of ${surfaces.length} interaction surfaces (API operations / screens) appear in no session step: ${uncovered.slice(0, 8).map((s) => s.name).join(", ")}${uncovered.length > 8 ? ", …" : ""}.`,
    });
  }

  const cited = new Set((options.testRefs ?? []).map((t) => t.ref));
  const subRefs = (type: "acceptance" | "requirements" | "outcomes") =>
    docs.flatMap((d) => {
      const list =
        type === "outcomes" ? (d.type === "session" ? d.outcomes : []) : d[type];
      return list.map((c) => normalizeProductRef(`${d.id}.${c.id}`));
    });
  const criteria = subRefs("acceptance");
  const requirements = subRefs("requirements");
  const outcomes = subRefs("outcomes");
  const allBindings = docs.flatMap((d) => d.bindings);
  const coverage: ProductCoverage = {
    criteria: criteria.length,
    criteriaTested: criteria.filter((r) => cited.has(r)).length,
    requirements: requirements.length,
    requirementsTested: requirements.filter((r) => cited.has(r)).length,
    outcomes: outcomes.length,
    outcomesTested: outcomes.filter((r) => cited.has(r)).length,
    surfaces: surfaces.length,
    surfacesCovered: surfaces.length - uncovered.length,
    bindings: allBindings.length,
    bindingsBroken: allBindings.filter((b) => b.state === "broken").length,
    bindingsChanged: allBindings.filter((b) => b.state === "changed").length,
    testsScanned: options.testRefs !== undefined,
  };

  const typeOrder = Object.keys(PRODUCT_TYPE_DIRS);
  docs.sort((a, b) => typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  const levelOrder = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => levelOrder[a.level] - levelOrder[b.level]);

  return {
    schemaVersion: SCHEMA_VERSION,
    repo: model.repo.slug,
    source,
    stale: setStale,
    overview,
    docs,
    surfaces,
    findings,
    coverage,
    diagram: intentMapDiagram(docs),
    generatedAt: now(),
  };
}
