import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { HELP_INDEX_ID, HELP_NAV, helpHref, helpIdFromPath } from "./help-nav.js";
import { MarkdownDoc } from "./markdown.js";
import { dirname, isExternalHref } from "./resolve.js";

/**
 * The served handbook for necronomidoc itself (routes under `/help`) — how to
 * operate this server, distinct from the docs it generates for user repos.
 * The repository's `docs/**.md` files are bundled at build time, so the
 * running server always carries the documentation of the version it was
 * built from.
 */

// Lazy glob: each doc becomes its own chunk fetched on first view, keeping
// ~140 KB of markdown out of the entry bundle. The path reaches outside
// packages/site to the repo-root docs/ tree, which is the single source of
// truth (also browsable on GitHub); the Dockerfile copies docs/ into the
// build stage for the same reason.
const docLoaders = import.meta.glob("../../../docs/**/*.md", {
  query: "?raw",
  import: "default",
}) as Record<string, () => Promise<string>>;

/** Page id (docs/ path without .md) → content loader. */
const helpDocs: Map<string, () => Promise<string>> = new Map(
  Object.entries(docLoaders).map(([key, load]) => [
    key.replace(/^.*?\/docs\//, "").replace(/\.md$/, ""),
    load,
  ]),
);

/** Every page the handbook can serve (nav entries must name one of these). */
export const helpPageIds: ReadonlySet<string> = new Set(helpDocs.keys());

// A nav entry pointing at a page the glob didn't find is a docs-refactor
// mistake (renamed/deleted file) — surface it instead of shipping dead links.
for (const section of HELP_NAV) {
  for (const p of section.pages) {
    if (!helpPageIds.has(p.id)) {
      console.warn(`[help] nav entry "${p.label}" names a missing docs page: ${p.id}`);
    }
  }
}

/** First `# heading` outside fenced code blocks (falls back to the id). */
export function pageTitle(content: string, id: string): string {
  let fenced = false;
  for (const line of content.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) return m[1];
  }
  return id;
}

/**
 * Collapse `.`/`..` segments; undefined when the path escapes the docs root
 * (unlike resolve.ts's clamping normalizeSegments — a link that leaves the
 * docs tree points at a repo file we don't bundle, and clamping it could
 * alias it onto an unrelated help page).
 */
function normalizeWithinRoot(p: string): string | undefined {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.join("/");
}

/**
 * Resolve a relative `.md` link between bundled help pages to its `/help`
 * route. Returns undefined for anchors, external URLs, and paths that leave
 * the docs tree (e.g. links to repo files) — the renderer degrades those.
 */
export function resolveHelpLink(fromId: string, href: string): string | undefined {
  if (isExternalHref(href) || href.startsWith("#") || href.startsWith("/")) return undefined;
  const [pathPart = "", fragment] = href.split("#");
  const base = normalizeWithinRoot(`${dirname(fromId)}/${pathPart}`);
  if (base === undefined) return undefined;
  const stripped = base.replace(/\.md$/, "");
  // A bare directory link (e.g. `decisions/`) lands on that directory's README.
  const target = [stripped, stripped ? `${stripped}/README` : HELP_INDEX_ID].find((c) =>
    helpDocs.has(c),
  );
  return target ? `${helpHref(target)}${fragment ? `#${fragment}` : ""}` : undefined;
}

export function HelpView() {
  const { pathname } = useLocation();
  const id = helpIdFromPath(pathname);
  const load = helpDocs.get(id);
  const [content, setContent] = useState<string>();
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!load) return;
    let live = true;
    setContent(undefined);
    setError(false);
    // Vite caches the dynamic import, so revisits render synchronously-fast.
    load().then(
      (text) => live && setContent(text),
      () => live && setError(true),
    );
    return () => {
      live = false;
    };
  }, [load]);

  const resolveHref = useCallback((href: string) => resolveHelpLink(id, href), [id]);

  if (!load || error) {
    return (
      <div className="alert alert-warning">
        <span>
          {error ? "This documentation page failed to load — " : "No such page in the necronomidoc documentation — "}
          back to the{" "}
          <Link to="/help" className="link">
            overview
          </Link>
          .
        </span>
      </div>
    );
  }

  return (
    <div>
      <div className="breadcrumbs text-sm">
        <ul>
          <li>
            <Link to="/help">Necronomidoc docs</Link>
          </li>
          {id !== HELP_INDEX_ID && content && <li className="font-medium">{pageTitle(content, id)}</li>}
        </ul>
      </div>
      {content ? (
        <MarkdownDoc content={content} resolveHref={resolveHref} />
      ) : (
        <div className="flex justify-center p-10">
          <span className="loading loading-spinner loading-md" aria-label="Loading" />
        </div>
      )}
    </div>
  );
}
