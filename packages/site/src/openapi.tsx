import { useMemo, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import type { DocFile, DocSymbolShape } from "./api.js";
import { DocText, ProvenanceBadge } from "./components.js";
import { slugifyEndpointAnchor } from "./resolve.js";

/**
 * Interactive API reference for an `openapi`-format DocFile. The file's
 * `content` carries the bundled spec as JSON (internal `$ref`s only), so this
 * renders entirely client-side — no external reference widget, which keeps the
 * bundle small, matches the daisyUI look, and works in static exports
 * (decision 0012).
 */

type SpecNode = Record<string, unknown>;

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

const METHOD_BADGE: Record<string, string> = {
  get: "badge-success",
  post: "badge-info",
  put: "badge-warning",
  patch: "badge-warning",
  delete: "badge-error",
};

/**
 * Heuristic enrichment often just copies the spec's own summary/description —
 * suppress the (heuristic-provenance only) enrichment line when it adds
 * nothing over the spec text. Human/LLM enrichment always renders, so its
 * provenance and stale badges stay visible.
 */
function isEcho(enrichment: string, ...specTexts: unknown[]): boolean {
  const bare = enrichment.replace(/…$/, "").trim();
  return specTexts.some(
    (t) => typeof t === "string" && t.trim().replace(/\s+/g, " ").startsWith(bare),
  );
}

function MethodBadge({ method }: { method: string }) {
  return (
    <span className={`badge badge-sm font-mono uppercase ${METHOD_BADGE[method] ?? "badge-ghost"}`}>
      {method}
    </span>
  );
}

// ---- Spec traversal (mirrors the adapter's bundled-doc helpers) ----

function resolvePointer(doc: SpecNode, ref: string): SpecNode | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = doc;
  for (const seg of ref.slice(2).split("/")) {
    const key = seg.replace(/~1/g, "/").replace(/~0/g, "~");
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as SpecNode)[key];
  }
  return typeof node === "object" && node !== null ? (node as SpecNode) : undefined;
}

function deref(doc: SpecNode, node: unknown): SpecNode | undefined {
  let current = node;
  for (let i = 0; i < 4; i++) {
    if (typeof current !== "object" || current === null) return undefined;
    const ref = (current as SpecNode)["$ref"];
    if (typeof ref !== "string") return current as SpecNode;
    current = resolvePointer(doc, ref);
  }
  return undefined;
}

function refName(node: unknown): string | undefined {
  const ref = typeof node === "object" && node !== null ? (node as SpecNode)["$ref"] : undefined;
  return typeof ref === "string" ? ref.split("/").pop() : undefined;
}

interface Param {
  name: string;
  in: string;
  required: boolean;
  description?: string;
  schema?: unknown;
}

/** Merge path-item and operation parameters (operation wins on name+in). */
function mergedParams(doc: SpecNode, pathItem: SpecNode, op: SpecNode): Param[] {
  const byKey = new Map<string, Param>();
  for (const list of [pathItem["parameters"], op["parameters"]]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const p = deref(doc, raw);
      if (!p || typeof p["name"] !== "string") continue;
      const where = typeof p["in"] === "string" ? (p["in"] as string) : "query";
      byKey.set(`${where}:${p["name"]}`, {
        name: p["name"] as string,
        in: where,
        required: p["required"] === true,
        description: typeof p["description"] === "string" ? (p["description"] as string) : undefined,
        schema: p["schema"],
      });
    }
  }
  return [...byKey.values()];
}

// ---- Schema rendering (depth-limited, cycle-safe) ----

function typeLabel(doc: SpecNode, schema: unknown, depth = 0): string {
  const named = refName(schema);
  // Recursive array schemas (Tree = Tree[]) would loop without a depth cap.
  if (depth > 4) return named ?? "…";
  const s = deref(doc, schema);
  if (!s) return named ?? "unknown";
  if (s["type"] === "array") return `${typeLabel(doc, s["items"], depth + 1)}[]`;
  const base = typeof s["type"] === "string" ? (s["type"] as string) : named ?? "object";
  const format = typeof s["format"] === "string" ? ` (${s["format"] as string})` : "";
  return named && s["type"] === "object" ? named : `${base}${format}`;
}

function SchemaView({
  doc,
  schema,
  depth = 0,
  seen = new Set<string>(),
}: {
  doc: SpecNode;
  schema: unknown;
  depth?: number;
  seen?: Set<string>;
}) {
  const named = refName(schema);
  const s = deref(doc, schema);
  if (!s) return <code className="text-sm">{named ?? "unknown"}</code>;
  if (named && seen.has(named)) {
    // Recursive schema (e.g. User.manager: User) — stop at the cycle.
    return <code className="text-sm">{named} ↺</code>;
  }
  const nextSeen = named ? new Set(seen).add(named) : seen;

  if (s["type"] === "array") {
    return (
      <span className="text-sm">
        array of <SchemaView doc={doc} schema={s["items"]} depth={depth} seen={nextSeen} />
      </span>
    );
  }

  if (Array.isArray(s["enum"])) {
    return (
      <span className="flex flex-wrap items-center gap-1 text-sm">
        {typeof s["type"] === "string" ? (s["type"] as string) : "enum"}:
        {(s["enum"] as unknown[]).map((v, i) => (
          <code key={i} className="badge badge-ghost badge-sm font-mono">
            {JSON.stringify(v)}
          </code>
        ))}
      </span>
    );
  }

  const properties = s["properties"];
  if (typeof properties === "object" && properties !== null) {
    if (depth >= 3) return <code className="text-sm">{named ?? "object"} …</code>;
    const required = new Set(Array.isArray(s["required"]) ? (s["required"] as string[]) : []);
    return (
      <div className="text-sm">
        {named && <div className="mb-1 font-mono font-medium">{named}</div>}
        <ul className={depth > 0 ? "border-l border-base-300 pl-3" : ""}>
          {Object.entries(properties as SpecNode).map(([prop, propSchema]) => {
            const child = deref(doc, propSchema);
            const nested =
              child &&
              (typeof child["properties"] === "object" ||
                child["type"] === "array" ||
                Array.isArray(child["enum"]));
            return (
              <li key={prop} className="py-0.5">
                <code className="font-medium">{prop}</code>
                {required.has(prop) && <span className="text-error"> *</span>}
                <span className="text-base-content/60"> — </span>
                {nested ? (
                  <SchemaView doc={doc} schema={propSchema} depth={depth + 1} seen={nextSeen} />
                ) : (
                  <span className="text-base-content/70">{typeLabel(doc, propSchema)}</span>
                )}
                {child && typeof child["description"] === "string" && (
                  <span className="text-base-content/60"> — {child["description"] as string}</span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  return <span className="text-sm text-base-content/70">{typeLabel(doc, schema)}</span>;
}

// ---- "Try it" console ----

interface TryItProps {
  doc: SpecNode;
  method: string;
  pathKey: string;
  params: Param[];
  hasBody: boolean;
  bodyTypes: string[];
}

function TryIt({ doc, method, pathKey, params, hasBody, bodyTypes }: TryItProps) {
  const servers = Array.isArray(doc["servers"]) ? (doc["servers"] as SpecNode[]) : [];
  const [baseUrl, setBaseUrl] = useState(
    typeof servers[0]?.["url"] === "string" ? (servers[0]!["url"] as string) : "",
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [body, setBody] = useState("");
  const [contentType, setContentType] = useState(bodyTypes[0] ?? "application/json");
  const [result, setResult] = useState<{ status?: string; body?: string; error?: string }>();
  const [busy, setBusy] = useState(false);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    let url = pathKey.replace(/\{([^}]+)\}/g, (_, name: string) =>
      encodeURIComponent(values[`path:${name}`] ?? `{${name}}`),
    );
    const query = params
      .filter((p) => p.in === "query" && (values[`query:${p.name}`] ?? "") !== "")
      .map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(values[`query:${p.name}`]!)}`);
    if (query.length > 0) url += `?${query.join("&")}`;

    const headers: Record<string, string> = {};
    for (const p of params.filter((p) => p.in === "header")) {
      const v = values[`header:${p.name}`];
      if (v) headers[p.name] = v;
    }
    const useBody = hasBody && body.trim() !== "" && !["get", "head"].includes(method);
    if (useBody) headers["content-type"] = contentType;

    setBusy(true);
    setResult(undefined);
    const started = performance.now();
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}${url}`, {
        method: method.toUpperCase(),
        headers,
        body: useBody ? body : undefined,
      });
      const text = await res.text();
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* not JSON — show as-is */
      }
      setResult({
        status: `${res.status} ${res.statusText} · ${Math.round(performance.now() - started)}ms`,
        body: pretty.length > 20_000 ? `${pretty.slice(0, 20_000)}\n…(truncated)` : pretty,
      });
    } catch (err) {
      setResult({
        error:
          `${String(err)} — the request never reached a response. This is usually CORS: ` +
          "requests go straight from your browser to the API, so the target must allow " +
          "this docs origin (or be same-origin / a local dev server).",
      });
    } finally {
      setBusy(false);
    }
  };

  const input = (key: string, p: Param) => (
    <label key={key} className="input input-sm w-full">
      <span className="label font-mono text-xs">
        {p.name}
        {p.required && <span className="text-error">*</span>}
      </span>
      <input
        type="text"
        placeholder={typeLabel(doc, p.schema)}
        value={values[key] ?? ""}
        onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
      />
    </label>
  );

  return (
    <form onSubmit={send} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          type="text"
          className="input input-sm flex-1 font-mono"
          placeholder="https://api.example.com"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          list={servers.length > 0 ? `servers-${method}-${pathKey}` : undefined}
          aria-label="Base URL"
        />
        {servers.length > 0 && (
          <datalist id={`servers-${method}-${pathKey}`}>
            {servers.map((s, i) => (
              <option key={i} value={String(s["url"] ?? "")}>
                {String(s["description"] ?? "")}
              </option>
            ))}
          </datalist>
        )}
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !baseUrl}>
          {busy ? <span className="loading loading-spinner loading-xs" /> : "Send"}
        </button>
      </div>
      {(["path", "query", "header"] as const).map((where) => {
        const group = params.filter((p) => p.in === where);
        if (group.length === 0) return null;
        return (
          <div key={where} className="grid gap-2 sm:grid-cols-2">
            {group.map((p) => input(`${where}:${p.name}`, p))}
          </div>
        );
      })}
      {hasBody && (
        <>
          {bodyTypes.length > 1 && (
            <select
              className="select select-sm w-fit font-mono"
              value={contentType}
              onChange={(e) => setContentType(e.target.value)}
              aria-label="Request content type"
            >
              {bodyTypes.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          )}
          <textarea
            className="textarea textarea-sm w-full font-mono"
            rows={4}
            placeholder={`Request body (${contentType})`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </>
      )}
      <p className="text-xs text-base-content/60">
        Requests are sent from your browser directly to the API — the target must allow this
        origin via CORS for the response to be readable.
      </p>
      {result?.status && (
        <div>
          <span className="badge badge-outline badge-sm">{result.status}</span>
          <pre className="mt-1 max-h-80 overflow-auto rounded-box bg-base-200 p-3 text-xs">
            <code>{result.body}</code>
          </pre>
        </div>
      )}
      {result?.error && <div className="alert alert-warning text-sm">{result.error}</div>}
    </form>
  );
}

// ---- Operation card ----

function OperationCard({
  doc,
  method,
  pathKey,
  pathItem,
  op,
  symbol,
}: {
  doc: SpecNode;
  method: string;
  pathKey: string;
  pathItem: SpecNode;
  op: SpecNode;
  symbol?: DocSymbolShape;
}) {
  const anchor = slugifyEndpointAnchor(`${method.toUpperCase()} ${pathKey}`);
  const params = mergedParams(doc, pathItem, op);
  const requestBody = deref(doc, op["requestBody"]);
  const bodyContent =
    requestBody && typeof requestBody["content"] === "object" && requestBody["content"] !== null
      ? (requestBody["content"] as SpecNode)
      : undefined;
  const responses =
    typeof op["responses"] === "object" && op["responses"] !== null
      ? Object.entries(op["responses"] as SpecNode)
      : [];

  return (
    <div className="card card-border mb-4 bg-base-100 scroll-mt-4" id={anchor}>
      <div className="card-body gap-2 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <MethodBadge method={method} />
          <a href={`#${anchor}`} className="font-mono text-base font-semibold hover:underline">
            {pathKey}
          </a>
          {op["deprecated"] === true && <span className="badge badge-sm badge-error badge-outline">deprecated</span>}
          {typeof op["operationId"] === "string" && (
            <code className="text-xs text-base-content/50">{op["operationId"] as string}</code>
          )}
        </div>
        {typeof op["summary"] === "string" && <p className="font-medium">{op["summary"] as string}</p>}
        {symbol?.enrichment?.summary &&
          !(
            symbol.enrichment.provenance === "heuristic" &&
            isEcho(symbol.enrichment.summary, op["summary"], op["description"])
          ) && (
            <p>
              <DocText text={symbol.enrichment.summary} />{" "}
              <ProvenanceBadge provenance={symbol.enrichment.provenance} stale={symbol.enrichment.stale} />
            </p>
          )}
        {typeof op["description"] === "string" && (
          <div className="prose prose-sm max-w-none text-base-content/80">
            <ReactMarkdown>{op["description"] as string}</ReactMarkdown>
          </div>
        )}

        {params.length > 0 && (
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>parameter</th>
                  <th>in</th>
                  <th>type</th>
                  <th>required</th>
                  <th>description</th>
                </tr>
              </thead>
              <tbody>
                {params.map((p) => (
                  <tr key={`${p.in}:${p.name}`}>
                    <td>
                      <code>{p.name}</code>
                    </td>
                    <td>{p.in}</td>
                    <td>
                      <code>{typeLabel(doc, p.schema)}</code>
                    </td>
                    <td>{p.required ? "yes" : "no"}</td>
                    <td>{p.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {bodyContent && (
          <div>
            <h4 className="mb-1 text-sm font-medium">
              Request body{requestBody!["required"] === true && <span className="text-error"> *</span>}
            </h4>
            {Object.entries(bodyContent).map(([mime, media]) => (
              <div key={mime} className="rounded-box bg-base-200 p-3">
                <div className="mb-1 font-mono text-xs text-base-content/60">{mime}</div>
                <SchemaView doc={doc} schema={(media as SpecNode | null)?.["schema"]} />
              </div>
            ))}
          </div>
        )}

        {responses.length > 0 && (
          <div>
            <h4 className="mb-1 text-sm font-medium">Responses</h4>
            <ul className="flex flex-col gap-1">
              {responses.map(([code, raw]) => {
                const resp = deref(doc, raw);
                const content =
                  resp && typeof resp["content"] === "object" && resp["content"] !== null
                    ? (resp["content"] as SpecNode)
                    : undefined;
                return (
                  <li key={code} className="rounded-box bg-base-200 p-3">
                    <span
                      className={`badge badge-sm font-mono ${
                        code.startsWith("2") ? "badge-success" : code.startsWith("4") || code.startsWith("5") ? "badge-error badge-outline" : "badge-ghost"
                      }`}
                    >
                      {code}
                    </span>{" "}
                    <span className="text-sm">{String(resp?.["description"] ?? "")}</span>
                    {content &&
                      Object.entries(content).map(([mime, media]) => (
                        <div key={mime} className="mt-2">
                          <div className="mb-1 font-mono text-xs text-base-content/60">{mime}</div>
                          <SchemaView doc={doc} schema={(media as SpecNode | null)?.["schema"]} />
                        </div>
                      ))}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="collapse-arrow collapse bg-base-200">
          <input type="checkbox" aria-label="Toggle try-it console" />
          <div className="collapse-title text-sm font-medium">Try it</div>
          <div className="collapse-content">
            <TryIt
              doc={doc}
              method={method}
              pathKey={pathKey}
              params={params}
              hasBody={bodyContent !== undefined}
              bodyTypes={bodyContent ? Object.keys(bodyContent) : []}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- The reference page ----

export function ApiReference({ file }: { file: DocFile }) {
  const doc = useMemo(() => {
    if (!file.content) return undefined;
    try {
      return JSON.parse(file.content) as SpecNode;
    } catch {
      return undefined;
    }
  }, [file.content]);

  const symbolsByAnchor = useMemo(() => {
    const map = new Map<string, DocSymbolShape>();
    for (const s of file.symbols) {
      const hash = s.id.indexOf("#");
      if (hash !== -1) map.set(s.id.slice(hash + 1), s);
    }
    return map;
  }, [file.symbols]);

  if (!doc) {
    // No content + extracted operations = a valid spec whose bundled JSON
    // exceeded the adapter's size cap. Degrade to a plain operation listing
    // instead of masquerading as a parse failure.
    if (file.symbols.length > 0) {
      return (
        <div>
          <h1 className="mb-2 text-2xl font-bold">{file.title ?? file.path}</h1>
          <div className="alert alert-info mb-4">
            <span>
              This spec is too large for the interactive reference — showing the extracted
              operation list instead.
            </span>
          </div>
          {file.symbols.map((s) => (
            <div key={s.id} className="card card-border mb-3 bg-base-100 scroll-mt-4" id={s.id.slice(s.id.indexOf("#") + 1)}>
              <div className="card-body gap-1 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <MethodBadge method={s.name.split(" ")[0]?.toLowerCase() ?? ""} />
                  <span className="font-mono font-semibold">{s.name.split(" ").slice(1).join(" ")}</span>
                </div>
                {s.doc?.summary && <p className="text-sm">{s.doc.summary}</p>}
                {s.doc?.returns && <p className="text-xs text-base-content/60">{s.doc.returns}</p>}
              </div>
            </div>
          ))}
        </div>
      );
    }
    // Otherwise the spec failed to parse (or was Swagger 2.0) — moduleDoc
    // carries the explanation the adapter published.
    return (
      <div className="alert alert-warning">
        <span>{file.moduleDoc?.summary ?? "This spec could not be rendered."}</span>
      </div>
    );
  }

  const info = (doc["info"] ?? {}) as SpecNode;
  const servers = Array.isArray(doc["servers"]) ? (doc["servers"] as SpecNode[]) : [];
  const paths = (doc["paths"] ?? {}) as SpecNode;

  // Group operations by first tag, in root tag-declaration order.
  interface Op {
    method: string;
    pathKey: string;
    pathItem: SpecNode;
    op: SpecNode;
  }
  const groups = new Map<string, Op[]>();
  const declared = Array.isArray(doc["tags"]) ? (doc["tags"] as SpecNode[]) : [];
  for (const t of declared) {
    if (typeof t["name"] === "string") groups.set(t["name"] as string, []);
  }
  for (const [pathKey, rawItem] of Object.entries(paths)) {
    const pathItem = deref(doc, rawItem);
    if (!pathItem) continue;
    for (const method of METHODS) {
      const op = pathItem[method];
      if (typeof op !== "object" || op === null) continue;
      const tags = (op as SpecNode)["tags"];
      const tag = Array.isArray(tags) && typeof tags[0] === "string" ? (tags[0] as string) : "operations";
      const list = groups.get(tag) ?? [];
      list.push({ method, pathKey, pathItem, op: op as SpecNode });
      groups.set(tag, list);
    }
  }

  const tagDescription = (tag: string): string | undefined => {
    const t = declared.find((d) => d["name"] === tag);
    return t && typeof t["description"] === "string" ? (t["description"] as string) : undefined;
  };

  return (
    <div>
      <div className="mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold">{String(info["title"] ?? file.path)}</h1>
          {typeof info["version"] === "string" && (
            <span className="badge badge-outline badge-sm">v{info["version"] as string}</span>
          )}
          <span className="badge badge-warning badge-sm">
            OpenAPI {String(doc["openapi"] ?? "3.x")}
          </span>
        </div>
        {file.enrichment?.summary &&
          !(
            file.enrichment.provenance === "heuristic" &&
            isEcho(file.enrichment.summary, info["summary"], info["description"])
          ) && (
            <p className="mt-2">
              <DocText text={file.enrichment.summary} />{" "}
              <ProvenanceBadge provenance={file.enrichment.provenance} stale={file.enrichment.stale} />
            </p>
          )}
        {typeof info["description"] === "string" && (
          <div className="prose prose-sm mt-2 max-w-none text-base-content/80">
            <ReactMarkdown>{info["description"] as string}</ReactMarkdown>
          </div>
        )}
        {servers.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {servers.map((s, i) => (
              <span key={i} className="badge badge-ghost badge-sm font-mono" title={String(s["description"] ?? "")}>
                {String(s["url"] ?? "")}
              </span>
            ))}
          </div>
        )}
      </div>

      {[...groups.entries()]
        .filter(([, ops]) => ops.length > 0)
        .map(([tag, ops]) => {
          const description = tagDescription(tag);
          return (
          <section key={tag} className="mb-6">
            <h2 className="mb-1 text-lg font-semibold capitalize" id={`tag-${tag}`}>
              {tag}
            </h2>
            {description && <p className="mb-3 text-sm text-base-content/60">{description}</p>}
            {ops.map(({ method, pathKey, pathItem, op }) => (
              <OperationCard
                key={`${method} ${pathKey}`}
                doc={doc}
                method={method}
                pathKey={pathKey}
                pathItem={pathItem}
                op={op}
                symbol={symbolsByAnchor.get(slugifyEndpointAnchor(`${method.toUpperCase()} ${pathKey}`))}
              />
            ))}
          </section>
          );
        })}
    </div>
  );
}
