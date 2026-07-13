import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { ManifestStore } from "./store.js";
import { tools, type ToolResult } from "./tools.js";

function jsonContent(result: ToolResult) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

/**
 * Build a fresh MCP server exposing the seven documentation tools over the
 * given manifest store (decision 0008). All tools are read-only and answer
 * from the in-memory store — no side effects, safe to instantiate per request.
 */
export function createMcpServer(store: ManifestStore): McpServer {
  const server = new McpServer(
    { name: "necronomidoc", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "list_repos",
    {
      description:
        "List every documented repository with file/symbol counts, a one-line summary, and enrichment coverage. Call this first to discover repo slugs for the other tools.",
      inputSchema: {},
    },
    async () => jsonContent(tools.list_repos(store)),
  );

  server.registerTool(
    "search_docs",
    {
      description:
        "Search files, symbols, and subsystems across repos by concept keywords. Call this whenever you need to know if something already exists (a helper, hook, component, or a whole subsystem) before writing new code. Returns ranked hits with ids for follow-up get_file_doc / get_function_doc calls. Cursor-paginated.",
      inputSchema: {
        query: z.string().describe("Search terms (concepts, names, purposes — e.g. 'currency formatting')."),
        repo: z.string().optional().describe("Restrict to one repo slug."),
        cursor: z.string().optional().describe("Pagination cursor from a previous response."),
      },
    },
    async (args) => jsonContent(tools.search_docs(store, args)),
  );

  server.registerTool(
    "get_file_doc",
    {
      description:
        "Get a file's purpose plus its full symbol inventory (with provenance and staleness flags — treat `stale: true` summaries as possibly outdated). Call this when you know the file path and need to answer 'what is this file for / what does it export?'.",
      inputSchema: {
        repo: z.string().describe("Repo slug."),
        path: z.string().describe("File path relative to the repo root."),
      },
    },
    async (args) => jsonContent(tools.get_file_doc(store, args)),
  );

  server.registerTool(
    "get_function_doc",
    {
      description:
        "Get the full documentation for one symbol (function, hook, component, class…) — signature, params, props, examples, and its purpose summary. Call this after search_docs to inspect a specific hit by its id, or look a symbol up by bare name within a repo.",
      inputSchema: {
        repo: z.string().describe("Repo slug (used when looking up by name)."),
        id: z.string().optional().describe("Stable symbol id, e.g. 'slug:src/x.ts#Name'."),
        name: z.string().optional().describe("Bare symbol name to look up within the repo."),
      },
    },
    async (args) => jsonContent(tools.get_function_doc(store, args)),
  );

  server.registerTool(
    "get_core_doc",
    {
      description:
        "Get one of a repo's four core documents: 'overview' (what the project is and does), 'conventions' (style and patterns to follow), 'packages' (third-party dependencies — why, how, where), or 'architecture' (high-level layout with a mermaid/ASCII diagram). Call this before writing code in an unfamiliar repo. Provenance tells you the source: repo (shipped with the code), override (server-side curation), llm, or heuristic; treat `stale: true` as possibly outdated.",
      inputSchema: {
        repo: z.string().describe("Repo slug."),
        doc: z
          .enum(["overview", "conventions", "packages", "architecture"])
          .describe("Which core document to fetch."),
      },
    },
    async (args) => jsonContent(tools.get_core_doc(store, args)),
  );

  server.registerTool(
    "get_subsystem_overview",
    {
      description:
        "Map a repo into its subsystems: purpose, explicit boundaries (what each subsystem owns and what does NOT belong in it), key entry points, relationships, and member files. Call this for scope / separation-of-concerns questions like 'where does auth logic live and what shouldn't go in it?' or before deciding where new code belongs. Curated maps (provenance human/llm) carry real boundary statements; heuristic ones are directory groupings.",
      inputSchema: {
        repo: z.string().describe("Repo slug."),
        dir: z.string().optional().describe("Directory prefix to scope the overview."),
      },
    },
    async (args) => jsonContent(tools.get_subsystem_overview(store, args)),
  );

  server.registerTool(
    "list_files",
    {
      description:
        "List a repo's files with one-line purposes. Call this to orient in an unfamiliar repo when you don't yet have a search term. Cursor-paginated.",
      inputSchema: {
        repo: z.string().describe("Repo slug."),
        cursor: z.string().optional().describe("Pagination cursor from a previous response."),
      },
    },
    async (args) => jsonContent(tools.list_files(store, args)),
  );

  return server;
}

/**
 * Handle one MCP HTTP request statelessly: spin up a fresh server + transport,
 * answer, and tear down. Fetch-portable so the same handler runs under Hono,
 * Cloudflare Workers, Deno, etc.
 */
export async function handleMcpRequest(store: ManifestStore, request: Request): Promise<Response> {
  const server = createMcpServer(store);
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
