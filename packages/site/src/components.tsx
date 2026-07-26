import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { DocFile, DocModel, Registry } from "./api.js";
import { HELP_NAV, helpHref, helpIdFromPath, isActiveNavEntry } from "./help-nav.js";
import { fileHref, type SymbolResolver } from "./resolve.js";

// ---- Shared async-fetch hook + loading spinner ----

/**
 * Fetch-into-state with a stale-response guard: only the latest invocation
 * may set state, and errors are captured rather than left as unhandled
 * rejections. The single async pattern for every data-loading view.
 */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[],
): { data?: T; error?: string; loading: boolean } {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({
    loading: true,
  });
  useEffect(() => {
    let live = true;
    // Keep the previous data while refetching so polled views (StatusView)
    // update in place instead of flashing back to a spinner.
    setState((s) => ({ ...s, loading: true }));
    fn()
      .then((data) => live && setState({ data, loading: false }))
      .catch(
        (err: unknown) =>
          live && setState((s) => ({ data: s.data, error: String(err), loading: false })),
      );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

export function Loading() {
  return (
    <div className="flex justify-center p-10">
      <span className="loading loading-spinner loading-md" aria-label="Loading" />
    </div>
  );
}

// ---- Badges (daisyUI badge variants per symbol kind / provenance) ----

const KIND_BADGE: Record<string, string> = {
  component: "badge-primary",
  hook: "badge-secondary",
  class: "badge-accent",
  interface: "badge-info badge-outline",
  type: "badge-info badge-outline",
  enum: "badge-info badge-outline",
  endpoint: "badge-warning",
  section: "badge-neutral badge-outline",
};

export function KindBadge({ kind }: { kind: string }) {
  return <span className={`badge badge-sm ${KIND_BADGE[kind] ?? "badge-ghost"}`}>{kind}</span>;
}

const PROV_BADGE: Record<string, string> = {
  human: "badge-success",
  llm: "badge-warning",
  heuristic: "badge-ghost",
  // Core-doc sources: a file shipped in the repo and a server-side override
  // are both human-curated tiers.
  repo: "badge-success",
  override: "badge-info",
};

export function ProvenanceBadge({ provenance, stale }: { provenance?: string; stale?: boolean }) {
  if (!provenance) return null;
  return (
    <>
      <span className={`badge badge-sm ${PROV_BADGE[provenance] ?? "badge-ghost"}`}>{provenance}</span>
      {stale && <span className="badge badge-sm badge-error">stale</span>}
    </>
  );
}

const SCOPE_BADGE: Record<string, string> = {
  repo: "badge-ghost",
  multi: "badge-info badge-outline",
  global: "badge-primary badge-outline",
};

/** How many repos a generated skill set / artefact drew from (slice 8). */
export function ScopeBadge({ scope }: { scope: string }) {
  return <span className={`badge badge-sm ${SCOPE_BADGE[scope] ?? "badge-ghost"}`}>{scope}</span>;
}

// ---- Linkified text ----

const IDENT = /([A-Za-z_$][A-Za-z0-9_$]*)/;

/**
 * Render code-ish text (a signature, a type) with every identifier that
 * resolves to a documented symbol turned into a link. `exclude` suppresses
 * self-links on a symbol's own card.
 */
export function CodeText({
  text,
  resolve,
  exclude,
}: {
  text: string;
  resolve?: SymbolResolver;
  exclude?: string;
}) {
  const parts = text.split(IDENT);
  return (
    <>
      {parts.map((part, i) => {
        // Odd indexes are identifiers — but not when quoted (string literals
        // like "internal" must not link to a symbol of the same name).
        const quoted = /["']$/.test(parts[i - 1] ?? "") && /^["']/.test(parts[i + 1] ?? "");
        if (i % 2 === 1 && resolve && part !== exclude && !quoted) {
          const href = resolve(part);
          if (href) {
            return (
              <Link key={i} to={href} className="xref">
                {part}
              </Link>
            );
          }
        }
        return part;
      })}
    </>
  );
}

/**
 * Render prose doc text: `{@link Target}` / `{@link Target|label}` tags become
 * links, and `backticked` spans render as inline code (linkified when the name
 * resolves).
 */
export function DocText({ text, resolve }: { text: string; resolve?: SymbolResolver }) {
  const nodes: ReactNode[] = [];
  const linkSplit = text.split(/\{@link\s+([^}]+)\}/g);
  linkSplit.forEach((chunk, i) => {
    if (i % 2 === 1) {
      const [target = "", label] = chunk.split(/[|\s]+/, 2);
      const href = resolve?.(target);
      nodes.push(
        href ? (
          <Link key={`l${i}`} to={href} className="xref">
            <code>{label ?? target}</code>
          </Link>
        ) : (
          <code key={`l${i}`}>{label ?? target}</code>
        ),
      );
      return;
    }
    chunk.split(/`([^`]+)`/g).forEach((piece, j) => {
      if (j % 2 === 1) {
        const href = resolve?.(piece);
        nodes.push(
          href ? (
            <Link key={`c${i}-${j}`} to={href} className="xref">
              <code>{piece}</code>
            </Link>
          ) : (
            <code key={`c${i}-${j}`}>{piece}</code>
          ),
        );
      } else if (piece) {
        nodes.push(piece);
      }
    });
  });
  return <>{nodes}</>;
}

// ---- Anchor scrolling (works under BrowserRouter and HashRouter) ----

export function ScrollToAnchor() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (hash) {
      const el = document.getElementById(decodeURIComponent(hash.slice(1)));
      if (el) {
        el.scrollIntoView({ block: "start" });
        el.classList.add("anchor-flash");
        const t = setTimeout(() => el.classList.remove("anchor-flash"), 1200);
        return () => clearTimeout(t);
      }
    }
    window.scrollTo(0, 0);
    return undefined;
  }, [pathname, hash]);
  return null;
}

// ---- Sidebar: repo dropdown + collapsible file tree ----

interface TreeDir {
  name: string;
  path: string;
  dirs: TreeDir[];
  files: DocFile[];
}

function buildTree(files: DocFile[]): TreeDir {
  const root: TreeDir = { name: "", path: "", dirs: [], files: [] };
  const dirMap = new Map<string, TreeDir>([["", root]]);
  const getDir = (path: string): TreeDir => {
    const existing = dirMap.get(path);
    if (existing) return existing;
    const i = path.lastIndexOf("/");
    const parent = getDir(i === -1 ? "" : path.slice(0, i));
    const node: TreeDir = { name: i === -1 ? path : path.slice(i + 1), path, dirs: [], files: [] };
    parent.dirs.push(node);
    dirMap.set(path, node);
    return node;
  };
  for (const f of files) {
    const i = f.path.lastIndexOf("/");
    getDir(i === -1 ? "" : f.path.slice(0, i)).files.push(f);
  }
  const sortNode = (n: TreeDir): void => {
    n.dirs.sort((a, b) => a.name.localeCompare(b.name));
    n.files.sort((a, b) => a.path.localeCompare(b.path));
    n.dirs.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

function DirNode({
  node,
  slug,
  activePath,
  depth,
}: {
  node: TreeDir;
  slug: string;
  activePath?: string;
  depth: number;
}) {
  const containsActive = activePath !== undefined && activePath.startsWith(`${node.path}/`);
  const [open, setOpen] = useState(depth < 2 || containsActive);
  useEffect(() => {
    if (containsActive) setOpen(true);
  }, [containsActive]);
  return (
    <li>
      <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary>{node.name}/</summary>
        <ul>
          <TreeItems node={node} slug={slug} activePath={activePath} depth={depth + 1} />
        </ul>
      </details>
    </li>
  );
}

/** The <li> items of one directory level (dirs first, then files). */
function TreeItems({
  node,
  slug,
  activePath,
  depth,
}: {
  node: TreeDir;
  slug: string;
  activePath?: string;
  depth: number;
}) {
  return (
    <>
      {node.dirs.map((d) => (
        <DirNode key={d.path} node={d} slug={slug} activePath={activePath} depth={depth} />
      ))}
      {node.files.map((f) => (
        <li key={f.id}>
          <Link
            to={fileHref(slug, f.path)}
            className={f.path === activePath ? "menu-active" : ""}
            title={f.enrichment?.summary}
          >
            {f.path.split("/").pop()}
          </Link>
        </li>
      ))}
    </>
  );
}

/**
 * Sidebar navigation for the /help handbook: necronomidoc's own served
 * documentation, grouped by the curated HELP_NAV sections. Decision pages
 * highlight the register entry they're reached from.
 */
function HelpNav({ activeId }: { activeId: string }) {
  return (
    <>
      <div className="text-xs text-base-content/60">
        The manual for this necronomidoc server — not for the repos it documents.
      </div>
      <ul className="menu menu-sm w-full flex-nowrap overflow-y-auto p-0">
        {HELP_NAV.map((section) => (
          <li key={section.title}>
            <h2 className="menu-title">{section.title}</h2>
            <ul>
              {section.pages.map((p) => (
                <li key={p.id}>
                  <Link
                    to={helpHref(p.id)}
                    className={isActiveNavEntry(p.id, activeId) ? "menu-active" : ""}
                  >
                    {p.label}
                  </Link>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </>
  );
}

export function Sidebar({
  registry,
  model,
  slug,
  activePath,
}: {
  registry?: Registry;
  model?: DocModel;
  slug?: string;
  activePath?: string;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const helpMatch = pathname === "/help" || pathname.startsWith("/help/");
  const tree = useMemo(() => (model ? buildTree(model.files) : undefined), [model]);
  const specFiles = useMemo(
    () => model?.files.filter((f) => f.format === "openapi") ?? [],
    [model],
  );
  return (
    <nav className="flex min-h-full w-72 flex-col gap-3 bg-base-200 p-4">
      <Link to="/" className="text-lg font-bold tracking-tight">
        necronomidoc
      </Link>
      {helpMatch ? (
        <>
          <HelpNav activeId={helpIdFromPath(pathname)} />
          <div className="mt-auto flex flex-col gap-1 border-t border-base-300 pt-3">
            <Link to="/" className="link-hover link text-sm text-base-content/60">
              ← Documented repos
            </Link>
          </div>
        </>
      ) : (
        <>
          <select
            className="select select-sm w-full"
            value={slug ?? ""}
            onChange={(e) => navigate(`/r/${e.target.value}`)}
            aria-label="Select repository"
          >
            <option value="" disabled>
              Select a repo…
            </option>
            {registry?.repos.map((r) => (
              <option key={r.slug} value={r.slug}>
                {r.name}
              </option>
            ))}
          </select>
          {slug && (
            <div>
              <div className="mb-1 text-xs font-medium uppercase text-base-content/50">Core docs</div>
              <ul className="menu menu-sm w-full p-0">
                {(
                  [
                    ["overview", "Overview"],
                    ["conventions", "Conventions"],
                    ["packages", "Packages"],
                    ["architecture", "Architecture"],
                  ] as const
                ).map(([kind, label]) => (
                  <li key={kind}>
                    <Link to={`/r/${slug}/docs/${kind}`}>{label}</Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {slug && (
            <Link to={`/r/${slug}/subsystems`} className="link-hover link text-sm">
              Subsystems
            </Link>
          )}
          {slug && specFiles.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-medium uppercase text-base-content/50">API Reference</div>
              <ul className="menu menu-sm w-full p-0">
                {specFiles.map((f) => (
                  <li key={f.id}>
                    <Link to={fileHref(slug, f.path)} className={f.path === activePath ? "menu-active" : ""}>
                      {f.title ?? f.path}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {slug && tree ? (
            <ul className="menu menu-sm w-full flex-nowrap overflow-y-auto p-0">
              <TreeItems node={tree} slug={slug} activePath={activePath} depth={0} />
            </ul>
          ) : (
            <p className="text-sm text-base-content/60">Pick a repo to browse its files.</p>
          )}
          <div className="mt-auto flex flex-col gap-1 border-t border-base-300 pt-3">
            <Link to="/skills" className="link-hover link text-sm text-base-content/60">
              Skills
            </Link>
            <Link to="/artefacts" className="link-hover link text-sm text-base-content/60">
              Artefacts
            </Link>
            <Link to="/status" className="link-hover link text-sm text-base-content/60">
              Build status
            </Link>
            <Link to="/help" className="link-hover link text-sm text-base-content/60">
              Necronomidoc docs
            </Link>
          </div>
        </>
      )}
    </nav>
  );
}
