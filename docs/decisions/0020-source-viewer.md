# 0020 — Source viewer: build-time source snapshots + built-in highlighter

**Status:** Accepted

## Context

Doc pages show extracted facts (signatures, prop tables, doc comments) but
not the code itself; readers kept a second tab open on their git host. The
IR deliberately stores no source text for code files (decision 0006), and
the persistent clones under `<dataDir>/clones/` are explicitly excluded from
HTTP serving — they may be private repos, and local-path builds have no
clone at all, so serving checkouts directly is both unsafe and incomplete.
The site also has no syntax-highlighting dependency (decision 0010 keeps the
component base lean).

## Decision

1. **Snapshot documented sources at publish time.** `publishModel` copies
   every `format: "source"` file the doc model documents (and only those)
   into `repos/<slug>/sources/<path>`, indexed by `sources.json`, staged
   into the same atomic per-repo swap as the other manifests. Files over
   512 KiB and binary content are skipped; pre-extracted IR (`POST
   /api/ir`) publishes an empty index since there is no checkout. Snapshots
   are served by the existing `/data` allowlist (as `text/plain`) and
   inherit the same auth gate.
2. **Highlight with a small built-in tokenizer, not a library.** A
   line-based scanner (keywords/strings/comments/numbers, with carry-over
   state for multi-line constructs) covers TS/JS, Python, C#, CSS, JSON.
   "Close enough to correct" beats adding a multi-hundred-KB grammar bundle
   for a viewer whose real feature is navigation.
3. **Identifiers link through the existing symbol index.** The same
   name-resolution the doc pages use for signatures resolves identifier
   tokens in code; a hit links to the declaring file's doc page with the
   panel kept open and focused on the declaration line
   (`?source=1&line=N#Symbol`). Panel state lives in the URL so code-to-code
   navigation and shareable line links fall out for free.
4. **Split view on desktop, toggle on mobile.** A pointer-dragged divider
   (25–75%, persisted per browser) on `lg+`; below that the panel replaces
   the docs and ✕ restores them.

## Consequences

- Published docs for a repo now include the text of its documented source
  files. That is the feature — but operators of team-private code must run
  with auth on (decision 0014), which the docs call out.
- Data-dir size grows by roughly the documented source size per repo
  (capped per file); the atomic swap keeps snapshots exactly in sync with
  the model, and dropped files disappear on the next publish.
- Highlighting is heuristic: no semantic tokens, no embedded-language
  handling, interpolations render as string text. Name-based linking can
  hit the wrong same-named symbol, matching the known behavior of signature
  linking. Both are acceptable for a navigation aid; revisit with tree-
  sitter/shiki only if real usage demands it.
- Repos need a rebuild before the button appears (no snapshot → no button —
  graceful for old builds, static exports, and external IR).
