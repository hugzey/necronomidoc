import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  fetchModel,
  fetchRegistry,
  flattenSymbols,
  type DocFile,
  type DocModel,
  type DocSymbolShape,
  type Registry,
} from "./api.js";
import { buildSiteIndex } from "./search.js";

function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data?: T; error?: string; loading: boolean } {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    let live = true;
    setState({ loading: true });
    fn()
      .then((data) => live && setState({ data, loading: false }))
      .catch((err: unknown) => live && setState({ error: String(err), loading: false }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

function ProvenanceBadge({ provenance, stale }: { provenance?: string; stale?: boolean }) {
  if (!provenance) return null;
  return (
    <span className={`badge prov-${provenance}`}>
      {provenance}
      {stale ? " · stale" : ""}
    </span>
  );
}

function KindBadge({ kind }: { kind: string }) {
  return <span className={`badge kind-${kind}`}>{kind}</span>;
}

export function RepoList() {
  const { data, error, loading } = useAsync<Registry>(fetchRegistry, []);
  return (
    <div className="page">
      <h1>necronomidoc</h1>
      <p className="muted">Documented repositories</p>
      {loading && <p>Loading…</p>}
      {error && <p className="error">No registry yet. Build a repo: <code>necronomidoc build &lt;path&gt;</code></p>}
      <ul className="repo-list">
        {data?.repos.map((r) => (
          <li key={r.slug}>
            <Link to={`/r/${r.slug}`}>{r.name}</Link>
            <span className="muted">
              {" "}
              — {r.fileCount} files, {r.symbolCount} symbols
            </span>
            {r.summary && <div className="muted small">{r.summary}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function groupByDir(files: DocFile[]): Map<string, DocFile[]> {
  const groups = new Map<string, DocFile[]>();
  for (const f of files) {
    const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ".";
    const list = groups.get(dir) ?? [];
    list.push(f);
    groups.set(dir, list);
  }
  return new Map([...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

export function RepoView() {
  const { slug = "" } = useParams();
  const { data: model, error, loading } = useAsync<DocModel>(() => fetchModel(slug), [slug]);
  const [query, setQuery] = useState("");
  const index = useMemo(() => (model ? buildSiteIndex(model) : undefined), [model]);
  const results = useMemo(() => (index && query ? index.search(query).slice(0, 25) : []), [index, query]);

  if (loading) return <div className="page">Loading…</div>;
  if (error || !model) return <div className="page error">Failed to load repo.</div>;

  const groups = groupByDir(model.files);

  return (
    <div className="page">
      <p><Link to="/">← all repos</Link></p>
      <h1>{model.repo.name}</h1>
      <input
        className="search"
        placeholder="Search files and symbols…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {query && (
        <ul className="results">
          {results.map((r) => (
            <li key={r.id}>
              <Link to={`/r/${slug}/f/${r.path}${r.type === "symbol" ? `#${r.name}` : ""}`}>
                <KindBadge kind={String(r.kind ?? r.type)} /> {r.name}
              </Link>
              <span className="muted small"> {r.path}</span>
              {r.summary && <div className="muted small">{r.summary}</div>}
            </li>
          ))}
          {results.length === 0 && <li className="muted">No matches.</li>}
        </ul>
      )}
      {!query &&
        [...groups.entries()].map(([dir, files]) => (
          <section key={dir}>
            <h3 className="dir">{dir}/</h3>
            <ul className="file-list">
              {files.map((f) => (
                <li key={f.id}>
                  <Link to={`/r/${slug}/f/${f.path}`}>{f.path.split("/").pop()}</Link>
                  {f.enrichment && (
                    <>
                      {" "}
                      <ProvenanceBadge provenance={f.enrichment.provenance} stale={f.enrichment.stale} />
                      <div className="muted small">{f.enrichment.summary}</div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}

function SymbolCard({ symbol }: { symbol: DocSymbolShape }) {
  return (
    <div className="symbol" id={symbol.name}>
      <div className="symbol-head">
        <strong>{symbol.name}</strong> <KindBadge kind={symbol.kind} />
        {symbol.exported ? <span className="badge export">export</span> : <span className="badge internal">internal</span>}
      </div>
      {symbol.signature && <pre className="sig"><code>{symbol.signature}</code></pre>}
      {symbol.enrichment && (
        <p className="purpose">
          {symbol.enrichment.summary} <ProvenanceBadge provenance={symbol.enrichment.provenance} stale={symbol.enrichment.stale} />
          {symbol.enrichment.purpose && <span className="muted small"> — {symbol.enrichment.purpose}</span>}
        </p>
      )}
      {symbol.doc?.remarks && <p className="muted small">{symbol.doc.remarks}</p>}
      {symbol.doc?.params && symbol.doc.params.length > 0 && (
        <table className="props">
          <thead><tr><th>param</th><th>type</th><th>description</th></tr></thead>
          <tbody>
            {symbol.doc.params.map((p) => (
              <tr key={p.name}><td><code>{p.name}</code></td><td>{p.type}</td><td>{p.text}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {symbol.doc?.returns && <p><span className="muted">returns:</span> {symbol.doc.returns}</p>}
      {symbol.props && symbol.props.length > 0 && (
        <table className="props">
          <thead><tr><th>prop</th><th>type</th><th>required</th><th>description</th></tr></thead>
          <tbody>
            {symbol.props.map((p) => (
              <tr key={p.name}>
                <td><code>{p.name}</code></td>
                <td><code>{p.type}</code></td>
                <td>{p.required ? "yes" : "no"}</td>
                <td>{p.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {symbol.doc?.examples?.map((ex, i) => (
        <pre key={i} className="example"><code>{ex}</code></pre>
      ))}
    </div>
  );
}

export function FileView() {
  const { slug = "", "*": filePath = "" } = useParams();
  const { data: model, loading } = useAsync<DocModel>(() => fetchModel(slug), [slug]);
  if (loading) return <div className="page">Loading…</div>;
  const file = model?.files.find((f) => f.path === filePath);
  if (!file) return <div className="page error">File not found: {filePath}</div>;
  const symbols = flattenSymbols(file);

  return (
    <div className="page">
      <p><Link to={`/r/${slug}`}>← {model!.repo.name}</Link></p>
      <h1 className="mono">{file.path}</h1>
      {file.enrichment && (
        <p className="purpose">
          {file.enrichment.summary} <ProvenanceBadge provenance={file.enrichment.provenance} stale={file.enrichment.stale} />
          {file.enrichment.purpose && <div className="muted">{file.enrichment.purpose}</div>}
        </p>
      )}
      {file.imports.length > 0 && (
        <details>
          <summary className="muted">{file.imports.length} imports</summary>
          <ul className="muted small">
            {file.imports.map((i, idx) => <li key={idx}><code>{i.moduleSpecifier}</code></li>)}
          </ul>
        </details>
      )}
      <h2>Symbols ({symbols.length})</h2>
      {symbols.map((s) => <SymbolCard key={s.id} symbol={s} />)}
    </div>
  );
}
