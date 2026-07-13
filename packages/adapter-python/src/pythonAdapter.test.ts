import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { DocModel } from "@necronomidoc/docmodel";
import { PythonAdapter, discoverPythonTargets } from "./pythonAdapter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "../../../fixtures/sample-python");

const adapter = new PythonAdapter();
const toolchain = await adapter.checkToolchain();

const tempDirs: string[] = [];
function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "necronomidoc-pytest-"));
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
  it("detects the sample-python fixture via pyproject.toml", async () => {
    const match = await adapter.detect(FIXTURE);
    expect(match).not.toBeNull();
    expect(match!.language).toBe("python");
    expect(match!.reason).toContain("pyproject.toml");
  });

  it("detects a bare .py repo without packaging markers", async () => {
    const dir = tempRepo({ "tool.py": '"""A tool."""\n' });
    const match = await adapter.detect(dir);
    expect(match).not.toBeNull();
    expect(match!.reason).toContain("Python file");
  });

  it("returns null when there is nothing importable", async () => {
    const dir = tempRepo({ "readme.md": "# not python", "setup.py": "# packaging only" });
    expect(await adapter.detect(dir)).toBeNull();
  });
});

describe("discoverPythonTargets", () => {
  it("prefers src-layout and skips ignored dirs and setup/conftest", () => {
    const dir = tempRepo({
      "src/mypkg/__init__.py": "",
      "scripts.py": "",
      "setup.py": "",
      "conftest.py": "",
      ".venv/other/__init__.py": "",
      "node_modules/x.py": "",
    });
    const { names, searchPaths } = discoverPythonTargets(dir);
    expect(names.sort()).toEqual(["mypkg", "scripts"]);
    expect(searchPaths[0]).toBe(join(dir, "src"));
  });
});

// Requires a Python interpreter with griffe installed (see `necronomidoc
// doctor`); skipped otherwise, exactly like a host without the toolchain.
describe.runIf(toolchain.ok)("extract (requires python+griffe toolchain)", () => {
  it("builds a schema-valid model from the fixture with stable ids", async () => {
    const model = await adapter.extract(FIXTURE, { repoName: "sample-python" });
    expect(() => DocModel.parse(model)).not.toThrow();
    expect(model.repo.slug).toBe("sample-python");

    const paths = model.files.map((f) => f.path);
    expect(paths).toContain("src/greetkit/__init__.py");
    expect(paths).toContain("src/greetkit/core.py");
    expect(paths).toContain("scripts.py");

    const core = model.files.find((f) => f.path === "src/greetkit/core.py")!;
    expect(core.id).toBe("sample-python:src/greetkit/core.py");
    expect(core.moduleDoc?.summary).toBe("Core greeting machinery.");
    expect(core.symbols.map((s) => s.name)).toEqual([
      "DEFAULT_TARGET",
      "Tone",
      "Greeter",
      "greet_many",
      "_slugify",
    ]);

    const tone = core.symbols.find((s) => s.name === "Tone")!;
    expect(tone.kind).toBe("enum");

    const greeter = core.symbols.find((s) => s.name === "Greeter")!;
    expect(greeter.kind).toBe("class");
    const greet = greeter.members!.find((m) => m.name === "greet")!;
    expect(greet.id).toBe("sample-python:src/greetkit/core.py#Greeter.greet");
    expect(greet.kind).toBe("method");
    expect(greet.doc?.summary).toBe("Greet a single target.");
    expect(greet.doc?.params).toEqual([{ name: "target", type: "str", text: "Who to greet." }]);
    expect(greet.doc?.returns).toBe("The rendered greeting line.");
    expect(greet.doc?.tags).toContainEqual({ tag: "raises", text: "ValueError: If target is empty." });

    const init = greeter.members!.find((m) => m.name === "__init__");
    expect(init).toBeDefined(); // constructor kept, other dunders dropped

    const hidden = greeter.members!.find((m) => m.name === "_render_signature")!;
    expect(hidden.exported).toBe(false); // non-exported coverage guarantee

    const greetMany = core.symbols.find((s) => s.name === "greet_many")!;
    expect(greetMany.signature).toContain("greet_many(targets: list[str], *, tone: Tone");
    expect(greetMany.doc?.examples.length).toBeGreaterThan(0);
  });

  it("is deterministic across runs apart from generatedAt", async () => {
    const a = await adapter.extract(FIXTURE, { repoName: "sample-python" });
    const b = await adapter.extract(FIXTURE, { repoName: "sample-python" });
    expect({ ...a, generatedAt: undefined }).toEqual({ ...b, generatedAt: undefined });
  });

  it("survives a package with a syntax error and documents the rest", async () => {
    const dir = tempRepo({
      "good/__init__.py": '"""Good package."""\n\ndef ok() -> None:\n    """Fine."""\n',
      "broken/__init__.py": "def broken(:\n",
    });
    const model = await adapter.extract(dir, { repoName: "mixed" });
    expect(model.files.some((f) => f.path === "good/__init__.py")).toBe(true);
  });
});

describe.runIf(!toolchain.ok)("toolchain missing", () => {
  it("reports an actionable fix instead of crashing", async () => {
    expect(toolchain.fix).toContain("griffe");
    await expect(adapter.extract(FIXTURE, { repoName: "x" })).rejects.toThrow(/Fix:/);
  });
});
