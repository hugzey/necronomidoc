import type { DocSymbolShape, Subsystem } from "@necronomidoc/docmodel";
import { compact, detailOf, type Detail } from "./detail.js";
import { findDuplicates } from "./duplicates.js";
import type { ManifestStore } from "./store.js";
import { intentsForCode, type ToolResult } from "./tools.js";

/**
 * Pre-commit change-impact check (decision 0024). The agent submits a
 * unified diff (or a list of changed files / symbols); the answer is the gate
 * an agent should pass before committing:
 *
 *   • intents affected (via product-doc code bindings) with the acceptance
 *     criteria and session outcomes to keep true;
 *   • the tests to run — those citing the affected ids, those importing the
 *     changed files, and (one hop) those importing their importers;
 *   • subsystem boundary violations — added code of a kind the subsystem
 *     declares it does NOT own, or new imports into another subsystem;
 *   • invariants of the touched code, docs that will go stale, and new
 *     exports that look like duplicates of existing ones.
 */

export interface FileChange {
  path: string;
  /** Old-side line ranges touched (the published docs describe the old code). */
  ranges: [number, number][];
  added: string[];
  isNew: boolean;
  isDeleted: boolean;
}

function stripPrefix(p: string): string {
  return p.replace(/^"|"$/g, "").replace(/^[ab]\//, "");
}

/** Parse a unified diff (git or plain) into per-file changes. */
export function parseUnifiedDiff(diff: string): FileChange[] {
  const files: FileChange[] = [];
  let cur: FileChange | undefined;
  let oldPath: string | undefined;
  const start = (path: string): FileChange => {
    const existing = files.find((f) => f.path === path);
    if (existing) return existing;
    const fc: FileChange = { path, ranges: [], added: [], isNew: false, isDeleted: false };
    files.push(fc);
    return fc;
  };
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git (\S+) (\S+)$/.exec(line);
      cur = m ? start(stripPrefix(m[2]!)) : undefined;
      oldPath = m ? stripPrefix(m[1]!) : undefined;
      continue;
    }
    if (line.startsWith("--- ")) {
      const p = line.slice(4).split("\t")[0]!.trim();
      oldPath = p === "/dev/null" ? undefined : stripPrefix(p);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).split("\t")[0]!.trim();
      if (p === "/dev/null") {
        cur = start(oldPath ?? cur?.path ?? "");
        cur.isDeleted = true;
      } else {
        const path = stripPrefix(p);
        if (cur && cur.path !== path) {
          // A plain diff without a `diff --git` header: drop the placeholder.
          if (cur.ranges.length === 0 && cur.added.length === 0) files.splice(files.indexOf(cur), 1);
        }
        cur = start(path);
        if (oldPath === undefined) cur.isNew = true;
      }
      continue;
    }
    if (line.startsWith("new file mode") && cur) {
      cur.isNew = true;
      continue;
    }
    if (line.startsWith("deleted file mode") && cur) {
      cur.isDeleted = true;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && cur) {
      const a = Number(hunk[1]);
      const b = hunk[2] === undefined ? 1 : Number(hunk[2]);
      cur.ranges.push([Math.max(1, a), Math.max(1, a + Math.max(b, 1) - 1)]);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("+")) cur.added.push(line.slice(1));
  }
  return files.filter((f) => f.path);
}

/** Top-level symbols (and members) whose declaration overlaps a touched range. */
function touchedSymbols(symbols: DocSymbolShape[], ranges: [number, number][]): DocSymbolShape[] {
  const out: DocSymbolShape[] = [];
  for (const s of symbols) {
    const from = s.location.line;
    const to = s.location.endLine ?? s.location.line;
    if (ranges.some(([a, b]) => a <= to && b >= from)) out.push(s);
  }
  return out;
}

/** Kinds of code a boundary statement can exclude, with how to spot them. */
const CONCERNS: { id: string; label: string; added: RegExp; statement: RegExp }[] = [
  {
    id: "ui",
    label: "UI / rendering logic",
    added: /<[A-Z][A-Za-z0-9]*[\s/>]|<\/?(div|span|button|form|input|main|section|ul|li|p|h[1-6])[\s>]|className=|\buse(State|Effect|Memo|Callback|Ref|Context)\s*\(|from\s+["'](react|react-dom|vue|svelte|@angular\/core)["']|\bdocument\.|\bwindow\./,
    statement: /\b(ui|user interface|render(ing)?|components?|views?|presentation(al)?|display|jsx|markup|styling|css|react|dom)\b/i,
  },
  {
    id: "persistence",
    label: "persistence / database access",
    added: /\b(SELECT|INSERT|UPDATE|DELETE)\b[\s\S]*\b(FROM|INTO|SET)\b|\bprisma\.|\bknex\b|\bmongoose\b|\bsequelize\b|\.query\s*\(|\blocalStorage\b|\bindexedDB\b|\bsqlite/i,
    statement: /\b(persist(ence|ing)?|database|db|storage|sql|quer(y|ies)|orm|repositor(y|ies)|survives? a reload)\b/i,
  },
  {
    id: "network",
    label: "network / HTTP calls",
    added: /\bfetch\s*\(|\baxios\b|XMLHttpRequest|\bhttps?\.request\s*\(|\brequests\.(get|post|put|delete)\s*\(|\bHttpClient\b/,
    statement: /\b(http|network(ing)?|fetch(ing)?|api calls?|remote calls?|requests?|transport|i\/o)\b/i,
  },
  {
    id: "filesystem",
    label: "filesystem access",
    added: /\b(readFileSync|writeFileSync|readFile|writeFile|mkdirSync|createReadStream|createWriteStream)\s*\(|from\s+["'](node:)?fs(\/promises)?["']|\bopen\s*\([^)]*["'][rwa]b?["']/,
    statement: /\b(file ?system|filesystem|disk|files? on disk|fs|i\/o)\b/i,
  },
  {
    id: "business",
    label: "business / data-formatting logic",
    // Implementing formatting/calculation — not merely calling a helper that does.
    added: /\bnew\s+Intl\.|\btoLocale(String|DateString|TimeString)\s*\(|\.toFixed\s*\(|\.padStart\s*\(/,
    statement: /\b(business logic|domain logic|data formatting|formatting|calculations?)\b/i,
  },
];

const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]([^"'`\n]+)["'`]/g;

/** Is this subsystem statement naming another subsystem (by id, name or dir)? */
function mentions(statement: string, other: Subsystem): boolean {
  const lower = statement.toLowerCase();
  const names = [other.id, other.name, ...other.dirs.map((d) => d.split("/").pop() ?? d)].filter((n) => n && n.length >= 3);
  return names.some((n) => new RegExp(`\\b${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower));
}

interface BoundaryFinding {
  level: "warn" | "info";
  path: string;
  subsystem: string;
  message: string;
  statement?: string;
}

function boundaryChecks(store: ManifestStore, repo: string, change: FileChange): BoundaryFinding[] {
  const sub = store.subsystemOf(repo, change.path);
  if (!sub || change.added.length === 0) return [];
  const out: BoundaryFinding[] = [];
  const addedText = change.added.join("\n");
  for (const concern of CONCERNS) {
    if (!concern.added.test(addedText)) continue;
    const statement = sub.notOwns.find((s) => concern.statement.test(s));
    if (!statement) continue;
    out.push({
      level: "warn",
      path: change.path,
      subsystem: sub.id,
      message: `${change.path} is in ${sub.name}, but the change adds ${concern.label}, which ${sub.name} does not own.`,
      statement,
    });
  }
  // New imports into another subsystem.
  const subsystems = store.getSubsystems(repo)?.subsystems ?? [];
  const seen = new Set<string>();
  for (const m of addedText.matchAll(IMPORT_SPEC)) {
    const target = store.resolveImport(repo, change.path, m[1]!);
    if (!target) continue;
    const other = store.subsystemOf(repo, target);
    if (!other || other.id === sub.id || seen.has(other.id)) continue;
    seen.add(other.id);
    const forbidden = sub.notOwns.find((s) => mentions(s, other));
    if (forbidden) {
      out.push({ level: "warn", path: change.path, subsystem: sub.id, message: `${sub.name} imports ${target} from ${other.name}, which its boundary excludes.`, statement: forbidden });
      continue;
    }
    const declared = sub.related.some((r) => r.to === other.id);
    const reverse = other.related.some((r) => r.to === sub.id);
    if (!declared && subsystems.length > 1) {
      out.push({
        level: reverse ? "warn" : "info",
        path: change.path,
        subsystem: sub.id,
        message: reverse
          ? `${sub.name} now imports ${other.name}, but ${other.name} already depends on ${sub.name} — this creates a cycle.`
          : `${sub.name} gains a dependency on ${other.name} (${target}) that the subsystem map does not declare.`,
      });
    }
  }
  return out;
}

/** `export function Foo` / `export const Foo =` / `def foo(` / `public … Foo(` added in a diff. */
const NEW_EXPORT = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)|^def\s+([a-zA-Z]\w*)\s*\(|^\s*public\s+(?:static\s+)?(?:async\s+)?[\w<>[\],\s]+?\s+([A-Z]\w*)\s*\(/;

export interface CheckChangeArgs {
  repo: string;
  diff?: string;
  files?: string[];
  /** Symbol ids, `path#Name`, or bare names. */
  symbols?: string[];
  detail?: Detail;
}

/** `check_change`. */
export function checkChange(store: ManifestStore, args: CheckChangeArgs): ToolResult {
  const detail = detailOf(args.detail);
  if (!store.getRepo(args.repo)) return { error: `No repo "${args.repo}".` };
  const changes: FileChange[] = args.diff ? parseUnifiedDiff(args.diff) : [];
  for (const f of args.files ?? []) {
    const path = f.replace(/^\.\//, "");
    if (!changes.some((c) => c.path === path)) changes.push({ path, ranges: [], added: [], isNew: !store.getFile(args.repo, path), isDeleted: false });
  }
  const namedSymbols: { path: string; symbol: DocSymbolShape }[] = [];
  for (const ref of args.symbols ?? []) {
    const sym = ref.includes("#")
      ? (store.getSymbolById(ref.includes(":") ? ref : `${args.repo}:${ref}`) ?? undefined)
      : store.findSymbolByName(args.repo, ref);
    const path = sym ? store.fileOfSymbol(sym.id)?.path : undefined;
    if (sym && path) {
      namedSymbols.push({ path, symbol: sym });
      if (!changes.some((c) => c.path === path)) changes.push({ path, ranges: [], added: [], isNew: false, isDeleted: false });
    }
  }
  if (changes.length === 0) return { error: "Nothing to check — pass `diff` (unified diff), `files`, or `symbols`." };

  const product = store.getProduct(args.repo);
  const intents = new Map<string, ToolResult>();
  const tests = new Map<string, { reasons: Set<string>; rank: number }>();
  const addTest = (path: string, reason: string, rank: number) => {
    const t = tests.get(path) ?? { reasons: new Set<string>(), rank };
    t.reasons.add(reason);
    t.rank = Math.min(t.rank, rank);
    tests.set(path, t);
  };
  const invariants = new Set<string>();
  const boundary: BoundaryFinding[] = [];
  const staleDocs: ToolResult[] = [];
  const duplicates: ToolResult[] = [];
  const changed: ToolResult[] = [];

  for (const change of changes) {
    const file = store.getFile(args.repo, change.path);
    const sub = store.subsystemOf(args.repo, change.path);
    const touched = [
      ...(file && change.ranges.length > 0 ? touchedSymbols(file.symbols, change.ranges) : []),
      ...namedSymbols.filter((n) => n.path === change.path).map((n) => n.symbol),
    ].filter((s, i, all) => all.findIndex((x) => x.id === s.id) === i);

    changed.push(
      compact({
        path: change.path,
        status: change.isNew ? "added" : change.isDeleted ? "deleted" : file ? "modified" : "undocumented",
        subsystem: sub?.id,
        symbols: touched.map((s) => s.name),
      }),
    );

    if (/(^|\/)(tests?|__tests__|specs?|e2e)\/|\.(test|spec)\.[a-z0-9]+$|^test_|_test\.py$/i.test(change.path)) {
      addTest(change.path, "changed in this diff", 0);
    }

    // Intents bound to the file / touched symbols.
    const scopes = touched.length > 0 ? touched.map((s) => s.name.split(".")[0]!) : [undefined];
    for (const name of scopes) {
      for (const intent of intentsForCode(store, args.repo, change.path, name, detail === "full" ? "normal" : "brief")) {
        const id = String(intent["id"]);
        const existing = intents.get(id);
        const boundTo = name ? `${change.path}#${name}` : change.path;
        if (existing) (existing["boundTo"] as string[]).push(boundTo);
        else intents.set(id, { ...intent, boundTo: [boundTo] });
        const doc = product?.docs.find((d) => d.id === id);
        for (const t of doc?.tests ?? []) addTest(t.path, `cites ${t.ref}`, 1);
      }
    }

    // Tests importing the file, then (one hop) tests importing its importers.
    for (const t of store.testsFor(args.repo, change.path)) addTest(t, `imports ${change.path}`, 1);
    for (const importer of store.importersOf(args.repo, change.path).slice(0, 20)) {
      for (const t of store.testsFor(args.repo, importer)) addTest(t, `imports ${importer} (which imports ${change.path})`, 2);
    }

    for (const text of store.invariantsFor(args.repo, change.path)) invariants.add(text);
    for (const s of touched) for (const text of store.invariantsFor(args.repo, change.path, s)) invariants.add(text);

    boundary.push(...boundaryChecks(store, args.repo, change));

    // Curated/LLM descriptions of touched code will go stale.
    for (const s of touched) {
      const p = s.enrichment?.provenance;
      if (p === "human" || p === "llm") {
        staleDocs.push({ id: s.id, provenance: p, summary: s.enrichment?.summary });
      }
    }

    // New exports that may duplicate existing code.
    for (const line of change.added) {
      const m = NEW_EXPORT.exec(line);
      const name = m?.[1] ?? m?.[2] ?? m?.[3];
      if (!name || file?.symbols.some((s) => s.name === name)) continue;
      const dup = findDuplicates(store, { repo: args.repo, name, signature: line.trim() }, 1)[0];
      if (dup && dup.confidence >= 0.6 && dup.name !== name) {
        duplicates.push({ proposed: name, in: change.path, existing: dup.id, existingSignature: dup.signature, confidence: dup.confidence });
      }
    }
  }

  const testsToRun = [...tests.entries()]
    .sort((a, b) => a[1].rank - b[1].rank || a[0].localeCompare(b[0]))
    .map(([path, t]) => (detail === "brief" ? path : { path, why: [...t.reasons].slice(0, 3) }));
  const warnings = boundary.filter((b) => b.level === "warn").length + duplicates.length;
  const agent = store.getAgent(args.repo);
  return compact({
    repo: args.repo,
    verdict: warnings > 0 ? "review" : "ok",
    changed: detail === "brief" ? undefined : changed,
    intents: [...intents.values()],
    testsToRun,
    ...(agent && !agent.testsScanned ? { testsNote: "Tests were not scanned for this repo (pre-extracted IR) — only id citations are known." } : {}),
    boundaryViolations: boundary.filter((b) => b.level === "warn").map((b) => (detail === "brief" ? b.message : compact({ ...b }))),
    boundaryNotes: detail === "brief" ? undefined : boundary.filter((b) => b.level === "info").map((b) => b.message),
    possibleDuplicates: duplicates,
    invariants: [...invariants],
    docsToUpdate:
      staleDocs.length > 0
        ? { symbols: staleDocs, hint: "These descriptions will be flagged stale by the change — update them with propose_overlay if they no longer hold." }
        : undefined,
    note:
      intents.size > 0
        ? "Keep every listed outcome and acceptance criterion true, and run testsToRun before committing."
        : "No product intent binds to the changed code; run testsToRun and respect the invariants.",
  });
}
