import { Link, useParams } from "react-router-dom";
import { MarkdownDoc } from "./markdown.js";
import { normalizeSegments } from "./resolve.js";

/**
 * The served handbook for necronomidoc itself (routes under `/help`) — how to
 * operate this server, distinct from the docs it generates for user repos.
 * The repository's `docs/**.md` files are bundled into the SPA at build time,
 * so the running server always carries the documentation of the version it
 * was built from.
 */

// Vite inlines every matched file as a raw string at build time. The path
// reaches outside packages/site to the repo-root docs/ tree, which is the
// single source of truth (also browsable on GitHub); the Dockerfile copies
// docs/ into the build stage for the same reason.
const rawDocs = import.meta.glob("../../../docs/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export interface HelpPage {
  /** Path under docs/ without the .md extension, e.g. "deploy/ec2". */
  id: string;
  /** First `# heading` of the document (falls back to the id). */
  title: string;
  content: string;
}

/** Page id of the handbook landing page (docs/README.md). */
export const HELP_INDEX_ID = "README";

function pageTitle(content: string, id: string): string {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : id;
}

export const helpPages: Map<string, HelpPage> = new Map(
  Object.entries(rawDocs).map(([key, content]) => {
    const id = key.replace(/^.*?\/docs\//, "").replace(/\.md$/, "");
    return [id, { id, title: pageTitle(content, id), content }];
  }),
);

/** Curated sidebar navigation; decision pages are reachable from the register. */
export const HELP_NAV: { title: string; pages: { id: string; label: string }[] }[] = [
  {
    title: "Start here",
    pages: [
      { id: HELP_INDEX_ID, label: "Overview" },
      { id: "usage", label: "Usage guide" },
      { id: "architecture", label: "Architecture" },
      { id: "api", label: "HTTP API reference" },
    ],
  },
  {
    title: "Operations",
    pages: [
      { id: "ops-ingestion", label: "Automated ingestion" },
      { id: "deploy/configuration", label: "Configuration" },
      { id: "deploy/ec2", label: "Deploy: EC2" },
      { id: "deploy/azure-app-service", label: "Deploy: Azure" },
      { id: "deploy/on-prem", label: "Deploy: on-prem" },
      { id: "deploy/smoke-test", label: "Smoke test" },
      { id: "deploy/backup-restore", label: "Backup & upgrades" },
    ],
  },
  {
    title: "Features",
    pages: [
      { id: "enrichment", label: "Enrichment" },
      { id: "core-docs", label: "Core docs" },
      { id: "skills", label: "Skills" },
      { id: "artefacts", label: "Artefacts" },
      { id: "doc-standard", label: "Doc standard" },
    ],
  },
  {
    title: "Design",
    pages: [{ id: "decisions/README", label: "Decision register" }],
  },
];

/** Href of a help page. */
export function helpHref(id: string): string {
  return id === HELP_INDEX_ID ? "/help" : `/help/${id}`;
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

/**
 * Resolve a relative `.md` link between bundled help pages to its `/help`
 * route. Returns undefined for anchors, external URLs, and paths that leave
 * the docs tree (e.g. links to repo files) — the renderer degrades those.
 */
export function resolveHelpLink(fromId: string, href: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return undefined;
  if (href.startsWith("#") || href.startsWith("/")) return undefined;
  const [pathPart = "", fragment] = href.split("#");
  const base = normalizeSegments(`${dirname(fromId)}/${decodeURIComponent(pathPart)}`);
  const stripped = base.replace(/\.md$/, "");
  // A bare directory link (e.g. `decisions/`) lands on that directory's README.
  const target = [stripped, stripped ? `${stripped}/README` : HELP_INDEX_ID].find((c) =>
    helpPages.has(c),
  );
  return target ? `${helpHref(target)}${fragment ? `#${fragment}` : ""}` : undefined;
}

export function HelpView() {
  const { "*": rest = "" } = useParams();
  const id = rest.replace(/\/+$/, "") || HELP_INDEX_ID;
  const page = helpPages.get(id);

  if (!page) {
    return (
      <div>
        <div className="alert alert-warning">
          <span>
            No such page in the necronomidoc documentation — back to the{" "}
            <Link to="/help" className="link">
              overview
            </Link>
            .
          </span>
        </div>
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
          {id !== HELP_INDEX_ID && <li className="font-medium">{page.title}</li>}
        </ul>
      </div>
      <p className="mb-4 text-xs text-base-content/60">
        Documentation for this necronomidoc server itself — not for the repositories it documents.
      </p>
      <MarkdownDoc content={page.content} resolveHref={(href) => resolveHelpLink(id, href)} />
    </div>
  );
}
