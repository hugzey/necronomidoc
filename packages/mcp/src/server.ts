import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { ManifestStore } from "./store.js";
import { tools, type ToolResult } from "./tools.js";

function jsonContent(result: ToolResult) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

/**
 * Build a fresh MCP server exposing the six documentation tools over the given
 * manifest store (decision 0008). All tools are read-only and answer from the
 * in-memory store — no side effects, safe to instantiate per request.
 */
export function createMcpServer(store: ManifestStore): McpServer {
  const server = new McpServer(
    { name: "necronomidoc", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "list_repos",
    {
      description: "List every documented repository with file/symbol counts and a one-line summary.",
      inputSchema: {},
    },
    async () => jsonContent(tools.list_repos(store)),
  );

  server.registerTool(
    "search_docs",
    {
      description:
        "Search files and symbols across repos by concept keywords. Returns ranked hits with ids for follow-up get_* calls. Cursor-paginated.",
      inputSchema: {
        query: z.string().describe("Search terms (concepts, names, purposes)."),
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
        "Get a file's purpose plus its symbol inventory (with provenance and staleness). Answers 'what is this file for?'.",
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
        "Get the full documentation for one symbol (function, hook, component, class…) by id or by name within a repo.",
      inputSchema: {
        repo: z.string().describe("Repo slug (used when looking up by name)."),
        id: z.string().optional().describe("Stable symbol id, e.g. 'slug:src/x.ts#Name'."),
        name: z.string().optional().describe("Bare symbol name to look up within the repo."),
      },
    },
    async (args) => jsonContent(tools.get_function_doc(store, args)),
  );

  server.registerTool(
    "get_subsystem_overview",
    {
      description:
        "Map a repo (or a directory within it) into subsystems with per-file purposes and exports — for scope and separation-of-concerns questions.",
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
      description: "List a repo's files with one-line purposes. Cursor-paginated.",
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
