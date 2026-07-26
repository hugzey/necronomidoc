# Source viewer

Every documented code file can show its actual source next to its
documentation. A **View source** button on a file's doc page splits the view
in two: docs on the left, code on the right, with a draggable divider on
desktop widths. On small screens the code panel simply replaces the docs —
close it (✕) to get back.

## What you get

- **Syntax highlighting** — a lightweight built-in tokenizer (keywords,
  strings, comments, numbers) for TypeScript/JavaScript, Python, C#, CSS and
  JSON. It aims for readable, not compiler-perfect.
- **Clickable symbols** — identifiers in the code that resolve to a
  documented symbol are links. Clicking one navigates to that symbol's doc
  page *with the source panel kept open and focused on the declaration line*,
  so you can walk a codebase from inside the docs.
- **Jump to declaration** — each symbol card carries a `</>` link that opens
  the source panel scrolled to that symbol's declaration.
- **Linkable lines** — line numbers are links; the URL
  (`…?source=1&line=42`) reproduces the exact view, so you can share a
  pointer at a line of code.

The split position is remembered per browser (25–75%, default 50/50).

## Where the code comes from

Builds snapshot the documented source files into the published manifests dir:

```
<dataDir>/repos/<slug>/sources.json     index: path, size, content hash
<dataDir>/repos/<slug>/sources/<path>   one snapshot per documented file
```

Both are served under `/data/repos/<slug>/…` like every other manifest (the
snapshots as `text/plain`), and both are staged into the same atomic per-repo
swap as the doc model — the code you see always matches the docs you read.
Only files the doc model documents are copied, never the whole checkout.

## When there is no source to view

The button only renders when a snapshot exists. A file has no snapshot when:

- the repo was **built before this feature** shipped — rebuild it;
- the docs came from **pre-extracted IR** (`POST /api/ir`) — the server never
  saw a checkout, so there is nothing to snapshot;
- the file is **larger than 512 KiB** or **binary** — the viewer targets
  code, not bundled artifacts;
- the site runs as a **static single-file export** — snapshots need a server.

Prose and spec files (`markdown`, `openapi`) don't use the viewer: their full
content is already rendered as the doc page itself.

## Access control

Snapshots are served with the same auth story as everything else: with
team-private mode on (`DOCS_AUTH_REQUIRED=1`, see the
[configuration reference](deploy/configuration.md)), `/data/*` — snapshots
included — requires a session or bearer token. Note that publishing docs for
a repo now also publishes the text of its documented source files to anyone
who can reach the doc site; if that is more than you want to share, run with
auth on.
