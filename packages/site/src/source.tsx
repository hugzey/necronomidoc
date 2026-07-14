import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { fetchSourceText } from "./api.js";
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
  const [pct, setPct] = useState(() => {
    const v = Number(localStorage.getItem(SPLIT_KEY));
    return v >= MIN_PCT && v <= MAX_PCT ? v : 50;
  });
  const containerRef = useRef<HTMLDivElement>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId) || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const next = ((e.clientX - rect.left) / rect.width) * 100;
    setPct(Math.min(MAX_PCT, Math.max(MIN_PCT, next)));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setPct((v) => {
      localStorage.setItem(SPLIT_KEY, String(Math.round(v)));
      return v;
    });
  };

  return (
    <div ref={containerRef} className="lg:flex lg:items-start">
      <div className="hidden min-w-0 lg:block lg:pr-3" style={{ width: `${pct}%` }}>
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

export function SourcePanel({
  slug,
  path,
  focusLine,
  targets,
  onClose,
}: {
  slug: string;
  path: string;
  /** 1-based line to scroll to and highlight (`?line=` in the URL). */
  focusLine?: number;
  targets: TargetResolver;
  onClose: () => void;
}) {
  const [text, setText] = useState<string>();
  const [failed, setFailed] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setText(undefined);
    setFailed(false);
    fetchSourceText(slug, path).then((t) => {
      if (!live) return;
      if (t === undefined) setFailed(true);
      else setText(t);
    });
    return () => {
      live = false;
    };
  }, [slug, path]);

  const lines = useMemo(
    () => (text === undefined ? undefined : tokenizeLines(text, languageForPath(path))),
    [text, path],
  );

  // Scroll the focused line into view once the text is rendered.
  useEffect(() => {
    if (!focusLine || !lines || !bodyRef.current) return;
    const el = bodyRef.current.querySelector<HTMLElement>(`[data-line="${focusLine}"]`);
    el?.scrollIntoView({ block: "center" });
  }, [focusLine, lines]);

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
      <div ref={bodyRef} className="min-h-0 grow overflow-auto">
        {failed && (
          <div className="p-4 text-sm text-base-content/60">
            No source snapshot for this file — it may predate the source viewer, exceed the
            snapshot size cap, or come from a pre-extracted IR upload. Rebuild the repo with a
            current server to publish one.
          </div>
        )}
        {!failed && lines === undefined && (
          <div className="flex justify-center p-10">
            <span className="loading loading-spinner loading-md" aria-label="Loading source" />
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
                  slug={slug}
                  path={path}
                  targets={targets}
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

function SourceLine({
  n,
  tokens,
  slug,
  path,
  targets,
  focused,
}: {
  n: number;
  tokens: Token[];
  slug: string;
  path: string;
  targets: TargetResolver;
  focused: boolean;
}) {
  return (
    <div className={`src-line ${focused ? "src-line-focus" : ""}`} data-line={n}>
      <Link
        to={sourceHref(slug, path, n)}
        className="src-lineno"
        aria-label={`Line ${n}`}
      >
        {n}
      </Link>
      <span className="src-code">
        {tokens.length === 0
          ? "\n"
          : tokens.map((t, i) => <TokenSpan key={i} token={t} slug={slug} targets={targets} />)}
        {tokens.length > 0 && "\n"}
      </span>
    </div>
  );
}

function TokenSpan({
  token,
  slug,
  targets,
}: {
  token: Token;
  slug: string;
  targets: TargetResolver;
}) {
  if (token.type === "ident") {
    const target = targets(token.text);
    if (target) {
      return (
        <Link
          to={sourceHref(slug, target.path, target.line, target.anchor)}
          className="xref"
          title={`${target.path}:${target.line}`}
        >
          {token.text}
        </Link>
      );
    }
    return <>{token.text}</>;
  }
  if (token.type === "plain") return <>{token.text}</>;
  return <span className={`tok-${token.type}`}>{token.text}</span>;
}
