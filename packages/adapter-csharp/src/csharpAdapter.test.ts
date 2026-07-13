import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { DocModel } from "@necronomidoc/docmodel";
import { CSharpAdapter } from "./csharpAdapter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "../../../fixtures/sample-dotnet");

const adapter = new CSharpAdapter();
const toolchain = await adapter.checkToolchain();

const tempDirs: string[] = [];
function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "necronomidoc-cstest-"));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("detect", () => {
  it("detects the sample-dotnet fixture via its .csproj", async () => {
    const match = await adapter.detect(FIXTURE);
    expect(match).not.toBeNull();
    expect(match!.language).toBe("csharp");
    expect(match!.reason).toContain(".csproj");
  });

  it("returns null for repos without a project file", async () => {
    const dir = tempRepo({ "Loose.cs": "public class Loose {}" });
    expect(await adapter.detect(dir)).toBeNull();
  });
});

// Requires the .NET SDK + docfx (see `necronomidoc doctor`); docfx drives a
// full Roslyn load, so this is the slowest e2e test in the suite.
describe.runIf(toolchain.ok)("extract (requires dotnet+docfx toolchain)", () => {
  it(
    "builds a schema-valid model from the fixture end-to-end",
    { timeout: 300_000 },
    async () => {
      const model = await adapter.extract(FIXTURE, { repoName: "sample-dotnet" });
      expect(() => DocModel.parse(model)).not.toThrow();
      expect(model.files.map((f) => f.path)).toEqual([
        "SampleLib/Batch.cs",
        "SampleLib/Greeter.cs",
      ]);
      const greeter = model.files[1]!.symbols.find((s) => s.name === "Greeter")!;
      expect(greeter.members!.some((m) => m.name === "Greet")).toBe(true);
    },
  );
});

describe.runIf(!toolchain.ok)("toolchain missing", () => {
  it("reports an actionable fix instead of crashing", async () => {
    expect(toolchain.fix).toContain("docfx");
    await expect(adapter.extract(FIXTURE, { repoName: "x" })).rejects.toThrow(/Fix:/);
  });
});
