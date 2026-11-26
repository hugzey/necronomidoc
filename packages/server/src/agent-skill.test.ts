import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_SKILL_ID, MCP_URL_PLACEHOLDER, builtinSkill, builtinSkillMd } from "@necronomidoc/enrichment";
import { tools } from "@necronomidoc/mcp";
import { createApp, type App } from "./app.js";
import { loadConfig } from "./config.js";

/** Write-back tools registered only when a token is configured. */
const WRITE_TOOLS = ["propose_overlay", "propose_product_doc", "list_proposals"];

describe("built-in using-necronomidoc skill", () => {
  it("documents every MCP tool the server registers (drift guard)", () => {
    const md = builtinSkillMd();
    for (const name of [...Object.keys(tools), ...WRITE_TOOLS]) expect(md, `skill should mention ${name}`).toContain(`\`${name}\``);
  });

  it("renders valid frontmatter and fills in the MCP URL", () => {
    const md = builtinSkillMd({ mcpUrl: "https://docs.example.com/mcp", authRequired: true });
    expect(md.startsWith(`---\nname: "${BUILTIN_SKILL_ID}"\ndescription: "`)).toBe(true);
    expect(md).toContain("claude mcp add --transport http necronomidoc https://docs.example.com/mcp");
    expect(md).toContain('--header "Authorization: Bearer $DOCS_TOKEN"');
    expect(md).toContain("https://docs.example.com/data/repos/<slug>/llms.txt");
    expect(builtinSkill().body).toContain(MCP_URL_PLACEHOLDER);
  });
});

describe("agent-skill endpoints", () => {
  let dataDir: string;
  let app: App;
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "necro-skill-"));
    app = createApp(loadConfig({ dataDir, siteDir: join(dataDir, "no-site") }));
  });
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  it("serves JSON with the connect command for this server's origin", async () => {
    const res = await app.fetch(new Request("http://docs.local:4319/api/agent-skill"));
    const body = (await res.json()) as { mcpUrl: string; connectCommand: string; skillMd: string; installPath: string };
    expect(body.mcpUrl).toBe("http://docs.local:4319/mcp");
    expect(body.connectCommand).toBe("claude mcp add --transport http necronomidoc http://docs.local:4319/mcp");
    expect(body.skillMd).toContain("# Using necronomidoc");
    expect(body.installPath).toBe("~/.claude/skills/using-necronomidoc/SKILL.md");
  });

  it("honours the reverse proxy's forwarded origin, rejecting junk", async () => {
    const proxied = await app.fetch(new Request("http://127.0.0.1:4319/api/agent-skill", { headers: { "x-forwarded-host": "docs.example.com", "x-forwarded-proto": "https" } }));
    expect(((await proxied.json()) as { mcpUrl: string }).mcpUrl).toBe("https://docs.example.com/mcp");
    const junk = await app.fetch(new Request("http://127.0.0.1:4319/api/agent-skill", { headers: { "x-forwarded-host": "evil.com/<script>" } }));
    expect(((await junk.json()) as { mcpUrl?: string }).mcpUrl).toBeUndefined();
  });

  it("serves the raw SKILL.md and a zip with the skill folder", async () => {
    const raw = await app.fetch(new Request("http://x/api/agent-skill/SKILL.md"));
    expect(raw.headers.get("content-type")).toContain("text/markdown");
    expect(await raw.text()).toContain("get_context_for_task");
    const zipRes = await app.fetch(new Request("http://x/api/agent-skill/download"));
    expect(zipRes.headers.get("content-disposition")).toContain("using-necronomidoc.zip");
    const zip = await JSZip.loadAsync(new Uint8Array(await zipRes.arrayBuffer()));
    expect(Object.keys(zip.files)).toContain("using-necronomidoc/SKILL.md");
  });
});
