import type { SkillDefinition } from "@necronomidoc/docmodel";
import { renderSkillMd } from "./skills.js";

/**
 * The built-in `using-necronomidoc` skill: a fixed playbook that teaches any
 * Agent Skills–capable harness how to work with a necronomidoc server. It
 * needs no LLM and no built repo (unlike `necronomidoc skills`, which
 * generates skills ABOUT the documented repos). Served by the CLI
 * (`skills --builtin`), the REST API (`/api/agent-skill…`) and the site's
 * Skills page, with the serving instance's MCP URL filled in.
 */

export const BUILTIN_SKILL_ID = "using-necronomidoc";

/** Shown when the MCP URL isn't known (CLI without `--mcp-url`). */
export const MCP_URL_PLACEHOLDER = "https://<your-docs-server>/mcp";

export interface BuiltinSkillOptions {
  /** The server's MCP endpoint, e.g. `https://docs.example.com/mcp`. */
  mcpUrl?: string;
  /** The server requires a bearer token (DOCS_AUTH_REQUIRED). */
  authRequired?: boolean;
}

/** The `claude mcp add` command that connects Claude Code to this server. */
export function mcpConnectCommand(options: BuiltinSkillOptions = {}): string {
  const url = options.mcpUrl ?? MCP_URL_PLACEHOLDER;
  const header = options.authRequired ? ` \\\n  --header "Authorization: Bearer $DOCS_TOKEN"` : "";
  return `claude mcp add --transport http necronomidoc ${url}${header}`;
}

function body(options: BuiltinSkillOptions): string {
  const url = options.mcpUrl ?? MCP_URL_PLACEHOLDER;
  const llmsTxt = url.replace(/\/mcp\/?$/, "/data/repos/<slug>/llms.txt");
  return `# Using necronomidoc

necronomidoc documents your team's repositories and answers questions about
them over MCP (server name \`necronomidoc\`, endpoint \`${url}\`). Its answers
are ranked, budgeted and carry provenance, trust and invariants. Use it
instead of opening files at random, and before writing code that may
already exist.

## Setup (once)

\`\`\`bash
${mcpConnectCommand(options)}
\`\`\`

Check the connection with \`list_repos\`; it returns the repo **slugs** that
every other tool takes. On a team-private server, add
\`--header "Authorization: Bearer $DOCS_TOKEN"\`. No MCP client? Read
\`${llmsTxt}\` instead.

## The workflow

1. **Start every coding task with \`get_context_for_task\`.** Pass the task
   in plain words (\`"add price formatting to CartPage"\`), the repo slug,
   and a \`budget\` in tokens (default 1500; raise it for broad tasks). One
   call returns:
   - \`symbols\`: existing code, each with its signature and \`usage\`, a REAL
     call site. Copy its argument shape rather than guessing.
   - \`subsystems\`: where the code lives. \`doesNotOwn\` says what must NOT
     go there.
   - \`intents\`: user sessions and stories bound to those files. Keep the
     ids listed in \`keep\` true.
   - \`recipes\`: how this repo adds a page, an endpoint, a hook and so on.
   - \`conventions\` and \`tests\`.
   Follow \`next\` for the one follow-up worth making.
2. **Before writing any new function, hook, component or type, call
   \`is_this_a_duplicate\`** with its proposed \`name\`, \`signature\` and
   \`purpose\`.
   - \`likely-duplicate\`: reuse or extend the candidate. Do not write a new
     one.
   - \`possible-overlap\`: inspect the candidate with \`get_function_doc\`
     first.
3. **Look things up cheaply.**
   - \`search_docs\`: if the response has a \`bestAnswer\`, use it and stop.
     Otherwise scan the hits. \`matches\` lists other symbols in the same
     file.
   - List at \`detail: "brief"\`, then fetch \`detail: "full"\` only for the
     one item you pick.
   - \`get_function_doc\` (by \`id\`, or \`name\` + \`repo\`) for one symbol's
     full docs and call sites.
   - \`get_file_doc\` with \`symbol\` returns one declaration, not the whole
     file.
   - \`get_recipes\` with \`task\` gives the canonical steps and example for
     adding something new.
4. **Treat every \`invariants\` entry as a hard constraint.** Invariants
   appear on symbols, files and subsystems, in any answer that touches them.
5. **Weigh \`trust\`.** Rely on \`high\`. Treat \`medium\` as fine for
   orientation. For \`low\`, or \`stale: true\`, read the source before you
   rely on the answer.
6. **Before committing, call \`check_change\`** with your diff (the output
   of \`git diff\`, or \`git diff --staged\`).
   - Run every test in \`testsToRun\`. That set is what this change needs,
     not the whole suite.
   - If \`verdict\` is \`review\`, fix the \`boundaryViolations\` (code in a
     subsystem that doesn't own it) and the \`possibleDuplicates\` before you
     commit.
   - Keep every acceptance criterion and outcome in \`intents\` true.
   - For \`docsToUpdate\`, fix the descriptions your change made wrong with
     \`propose_overlay\`.
7. **Returning to a repo you've seen?** Call \`what_changed_since\` with the
   documentation version (or commit) you last saw, and get only the delta.
   \`list_repos\` with \`detail: "full"\` shows the current version; note it
   for next time.
8. **Leave the docs better than you found them.** When an answer was wrong,
   missing or stale, call \`propose_overlay\` (a summary, purpose, scope or
   invariants for a file or symbol) or \`propose_product_doc\` with a
   \`rationale\`. Proposals are linted and land as drafts for a human to
   review. If the linter rejects one, fix it and resubmit. These tools need
   the server's admin token on the connection.

## Product intent

Before changing user-facing behaviour:
- \`find_intents_for_code\` shows which sessions and stories run through a
  file.
- \`get_product_doc\` returns a document's full acceptance criteria.
- \`get_product_overview\` maps the personas, jobs and sessions.
- \`get_session_checks\` generates a test skeleton per session outcome.
  Implement it to make "does SES-001 still work?" a real, runnable check.

## Tool reference

| Tool | Use it to |
|---|---|
| \`get_context_for_task\` | start a task: one budgeted bundle of code, boundaries, intents, recipe, conventions, tests |
| \`search_docs\` | find something by concept; stop at \`bestAnswer\` |
| \`is_this_a_duplicate\` | check before writing new code |
| \`get_function_doc\` | read one symbol: signature, docs, real call sites, trust |
| \`get_file_doc\` | read a file's purpose and symbols (\`symbol\` narrows to one) |
| \`get_recipes\` | learn how this repo adds a page, an endpoint, a hook… |
| \`check_change\` | gate a diff: intents, tests to run, boundary violations |
| \`what_changed_since\` | catch up on a repo you already know |
| \`get_subsystem_overview\` | decide where new code belongs (owns / doesNotOwn) |
| \`get_core_doc\` | read the overview, conventions, packages or architecture |
| \`find_intents_for_code\` | see which user intents run through a file |
| \`get_product_overview\` / \`get_product_doc\` | understand what the product is for |
| \`get_session_checks\` | generate executable checks for a session |
| \`list_repos\` / \`list_files\` | orient: repo slugs, file purposes |
| \`propose_overlay\` / \`propose_product_doc\` / \`list_proposals\` | improve the docs (drafts for review; admin token) |

## Don'ts

- Don't open or \`get_file_doc\` file after file to orient yourself. Use
  \`get_context_for_task\`, or \`list_files\` with \`detail: "brief"\`.
- Don't request \`detail: "full"\` for lists or searches.
- Don't conclude something doesn't exist after one failed search. Rephrase
  once using different words, then conclude. Misses are logged, so the docs
  improve.
- Don't commit while \`check_change\` says \`review\` and its findings are
  unaddressed.
`;
}

/** The skill definition, with the given server's MCP URL filled in. */
export function builtinSkill(options: BuiltinSkillOptions = {}): SkillDefinition {
  return {
    id: BUILTIN_SKILL_ID,
    name: BUILTIN_SKILL_ID,
    description:
      "Work with a necronomidoc documentation server over MCP: get a task's context in one budgeted call, check for existing code before writing new code, look up symbols with real call sites, respect invariants and subsystem boundaries, gate diffs with check_change (intents, tests to run), catch up with what_changed_since, and propose doc fixes. Use for any coding task in a repository necronomidoc documents.",
    body: body(options),
    repos: [],
  };
}

/** The rendered SKILL.md (frontmatter + body). */
export function builtinSkillMd(options: BuiltinSkillOptions = {}): string {
  return renderSkillMd(builtinSkill(options));
}
