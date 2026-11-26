import type { DocSymbolShape, Recipe } from "@necronomidoc/docmodel";
import { compact, detailOf, estimateTokens, oneLine, symbolSummary, type Detail } from "./detail.js";
import { identifierWords, isUseful, meaningfulTerms, type RankedHit } from "./ranking.js";
import type { ManifestStore } from "./store.js";
import { intentsForCode, markMiss, rankedSearch, type ToolResult } from "./tools.js";

/**
 * Task-scoped context (decision 0024): the agent describes its task once and
 * gets one packed bundle — the relevant subsystem boundaries, the top
 * existing symbols with signatures, the intents bound to those files, a
 * matching recipe and the conventions excerpt — ranked and truncated to a
 * token budget. Replaces the usual search → file → function → subsystem
 * round trips.
 */

const DEFAULT_BUDGET = 1500;
const MIN_BUDGET = 200;
const MAX_BUDGET = 8000;

function singularize(t: string): string {
  return t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t;
}

/** Score recipes against a task by word overlap (title, keywords, pattern, kind). */
export function matchRecipes(recipes: Recipe[], task: string): { recipe: Recipe; score: number }[] {
  const terms = new Set(meaningfulTerms(task).map(singularize));
  if (terms.size === 0) return recipes.map((recipe) => ({ recipe, score: 0 }));
  return recipes
    .map((recipe) => {
      const vocab = new Set(
        [
          ...meaningfulTerms(recipe.title),
          ...recipe.keywords.flatMap((k) => identifierWords(k)),
          ...(recipe.pattern ? identifierWords(recipe.pattern) : []),
          ...(recipe.kind ? [recipe.kind] : []),
        ].map(singularize),
      );
      let score = 0;
      for (const t of terms) if (vocab.has(t)) score += meaningfulTerms(recipe.title).map(singularize).includes(t) ? 2 : 1;
      return { recipe, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.recipe.title.localeCompare(b.recipe.title));
}

function recipeView(r: Recipe, detail: Detail): ToolResult {
  if (detail === "brief") return compact({ id: r.id, title: r.title, pattern: r.pattern, steps: r.steps });
  return compact({
    id: r.id,
    title: r.title,
    pattern: r.pattern,
    kind: r.kind,
    steps: r.steps,
    example: r.example,
    files: r.files,
    ...(detail === "full" ? { instances: r.instances, keywords: r.keywords } : {}),
    provenance: r.provenance,
  });
}

/** `get_recipes`: precomputed "how do I…" snippets, optionally ranked for a task. */
export function getRecipes(store: ManifestStore, args: { repo: string; task?: string; detail?: Detail }): ToolResult {
  const detail = detailOf(args.detail);
  const agent = store.getAgent(args.repo);
  if (!agent) return { error: `No agent manifest for repo "${args.repo}" — rebuild it with a current server.` };
  const ranked = args.task ? matchRecipes(agent.recipes, args.task).map((r) => r.recipe) : agent.recipes;
  return {
    repo: args.repo,
    ...(args.task ? { task: args.task } : {}),
    recipes: ranked.slice(0, args.task ? 3 : 50).map((r) => recipeView(r, detail)),
    ...(ranked.length === 0
      ? { note: args.task ? "No recipe matches this task — call get_recipes without `task` for the full list." : "No repeated patterns found; curate .necronomidoc/recipes.yaml to add recipes." }
      : {}),
  };
}

/** The convention sections most relevant to the task (by word overlap), as one excerpt. */
function conventionsExcerpt(content: string, task: string, maxChars: number): string {
  const sections = content.split(/^(?=#{2,3} )/m).map((s) => s.trim()).filter(Boolean);
  const terms = meaningfulTerms(task).map(singularize);
  const scored = sections.map((text, i) => {
    const lower = text.toLowerCase();
    const score = terms.reduce((n, t) => n + (lower.includes(t) ? 1 : 0), 0);
    return { text, i, score };
  });
  const body = scored.filter((s) => !/^# /.test(s.text) || s.text.includes("\n"));
  const picked = body.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.i - b.i);
  const chosen = (picked.length > 0 ? picked : body.slice(0, 2)).slice(0, 3).sort((a, b) => a.i - b.i);
  const joined = chosen.map((s) => s.text).join("\n\n");
  return joined.length > maxChars ? `${joined.slice(0, Math.max(0, maxChars - 1))}…` : joined;
}

interface Item {
  section: "symbols" | "subsystems" | "recipes" | "intents" | "conventions" | "tests";
  priority: number;
  payload: unknown;
  /** Shrink to fit `tokens`, or undefined when it can't. */
  shrink?: (tokens: number) => unknown;
}

function symbolPayload(store: ManifestStore, repo: string, path: string, s: DocSymbolShape, detail: Detail): ToolResult {
  if (detail === "brief") {
    return compact({ id: s.id, name: s.name, kind: s.kind, path, signature: s.signature, purpose: oneLine(symbolSummary(s)) });
  }
  const trust = store.trustFor(repo, path, s);
  return compact({
    id: s.id,
    name: s.name,
    kind: s.kind,
    path,
    signature: s.signature,
    purpose: detail === "full" ? symbolSummary(s) : oneLine(symbolSummary(s), 240),
    trust: { score: trust.score, level: trust.level },
    invariants: store.invariantsFor(repo, path, s),
    usage: store.getAgent(repo)?.usages[s.id]?.[0],
  });
}

/** `get_context_for_task`: one packed, budgeted bundle for a described task. */
export function getContextForTask(
  store: ManifestStore,
  args: { task: string; repo?: string; budget?: number; detail?: Detail },
): ToolResult {
  const detail = detailOf(args.detail);
  const budget = Math.max(MIN_BUDGET, Math.min(MAX_BUDGET, Math.round(args.budget ?? DEFAULT_BUDGET)));
  const { ranked } = rankedSearch(store, args.task, args.repo);
  const isCode = (h: RankedHit) => h.type === "file" || h.type === "symbol";
  const repo = args.repo ?? ranked.find((h) => isCode(h) && isUseful(h))?.repo ?? ranked.find(isCode)?.repo ?? store.listRepos()[0]?.slug;
  if (!repo || !store.getRepo(repo)) {
    return markMiss({ task: args.task, error: args.repo ? `No repo "${args.repo}".` : "No documented repos." }, { query: args.task, repo: args.repo, hits: 0 });
  }

  // Useful code hits first (they cover the task), then the rest by score.
  const codeHits = ranked.filter((h) => h.repo === repo && isCode(h));
  const ordered = [...codeHits.filter(isUseful), ...codeHits.filter((h) => !isUseful(h))];

  const symbolIds: string[] = [];
  const pushSymbol = (id: string) => {
    if (!symbolIds.includes(id) && store.getSymbolById(id)) symbolIds.push(id);
  };
  for (const h of ordered) {
    if (h.type === "symbol") pushSymbol(h.id);
    for (const m of h.matches ?? []) if (symbolIds.length < 8) pushSymbol(m.id);
    if (h.type === "file") {
      const primary = store.getFile(repo, h.path)?.symbols.find((s) => s.exported);
      if (primary) pushSymbol(primary.id);
    }
    if (symbolIds.length >= 8) break;
  }
  // Prefer exported symbols; keep rank order otherwise.
  const symbols = symbolIds
    .map((id) => store.getSymbolById(id)!)
    .sort((a, b) => Number(b.exported) - Number(a.exported))
    .slice(0, 5);
  // The files the chosen symbols live in come first; then other code hits.
  const files = [
    ...new Set([
      ...symbols.map((s) => store.fileOfSymbol(s.id)?.path ?? s.location.path),
      ...ordered.filter(isUseful).map((h) => h.path),
    ]),
  ].slice(0, 5);

  const items: Item[] = [];
  symbols.forEach((s, i) => {
    const path = store.fileOfSymbol(s.id)?.path ?? s.location.path;
    items.push({ section: "symbols", priority: [100, 80, 70, 50, 45][i]!, payload: symbolPayload(store, repo, path, s, detail) });
  });

  const subsystems = [...new Map(files.map((p) => store.subsystemOf(repo, p)).filter((s) => s !== undefined).map((s) => [s.id, s])).values()];
  subsystems.slice(0, 3).forEach((s, i) => {
    items.push({
      section: "subsystems",
      priority: i === 0 ? 95 : 40 - i,
      payload: compact({
        id: s.id,
        name: s.name,
        // A heuristic grouping's purpose is boilerplate — say what it is instead.
        purpose: s.provenance === "heuristic" ? undefined : detail === "brief" ? oneLine(s.purpose) : s.purpose,
        provenance: s.provenance === "heuristic" ? "heuristic (directory/import grouping — no curated boundaries)" : undefined,
        owns: detail === "brief" ? undefined : s.owns,
        doesNotOwn: s.notOwns,
        invariants: s.invariants,
        dirs: s.dirs,
      }),
    });
  });

  const recipes = matchRecipes(store.getAgent(repo)?.recipes ?? [], args.task);
  recipes.slice(0, 2).forEach(({ recipe, score }, i) => {
    if (score < 2 && i > 0) return;
    items.push({ section: "recipes", priority: i === 0 ? (score >= 2 ? 90 : 55) : 35, payload: recipeView(recipe, detail) });
  });

  const seenIntents = new Set<string>();
  let intentRank = 0;
  for (const path of files) {
    for (const intent of intentsForCode(store, repo, path, undefined, "brief")) {
      const id = String(intent["id"]);
      if (seenIntents.has(id)) continue;
      seenIntents.add(id);
      items.push({ section: "intents", priority: 85 - 5 * intentRank++, payload: { ...intent, boundTo: path } });
    }
  }

  const conventions = store.getCoreDocs(repo)?.docs.find((d) => d.kind === "conventions");
  if (conventions) {
    const make = (chars: number) => ({ provenance: conventions.provenance, stale: conventions.stale || undefined, excerpt: conventionsExcerpt(conventions.content, args.task, chars) });
    items.push({
      section: "conventions",
      priority: 75,
      payload: make(detail === "full" ? 4000 : 1600),
      shrink: (tokens) => (tokens >= 60 ? make(tokens * 4 - 80) : undefined),
    });
  }

  const tests = [...new Set(files.flatMap((p) => store.testsFor(repo, p)))];
  if (tests.length > 0) items.push({ section: "tests", priority: 60, payload: tests.slice(0, 8) });

  // Greedy pack by priority within the budget.
  const out: Record<Item["section"], unknown[]> = { symbols: [], subsystems: [], recipes: [], intents: [], conventions: [], tests: [] };
  const omitted: Partial<Record<Item["section"], number>> = {};
  let used = estimateTokens({ task: args.task, repo, budget, used: 0, next: [] }) + 40;
  for (const item of items.sort((a, b) => b.priority - a.priority)) {
    const cost = estimateTokens(item.payload);
    if (used + cost <= budget) {
      out[item.section].push(item.payload);
      used += cost;
      continue;
    }
    const shrunk = item.shrink?.(budget - used);
    if (shrunk !== undefined) {
      const c = estimateTokens(shrunk);
      if (used + c <= budget) {
        out[item.section].push(shrunk);
        used += c;
        continue;
      }
    }
    omitted[item.section] = (omitted[item.section] ?? 0) + 1;
  }

  const top = out.symbols[0] as { id?: string } | undefined;
  const next = [
    ...(top?.id ? [`get_function_doc id=${top.id} detail=full — full docs + call sites for the top symbol`] : []),
    "check_change with your diff before committing — intents, tests to run, boundary checks",
    ...(Object.keys(omitted).length > 0 ? ["raise `budget` to include what was omitted"] : []),
  ];
  const result: ToolResult = compact({
    task: args.task,
    repo,
    budget,
    used,
    symbols: out.symbols,
    subsystems: out.subsystems,
    recipes: out.recipes,
    intents: out.intents,
    conventions: out.conventions[0],
    tests: out.tests[0],
    omitted: Object.keys(omitted).length > 0 ? omitted : undefined,
    next,
  });
  return codeHits.some(isUseful)
    ? result
    : markMiss({ ...result, note: "Nothing in the docs clearly covers this task — the bundle holds the closest matches only." }, { query: args.task, repo, hits: codeHits.length, topScore: codeHits[0]?.score });
}
