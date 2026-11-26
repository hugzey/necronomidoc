import type { DocSymbolShape } from "@necronomidoc/docmodel";
import { compact, oneLine, symbolSummary } from "./detail.js";
import { identifierWords, isTestOrFixturePath, meaningfulTerms } from "./ranking.js";
import type { ManifestStore } from "./store.js";
import { rankedSearch, type ToolResult } from "./tools.js";

/**
 * Duplicate-detection guard (decision 0024, JOB-001 "find existing code
 * instead of duplicating it"). Before writing a new function the agent sends
 * the proposed name, signature and purpose; candidates come from the search
 * index plus a name scan, scored by fuzzy lexical similarity of names,
 * purposes and signatures after verb/noun canonicalisation ("fetchUser" ≈
 * "loadUser", "currency" ≈ "money"). Deterministic and key-free — no
 * embedding provider is needed at query time.
 */

/** Words that mean the same thing in code names; the first word is canonical. */
const GROUPS: string[][] = [
  ["get", "fetch", "load", "read", "retrieve", "find", "lookup", "query", "select"],
  ["create", "make", "build", "new", "add", "insert", "register"],
  ["delete", "remove", "destroy", "drop", "erase", "purge", "clear"],
  ["update", "set", "modify", "edit", "patch", "change", "save", "write", "store", "put"],
  ["format", "render", "display", "print", "stringify", "fmt", "pretty", "humanize", "show"],
  ["parse", "decode", "deserialize", "unmarshal"],
  ["serialize", "encode", "marshal", "dump"],
  ["validate", "check", "verify", "assert", "ensure", "guard"],
  ["convert", "transform", "map", "translate", "to"],
  ["money", "currency", "price", "amount", "cost", "cash", "payment", "pay"],
  ["date", "time", "datetime", "timestamp", "duration", "elapsed"],
  ["user", "account", "member", "profile", "person"],
  ["count", "counter", "tally", "total", "sum"],
  ["list", "all", "many", "collection", "items"],
  ["send", "post", "submit", "dispatch", "emit", "publish", "notify"],
  ["cart", "basket", "bag"],
  ["order", "purchase", "checkout"],
  ["error", "exception", "failure", "fault"],
  ["config", "configuration", "settings", "options", "preferences", "prefs"],
  ["auth", "authenticate", "authentication", "login", "signin", "session"],
  ["id", "identifier", "key", "uid", "uuid"],
  ["button", "btn"],
];
const CANON = new Map<string, string>();
for (const group of GROUPS) for (const w of group) if (!CANON.has(w)) CANON.set(w, group[0]!);

/** Light stemmer: plural / -ing / -ed / -er endings. */
function stem(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("es") && /(ss|sh|ch|x)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

export function canon(word: string): string {
  const w = word.toLowerCase();
  return CANON.get(w) ?? CANON.get(stem(w)) ?? stem(w);
}

function canonSet(words: string[]): Set<string> {
  return new Set(words.map(canon).filter((w) => w.length >= 2));
}

/** Sørensen–Dice overlap of two token sets (0..1). */
function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return (2 * n) / (a.size + b.size);
}

function signatureTokens(signature: string | undefined): Set<string> {
  if (!signature) return new Set();
  const words = (signature.match(/[A-Za-z_$][\w$]*/g) ?? []).flatMap(identifierWords);
  return canonSet(words.filter((w) => !["function", "async", "export", "const", "def", "public", "static", "return", "void"].includes(w)));
}

export interface DuplicateQuery {
  repo?: string;
  name?: string;
  signature?: string;
  purpose?: string;
  kind?: string;
}

export interface DuplicateCandidate {
  id: string;
  name: string;
  kind: string;
  path: string;
  signature?: string;
  summary?: string;
  confidence: number;
  /** The canonical words the two share. */
  shared: string[];
}

const COMPATIBLE_KINDS: Record<string, string[]> = {
  function: ["function", "method", "variable", "hook"],
  method: ["function", "method"],
  hook: ["hook", "function"],
  component: ["component", "function"],
  class: ["class", "interface", "type"],
  interface: ["interface", "type", "class"],
  type: ["type", "interface", "enum"],
  endpoint: ["endpoint", "function"],
};

/** Score existing symbols against a proposed one; best first. */
export function findDuplicates(store: ManifestStore, q: DuplicateQuery, limit = 5): DuplicateCandidate[] {
  const nameWords = canonSet(q.name ? identifierWords(q.name) : []);
  const purposeWords = canonSet(q.purpose ? meaningfulTerms(q.purpose).flatMap(identifierWords) : []);
  const sigWords = signatureTokens(q.signature);
  if (nameWords.size + purposeWords.size + sigWords.size === 0) return [];

  // Candidates: search hits for the name + purpose, plus a scan of symbol names.
  const candidates = new Map<string, DocSymbolShape>();
  const query = [q.name ? identifierWords(q.name).join(" ") : "", q.purpose ?? ""].join(" ").trim();
  if (query) {
    const { ranked } = rankedSearch(store, query, q.repo);
    for (const h of ranked.slice(0, 40)) {
      if (h.type !== "symbol") continue;
      const s = store.getSymbolById(h.id);
      if (s) candidates.set(s.id, s);
      for (const m of h.matches ?? []) {
        const ms = store.getSymbolById(m.id);
        if (ms) candidates.set(ms.id, ms);
      }
    }
  }
  if (nameWords.size > 0) {
    const repos = q.repo ? [q.repo] : store.listRepos().map((r) => r.slug);
    let scanned = 0;
    for (const slug of repos) {
      for (const file of store.listFiles(slug)) {
        for (const s of file.symbols) {
          if (++scanned > 50_000) break;
          if (candidates.has(s.id) || s.kind === "section") continue;
          if (dice(nameWords, canonSet(identifierWords(s.name))) >= 0.5) candidates.set(s.id, s);
        }
      }
    }
  }

  const exactName = q.name?.toLowerCase();
  const out: DuplicateCandidate[] = [];
  for (const s of candidates.values()) {
    const path = store.fileOfSymbol(s.id)?.path ?? s.location.path;
    const cName = canonSet(identifierWords(s.name));
    const cText = canonSet([
      ...identifierWords(s.name),
      ...meaningfulTerms([symbolSummary(s), s.enrichment?.purpose].filter(Boolean).join(" ")).flatMap(identifierWords),
    ]);
    const parts: [number, number][] = [];
    if (nameWords.size > 0) parts.push([s.name.toLowerCase() === exactName ? 1 : dice(nameWords, cName), 0.45]);
    if (purposeWords.size > 0) parts.push([dice(purposeWords, cText), 0.4]);
    if (sigWords.size > 0) parts.push([dice(sigWords, signatureTokens(s.signature)), 0.15]);
    const weight = parts.reduce((n, [, w]) => n + w, 0);
    let score = parts.reduce((n, [v, w]) => n + v * w, 0) / weight;
    if (q.kind && !(COMPATIBLE_KINDS[q.kind] ?? [q.kind]).includes(s.kind)) score *= 0.85;
    if (isTestOrFixturePath(path)) score *= 0.5;
    if (!s.exported) score *= 0.9;
    const shared = [...new Set([...nameWords, ...purposeWords, ...sigWords])].filter((w) => cText.has(w) || cName.has(w));
    out.push({
      id: s.id,
      name: s.name,
      kind: s.kind,
      path,
      signature: s.signature,
      summary: oneLine(symbolSummary(s)),
      confidence: Math.round(score * 100) / 100,
      shared,
    });
  }
  return out.filter((c) => c.confidence >= 0.3).sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id)).slice(0, limit);
}

/** `is_this_a_duplicate`. */
export function isThisADuplicate(store: ManifestStore, args: DuplicateQuery & { limit?: number }): ToolResult {
  if (!args.name && !args.purpose && !args.signature) {
    return { error: "Describe the proposed code: at least one of `name`, `signature`, `purpose`." };
  }
  if (args.repo && !store.getRepo(args.repo)) return { error: `No repo "${args.repo}".` };
  const candidates = findDuplicates(store, args, Math.min(Math.max(args.limit ?? 5, 1), 10));
  const top = candidates[0];
  const verdict = !top
    ? "no-duplicate-found"
    : top.confidence >= 0.65
      ? "likely-duplicate"
      : top.confidence >= 0.4
        ? "possible-overlap"
        : "no-duplicate-found";
  const enriched = candidates.map((c) => {
    const repo = c.id.split(":")[0]!;
    const s = store.getSymbolById(c.id);
    return compact({
      ...c,
      trust: s ? store.trustFor(repo, c.path, s).level : undefined,
      usage: store.getAgent(repo)?.usages[c.id]?.[0],
    });
  });
  return {
    proposed: compact({ name: args.name, signature: args.signature, purpose: args.purpose }),
    verdict,
    candidates: enriched,
    advice:
      verdict === "likely-duplicate"
        ? `Reuse or extend ${top!.name} (${top!.path}) instead of writing a new one.`
        : verdict === "possible-overlap"
          ? `Check ${top!.name} (${top!.path}) first — it may already cover this, or be the place to extend.`
          : "Nothing similar is documented — write it, in the subsystem that owns this concern (get_context_for_task shows which).",
  };
}
