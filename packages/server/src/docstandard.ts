import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CoreDocKind } from "@necronomidoc/docmodel";

/**
 * The necronomidoc documentation standard (slice 8, decision 0019): shipped
 * templates for the four core documents plus a `.necronomidoc/` README,
 * scaffolded into a repo by `necronomidoc init-docs`, and advisory compliance
 * checks surfaced by `necronomidoc doctor`. The full written standard lives
 * in docs/doc-standard.md; these templates are its executable half.
 *
 * Templates are embedded as constants (not packaged asset files) so the CLI
 * works from any install layout without an asset-copy step.
 */

const TODO = "TODO(doc):";

const OVERVIEW_TEMPLATE = `# Project overview

<!-- Standard: docs/doc-standard.md — overview answers "what is this and why
     does it exist" for a reader (human or agent) with zero context. -->

${TODO} One-paragraph purpose statement: what this project is, who uses it,
and the problem it solves. Lead with the outcome, not the implementation.

## What it does

${TODO} The 3–6 main capabilities, each one line, outcome-first.

## How it's used

${TODO} How the outputs are consumed (apps, services, people, agents), with
the entry points a newcomer touches first.

## Boundaries

${TODO} What this project deliberately does NOT do, and where that
responsibility lives instead.
`;

const CONVENTIONS_TEMPLATE = `# Conventions

<!-- Standard: docs/doc-standard.md — conventions state the rules a change
     must follow to look native. Describe what IS, not what should be. -->

## Code style

${TODO} Naming, file organization, typing, and formatting rules actually in
force (link the linter/formatter config instead of restating it).

## Error handling

${TODO} How errors are raised, wrapped, logged, and surfaced. Name the error
types/helpers a new module should reuse.

## Testing

${TODO} Test framework, where tests live, naming pattern, how to run them,
and what a change is expected to cover.

## Documentation

${TODO} Doc-comment style for this language (e.g. TSDoc), what must carry a
doc comment, and where supporting docs live. See the necronomidoc standard:
every exported symbol's comment starts with a one-line purpose sentence.
`;

const PACKAGES_TEMPLATE = `# Packages, modules & libraries

<!-- Standard: docs/doc-standard.md — for each dependency: what it is, why
     THIS project uses it, and where. "Why" prevents accidental duplicates. -->

${TODO} Table or list of third-party dependencies:

| Package | What it is | Why we use it | Where |
|---|---|---|---|
| ${TODO} | | | |

## Internal modules

${TODO} The project's own top-level modules/packages, one line each: name,
purpose, and what depends on it.
`;

const ARCHITECTURE_TEMPLATE = `# Architecture

<!-- Standard: docs/doc-standard.md — the shape of the system: modules,
     dependencies between them, external systems. MUST keep a mermaid (or
     ASCII) diagram so humans and agents get the same picture. -->

${TODO} One paragraph: the architectural style and the main moving parts.

\`\`\`mermaid
graph LR
  %% ${TODO} replace with the real module/infrastructure diagram
  a[module a] --> b[module b]
\`\`\`

## Parts

${TODO} One short subsection or bullet per box in the diagram: what it owns,
what it must not know about.

## Data & control flow

${TODO} How a representative request/build/job travels through the parts.
`;

const NECRONOMIDOC_README = `# .necronomidoc/

Repo-owned documentation inputs for the necronomidoc server
(https://github.com/hugzey/necronomidoc). Everything here is optional; what
exists beats every other source on every rebuild.

- \`docs/overview.md | conventions.md | packages.md | architecture.md\` —
  the four core documents (highest-precedence source).
- \`enrichment/*.yaml\` — human-curated purpose/scope overlays for files and
  symbols.
- \`subsystems.yaml\` — curated subsystem map ("owns X / does not own Y").

Replace each ${TODO} marker and delete these instructions as you go; the
doctor command flags markers that are still present.
`;

export const DOC_TEMPLATES: Record<CoreDocKind, string> = {
  overview: OVERVIEW_TEMPLATE,
  conventions: CONVENTIONS_TEMPLATE,
  packages: PACKAGES_TEMPLATE,
  architecture: ARCHITECTURE_TEMPLATE,
};

export interface ScaffoldResult {
  dir: string;
  written: string[];
  skipped: string[];
}

/**
 * Drop the doc-standard templates into a repo's `.necronomidoc/` dir.
 * Existing files are never overwritten unless `force` — curated docs beat
 * templates.
 */
export function scaffoldDocs(repoDir: string, options: { force?: boolean } = {}): ScaffoldResult {
  const root = resolve(repoDir);
  if (!existsSync(root)) throw new Error(`No such directory: ${root}`);
  const docsDir = join(root, ".necronomidoc", "docs");
  mkdirSync(docsDir, { recursive: true });
  const result: ScaffoldResult = { dir: join(root, ".necronomidoc"), written: [], skipped: [] };

  const writeIfAbsent = (path: string, content: string, label: string): void => {
    if (existsSync(path) && !options.force) {
      result.skipped.push(label);
      return;
    }
    writeFileSync(path, content);
    result.written.push(label);
  };

  for (const kind of CoreDocKind.options) {
    writeIfAbsent(join(docsDir, `${kind}.md`), DOC_TEMPLATES[kind], `docs/${kind}.md`);
  }
  writeIfAbsent(join(root, ".necronomidoc", "README.md"), NECRONOMIDOC_README, "README.md");
  return result;
}

// ---- Advisory compliance checks (doctor) ----

export interface DocStandardFinding {
  level: "ok" | "info" | "warn";
  message: string;
}

/**
 * Advisory doc-standard check for one working tree. Never fails a build —
 * the heuristic floor keeps every repo documented — but tells a team exactly
 * what to curate next (decision 0019).
 */
export function checkDocStandard(repoDir: string): DocStandardFinding[] {
  const findings: DocStandardFinding[] = [];
  const docsDir = join(resolve(repoDir), ".necronomidoc", "docs");

  const missing: string[] = [];
  for (const kind of CoreDocKind.options) {
    const path = join(docsDir, `${kind}.md`);
    if (!existsSync(path)) {
      missing.push(kind);
      continue;
    }
    const content = readFileSync(path, "utf8");
    if (content.includes(TODO)) {
      findings.push({
        level: "warn",
        message: `.necronomidoc/docs/${kind}.md still contains ${TODO} markers — finish or remove them.`,
      });
    }
    if (!/^#\s+/m.test(content)) {
      findings.push({
        level: "warn",
        message: `.necronomidoc/docs/${kind}.md has no top-level \`# heading\` (its title).`,
      });
    }
    if (kind === "architecture" && !/```mermaid|```ascii|graph (TD|LR|RL|BT)/.test(content)) {
      findings.push({
        level: "warn",
        message:
          ".necronomidoc/docs/architecture.md has no mermaid/ASCII diagram — the standard requires one.",
      });
    }
  }

  if (missing.length === CoreDocKind.options.length) {
    findings.push({
      level: "info",
      message:
        "no repo-curated core docs (.necronomidoc/docs/) — served docs fall back to overrides/LLM/heuristic; scaffold with `necronomidoc init-docs <repo>`.",
    });
  } else if (missing.length > 0) {
    findings.push({
      level: "info",
      message: `core docs not repo-curated yet: ${missing.join(", ")}.`,
    });
  }

  if (findings.every((f) => f.level === "ok") && missing.length === 0) {
    findings.push({ level: "ok", message: "core docs curated and complete." });
  }
  return findings;
}
