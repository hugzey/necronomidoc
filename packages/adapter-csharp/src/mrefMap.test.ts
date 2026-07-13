import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DocFile } from "@necronomidoc/docmodel";
import { readManagedReferenceDocs } from "./csharpAdapter.js";
import { cleanDocText, mapManagedReference, prettyTypeRef, type MrefMapContext } from "./mrefMap.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_FIXTURE = resolve(__dirname, "../../../fixtures/sample-dotnet");
const MREF_FIXTURE = resolve(__dirname, "../../../fixtures/sample-dotnet-mref");
// The checked-in YAML has source paths relative to this pretend docfx dir.
const PRETEND_DOCFX_DIR = join(REPO_FIXTURE, ".docfx");

function fixtureContext(): MrefMapContext {
  return {
    repoSlug: "sample-dotnet",
    resolveSourcePath: (docfxRelative) => {
      const abs = resolve(PRETEND_DOCFX_DIR, docfxRelative);
      const rel = abs.startsWith(REPO_FIXTURE + "/") ? abs.slice(REPO_FIXTURE.length + 1) : null;
      return rel;
    },
    readSource: (relPath) => readFileSync(join(REPO_FIXTURE, relPath), "utf8"),
  };
}

describe("cleanDocText", () => {
  it("converts docfx HTML fragments to readable text", () => {
    expect(cleanDocText('If <code class="paramref">target</code> is empty.')).toBe(
      "If `target` is empty.",
    );
    expect(cleanDocText('<pre><code class="lang-csharp">var x = 1;</code></pre>')).toBe("`var x = 1;`");
    expect(cleanDocText('Batch helpers over <xref href="SampleLib.Greeter" data-throw-if-not-resolved="false"></xref>.')).toBe(
      "Batch helpers over Greeter.",
    );
    expect(cleanDocText("a &lt; b &amp;&amp; c")).toBe("a < b && c");
    expect(cleanDocText(undefined)).toBeUndefined();
    expect(cleanDocText("")).toBeUndefined();
  });
});

describe("prettyTypeRef", () => {
  it("prefers reference names and falls back to shortening uids", () => {
    const refs = new Map([
      ["System.Collections.Generic.IEnumerable{System.String}", { uid: "x", name: "IEnumerable<string>" }],
    ]);
    expect(prettyTypeRef("System.Collections.Generic.IEnumerable{System.String}", refs)).toBe(
      "IEnumerable<string>",
    );
    expect(prettyTypeRef("SampleLib.Tone", new Map())).toBe("Tone");
    // Fallback shortens uids but keeps CLR type names (no reference to prettify).
    expect(prettyTypeRef("System.Collections.Generic.IReadOnlyList{System.String}", new Map())).toBe(
      "IReadOnlyList<String>",
    );
  });
});

describe("mapManagedReference over the checked-in docfx fixture", () => {
  const documents = readManagedReferenceDocs(MREF_FIXTURE);

  it("parses the ManagedReference YAML fixture", () => {
    expect(documents.length).toBeGreaterThanOrEqual(3); // Greeter, Tone, Batch (+ namespace)
  });

  const files = mapManagedReference(documents, fixtureContext());

  it("emits one schema-valid DocFile per C# source file with stable ids", () => {
    expect(files.map((f) => f.path)).toEqual(["SampleLib/Batch.cs", "SampleLib/Greeter.cs"]);
    for (const file of files) expect(() => DocFile.parse(file)).not.toThrow();

    const greeterFile = files.find((f) => f.path === "SampleLib/Greeter.cs")!;
    expect(greeterFile.id).toBe("sample-dotnet:SampleLib/Greeter.cs");
    expect(greeterFile.symbols.map((s) => [s.name, s.kind])).toEqual([
      ["Tone", "enum"],
      ["Greeter", "class"],
    ]);
  });

  it("maps members, docs, params, returns, and exceptions", () => {
    const greeterFile = files.find((f) => f.path === "SampleLib/Greeter.cs")!;
    const greeter = greeterFile.symbols.find((s) => s.name === "Greeter")!;
    expect(greeter.doc?.summary).toBe("Produces greetings with a configurable tone.");
    expect(greeter.exported).toBe(true);

    const greet = greeter.members!.find((m) => m.name === "Greet")!;
    expect(greet.id).toBe("sample-dotnet:SampleLib/Greeter.cs#Greeter.Greet");
    expect(greet.kind).toBe("method");
    expect(greet.signature).toBe('public string Greet(string target = "world")');
    expect(greet.doc?.params).toEqual([{ name: "target", type: "string", text: "Who to greet." }]);
    expect(greet.doc?.returns).toBe("The rendered greeting line.");
    expect(greet.doc?.tags).toContainEqual({
      tag: "raises",
      text: "ArgumentException: If `target` is empty.",
    });
    // 1-based line pointing at the method declaration.
    expect(greet.location.line).toBeGreaterThan(30);
  });

  it("keeps private members unexported (per-file coverage guarantee)", () => {
    const greeterFile = files.find((f) => f.path === "SampleLib/Greeter.cs")!;
    const greeter = greeterFile.symbols.find((s) => s.name === "Greeter")!;
    const names = greeter.members!.map((m) => m.name);
    expect(names).toContain("_tone");
    expect(names).toContain("RenderSignature");
    expect(greeter.members!.find((m) => m.name === "_tone")!.exported).toBe(false);
    expect(greeterFile.exports).not.toContain("_tone");
  });

  it("maps enums with their members and examples on methods", () => {
    const greeterFile = files.find((f) => f.path === "SampleLib/Greeter.cs")!;
    const tone = greeterFile.symbols.find((s) => s.name === "Tone")!;
    expect(tone.kind).toBe("enum");
    expect(tone.members!.map((m) => m.name)).toEqual(["Calm", "Excited"]);

    const batchFile = files.find((f) => f.path === "SampleLib/Batch.cs")!;
    const batch = batchFile.symbols.find((s) => s.name === "Batch")!;
    const greetMany = batch.members!.find((m) => m.name === "GreetMany")!;
    expect(greetMany.doc?.examples.length).toBeGreaterThan(0);
    expect(greetMany.doc?.params.map((p) => p.type)).toEqual(["IEnumerable<string>", "Tone"]);
  });

  it("hashes deterministically", () => {
    const again = mapManagedReference(readManagedReferenceDocs(MREF_FIXTURE), fixtureContext());
    expect(again.map((f) => f.contentHash)).toEqual(files.map((f) => f.contentHash));
  });
});
