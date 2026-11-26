import type { SearchHit } from "./store.js";

/**
 * Code-aware search ranking (decision 0024): strip filler words, expand
 * curated synonyms, boost exported symbols and exact names, penalise test and
 * fixture files, weight by how much of the query a hit actually covers, and
 * collapse a file hit with the symbol hits inside it — so the first hit is
 * usually the answer and a `bestAnswer` can be named outright.
 */

/** Words that carry no meaning in a code search. */
const STOP = new Set(
  "a an the to of in on at for from with and or but by as is are be been it its this that these those there here where what which who whom how why when do does did i we you me my our your can could should would will shall may might into onto about via than then so if else not no yes any all some each every just also only very use using used".split(
    " ",
  ),
);
/** Task verbs: kept in the query, but not required for a hit to count as covering it. */
const WEAK = new Set(
  "add adding create creating make making new implement implementing write writing change changing update updating fix fixing support supporting handle handling build building need needs want get thing things way something existing".split(
    " ",
  ),
);

/** Lowercased word tokens of a query (letters/digits, ≥ 2 chars). */
export function queryTokens(query: string): string[] {
  return (query.toLowerCase().match(/[a-z0-9_$]+/g) ?? []).filter((t) => t.length >= 2 || /\d/.test(t));
}

/** Tokens that carry meaning (no stopwords). */
export function meaningfulTerms(query: string): string[] {
  return [...new Set(queryTokens(query).filter((t) => !STOP.has(t)))];
}

/** Tokens a hit must cover to count as answering the query. */
export function contentTerms(query: string): string[] {
  const terms = meaningfulTerms(query);
  const strong = terms.filter((t) => !WEAK.has(t));
  return strong.length > 0 ? strong : terms;
}

/** Split an identifier into lowercase words (camel/Pascal/snake/kebab). */
export function identifierWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export interface PreparedQuery {
  /** What MiniSearch is asked (filler removed, synonyms appended). */
  text: string;
  /** Terms a useful hit must cover. */
  terms: string[];
  /** term → the lowercased tokens that also count as covering it (synonyms). */
  alternates: Map<string, Set<string>>;
}

/** Remove filler words and append curated synonym expansions. */
export function prepareQuery(query: string, synonyms: Record<string, string[]> = {}): PreparedQuery {
  const meaningful = meaningfulTerms(query);
  const terms = contentTerms(query);
  const alternates = new Map<string, Set<string>>();
  const extra: string[] = [];
  const lowerQuery = query.toLowerCase();
  for (const [key, values] of Object.entries(synonyms)) {
    // Multi-word keys match as a phrase; single words match a token.
    const hit = key.includes(" ") ? lowerQuery.includes(key) : meaningful.includes(key);
    if (!hit) continue;
    const owner = key.includes(" ") ? (contentTerms(key)[0] ?? key) : key;
    const set = alternates.get(owner) ?? new Set<string>();
    for (const v of values) {
      extra.push(v);
      for (const t of [v.toLowerCase(), ...identifierWords(v)]) set.add(t);
    }
    alternates.set(owner, set);
  }
  const base = meaningful.length > 0 ? meaningful.join(" ") : query;
  return { text: [base, ...extra].join(" "), terms, alternates };
}

/** Fraction of the query's content terms a hit covers (0..1). */
export function coverage(hit: SearchHit, prepared: PreparedQuery): number {
  if (prepared.terms.length === 0) return 1;
  const matched = new Set(hit.matchedTerms.map((t) => t.toLowerCase()));
  const nameWords = new Set(identifierWords(hit.name));
  let covered = 0;
  for (const term of prepared.terms) {
    const alts = prepared.alternates.get(term);
    if (
      matched.has(term) ||
      nameWords.has(term) ||
      [...matched].some((m) => m.startsWith(term) || term.startsWith(m)) ||
      (alts && [...alts].some((a) => matched.has(a) || nameWords.has(a)))
    ) {
      covered++;
    }
  }
  return covered / prepared.terms.length;
}

/** Test, fixture, mock and story files: rarely what an agent is looking for. */
export function isTestOrFixturePath(path: string): boolean {
  const lower = path.toLowerCase();
  const base = lower.split("/").pop() ?? lower;
  return (
    /(^|\/)(tests?|__tests__|specs?|e2e|fixtures?|__fixtures__|__mocks__|mocks?|testdata|test-fixtures|stories|cypress|playwright)\//.test(lower) ||
    /\.(test|spec|e2e|stories|story)\.[a-z0-9]+$/.test(base) ||
    /^test_.*\.py$/.test(base) ||
    /_test\.(py|go|rb)$/.test(base)
  );
}

export interface RankedHit extends SearchHit {
  /** How much of the query this hit covers (0..1). */
  coverage: number;
  /** Other symbols in the same file that also matched (collapsed into this hit). */
  matches?: { id: string; name: string; kind?: string }[];
  /** The collapsed file hit's own summary, when the representative is a symbol. */
  fileSummary?: string;
}

export interface RankContext {
  /** Is this symbol id exported? (undefined = unknown). */
  exported(id: string): boolean | undefined;
}

const MATCHES_MAX = 5;

/**
 * Re-score raw MiniSearch hits for code search and collapse each file with
 * its symbols (representative = the best of them; the rest become `matches`).
 * Subsystem / core-doc / product hits pass through re-scored only.
 */
export function rankHits(raw: SearchHit[], query: string, prepared: PreparedQuery, ctx: RankContext): RankedHit[] {
  const compact = query.trim().toLowerCase().replace(/[\s_-]+/g, "");
  const scored: RankedHit[] = raw.map((h) => {
    let score = h.score;
    const cov = coverage(h, prepared);
    score *= 0.4 + 0.6 * cov;
    if (h.type === "symbol") {
      const exported = ctx.exported(h.id);
      if (exported === true) score *= 1.25;
      else if (exported === false) score *= 0.8;
    }
    if ((h.type === "file" || h.type === "symbol") && isTestOrFixturePath(h.path)) score *= 0.35;
    const name = h.name.toLowerCase().replace(/[\s_-]+/g, "");
    if (compact && (name === compact || name.replace(/\.[a-z0-9]+$/, "") === compact)) score *= 2;
    return { ...h, score, coverage: cov };
  });

  const groups = new Map<string, RankedHit[]>();
  const passthrough: RankedHit[] = [];
  for (const h of scored) {
    if (h.type !== "file" && h.type !== "symbol") {
      passthrough.push(h);
      continue;
    }
    const key = `${h.repo}\u0000${h.path}`;
    const list = groups.get(key) ?? [];
    list.push(h);
    groups.set(key, list);
  }
  const collapsed: RankedHit[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => b.score - a.score);
    const symbols = list.filter((h) => h.type === "symbol");
    const file = list.find((h) => h.type === "file");
    // A symbol represents its file when one matched; the file hit then only
    // lends its summary (and a small bonus for corroborating the match).
    const rep = symbols[0] ?? file!;
    const others = symbols.filter((s) => s !== rep);
    const bonus = (file && rep !== file ? 0.15 * file.score : 0) + others.reduce((n, o) => n + 0.05 * o.score, 0);
    collapsed.push({
      ...rep,
      score: rep.score + bonus,
      coverage: Math.max(rep.coverage, file?.coverage ?? 0),
      ...(others.length > 0
        ? { matches: others.slice(0, MATCHES_MAX).map((o) => ({ id: o.id, name: o.name, kind: o.kind })) }
        : {}),
      ...(file && rep !== file && file.summary ? { fileSummary: file.summary } : {}),
    });
  }
  return [...collapsed, ...passthrough].sort((a, b) => b.score - a.score);
}

/** Is this hit a credible answer (covers at least half the query)? */
export function isUseful(hit: RankedHit): boolean {
  return hit.coverage >= 0.5;
}

/**
 * Name the best answer when the ranking is decisive — an exact name match,
 * or a top hit that covers the query and clearly outscores the runner-up —
 * so the agent can usually stop after one call.
 */
export function pickBestAnswer(
  ranked: RankedHit[],
  query: string,
): { hit: RankedHit; confidence: "high" | "medium"; reason: string } | undefined {
  const [top, second] = ranked;
  if (!top || !isUseful(top)) return undefined;
  const compact = query.trim().toLowerCase().replace(/[\s_-]+/g, "");
  const name = top.name.toLowerCase().replace(/[\s_-]+/g, "");
  if (compact && name === compact) return { hit: top, confidence: "high", reason: "exact name match" };
  const ratio = second ? top.score / Math.max(second.score, 1e-9) : Number.POSITIVE_INFINITY;
  if (top.coverage >= 0.75 && ratio >= 1.5) return { hit: top, confidence: "high", reason: `covers the query and outscores the next hit ${ratio === Infinity ? "(only hit)" : `${ratio.toFixed(1)}×`}` };
  if (top.coverage >= 0.5 && ratio >= 1.2) return { hit: top, confidence: "medium", reason: `leads the next hit ${ratio === Infinity ? "(only hit)" : `${ratio.toFixed(1)}×`}` };
  return undefined;
}
