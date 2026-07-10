import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DocModel } from "@necronomidoc/docmodel";
import { TypeScriptAdapter } from "./tsAdapter.js";

const fixture = fileURLToPath(new URL("../../../fixtures/sample-react-app", import.meta.url));

describe("TypeScriptAdapter", () => {
  it("detects a TS/React repo", async () => {
    const match = await new TypeScriptAdapter().detect(fixture);
    expect(match?.language).toBe("typescript");
  });

  it("extracts a schema-valid, file-rooted model", async () => {
    const model = await new TypeScriptAdapter().extract(fixture, { repoName: "sample-react-app" });
    // Schema validity (decision 0006 contract).
    expect(() => DocModel.parse(model)).not.toThrow();
    const paths = model.files.map((f) => f.path);
    expect(paths).toContain("src/hooks/useCounter.ts");
    expect(paths).toContain("src/components/Button.tsx");
  });

  it("classifies components and hooks and captures non-exported symbols", async () => {
    const model = await new TypeScriptAdapter().extract(fixture, { repoName: "sample-react-app" });
    const button = model.files
      .find((f) => f.path.endsWith("Button.tsx"))!
      .symbols.find((s) => s.name === "Button")!;
    expect(button.kind).toBe("component");
    expect(button.props?.map((p) => p.name)).toEqual(["children", "variant", "disabled", "onClick"]);
    expect(button.props?.find((p) => p.name === "children")?.required).toBe(true);
    expect(button.props?.find((p) => p.name === "variant")?.required).toBe(false);

    const counter = model.files.find((f) => f.path.endsWith("useCounter.ts"))!;
    const hook = counter.symbols.find((s) => s.name === "useCounter")!;
    expect(hook.kind).toBe("hook");
    expect(hook.doc?.summary).toMatch(/counter/i);
    expect(hook.doc?.params.map((p) => p.name)).toContain("initial");

    // Non-exported internal helper still swept.
    const format = model.files.find((f) => f.path.endsWith("format.ts"))!;
    const pad2 = format.symbols.find((s) => s.name === "pad2");
    expect(pad2).toBeDefined();
    expect(pad2?.exported).toBe(false);
  });

  it("gives every symbol a stable, deterministic id", async () => {
    const a = new TypeScriptAdapter();
    const m1 = await a.extract(fixture, { repoName: "sample-react-app" });
    const m2 = await a.extract(fixture, { repoName: "sample-react-app" });
    const ids1 = m1.files.flatMap((f) => f.symbols.map((s) => s.id)).sort();
    const ids2 = m2.files.flatMap((f) => f.symbols.map((s) => s.id)).sort();
    expect(ids1).toEqual(ids2);
    expect(ids1).toContain("sample-react-app:src/hooks/useCounter.ts#useCounter");
  });
});
