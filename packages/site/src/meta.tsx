import { useEffect, useState, type ReactNode } from "react";
import { fetchVersions, type DocVersionEntry, type VersionsManifest } from "./api.js";

/**
 * The documentation info drawer (decision 0021): an (i) button at the top
 * right of every repo doc page opening a right-hand drawer with the metadata
 * of the current documentation build and, in its own section, the version
 * history journal.
 */

export function RepoInfoDrawer({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);

  // A fresh slug is a different repo: don't leave the old drawer hanging open.
  useEffect(() => setOpen(false), [slug]);

  return (
    <>
      <button
        type="button"
        className="btn btn-circle btn-ghost btn-sm absolute right-3 top-3 z-10 text-base-content/60"
        onClick={() => setOpen(true)}
        aria-label="Documentation info"
        title="Documentation info"
      >
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      </button>
      {open && <InfoDrawer slug={slug} onClose={() => setOpen(false)} />}
    </>
  );
}

function InfoDrawer({ slug, onClose }: { slug: string; onClose: () => void }) {
  const [manifest, setManifest] = useState<VersionsManifest>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    fetchVersions(slug)
      .then((m) => {
        if (live) setManifest(m);
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [slug]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const current = manifest?.versions[0];

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-label="Documentation info">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} aria-hidden />
      <aside className="absolute right-0 top-0 flex h-full w-96 max-w-[90vw] flex-col bg-base-100 shadow-xl">
        <div className="flex items-center gap-2 border-b border-base-300 px-4 py-3">
          <h2 className="text-base font-semibold">Documentation info</h2>
          <span className="badge badge-ghost badge-sm font-mono">{slug}</span>
          <button
            type="button"
            className="btn btn-ghost btn-xs ml-auto"
            onClick={onClose}
            aria-label="Close info drawer"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 grow overflow-y-auto p-4">
          {loading && (
            <div className="flex justify-center p-8">
              <span className="loading loading-spinner loading-md" aria-label="Loading" />
            </div>
          )}
          {!loading && !current && (
            <div className="alert alert-info text-sm">
              <span>
                No version journal published for this repo yet — it was built before versioning
                shipped (or this is a static export). Rebuild it with a current server.
              </span>
            </div>
          )}
          {current && (
            <>
              <h3 className="mb-2 text-xs font-medium uppercase text-base-content/50">Metadata</h3>
              <Metadata entry={current} />
              <div className="divider my-4" />
              <h3 className="mb-2 text-xs font-medium uppercase text-base-content/50">
                Version history
              </h3>
              <ol className="flex flex-col gap-3">
                {manifest!.versions.map((v, i) => (
                  <VersionRow key={v.version} entry={v} current={i === 0} />
                ))}
              </ol>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="shrink-0 text-base-content/60">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium">{children}</dd>
    </div>
  );
}

function shortHash(hash?: string): string {
  return hash ? hash.slice(0, 10) : "—";
}

function when(iso?: string): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/** The generation metadata of the current documentation build. */
function Metadata({ entry }: { entry: DocVersionEntry }) {
  const e = entry.enrichment;
  return (
    <dl className="text-sm">
      <Row label="Version">v{entry.version}</Row>
      <Row label="Generated">{when(entry.generatedAt)}</Row>
      {(entry.rebuilds > 0 || entry.lastRebuiltAt) && (
        <Row label="Rebuilt">
          {when(entry.lastRebuiltAt)}
          {entry.rebuilds > 0 && (
            <span className="text-base-content/60"> ({entry.rebuilds}×, unchanged)</span>
          )}
        </Row>
      )}
      {entry.source && (
        <Row label="Source">
          <span className="font-mono text-xs">{entry.source}</span>
        </Row>
      )}
      {entry.ref && (
        <Row label="Ref">
          <span className="font-mono text-xs">{entry.ref}</span>
        </Row>
      )}
      {entry.commit && (
        <Row label="Commit">
          <span className="font-mono text-xs">{entry.commit.slice(0, 12)}</span>
        </Row>
      )}
      {entry.trigger && <Row label="Triggered by">{entry.trigger}</Row>}
      {entry.adapter && (
        <Row label="Extractors">
          <span className="font-mono text-xs">{entry.adapter}</span>
        </Row>
      )}
      <Row label="Files">{entry.fileCount}</Row>
      <Row label="Symbols">{entry.symbolCount}</Row>
      {entry.sourceFileCount !== undefined && (
        <Row label="Source snapshots">{entry.sourceFileCount}</Row>
      )}
      {e && (
        <Row label="Enrichment">
          {e.human} human · {e.llm} llm · {e.heuristic} heuristic
          {e.stale > 0 && <span className="text-error"> · {e.stale} stale</span>}
        </Row>
      )}
      <Row label="Docs hash">
        <span className="font-mono text-xs">{shortHash(entry.docsHash)}</span>
      </Row>
      <Row label="Content hash">
        <span className="font-mono text-xs">{shortHash(entry.contentHash)}</span>
      </Row>
    </dl>
  );
}

function VersionRow({ entry, current }: { entry: DocVersionEntry; current: boolean }) {
  return (
    <li className="rounded-box border border-base-300 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`badge badge-sm ${current ? "badge-primary" : "badge-ghost"}`}>
          v{entry.version}
        </span>
        {current && <span className="text-xs text-base-content/50">current</span>}
        <span className="ml-auto text-xs text-base-content/60">{when(entry.generatedAt)}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-base-content/70">
        {entry.commit && <span className="font-mono">{entry.commit.slice(0, 8)}</span>}
        {entry.trigger && <span>via {entry.trigger}</span>}
        <span>
          {entry.fileCount} files · {entry.symbolCount} symbols
        </span>
        <span className="font-mono text-base-content/50">{shortHash(entry.docsHash)}</span>
        {entry.rebuilds > 0 && <span>{entry.rebuilds}× rebuilt unchanged</span>}
      </div>
    </li>
  );
}
