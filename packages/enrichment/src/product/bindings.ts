import {
  hashContent,
  type CodeBinding,
  type DocFile,
  type DocModel,
  type DocSymbolShape,
} from "@necronomidoc/docmodel";

/**
 * Code bindings (decision 0023): product docs point at the code a story or a
 * session step exercises, and the build resolves each reference against the
 * extracted doc model. A reference that stops resolving means the documented
 * behaviour has drifted from the product; one whose target's content hash
 * moved since the doc was last edited asks for a review.
 *
 * Reference forms, in resolution order:
 *   - `GET /users/{id}`        an OpenAPI operation (case-insensitive method)
 *   - `src/a.ts#Name.member`   a symbol in a file
 *   - `src/a.ts`               a file
 *   - `src/feature/`           a directory (every documented file under it)
 *   - `Name`                   a symbol by bare name, when exactly one matches
 */

const HTTP_METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+\S/i;

export type ResolvedTarget = NonNullable<CodeBinding["target"]> & { hash: string };

export interface BindingResolver {
  resolve(ref: string): ResolvedTarget | undefined;
}

interface IndexedSymbol {
  symbol: DocSymbolShape;
  file: DocFile;
  /** Dotted path inside the file (`Class.method`). */
  path: string;
}

/** Build a resolver over one doc model (index built once per build). */
export function createBindingResolver(model: DocModel): BindingResolver {
  const files = new Map(model.files.map((f) => [f.path, f]));
  const symbolsByFile = new Map<string, Map<string, IndexedSymbol>>();
  const byName = new Map<string, IndexedSymbol[]>();
  const endpoints = new Map<string, IndexedSymbol>();
  for (const file of model.files) {
    const perFile = new Map<string, IndexedSymbol>();
    const walk = (symbols: DocSymbolShape[], prefix: string): void => {
      for (const symbol of symbols) {
        const path = prefix ? `${prefix}.${symbol.name}` : symbol.name;
        const entry = { symbol, file, path };
        if (!perFile.has(path)) perFile.set(path, entry);
        if (symbol.kind === "endpoint") {
          endpoints.set(normalizeEndpoint(symbol.name), entry);
        } else if (symbol.kind !== "section") {
          const list = byName.get(symbol.name) ?? [];
          list.push(entry);
          byName.set(symbol.name, list);
        }
        if (symbol.members) walk(symbol.members, path);
      }
    };
    walk(file.symbols, "");
    symbolsByFile.set(file.path, perFile);
  }

  const symbolTarget = (e: IndexedSymbol): ResolvedTarget => ({
    kind: "symbol",
    id: e.symbol.id,
    path: e.file.path,
    name: e.path,
    hash: e.symbol.contentHash,
  });

  return {
    resolve(raw: string): ResolvedTarget | undefined {
      const ref = raw.trim().replace(/^`|`$/g, "");
      if (!ref) return undefined;
      if (HTTP_METHOD.test(ref)) {
        const hit = endpoints.get(normalizeEndpoint(ref));
        return hit ? symbolTarget(hit) : undefined;
      }
      const hashAt = ref.indexOf("#");
      if (hashAt > 0) {
        const path = ref.slice(0, hashAt).replace(/^\.\//, "");
        const name = ref.slice(hashAt + 1);
        const hit = symbolsByFile.get(path)?.get(name);
        return hit ? symbolTarget(hit) : undefined;
      }
      const path = ref.replace(/^\.\//, "");
      const file = files.get(path);
      if (file) return { kind: "file", id: file.id, path: file.path, hash: file.contentHash };
      if (path.endsWith("/") || path.includes("/")) {
        const dir = path.replace(/\/+$/, "");
        const under = model.files.filter((f) => f.path.startsWith(`${dir}/`));
        if (under.length > 0) {
          return {
            kind: "dir",
            id: `${model.repo.slug}:${dir}/`,
            path: dir,
            hash: hashContent(under.map((f) => `${f.path}:${f.contentHash}`).sort().join("\n")),
          };
        }
        return undefined;
      }
      // Bare name: only a unique match counts — guessing between two
      // same-named declarations would bind the doc to the wrong code.
      const candidates = byName.get(ref);
      if (candidates && candidates.length === 1) return symbolTarget(candidates[0]!);
      const exported = candidates?.filter((c) => c.symbol.exported);
      if (exported && exported.length === 1) return symbolTarget(exported[0]!);
      return undefined;
    },
  };
}

function normalizeEndpoint(name: string): string {
  const [method, ...rest] = name.trim().split(/\s+/);
  return `${method!.toUpperCase()} ${rest.join(" ")}`;
}

/** Backticked spans in free text — candidates for inferred bindings. */
export function backtickedRefs(text: string | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(/`([^`\n]{1,200})`/g)) out.push(m[1]!.trim());
  // Endpoint mentions without backticks ("calls GET /api/repos") are still
  // unambiguous enough to bind.
  for (const m of text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s,;)]*)/g)) {
    out.push(`${m[1]} ${m[2]}`);
  }
  return out;
}

/**
 * Resolve a document's explicit and inferred references into bindings, with
 * drift state against the previous build's baseline for the same document.
 * `previous` maps `<step>|<ref>` → baseline hash; it only applies while the
 * document itself is unchanged (`docUnchanged`) — editing the doc (or its
 * `verified:` field) re-baselines every binding.
 */
export function resolveBindings(
  resolver: BindingResolver,
  refs: { ref: string; step?: string; inferred: boolean }[],
  previous: Map<string, string> | undefined,
  docUnchanged: boolean,
): CodeBinding[] {
  const out: CodeBinding[] = [];
  const seen = new Set<string>();
  for (const { ref, step, inferred } of refs) {
    const key = bindingKey(step, ref);
    if (seen.has(key)) continue;
    const target = resolver.resolve(ref);
    // An inferred mention that doesn't resolve is just prose, not a binding.
    if (!target && inferred) continue;
    seen.add(key);
    if (!target) {
      out.push({ ref, step, inferred, state: "broken" });
      continue;
    }
    const { hash, ...rest } = target;
    const prior = docUnchanged ? previous?.get(key) : undefined;
    const baselineHash = prior ?? hash;
    out.push({
      ref,
      step,
      inferred,
      target: rest,
      hash,
      baselineHash,
      state: baselineHash === hash ? "ok" : "changed",
    });
  }
  return out;
}

export function bindingKey(step: string | undefined, ref: string): string {
  return `${step ?? ""}|${ref}`;
}
