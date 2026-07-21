/**
 * Navigation metadata for the /help handbook — necronomidoc's own served
 * documentation. Kept free of the docs-content glob (help.tsx) so the
 * always-loaded Sidebar can import nav structure without dragging every
 * bundled markdown chunk into the entry bundle.
 */

/** Page id of the handbook landing page (docs/README.md). */
export const HELP_INDEX_ID = "README";

/** Route of a help page (ids are docs/ paths without the .md extension). */
export function helpHref(id: string): string {
  return id === HELP_INDEX_ID ? "/help" : `/help/${id}`;
}

/**
 * Inverse of {@link helpHref}: the page id a location pathname shows.
 * Shared by HelpView and the sidebar so their normalization (trailing
 * slashes, the index fallback) can never disagree.
 */
export function helpIdFromPath(pathname: string): string {
  const rest = pathname.startsWith("/help") ? pathname.slice("/help".length) : pathname;
  return rest.replace(/^\/+|\/+$/g, "") || HELP_INDEX_ID;
}

/** Curated sidebar sections; decision pages are reachable from the register. */
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
      { id: "source-viewer", label: "Source viewer" },
      { id: "doc-versions", label: "Versions & metadata" },
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

/**
 * Is the nav entry the one a given page should highlight? A `<dir>/README`
 * entry is a directory index, so it also claims every page under its dir
 * (e.g. individual decisions highlight the register).
 */
export function isActiveNavEntry(entryId: string, activeId: string): boolean {
  if (entryId === activeId) return true;
  const dir = entryId.endsWith("/README") ? entryId.slice(0, -"README".length) : undefined;
  return dir !== undefined && activeId.startsWith(dir);
}
