import {
  memo,
  useEffect,
  useMemo,
  useRef,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { fetchSourceText } from "./api.js";
import { Loading, useAsync } from "./components.js";
import { languageForPath, tokenizeLines, type Token } from "./highlight.js";
import { sourceHref, type TargetResolver } from "./resolve.js";

/**
 * The source viewer panel (decision 0020): a snapshotted source file rendered
 * with lightweight syntax highlighting. Identifiers that resolve to a
 * documented symbol link to that symbol's doc page with the source panel kept
 * open and focused on the declaration line — code-to-code navigation.
 */

/** localStorage key for the split position — a UI preference, not a secret. */
const SPLIT_KEY = "necronomidoc-split-pct";

const MIN_PCT = 25;
const MAX_PCT = 75;

/**
 * The two-pane layout of a file doc page with its source open: docs left,
 * code right, separated by a draggable divider on desktop widths. Below `lg`
 * the doc column is hidden and the panel takes over — a plain toggle, closed
 * again via the panel's ✕.
 */
export function SplitSourceView({ doc, panel }: { doc: ReactNode; panel: ReactNode }) {
  const initialPct = (() => {
    const v = Number(localStorage.getItem(SPLIT_KEY));
    return v >= MIN_PCT && v <= MAX_PCT ? v : 50;
  })();
  const containerRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<HTMLDivElement>(null);

  // Dragging writes the width style directly — a per-move React re-render of
  // the whole doc column would make the drag visibly lag on big pages.
  const applyPct = (pct: number): void => {
    if (docRef.current) docRef.current.style.width = `${pct}%`;
  };
  const pctFromEvent = (e: PointerEvent<HTMLDivElement>): number => {
    const rect = containerRef.current!.getBoundingClientRect();
    const next = ((e.clientX - rect.left) / rect.width) * 100;
    return Math.min(MAX_PCT, Math.max(MIN_PCT, next));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId) || !containerRef.current) return;
    applyPct(pctFromEvent(e));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (containerRef.current) {
      localStorage.setItem(SPLIT_KEY, String(Math.round(pctFromEvent(e))));
    }
  };

  return (
    <div ref={containerRef} className="lg:flex lg:items-start">
      <div
        ref={docRef}
        className="hidden min-w-0 lg:block lg:pr-3"
        style={{ width: `${initialPct}%` }}
      >
        {doc}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize source panel"
        className="hidden w-1.5 shrink-0 cursor-col-resize touch-none self-stretch rounded-full bg-base-300 transition-colors hover:bg-primary lg:block"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <div className="h-[calc(100vh-7rem)] min-w-0 lg:sticky lg:top-4 lg:h-[calc(100vh-2rem)] lg:grow lg:pl-3">
        {panel}
      </div>
    </div>
  );
}

/** A display token: highlight class + optional cross-reference target. */
interface RenderToken {
  type: Token["type"];
  text: string;
  /** Href to the declaring symbol's doc page + source line, when resolved. */
  href?: string;
}

export function SourcePanel({
  slug,
  path,
  focusLine,
  targets,
  version,
  onClose,
}: {
  slug: string;
  path: string;
  /** 1-based line to scroll to and highlight (`?line=` in the URL). */
  focusLine?: number;
  targets: TargetResolver;
  /** Historical preview version (`?docv=N`); undefined = live source. */
  version?: number;
  onClose: () => void;
}) {
  const { data: text, loading } = useAsync(
    () => fetchSourceText(slug, path, version),
    [slug, path, version],
  );
  const bodyRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();

  // Tokenize once per file and resolve every identifier's target up front, so
  // re-renders (line focus, drawer state) never redo per-token work and the
  // memoized lines stay referentially stable.
  const lines = useMemo(() => {
    if (text === undefined) return undefined;
    return tokenizeLines(text, languageForPath(path)).map((tokens): RenderToken[] =>
      tokens.map((t) => {
        if (t.type !== "ident") return t;
        const target = targets(t.text);
        return target
          ? { ...t, href: sourceHref(slug, target.path, target.line, target.anchor, version) }
          : t;
      }),
    );
  }, [text, path, slug, targets, version]);

  // Scroll the focused line into view once the text is rendered — scrolling
  // only the panel body, never the window (the page may already be positioned
  // at a doc anchor).
  useEffect(() => {
    const body = bodyRef.current;
    if (!focusLine || !lines || !body) return;
    const el = body.querySelector<HTMLElement>(`[data-line="${focusLine}"]`);
    if (!el) return;
    const bodyRect = body.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    body.scrollTop += elRect.top - bodyRect.top - (body.clientHeight - elRect.height) / 2;
  }, [focusLine, lines]);

  // One delegated click handler navigates for every in-panel link, instead of
  // thousands of <Link> components each subscribed to the location context.
  const onBodyClick = (e: MouseEvent<HTMLDivElement>): void => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    const anchor = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[data-nav]");
    if (!anchor) return;
    e.preventDefault();
    // Line-number permalinks carry no anchor of their own; keep the current
    // hash so clearing it doesn't bounce the page back to the top.
    const keepHash = anchor.dataset.keepHash === "1" ? location.hash : "";
    navigate(anchor.getAttribute("data-nav")! + keepHash);
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-box border border-base-300 bg-base-100">
      <div className="flex items-center gap-2 border-b border-base-300 bg-base-200 px-3 py-2">
        <span className="truncate font-mono text-sm font-medium">{path}</span>
        {lines && (
          <span className="whitespace-nowrap text-xs text-base-content/50">
            {lines.length} lines
          </span>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-xs ml-auto"
          onClick={onClose}
          aria-label="Close source view"
        >
          ✕
        </button>
      </div>
      <div ref={bodyRef} className="min-h-0 grow overflow-auto" onClick={onBodyClick}>
        {loading && <Loading />}
        {!loading && lines === undefined && (
          <div className="p-4 text-sm text-base-content/60">
            No source snapshot for this file — it may predate the source viewer, exceed the
            snapshot size cap, or come from a pre-extracted IR upload. Rebuild the repo with a
            current server to publish one.
          </div>
        )}
        {lines && (
          <pre className="min-w-max p-0 text-sm leading-relaxed">
            <code>
              {lines.map((tokens, i) => (
                <SourceLine
                  key={i}
                  n={i + 1}
                  tokens={tokens}
                  lineHref={sourceHref(slug, path, i + 1, undefined, version)}
                  focused={i + 1 === focusLine}
                />
              ))}
            </code>
          </pre>
        )}
      </div>
    </div>
  );
}

/**
 * One rendered source line. Memoized: on a focus change only the two lines
 * whose `focused` flips re-render, not the whole file.
 */
const SourceLine = memo(function SourceLine({
  n,
  tokens,
  lineHref,
  focused,
}: {
  n: number;
  tokens: RenderToken[];
  lineHref: string;
  focused: boolean;
}) {
  return (
    <div className={`src-line ${focused ? "src-line-focus" : ""}`} data-line={n}>
      <a
        href={lineHref}
        data-nav={lineHref}
        data-keep-hash="1"
        className="src-lineno"
        aria-label={`Line ${n}`}
      >
        {n}
      </a>
      <span className="src-code">
        {tokens.map((t, i) =>
          t.href ? (
            <a key={i} href={t.href} data-nav={t.href} className="xref">
              {t.text}
            </a>
          ) : t.type === "plain" || t.type === "ident" ? (
            t.text
          ) : (
            <span key={i} className={`tok-${t.type}`}>
              {t.text}
            </span>
          ),
        )}
        {"\n"}
      </span>
    </div>
  );
});
