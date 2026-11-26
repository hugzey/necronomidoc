import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { DETAILS } from "./detail.js";
import type { MissLog } from "./misses.js";
import type { ProposalSink } from "./proposals.js";
import type { ManifestStore } from "./store.js";
import { MISS, type MissInfo, type ToolResult } from "./tools.js";
import { tools } from "./toolset.js";

function jsonContent(result: ToolResult) {
  // Compact JSON: indentation costs agents tokens and carries no information.
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

export interface McpServerOptions {
  /** Records queries that returned nothing useful (decision 0024). */
  missLog?: MissLog;
  /** Write-back seam for agent-written docs; write tools exist only when set. */
  proposals?: ProposalSink;
  /** This request carries the admin bearer token (write tools require it). */
  canWrite?: boolean;
}

/** The shared `detail` parameter (decision 0024). */
const detail = z
  .enum(DETAILS)
  .optional()
  .describe("brief = id, name, one-line purpose, signature; normal (default); full = everything incl. doc comments and real call sites. List at brief, fetch full only for the hit you pick.");

/**
 * Build a fresh MCP server exposing the documentation tools over the given
 * manifest store (decision 0008, extended by 0024). The read tools answer
 * from the in-memory store — safe to instantiate per request; the only side
 * effects are the miss log and, when enabled and authorized, doc proposals.
 */
export function createMcpServer(store: ManifestStore, options: McpServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: "necronomidoc", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  /** Run a tool, feed a miss to the log, and wrap the JSON result. */
  const run = (name: string, fn: () => ToolResult) => {
    const result = fn();
    const miss = (result as Record<symbol, unknown>)[MISS] as MissInfo | undefined;
    if (miss && options.missLog) options.missLog.record({ tool: name, ...miss });
    return jsonContent(result);
  };

  server.registerTool(
    "list_repos",
    {
      description:
        "List every documented repository with file/symbol counts, a one-line summary, and enrichment coverage. Call this first to discover repo slugs for the other tools.",
      inputSchema: { detail },
    },
    async (args) => run("list_repos", () => tools.list_repos(store, args)),
  );

  server.registerTool(
    "get_context_for_task",
    {
      description:
        "START HERE for a coding task. Describe the task once (e.g. 'add price formatting to CartPage') and get one packed bundle: the top existing symbols with signatures, trust and real call sites; the owning subsystem's boundaries and invariants; the user intents bound to those files; a matching 'how do I…' recipe; the relevant conventions excerpt; and the tests near the code — ranked and truncated to `budget` tokens. Replaces the usual search → file → function → subsystem round trips.",
      inputSchema: {
        task: z.string().describe("The task in plain words, e.g. 'add price formatting to CartPage'."),
        repo: z.string().optional().describe("Repo slug (inferred from the best hit when omitted)."),
        budget: z.number().int().optional().describe("Max response size in tokens (default 1500, 200–8000). Content is ranked, then truncated to fit."),
        detail,
      },
    },
    async (args) => run("get_context_for_task", () => tools.get_context_for_task(store, args)),
  );

  server.registerTool(
    "search_docs",
    {
      description:
        "Search files, symbols, subsystems, core docs and product docs (personas, intents, sessions, stories) across repos by concept keywords. Call this whenever you need to know if something already exists (a helper, hook, component, or a whole subsystem) before writing new code. Hits are code-aware ranked (exported symbols boosted, tests/fixtures penalised, a file collapsed with its matching symbols); when the ranking is decisive a `bestAnswer` with signature, trust and a real call site is included — usually you can stop there. Cursor-paginated.",
      inputSchema: {
        query: z.string().describe("Search terms (concepts, names, purposes — e.g. 'currency formatting')."),
        repo: z.string().optional().describe("Restrict to one repo slug."),
        cursor: z.string().optional().describe("Pagination cursor from a previous response."),
        detail,
      },
    },
    async (args) => run("search_docs", () => tools.search_docs(store, args)),
  );

  server.registerTool(
    "is_this_a_duplicate",
    {
      description:
        "Before writing a new function, hook, component or type: send its proposed name, signature and purpose. Returns existing symbols that likely already do it, with confidence scores (fuzzy similarity of names, purposes and signatures, with verb/noun synonyms like fetch≈load, currency≈money) and a verdict: likely-duplicate, possible-overlap, or no-duplicate-found.",
      inputSchema: {
        name: z.string().optional().describe("Proposed name, e.g. 'formatPrice'."),
        signature: z.string().optional().describe("Proposed signature, e.g. '(amount: number, currency: string) => string'."),
        purpose: z.string().optional().describe("One sentence: what it will do."),
        kind: z.string().optional().describe("function | hook | component | class | type | endpoint …"),
        repo: z.string().optional().describe("Restrict to one repo slug."),
      },
    },
    async (args) => run("is_this_a_duplicate", () => tools.is_this_a_duplicate(store, args)),
  );

  server.registerTool(
    "get_file_doc",
    {
      description:
        "Get a file's purpose plus its symbol inventory (with provenance, staleness, trust and invariants — treat `stale: true` / low trust as possibly outdated). Pass `symbol` to get just one declaration, or detail=brief for names + signatures only. Call this when you know the file path.",
      inputSchema: {
        repo: z.string().describe("Repo slug."),
        path: z.string().describe("File path relative to the repo root."),
        symbol: z.string().optional().describe("Narrow to one symbol (or Class.member) in the file."),
        detail,
      },
    },
    async (args) => run("get_file_doc", () => tools.get_file_doc(store, args)),
  );

  server.registerTool(
    "get_function_doc",
    {
      description:
        "Get the full documentation for one symbol (function, hook, component, class…) — signature, params, props, examples, purpose, trust, invariants, and 1–2 REAL call sites from the codebase (copy their argument shapes). Call this after search_docs to inspect a specific hit by its id, or look a symbol up by bare name within a repo.",
      inputSchema: {
        repo: z.string().describe("Repo slug (used when looking up by name)."),
        id: z.string().optional().describe("Stable symbol id, e.g. 'slug:src/x.ts#Name'."),
        name: z.string().optional().describe("Bare symbol name to look up within the repo."),
        detail,
      },
    },
    async (args) => run("get_function_doc", () => tools.get_function_doc(store, args)),
  );

  server.registerTool(
    "get_recipes",
    {
      description:
        "Precomputed 'how do I…' recipes mined from repeated patterns in the code ('Add a page', 'Add an API endpoint', 'Add a hook'…): where the new file goes and how it is named, ordered steps, a five-line canonical example from a real instance, and the files a new instance touches (registration sites, tests). Pass `task` to get the best matches only.",
      inputSchema: {
        repo: z.string().describe("Repo slug."),
        task: z.string().optional().describe("What you want to add, e.g. 'add a settings page'."),
        detail,
      },
    },
    async (args) => run("get_recipes", () => tools.get_recipes(store, args)),
  );

  server.registerTool(
    "check_change",
    {
      description:
        "Pre-commit gate. Submit a unified diff (or changed files / symbols) and get: the user intents affected with the acceptance criteria and session outcomes to keep true; exactly which tests to run (those citing the affected ids, importing the changed files, or one hop away); subsystem boundary violations (e.g. UI logic added to a subsystem that does not own UI, undeclared cross-subsystem imports); invariants of the touched code; docs that will go stale; and new exports that duplicate existing code. `verdict: review` means something needs a look.",
      inputSchema: {
        repo: z.string().describe("Repo slug."),
        diff: z.string().optional().describe("Unified diff (git diff output)."),
        files: z.array(z.string()).optional().describe("Changed file paths, when you have no diff."),
        symbols: z.array(z.string()).optional().describe("Changed symbols: ids, 'path#Name', or bare names."),
        detail,
      },
    },
    async (args) => run("check_change", () => tools.check_change(store, args)),
  );

  server.registerTool(
    "what_changed_since",
    {
      description:
        "Returning to a repo? Pass the documentation version number (or a commit sha prefix) you last saw and get ONLY what changed since: files and symbols added/removed/changed (with old signatures), doc-only changes, product intents, code-binding drift and subsystem changes. Much cheaper than re-reading. list_repos detail=full shows the current version.",
      inputSchema: {
        repo: z.string().describe("Repo slug."),
        since: z.union([z.string(), z.number()]).describe("Version number (e.g. 12 or 'v12') or a commit sha prefix (≥ 4 chars)."),
        detail,
      },
    },
    async (args) => run("what_changed_since", () => tools.what_changed_since(store, args)),
  );

  server.registerTool(
    "get_core_doc",
    {
      description:
        "Get one of a repo's four core documents: 'overview' (what the project is and does), 'conventions' (style and patterns to follow), 'packages' (third-party dependencies — why, how, where), or 'architecture' (high-level layout with a mermaid/ASCII diagram). Call this before writing code in an unfamiliar repo (get_context_for_task already includes the relevant conventions excerpt). Provenance tells you the source: repo (shipped with the code), override (server-side curation), llm, or heuristic; treat `stale: true` as possibly outdated.",
      inputSchema: {
        repo: z.string().describe("Repo slug."),
        doc: z
          .enum(["overview", "conventions", "packages", "architecture"])
          .describe("Which core document to fetch."),
        detail,
      },
    },
    async (args) => run("get_core_doc", () => tools.get_core_doc(store, args)),
  );

  server.registerTool(
    "get_subsystem_overview",
    {
      description:
        "Map a repo into its subsystems: purpose, explicit boundaries (what each subsystem owns and what does NOT belong in it), invariants, key entry points, relationships, and member files. Call this for scope / separation-of-concerns questions like 'where does auth logic live and what shouldn't go in it?' or before deciding where new code belongs. Curated maps (provenance human/llm) carry real boundary statements; heuristic ones are directory groupings.",
      inputSchema: {
        repo: z.string().describe("Repo slug."),
        dir: z.string().optional().describe("Directory prefix to scope the overview."),
        detail,
      },
    },
    async (args) => run("get_subsystem_overview", () => tools.get_subsystem_overview(store, args)),
  );

  server.registerTool(
    "get_product_overview",
    {
      description:
        "Get a repo's product documentation: personas, jobs-to-be-done (the INTENTS users arrive with), intent interaction sessions (one intent followed end to end through the product), journeys, epics and user stories — plus test coverage of acceptance criteria/outcomes, drift findings, and interaction surfaces no session covers. Call this to understand what the product is FOR before changing user-facing behaviour.",
      inputSchema: {
        repo: z.string().describe("Repo slug."),
        detail,
      },
    },
    async (args) => run("get_product_overview", () => tools.get_product_overview(store, args)),
  );

  server.registerTool(
    "get_product_doc",
    {
      description:
        "Get one product document by id (PER-…, JOB-…, EPIC-…, STORY-…, JRN-…, SES-…): all structured fields, Gherkin acceptance criteria and EARS requirements, session steps with their code bindings (state ok/changed/broken), outcomes, tests citing it, and inbound links. Use it to see exactly how a user intent must play out.",
      inputSchema: {
        repo: z.string().describe("Repo slug."),
        id: z.string().describe("Product doc id, e.g. 'SES-001' or 'STORY-012'."),
        detail,
      },
    },
    async (args) => run("get_product_doc", () => tools.get_product_doc(store, args)),
  );

  server.registerTool(
    "find_intents_for_code",
    {
      description:
        "Before changing a file or symbol, ask which user intents run through it: returns the interaction sessions (with the steps that touch it and the outcomes to preserve) and stories (with acceptance criteria to keep true) whose code bindings point at it. Prevents behaviour drift. check_change does this for a whole diff and adds the tests to run.",
      inputSchema: {
        repo: z.string().describe("Repo slug."),
        path: z.string().describe("File path relative to the repo root (or a directory)."),
        symbol: z.string().optional().describe("Symbol name within the file, to narrow the match."),
        detail,
      },
    },
    async (args) => run("find_intents_for_code", () => tools.find_intents_for_code(store, args)),
  );

  server.registerTool(
    "get_session_checks",
    {
      description:
        "Generate executable check skeletons for intent interaction sessions: one test per outcome (titled with its id, e.g. [SES-001.OUT-1]), the steps on the path to it as actions, `expects` as assertions, and the outcome criteria as final checks — Playwright for web sessions, MCP client calls for agent sessions, process/HTTP calls for CLI/API ones. Implement one to turn 'does SES-001 still fulfil?' into a real, runnable check.",
      inputSchema: {
        repo: z.string().describe("Repo slug."),
        id: z.string().optional().describe("Session id (SES-…); omit for every session."),
      },
    },
    async (args) => run("get_session_checks", () => tools.get_session_checks(store, args)),
  );

  server.registerTool(
    "list_files",
    {
      description:
        "List a repo's files with one-line purposes. Call this to orient in an unfamiliar repo when you don't yet have a search term. Cursor-paginated (detail=brief pages twice as many).",
      inputSchema: {
        repo: z.string().describe("Repo slug."),
        cursor: z.string().optional().describe("Pagination cursor from a previous response."),
        detail,
      },
    },
    async (args) => run("list_files", () => tools.list_files(store, args)),
  );

  // ---- Write-back: agent-written docs, behind the admin token (decision 0024) ----
  const sink = options.proposals;
  if (sink) {
    const denied = (): ToolResult => ({
      error: "Proposing docs requires the server's admin bearer token (Authorization: Bearer <DOCS_TOKEN>) on the MCP connection.",
    });
    server.registerTool(
      "propose_overlay",
      {
        description:
          "Propose a documentation fix for a file or symbol you just worked with — a better summary/purpose/scope, or invariants ('must hold the lock', 'never call from the UI layer'). Validated like human-written overlays and stored as a DRAFT for human review (nothing publishes until accepted). Use it when a summary was wrong, missing or stale, so the next agent doesn't rediscover it. Requires the admin token.",
        inputSchema: {
          repo: z.string().describe("Repo slug."),
          targetId: z.string().optional().describe("File or symbol id ('slug:path' / 'slug:path#Name')."),
          path: z.string().optional().describe("File path (alternative to targetId)."),
          symbol: z.string().optional().describe("Symbol name within `path`."),
          summary: z.string().optional().describe("One sentence: what it is for."),
          purpose: z.string().optional().describe("Why it exists / what it is responsible for."),
          scope: z.string().optional().describe("What it does NOT do."),
          notes: z.string().optional(),
          invariants: z.array(z.string()).optional().describe("One-line constraints to keep true when changing it."),
          rationale: z.string().optional().describe("What was wrong or missing, and how you know."),
          author: z.string().optional().describe("Your agent/client name."),
        },
      },
      async (args) => jsonContent(options.canWrite ? sink.proposeOverlay(args) : denied()),
    );
    server.registerTool(
      "propose_product_doc",
      {
        description:
          "Propose a new or updated product doc (persona, job, story, journey or intent interaction session) as markdown with YAML frontmatter, as it would live under docs/product/. Linted with the same rules as `necronomidoc product lint` against the published code (errors are returned for you to fix; nothing is stored); valid docs land as DRAFTS for human review. Requires the admin token.",
        inputSchema: {
          repo: z.string().describe("Repo slug."),
          content: z.string().describe("The full markdown document including frontmatter."),
          path: z.string().optional().describe("docs/product/… path; derived from id + title when omitted."),
          rationale: z.string().optional(),
          author: z.string().optional(),
        },
      },
      async (args) => jsonContent(options.canWrite ? sink.proposeProductDoc(args) : denied()),
    );
    server.registerTool(
      "list_proposals",
      {
        description: "List doc proposals agents have submitted and their review status (proposed / accepted / rejected). Requires the admin token.",
        inputSchema: {
          repo: z.string().optional(),
          status: z.enum(["proposed", "accepted", "rejected"]).optional(),
        },
      },
      async (args) => jsonContent(options.canWrite ? sink.listProposals(args.repo, args.status) : denied()),
    );
  }

  return server;
}

/**
 * Handle one MCP HTTP request statelessly: spin up a fresh server + transport,
 * answer, and tear down. Fetch-portable so the same handler runs under Hono,
 * Cloudflare Workers, Deno, etc.
 */
export async function handleMcpRequest(
  store: ManifestStore,
  request: Request,
  options: McpServerOptions = {},
): Promise<Response> {
  const server = createMcpServer(store, options);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await transport.close();
    await server.close();
  }
}
