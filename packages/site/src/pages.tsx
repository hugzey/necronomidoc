import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Outlet, useLocation, useMatch, useParams } from "react-router-dom";
import {
  fetchModel,
  fetchRegistry,
  fetchStatus,
  flattenSymbols,
  type DocModel,
  type DocSymbolShape,
  type Registry,
  type StatusResponse,
} from "./api.js";
import {
  CodeText,
  DocText,
  KindBadge,
  ProvenanceBadge,
  ScrollToAnchor,
  Sidebar,
} from "./components.js";
import { MarkdownDoc } from "./markdown.js";
import {
  buildSymbolIndex,
  fileHref,
  makeResolver,
  resolveImport,
  slugifyAnchor,
  type SymbolResolver,
} from "./resolve.js";
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

function Loading() {
  return (
    <div className="flex justify-center p-10">
      <span className="loading loading-spinner loading-md" aria-label="Loading" />
    </div>
  );
}

// ---- Layout: drawer with sidebar (persistent on lg, overlay below) ----

export function Layout() {
  const match = useMatch("/r/:slug/*");
  const slug = match?.params.slug;
  const fileMatch = useMatch("/r/:slug/f/*");
  const activePath = fileMatch?.params["*"];
  const { data: registry } = useAsync<Registry>(fetchRegistry, []);
  const { data: model } = useAsync<DocModel | undefined>(
    () => (slug ? fetchModel(slug) : Promise.resolve(undefined)),
    [slug],
  );
  const drawerRef = useRef<HTMLInputElement>(null);
  const location = useLocation();
  useEffect(() => {
    if (drawerRef.current) drawerRef.current.checked = false;
  }, [location]);

  return (
    <div className="drawer lg:drawer-open">
      <input id="app-drawer" type="checkbox" className="drawer-toggle" ref={drawerRef} />
      <div className="drawer-content">
        <header className="navbar border-b border-base-300 lg:hidden">
          <label htmlFor="app-drawer" className="btn btn-square btn-ghost" aria-label="Open sidebar">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </label>
          <Link to="/" className="btn btn-ghost text-lg font-bold">
            necronomidoc
          </Link>
        </header>
        <main className="mx-auto w-full max-w-4xl px-5 py-8">
          <ScrollToAnchor />
          <Outlet />
        </main>
      </div>
      <div className="drawer-side">
        <label htmlFor="app-drawer" className="drawer-overlay" aria-label="Close sidebar" />
        <Sidebar registry={registry} model={model} slug={slug} activePath={activePath} />
      </div>
    </div>
  );
}

// ---- Home: repo cards ----

export function Home() {
  const { data, error, loading } = useAsync<Registry>(fetchRegistry, []);
  if (loading) return <Loading />;
  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">Documentation</h1>
      <p className="mb-6 text-base-content/60">Generated docs for your team's repositories.</p>
      {error && (
        <div className="alert alert-warning">
          <span>
            No registry yet — build a repo first: <code>necronomidoc build &lt;path&gt;</code>
          </span>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {data?.repos.map((r) => (
          <Link key={r.slug} to={`/r/${r.slug}`} className="card card-border bg-base-100 transition-shadow hover:shadow-md">
            <div className="card-body p-5">
              <h2 className="card-title text-base">{r.name}</h2>
              {r.summary && (
                <p className="text-sm text-base-content/70">
                  <DocText text={r.summary} />
                </p>
              )}
              <div className="mt-1 flex gap-2 text-xs text-base-content/60">
                <span className="badge badge-ghost badge-sm">{r.fileCount} files</span>
                <span className="badge badge-ghost badge-sm">{r.symbolCount} symbols</span>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ---- Build status: registered sources, last builds, queue (slice 2) ----

function shortSha(sha?: string): string {
  return sha ? sha.slice(0, 8) : "—";
}

export function StatusView() {
  // Poll so a queued build's outcome shows up without a manual refresh.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  const { data, error, loading } = useAsync<StatusResponse | undefined>(fetchStatus, [tick]);

  if (loading && !data) return <Loading />;
  if (error) return <div className="alert alert-error">Failed to load status: {error}</div>;
  if (!data) {
    return (
      <div className="alert alert-info">
        <span>Build status needs a running server — it isn't available in a static export.</span>
      </div>
    );
  }

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">Build status</h1>
      <p className="mb-6 text-base-content/60">
        Registered source repos, their last builds, and the trigger queue.
      </p>

      {data.sources.length === 0 ? (
        <div className="alert alert-warning">
          <span>
            No source repos registered — add one with{" "}
            <code>necronomidoc repo add &lt;url&gt;</code>
          </span>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Repo</th>
                <th>Provider</th>
                <th>Branch</th>
                <th>Last build</th>
                <th>Commit</th>
                <th>Duration</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {data.sources.map((s) => (
                <tr key={s.id}>
                  <td className="font-mono text-sm">
                    {s.id}
                    {!s.enabled && <span className="badge badge-ghost badge-sm ml-2">disabled</span>}
                  </td>
                  <td>{s.provider}</td>
                  <td className="font-mono text-sm">{s.branch}</td>
                  <td className="whitespace-nowrap text-sm">
                    {s.lastBuild ? new Date(s.lastBuild.startedAt).toLocaleString() : "never"}
                  </td>
                  <td className="font-mono text-sm">{shortSha(s.lastBuild?.commitSha)}</td>
                  <td className="text-sm">
                    {s.lastBuild ? `${(s.lastBuild.durationMs / 1000).toFixed(1)}s` : "—"}
                  </td>
                  <td>
                    {s.lastBuild ? (
                      s.lastBuild.result === "ok" ? (
                        <span className="badge badge-success badge-sm">ok</span>
                      ) : (
                        <span className="badge badge-error badge-sm" title={s.lastBuild.error}>
                          failed
                        </span>
                      )
                    ) : (
                      <span className="badge badge-ghost badge-sm">pending</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="mb-2 mt-8 text-lg font-semibold">Queue ({data.queue.depth})</h2>
      {data.queue.items.length === 0 ? (
        <p className="text-sm text-base-content/60">Idle — no builds queued.</p>
      ) : (
        <ul className="menu w-full rounded-box bg-base-200">
          {data.queue.items.map((item, i) => (
            <li key={i} className="p-2 text-sm">
              <span>
                <span className="font-mono">{item.repoId}</span> via {item.provider} —{" "}
                {item.state === "running" ? (
                  <span className="badge badge-info badge-sm">building…</span>
                ) : (
                  <span className="badge badge-ghost badge-sm">waiting</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- Repo overview: search + file inventory ----

export function RepoView() {
  const { slug = "" } = useParams();
  const { data: model, error, loading } = useAsync<DocModel>(() => fetchModel(slug), [slug]);
  const [query, setQuery] = useState("");
  const searchIndex = useMemo(() => (model ? buildSiteIndex(model) : undefined), [model]);
  const symbolIndex = useMemo(() => (model ? buildSymbolIndex(model) : undefined), [model]);
  const resolve = useMemo(
    () => (symbolIndex ? makeResolver(slug, symbolIndex) : undefined),
    [slug, symbolIndex],
  );
  const results = useMemo(
    () => (searchIndex && query ? searchIndex.search(query).slice(0, 25) : []),
    [searchIndex, query],
  );

  if (loading) return <Loading />;
  if (error || !model) return <div className="alert alert-error">Failed to load repo.</div>;
  const readme = model.files.find((f) => f.format === "markdown" && /^readme\.(md|markdown|mdx)$/i.test(f.path));

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">{model.repo.name}</h1>
      <label className="input w-full">
        <svg className="h-4 w-4 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z" />
        </svg>
        <input
          type="search"
          placeholder="Search files and symbols…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      {query ? (
        <ul className="menu mt-4 w-full rounded-box bg-base-200">
          {results.map((r) => (
            <li key={r.id}>
              <Link
                to={fileHref(
                  slug,
                  r.path,
                  r.type !== "symbol" ? undefined : r.kind === "section" ? slugifyAnchor(r.name) : r.name,
                )}
              >
                <KindBadge kind={String(r.kind ?? r.type)} />
                <span className="font-medium">{r.name}</span>
                <span className="text-xs text-base-content/60">{r.path}</span>
              </Link>
            </li>
          ))}
          {results.length === 0 && <li className="p-3 text-base-content/60">No matches.</li>}
        </ul>
      ) : (
        <>
          {readme?.content && (
            <div className="mt-6">
              <MarkdownDoc content={readme.content} slug={slug} path={readme.path} files={model.files} />
              <div className="divider" />
            </div>
          )}
          <h2 className="mb-2 mt-6 text-lg font-semibold">Files</h2>
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>File</th>
                <th>Purpose</th>
              </tr>
            </thead>
            <tbody>
              {model.files.map((f) => (
                <tr key={f.id}>
                  <td className="whitespace-nowrap align-top">
                    <Link to={fileHref(slug, f.path)} className="link-hover link font-mono text-sm">
                      {f.path}
                    </Link>
                  </td>
                  <td className="text-sm text-base-content/80">
                    {f.enrichment?.summary && <DocText text={f.enrichment.summary} resolve={resolve} />}{" "}
                    <ProvenanceBadge provenance={f.enrichment?.provenance} stale={f.enrichment?.stale} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
    </div>
  );
}

// ---- File page: purpose, imports, symbol cards ----

function SymbolCard({
  symbol,
  resolve,
}: {
  symbol: DocSymbolShape;
  resolve: SymbolResolver;
}) {
  return (
    <div className="card card-border mb-4 bg-base-100 scroll-mt-4" id={symbol.name}>
      <div className="card-body gap-2 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <a href={`#${symbol.name}`} className="text-lg font-semibold hover:underline">
            {symbol.name}
          </a>
          <KindBadge kind={symbol.kind} />
          {symbol.exported ? (
            <span className="badge badge-sm badge-success badge-outline">export</span>
          ) : (
            <span className="badge badge-sm badge-ghost">internal</span>
          )}
        </div>
        {symbol.signature && (
          <pre className="overflow-x-auto rounded-box bg-base-200 p-3 text-sm">
            <code>
              <CodeText text={symbol.signature} resolve={resolve} exclude={symbol.name} />
            </code>
          </pre>
        )}
        {symbol.enrichment?.summary && (
          <p>
            <DocText text={symbol.enrichment.summary} resolve={resolve} />{" "}
            <ProvenanceBadge provenance={symbol.enrichment.provenance} stale={symbol.enrichment.stale} />
          </p>
        )}
        {symbol.enrichment?.purpose && (
          <p className="text-sm text-base-content/70">
            <DocText text={symbol.enrichment.purpose} resolve={resolve} />
          </p>
        )}
        {symbol.doc?.remarks && (
          <p className="text-sm text-base-content/70">
            <DocText text={symbol.doc.remarks} resolve={resolve} />
          </p>
        )}
        {symbol.doc?.params && symbol.doc.params.length > 0 && (
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>param</th>
                  <th>type</th>
                  <th>description</th>
                </tr>
              </thead>
              <tbody>
                {symbol.doc.params.map((p) => (
                  <tr key={p.name}>
                    <td>
                      <code>{p.name}</code>
                    </td>
                    <td>{p.type && <code><CodeText text={p.type} resolve={resolve} /></code>}</td>
                    <td>{p.text && <DocText text={p.text} resolve={resolve} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {symbol.doc?.returns && (
          <p className="text-sm">
            <span className="text-base-content/60">returns:</span>{" "}
            <DocText text={symbol.doc.returns} resolve={resolve} />
          </p>
        )}
        {symbol.props && symbol.props.length > 0 && (
          <div className="overflow-x-auto">
            <table className="table table-sm table-zebra">
              <thead>
                <tr>
                  <th>prop</th>
                  <th>type</th>
                  <th>required</th>
                  <th>description</th>
                </tr>
              </thead>
              <tbody>
                {symbol.props.map((p) => (
                  <tr key={p.name}>
                    <td>
                      <code>{p.name}</code>
                    </td>
                    <td>{p.type && <code><CodeText text={p.type} resolve={resolve} /></code>}</td>
                    <td>{p.required ? "yes" : "no"}</td>
                    <td>{p.description && <DocText text={p.description} resolve={resolve} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {symbol.doc?.examples?.map((ex, i) => (
          <pre key={i} className="overflow-x-auto rounded-box border-l-4 border-primary bg-base-200 p-3 text-sm">
            <code>{ex}</code>
          </pre>
        ))}
      </div>
    </div>
  );
}

export function FileView() {
  const { slug = "", "*": filePath = "" } = useParams();
  const { data: model, loading } = useAsync<DocModel>(() => fetchModel(slug), [slug]);
  const symbolIndex = useMemo(() => (model ? buildSymbolIndex(model) : undefined), [model]);
  const resolve = useMemo(
    () => (symbolIndex ? makeResolver(slug, symbolIndex, filePath) : undefined),
    [slug, symbolIndex, filePath],
  );

  if (loading) return <Loading />;
  const file = model?.files.find((f) => f.path === filePath);
  if (!file || !resolve) return <div className="alert alert-error">File not found: {filePath}</div>;
  const symbols = flattenSymbols(file);

  const breadcrumbs = (
    <div className="breadcrumbs text-sm">
      <ul>
        <li>
          <Link to={`/r/${slug}`}>{model!.repo.name}</Link>
        </li>
        {filePath.split("/").map((seg, i, all) => (
          <li key={i} className={i === all.length - 1 ? "font-medium" : "text-base-content/60"}>
            {seg}
          </li>
        ))}
      </ul>
    </div>
  );

  // Prose documents render as a page, not as a symbol inventory.
  if (file.format === "markdown" && file.content) {
    return (
      <div>
        {breadcrumbs}
        <MarkdownDoc content={file.content} slug={slug} path={file.path} files={model!.files} />
      </div>
    );
  }

  return (
    <div>
      {breadcrumbs}
      <h1 className="mb-3 font-mono text-xl font-bold">{file.path}</h1>
      {file.enrichment?.summary && (
        <p className="mb-1">
          <DocText text={file.enrichment.summary} resolve={resolve} />{" "}
          <ProvenanceBadge provenance={file.enrichment.provenance} stale={file.enrichment.stale} />
        </p>
      )}
      {file.enrichment?.purpose && (
        <p className="mb-2 text-base-content/70">
          <DocText text={file.enrichment.purpose} resolve={resolve} />
        </p>
      )}

      {file.imports.length > 0 && (
        <div className="collapse-arrow collapse mb-4 bg-base-200">
          <input type="checkbox" aria-label="Toggle imports" />
          <div className="collapse-title text-sm font-medium">{file.imports.length} imports</div>
          <div className="collapse-content">
            <ul className="space-y-1 text-sm">
              {file.imports.map((imp, i) => {
                const target = resolveImport(file.path, imp.moduleSpecifier, model!.files);
                return (
                  <li key={i} className="font-mono">
                    {target ? (
                      <Link to={fileHref(slug, target)} className="xref">
                        {imp.moduleSpecifier}
                      </Link>
                    ) : (
                      <span className="text-base-content/70">{imp.moduleSpecifier}</span>
                    )}
                    {imp.names.length > 0 && (
                      <span className="text-base-content/60">
                        {" — "}
                        {imp.names.map((n, j) => {
                          const bare = n.replace(/^\* as /, "");
                          const href =
                            target && symbolIndex?.perFile.get(target)?.has(bare)
                              ? fileHref(slug, target, bare)
                              : resolve(bare);
                          return (
                            <span key={j}>
                              {j > 0 && ", "}
                              {href ? (
                                <Link to={href} className="xref">
                                  {n}
                                </Link>
                              ) : (
                                n
                              )}
                            </span>
                          );
                        })}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      <h2 className="mb-3 mt-6 text-lg font-semibold">Symbols ({symbols.length})</h2>
      {symbols.map((s) => (
        <SymbolCard key={s.id} symbol={s} resolve={resolve} />
      ))}
    </div>
  );
}
