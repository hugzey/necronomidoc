# 0010 — UI components: Tailwind CSS + daisyUI as the site's component base

- **Status:** Accepted
- **Date:** 2026-07-10
- **Decider:** Luke (project owner)

## Context

The slice-1 doc site shipped with hand-rolled CSS (decision 0005's fallback
path). As the UI grows (sidebar navigation, trees, tables, drawers, theming),
hand-maintained styles don't scale, and the owner wants a consistent component
vocabulary for all future UI work.

## Decision

- **daisyUI (v5) on Tailwind CSS (v4)** is the component base for
  `packages/site` and any future UI in this project.
- **Order of preference for building UI:** daisyUI component classes first
  (`menu`, `drawer`, `card`, `table`, `badge`, `collapse`, `select`, …); plain
  Tailwind utilities for layout/spacing; custom CSS **only** where neither can
  express it (e.g. the anchor-flash highlight, inline-code prose styling).
- Theming uses daisyUI's built-in theme system: `light` default, `dark` follows
  the OS preference, and explicit `data-theme` stamps on `<html>` (e.g. a host
  page's toggle) override both — daisyUI reads `data-theme` natively.
- Tailwind v4 CSS-first config (`@import "tailwindcss"; @plugin "daisyui"`) via
  `@tailwindcss/vite`; no `tailwind.config.js`.

## Consequences

- All future site features start from daisyUI primitives; custom components are
  the exception and should say why in a comment.
- The static single-file export keeps working unchanged (one CSS bundle in,
  one CSS bundle inlined; ~12 KB gzipped added by the framework).
- If Fumadocs UI is adopted later (0005's original preference), it must coexist
  with or replace daisyUI deliberately — revisit this decision then.
