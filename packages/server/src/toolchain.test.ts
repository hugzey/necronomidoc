import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { buildRepo, listAdapters } from "./build.js";

const pythonFixture = fileURLToPath(new URL("../../../fixtures/sample-python", import.meta.url));

describe("toolchain degradation (slice 5 acceptance criterion 3)", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "necro-toolchain-"));
  const savedPython = process.env["NECRONOMIDOC_PYTHON"];

  afterEach(() => {
    if (savedPython === undefined) delete process.env["NECRONOMIDOC_PYTHON"];
    else process.env["NECRONOMIDOC_PYTHON"] = savedPython;
  });
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  it("fails a build with an actionable message when the toolchain is absent", async () => {
    // Force the python adapter to see no usable interpreter.
    process.env["NECRONOMIDOC_PYTHON"] = "/nonexistent/python-that-is-not-there";
    await expect(
      buildRepo({ dataDir, target: pythonFixture, name: "sample-python" }),
    ).rejects.toThrow(/Fix:.*griffe/s);
  });

  it("exposes toolchain checks for doctor on the shelling adapters", async () => {
    const adapters = listAdapters();
    const python = adapters.find((a) => a.language === "python")!;
    const csharp = adapters.find((a) => a.language === "csharp")!;
    expect(python.checkToolchain).toBeDefined();
    expect(csharp.checkToolchain).toBeDefined();
    expect(python.requires?.pip?.[0]).toContain("griffe");
    expect(csharp.requires?.dotnetTools).toContain("docfx");

    process.env["NECRONOMIDOC_PYTHON"] = "/nonexistent/python-that-is-not-there";
    const status = await python.checkToolchain!();
    expect(status.ok).toBe(false);
    expect(status.fix).toContain("griffe");
  });
});
