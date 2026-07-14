import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, Outlet, useLocation, useMatch, useParams, useSearchParams } from "react-router-dom";
import {
  fetchArtefacts,
  fetchCoreDocs,
  fetchModel,
  fetchRegistry,
  fetchSkillSet,
  fetchSkillSets,
  fetchSources,
  fetchStatus,
  fetchSubsystems,
  flattenSymbols,
  generateArtefact,
  generateSkills,
  type ArtefactGenerateResult,
  type ArtefactIndex,
  type CoreDocsManifest,
  type DocModel,
  type DocSymbolShape,
  type Registry,
  type SkillSet,
  type SkillSetIndex,
  type SkillsGenerateResult,
  type SourcesManifest,
  type StatusResponse,
  type Subsystem,
  type SubsystemsManifest,
} from "./api.js";
import {
  CodeText,
  DocText,
  KindBadge,
  ProvenanceBadge,
  ScopeBadge,
  ScrollToAnchor,
  Sidebar,
} from "./components.js";
import { MarkdownDoc } from "./markdown.js";
import { RepoInfoDrawer } from "./meta.js";
import { ApiReference } from "./openapi.js";
import {
  anchorForSymbol,
  buildSymbolIndex,
  fileHref,
  makeResolver,
  makeTargetResolver,
  resolveImport,
  sourceHref,
  type SymbolResolver,
} from "./resolve.js";
import { buildSiteIndex } from "./search.js";
import { SourcePanel, SplitSourceView } from "./source.js";

function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data?: T; error?: string; loading: boolean } {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    let live = true;
    // Keep the previous data while refetching so polled views (StatusView)
    // update in place instead of flashing back to a spinner.
    setState((s) => ({ ...s, loading: true }));
    fn()
      .then((data) => live && setState({ data, loading: false }))
      .catch(
        (err: unknown) => live && setState((s) => ({ data: s.data, error: String(err), loading: false })),
      );
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
  const [searchParams] = useSearchParams();
  // The doc column stays readable-width; with the source panel open the file
  // page needs the whole viewport for its split view.
  const wide = fileMatch !== null && searchParams.get("source") === "1";
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
        <main className={`relative mx-auto w-full ${wide ? "max-w-none" : "max-w-4xl"} px-5 py-8`}>
          <ScrollToAnchor />
          {slug && <RepoInfoDrawer slug={slug} />}
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
  if (error && !data) return <div className="alert alert-error">Failed to load status: {error}</div>;
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

// ---- Skills & artefacts (slice 8): generated skill sets + filled templates ----

const TOKEN_KEY = "necronomidoc-token";

// sessionStorage (never localStorage) so the admin token dies with the tab.
function useServerToken(): [string, (t: string) => void] {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? "");
  return [
    token,
    (t: string) => {
      setToken(t);
      sessionStorage.setItem(TOKEN_KEY, t);
    },
  ];
}

function ScopePicker({
  registry,
  all,
  setAll,
  selected,
  setSelected,
}: {
  registry?: Registry;
  all: boolean;
  setAll: (all: boolean) => void;
  selected: string[];
  setSelected: (repos: string[]) => void;
}) {
  return (
    <div>
      <div className="mb-1 text-sm font-medium">Scope</div>
      <div className="flex flex-wrap gap-4">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="radio" className="radio radio-sm" checked={all} onChange={() => setAll(true)} />
          All repos
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="radio" className="radio radio-sm" checked={!all} onChange={() => setAll(false)} />
          Selected repos
        </label>
      </div>
      {!all && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
          {registry?.repos.map((r) => (
            <label key={r.slug} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="checkbox checkbox-sm"
                checked={selected.includes(r.slug)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked ? [...selected, r.slug] : selected.filter((s) => s !== r.slug),
                  )
                }
              />
              <span className="font-mono">{r.slug}</span>
            </label>
          ))}
          {(registry?.repos.length ?? 0) === 0 && (
            <p className="text-sm text-base-content/60">No repos in the registry yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

function TokenInput({ token, setToken }: { token: string; setToken: (t: string) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      Server token
      <input
        type="password"
        className="input input-sm max-w-xs grow"
        placeholder="Bearer token"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        autoComplete="off"
      />
    </label>
  );
}

function GenerateSkillsForm({ registry, onDone }: { registry?: Registry; onDone: () => void }) {
  const [all, setAll] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [force, setForce] = useState(false);
  const [token, setToken] = useServerToken();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<SkillsGenerateResult>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(undefined);
    setResult(undefined);
    try {
      const res = await generateSkills(all ? { all: true, force } : { repos: selected, force }, token);
      setResult(res);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="card card-border bg-base-100">
      <div className="card-body gap-3 p-5">
        <ScopePicker registry={registry} all={all} setAll={setAll} selected={selected} setSelected={setSelected} />
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="checkbox checkbox-sm"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
          />
          Force regenerate even when the cached set is fresh
        </label>
        <TokenInput token={token} setToken={setToken} />
        <p className="text-xs text-base-content/60">
          Needs the server's admin bearer token. Generation calls the LLM and can take a minute or more.
        </p>
        <div>
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={pending || !token || (!all && selected.length === 0)}
          >
            {pending && <span className="loading loading-spinner loading-xs" />}
            {pending ? "Generating…" : "Generate skills"}
          </button>
        </div>
        {error && (
          <div className="alert alert-error">
            <span>{error}</span>
          </div>
        )}
        {result && (
          <div className="alert alert-success">
            <span>
              {result.cached ? (
                <>
                  Cached set <code>{result.setId}</code> is still fresh — nothing regenerated.
                </>
              ) : (
                <>
                  Wrote {result.skillsWritten} skills to <code>{result.setId}</code> ({result.calls}{" "}
                  calls, {result.inputTokens + result.outputTokens} tokens).
                </>
              )}
            </span>
          </div>
        )}
      </div>
    </form>
  );
}

export function SkillsView() {
  const [refresh, setRefresh] = useState(0);
  const { data, error, loading } = useAsync<SkillSetIndex | undefined>(fetchSkillSets, [refresh]);
  const { data: registry } = useAsync<Registry>(fetchRegistry, []);

  if (loading && !data) return <Loading />;
  if (error && !data) return <div className="alert alert-error">Failed to load skill sets: {error}</div>;
  if (!data) {
    return (
      <div className="alert alert-info">
        <span>Skills need a running server — they aren't available in a static export.</span>
      </div>
    );
  }

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">Skills</h1>
      <p className="mb-6 text-base-content/60">
        Generated agent skill sets (SKILL.md folders) drawn from the documented repos.
      </p>
      {data.sets.length === 0 ? (
        <div className="alert alert-warning">
          <span>No skill sets yet — generate one below.</span>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Set</th>
                <th>Scope</th>
                <th>Repos</th>
                <th>Skills</th>
                <th>Generated</th>
                <th>Model</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.sets.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link to={`/skills/${s.id}`} className="link-hover link font-mono text-sm">
                      {s.id}
                    </Link>
                  </td>
                  <td>
                    <ScopeBadge scope={s.scope} />
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {s.repos.map((r) => (
                        <span key={r} className="badge badge-ghost badge-sm font-mono">
                          {r}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>{s.skillCount}</td>
                  <td className="whitespace-nowrap text-sm">
                    {s.generatedAt ? new Date(s.generatedAt).toLocaleString() : "—"}
                  </td>
                  <td className="text-sm">{s.model ?? "—"}</td>
                  <td>
                    <a href={`/api/skills/${s.id}/download`} className="link-hover link text-sm">
                      zip
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h2 className="mb-2 mt-8 text-lg font-semibold">Generate</h2>
      <GenerateSkillsForm registry={registry} onDone={() => setRefresh((n) => n + 1)} />
    </div>
  );
}

export function SkillSetView() {
  const { id = "" } = useParams();
  const { data: set, error, loading } = useAsync<SkillSet>(() => fetchSkillSet(id), [id]);

  if (loading) return <Loading />;
  if (error || !set) return <div className="alert alert-error">Failed to load skill set: {error}</div>;

  return (
    <div>
      <div className="breadcrumbs text-sm">
        <ul>
          <li>
            <Link to="/skills">Skills</Link>
          </li>
          <li className="font-medium">{set.id}</li>
        </ul>
      </div>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-bold">{set.id}</h1>
        <ScopeBadge scope={set.scope} />
        {set.repos.map((r) => (
          <span key={r} className="badge badge-ghost badge-sm font-mono">
            {r}
          </span>
        ))}
        <a href={`/api/skills/${set.id}/download`} className="btn btn-outline btn-sm ml-auto">
          Download zip
        </a>
      </div>
      <p className="mb-6 text-sm text-base-content/60">
        {set.skills.length} skill{set.skills.length === 1 ? "" : "s"}
        {set.generatedAt && <> · generated {new Date(set.generatedAt).toLocaleString()}</>}
        {set.model && <> · {set.model}</>}
      </p>
      {set.skills.map((skill) => (
        <div key={skill.id} className="card card-border mb-4 bg-base-100 scroll-mt-4" id={skill.id}>
          <div className="card-body gap-2 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <a href={`#${skill.id}`} className="text-lg font-semibold hover:underline">
                {skill.name}
              </a>
              <span className="badge badge-ghost badge-sm font-mono">{skill.id}</span>
            </div>
            <p className="text-sm text-base-content/70">{skill.description}</p>
            <div className="collapse-arrow collapse bg-base-200">
              <input type="checkbox" aria-label="Toggle skill body" />
              <div className="collapse-title text-sm font-medium">SKILL.md</div>
              <div className="collapse-content">
                <MarkdownDoc content={skill.body} slug="" path={`${skill.id}/SKILL.md`} files={[]} />
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function GenerateArtefactForm({ registry, onDone }: { registry?: Registry; onDone: () => void }) {
  const [file, setFile] = useState<File>();
  const [all, setAll] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [token, setToken] = useServerToken();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<ArtefactGenerateResult>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setPending(true);
    setError(undefined);
    setResult(undefined);
    try {
      const form = new FormData();
      form.set("template", file);
      form.set("repos", all ? "all" : selected.join(","));
      const res = await generateArtefact(form, token);
      setResult(res);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="card card-border bg-base-100">
      <div className="card-body gap-3 p-5">
        <label className="flex items-center gap-2 text-sm">
          Template
          <input
            type="file"
            className="file-input file-input-sm"
            accept=".md,.markdown,.txt,.docx"
            onChange={(e) => setFile(e.target.files?.[0])}
          />
        </label>
        <p className="text-xs text-base-content/60">
          Templates may mark fill-in points with <code>{"{{instruction}}"}</code> or{" "}
          <code>{"<instruction>"}</code>; templates without markers are planned into sections from
          their headings. Sections-mode .docx templates produce markdown output.
        </p>
        <ScopePicker registry={registry} all={all} setAll={setAll} selected={selected} setSelected={setSelected} />
        <TokenInput token={token} setToken={setToken} />
        <p className="text-xs text-base-content/60">
          Needs the server's admin bearer token. Generation calls the LLM and can take a minute or more.
        </p>
        <div>
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={pending || !file || !token || (!all && selected.length === 0)}
          >
            {pending && <span className="loading loading-spinner loading-xs" />}
            {pending ? "Generating…" : "Generate artefact"}
          </button>
        </div>
        {error && (
          <div className="alert alert-error">
            <span>{error}</span>
          </div>
        )}
        {result && (
          <div className={`alert ${result.failures.length > 0 || result.aborted ? "alert-warning" : "alert-success"}`}>
            <span>
              Filled {result.filled}/{result.tasks}{" "}
              {result.mode === "placeholders" ? "placeholders" : "sections"} ({result.calls} calls,{" "}
              {result.inputTokens + result.outputTokens} tokens).
              {result.markdownFallback && " Output fell back to markdown."}
              {result.aborted && " Generation stopped early at the token budget."}
              {result.failures.length > 0 && ` ${result.failures.length} failed.`}{" "}
              <a href={`/api/artefacts/${result.record.id}/output`} className="link">
                Download output
              </a>
            </span>
          </div>
        )}
      </div>
    </form>
  );
}

export function ArtefactsView() {
  const [refresh, setRefresh] = useState(0);
  const { data, error, loading } = useAsync<ArtefactIndex | undefined>(fetchArtefacts, [refresh]);
  const { data: registry } = useAsync<Registry>(fetchRegistry, []);

  if (loading && !data) return <Loading />;
  if (error && !data) return <div className="alert alert-error">Failed to load artefacts: {error}</div>;
  if (!data) {
    return (
      <div className="alert alert-info">
        <span>Artefacts need a running server — they aren't available in a static export.</span>
      </div>
    );
  }

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">Artefacts</h1>
      <p className="mb-6 text-base-content/60">
        Documents generated by filling an uploaded template from the documented repos.
      </p>
      {data.artefacts.length === 0 ? (
        <div className="alert alert-warning">
          <span>No artefacts yet — upload a template below.</span>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Name</th>
                <th>Mode</th>
                <th>Format</th>
                <th>Repos</th>
                <th>Filled</th>
                <th>Generated</th>
                <th>Download</th>
              </tr>
            </thead>
            <tbody>
              {data.artefacts.map((a) => (
                <tr key={a.id}>
                  <td className="text-sm font-medium">{a.name}</td>
                  <td>
                    <span className="badge badge-sm badge-info badge-outline">{a.mode}</span>
                  </td>
                  <td>
                    <span className="badge badge-ghost badge-sm">{a.format}</span>
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      <ScopeBadge scope={a.scope} />
                      {a.repos.map((r) => (
                        <span key={r} className="badge badge-ghost badge-sm font-mono">
                          {r}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>{a.sectionsFilled}</td>
                  <td className="whitespace-nowrap text-sm">
                    {a.generatedAt ? new Date(a.generatedAt).toLocaleString() : "—"}
                  </td>
                  <td className="whitespace-nowrap text-sm">
                    <a href={`/api/artefacts/${a.id}/output`} className="link-hover link">
                      output
                    </a>{" "}
                    ·{" "}
                    <a href={`/api/artefacts/${a.id}/template`} className="link-hover link">
                      template
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h2 className="mb-2 mt-8 text-lg font-semibold">Generate</h2>
      <GenerateArtefactForm registry={registry} onDone={() => setRefresh((n) => n + 1)} />
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
                  r.type === "symbol" ? anchorForSymbol(r.kind, r.name) : undefined,
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

// ---- Core docs: overview / conventions / packages / architecture (slice 7) ----

const CORE_DOC_TABS = [
  ["overview", "Overview"],
  ["conventions", "Conventions"],
  ["packages", "Packages"],
  ["architecture", "Architecture"],
] as const;

export function CoreDocView() {
  const { slug = "", kind = "overview" } = useParams();
  const { data: model, loading: modelLoading } = useAsync<DocModel>(() => fetchModel(slug), [slug]);
  const { data: manifest, loading } = useAsync<CoreDocsManifest | undefined>(
    () => fetchCoreDocs(slug),
    [slug],
  );

  if (loading || modelLoading) return <Loading />;
  const doc = manifest?.docs.find((d) => d.kind === kind);
  return (
    <div>
      <div role="tablist" className="tabs tabs-border mb-4">
        {CORE_DOC_TABS.map(([k, label]) => (
          <Link
            key={k}
            role="tab"
            to={`/r/${slug}/docs/${k}`}
            className={`tab ${k === kind ? "tab-active" : ""}`}
          >
            {label}
          </Link>
        ))}
      </div>
      {doc ? (
        <>
          <p className="mb-4">
            <ProvenanceBadge provenance={doc.provenance} stale={doc.stale} />{" "}
            <span className="text-xs text-base-content/60">
              {doc.provenance === "repo" && (
                <>
                  from <code>.necronomidoc/docs/{doc.kind}.md</code> in the source repo
                </>
              )}
              {doc.provenance === "override" && "server-side override"}
              {doc.provenance === "llm" && "generated by necronomidoc enrich"}
              {doc.provenance === "heuristic" && "heuristic draft — curate or enrich to replace it"}
            </span>
          </p>
          <MarkdownDoc content={doc.content} slug={slug} path={`.necronomidoc/docs/${doc.kind}.md`} files={model?.files ?? []} />
        </>
      ) : manifest ? (
        // Manifest loaded fine — the URL just names a kind that isn't one of
        // the four. Point back to the tabs rather than blaming the build.
        <div className="alert alert-warning">
          <span>
            No <code>{kind}</code> document — pick one of the tabs above.
          </span>
        </div>
      ) : (
        <div className="alert alert-info">
          <span>
            No core docs published for this repo yet — rebuild it with a current server, or run{" "}
            <code>necronomidoc enrich</code>.
          </span>
        </div>
      )}
    </div>
  );
}

// ---- Subsystems: purpose + boundaries per named group (slice 3) ----

function SubsystemCard({
  subsystem,
  slug,
  files,
}: {
  subsystem: Subsystem;
  slug: string;
  files: DocModel["files"];
}) {
  const owned = files.filter((f) =>
    subsystem.dirs.length === 0
      ? !f.path.includes("/")
      : subsystem.dirs.some((d) => f.path === d || f.path.startsWith(`${d.replace(/\/+$/, "")}/`)),
  );
  return (
    <div className="card card-border mb-4 bg-base-100" id={subsystem.id}>
      <div className="card-body gap-2 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">{subsystem.name}</h2>
          <ProvenanceBadge provenance={subsystem.provenance} />
          {subsystem.dirs.map((d) => (
            <span key={d} className="badge badge-ghost badge-sm font-mono">
              {d}/
            </span>
          ))}
        </div>
        <p>
          <DocText text={subsystem.purpose} />
        </p>
        {(subsystem.owns.length > 0 || subsystem.notOwns.length > 0) && (
          <div className="grid gap-3 sm:grid-cols-2">
            {subsystem.owns.length > 0 && (
              <div>
                <h3 className="mb-1 text-sm font-medium text-success">Owns</h3>
                <ul className="list-inside list-disc text-sm text-base-content/80">
                  {subsystem.owns.map((o, i) => (
                    <li key={i}>{o}</li>
                  ))}
                </ul>
              </div>
            )}
            {subsystem.notOwns.length > 0 && (
              <div>
                <h3 className="mb-1 text-sm font-medium text-error">Does not own</h3>
                <ul className="list-inside list-disc text-sm text-base-content/80">
                  {subsystem.notOwns.map((o, i) => (
                    <li key={i}>{o}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        {subsystem.entryPoints.length > 0 && (
          <p className="text-sm">
            <span className="text-base-content/60">Entry points: </span>
            {subsystem.entryPoints.map((entry, i) => {
              const isFile = files.some((f) => f.path === entry);
              return (
                <span key={entry}>
                  {i > 0 && ", "}
                  {isFile ? (
                    <Link to={fileHref(slug, entry)} className="xref font-mono">
                      {entry}
                    </Link>
                  ) : (
                    <code>{entry}</code>
                  )}
                </span>
              );
            })}
          </p>
        )}
        {subsystem.related.length > 0 && (
          <ul className="text-sm text-base-content/70">
            {subsystem.related.map((r, i) => (
              <li key={i}>
                ↔ <span className="font-medium">{r.name}</span> — {r.relation}
              </li>
            ))}
          </ul>
        )}
        {owned.length > 0 && (
          <div className="collapse-arrow collapse bg-base-200">
            <input type="checkbox" aria-label="Toggle files" />
            <div className="collapse-title text-sm font-medium">
              {owned.length} file{owned.length === 1 ? "" : "s"}
            </div>
            <div className="collapse-content">
              <ul className="space-y-1 text-sm">
                {owned.map((f) => (
                  <li key={f.id} className="font-mono">
                    <Link to={fileHref(slug, f.path)} className="xref">
                      {f.path}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function SubsystemsView() {
  const { slug = "" } = useParams();
  const { data: model, loading: modelLoading } = useAsync<DocModel>(() => fetchModel(slug), [slug]);
  const { data: manifest, loading } = useAsync<SubsystemsManifest | undefined>(
    () => fetchSubsystems(slug),
    [slug],
  );

  if (loading || modelLoading) return <Loading />;
  if (!manifest || manifest.subsystems.length === 0) {
    return (
      <div>
        <h1 className="mb-1 text-2xl font-bold">Subsystems</h1>
        <div className="alert alert-info mt-4">
          <span>
            No subsystem map published for this repo yet — rebuild it, curate{" "}
            <code>.necronomidoc/subsystems.yaml</code>, or run{" "}
            <code>necronomidoc enrich --subsystems</code>.
          </span>
        </div>
      </div>
    );
  }

  const curated = manifest.subsystems.some((s) => s.provenance !== "heuristic");
  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">Subsystems</h1>
      <p className="mb-6 text-base-content/60">
        {curated
          ? "What each part of this repo owns — and what does not belong in it."
          : "Heuristic grouping by top-level directory. Curate .necronomidoc/subsystems.yaml for real boundaries."}
      </p>
      {manifest.subsystems.map((s) => (
        <SubsystemCard key={s.id} subsystem={s} slug={slug} files={model?.files ?? []} />
      ))}
    </div>
  );
}

// ---- File page: purpose, imports, symbol cards ----

function SymbolCard({
  symbol,
  resolve,
  sourceLink,
}: {
  symbol: DocSymbolShape;
  resolve: SymbolResolver;
  /** Href opening the source panel at this symbol's declaration line. */
  sourceLink?: string;
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
          {sourceLink && (
            <Link
              to={sourceLink}
              className="btn btn-ghost btn-xs font-mono text-base-content/60"
              title={`View source (line ${symbol.location.line})`}
            >
              {"</>"}
            </Link>
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
  const { data: sources } = useAsync<SourcesManifest | undefined>(
    () => fetchSources(slug),
    [slug],
  );
  const [searchParams, setSearchParams] = useSearchParams();
  const symbolIndex = useMemo(() => (model ? buildSymbolIndex(model) : undefined), [model]);
  const resolve = useMemo(
    () => (symbolIndex ? makeResolver(slug, symbolIndex, filePath) : undefined),
    [slug, symbolIndex, filePath],
  );
  const targets = useMemo(
    () => (symbolIndex ? makeTargetResolver(symbolIndex, filePath) : undefined),
    [symbolIndex, filePath],
  );

  if (loading) return <Loading />;
  const file = model?.files.find((f) => f.path === filePath);
  if (!file || !resolve) return <div className="alert alert-error">File not found: {filePath}</div>;
  const symbols = flattenSymbols(file);

  // Source viewer state lives in the URL so cross-file symbol links can open
  // the panel focused on a declaration line (decision 0020).
  const hasSnapshot =
    file.format === "source" && (sources?.files.some((s) => s.path === filePath) ?? false);
  const sourceOpen = hasSnapshot && searchParams.get("source") === "1";
  const focusLine = Number(searchParams.get("line") ?? "") || undefined;
  const openSource = (): void =>
    setSearchParams(
      (p) => {
        p.set("source", "1");
        return p;
      },
      { replace: true },
    );
  const closeSource = (): void =>
    setSearchParams(
      (p) => {
        p.delete("source");
        p.delete("line");
        return p;
      },
      { replace: true },
    );

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

  // API specs render as an interactive reference (slice 4).
  if (file.format === "openapi") {
    return (
      <div>
        {breadcrumbs}
        <ApiReference file={file} />
      </div>
    );
  }

  const doc = (
    <div>
      {breadcrumbs}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-xl font-bold">{file.path}</h1>
        {hasSnapshot && !sourceOpen && (
          <button type="button" className="btn btn-outline btn-xs" onClick={openSource}>
            View source
          </button>
        )}
      </div>
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
                          const imported = target
                            ? symbolIndex?.perFile.get(target)?.get(bare)
                            : undefined;
                          const href = imported
                            ? fileHref(slug, target!, imported.anchor)
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
        <SymbolCard
          key={s.id}
          symbol={s}
          resolve={resolve}
          sourceLink={hasSnapshot ? sourceHref(slug, filePath, s.location.line, s.name) : undefined}
        />
      ))}
    </div>
  );

  if (!sourceOpen || !targets) return doc;

  return (
    <SplitSourceView
      doc={doc}
      panel={
        <SourcePanel
          slug={slug}
          path={filePath}
          focusLine={focusLine}
          targets={targets}
          onClose={closeSource}
        />
      }
    />
  );
}
