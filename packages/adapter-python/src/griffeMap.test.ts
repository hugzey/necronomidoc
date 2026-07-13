import { describe, expect, it } from "vitest";
import { DocFile } from "@necronomidoc/docmodel";
import {
  docstringToComment,
  exprToString,
  functionSignature,
  mapGriffePackage,
  type GriffeObject,
} from "./griffeMap.js";

describe("exprToString", () => {
  it("renders names, subscripts, unions, and callables", () => {
    expect(exprToString("None")).toBe("None");
    expect(exprToString({ cls: "ExprName", name: "str" })).toBe("str");
    expect(
      exprToString({
        cls: "ExprBinOp",
        left: {
          cls: "ExprSubscript",
          left: { cls: "ExprName", name: "dict" },
          slice: {
            cls: "ExprTuple",
            elements: [
              { cls: "ExprName", name: "str" },
              {
                cls: "ExprSubscript",
                left: { cls: "ExprName", name: "list" },
                slice: { cls: "ExprName", name: "int" },
              },
            ],
            implicit: true,
          },
        },
        operator: "|",
        right: "None",
      }),
    ).toBe("dict[str, list[int]] | None");
    expect(
      exprToString({
        cls: "ExprAttribute",
        values: [
          { cls: "ExprName", name: "typing" },
          { cls: "ExprName", name: "Optional" },
        ],
      }),
    ).toBe("typing.Optional");
  });

  it("degrades unknown expression nodes instead of failing", () => {
    expect(exprToString({ cls: "ExprSomethingNew", name: "X" })).toBe("X");
    expect(exprToString({ cls: "ExprSomethingNew" })).toBe("…");
  });
});

describe("functionSignature", () => {
  it("renders defaults, keyword-only markers, and variadics", () => {
    const fn: GriffeObject = {
      kind: "function",
      name: "process",
      parameters: [
        { name: "items", annotation: { cls: "ExprName", name: "list" }, kind: "positional or keyword" },
        { name: "args", annotation: { cls: "ExprName", name: "int" }, default: "()", kind: "variadic positional" },
        { name: "limit", annotation: { cls: "ExprName", name: "int" }, default: "None", kind: "keyword-only" },
        { name: "kwargs", annotation: { cls: "ExprName", name: "str" }, default: "{}", kind: "variadic keyword" },
      ],
      returns: { cls: "ExprName", name: "str" },
    };
    expect(functionSignature(fn)).toBe("process(items: list, *args: int, limit: int = None, **kwargs: str) -> str");
  });

  it("inserts a bare * before keyword-only params when there is no *args", () => {
    const fn: GriffeObject = {
      kind: "function",
      name: "f",
      parameters: [
        { name: "a", kind: "positional or keyword" },
        { name: "b", default: "1", kind: "keyword-only" },
      ],
      returns: "None",
    };
    expect(functionSignature(fn)).toBe("f(a, *, b=1)");
  });
});

describe("docstringToComment", () => {
  it("maps parsed google-style sections to DocComment parts", () => {
    const comment = docstringToComment({
      value: "Greet a target.\n\nArgs:\n    target: Who to greet.",
      parsed: [
        { kind: "text", value: "Greet a target." },
        {
          kind: "parameters",
          value: [{ name: "target", annotation: { cls: "ExprName", name: "str" }, description: "Who to greet." }],
        },
        { kind: "returns", value: [{ annotation: { cls: "ExprName", name: "str" }, description: "The greeting.", name: "" }] },
        { kind: "raises", value: [{ annotation: { cls: "ExprName", name: "ValueError" }, description: "If empty." }] },
        { kind: "examples", value: [["examples", ">>> greet('x')\n'hi x'"]] },
      ],
    });
    expect(comment).toMatchObject({
      summary: "Greet a target.",
      params: [{ name: "target", type: "str", text: "Who to greet." }],
      returns: "The greeting.",
      tags: [{ tag: "raises", text: "ValueError: If empty." }],
      examples: [">>> greet('x')\n'hi x'"],
    });
  });

  it("splits summary/remarks from raw docstrings without parsed sections", () => {
    const comment = docstringToComment({ value: "Summary line.\n\nMore detail\nover two lines." });
    expect(comment?.summary).toBe("Summary line.");
    expect(comment?.remarks).toBe("More detail\nover two lines.");
  });

  it("returns undefined for absent docstrings", () => {
    expect(docstringToComment(null)).toBeUndefined();
    expect(docstringToComment({ value: "" })).toBeUndefined();
  });
});

describe("mapGriffePackage", () => {
  const pkg: GriffeObject = {
    kind: "module",
    name: "pkg",
    path: "pkg",
    filepath: "/repo/pkg/__init__.py",
    docstring: { value: "Package docstring." },
    members: {
      mod: {
        kind: "module",
        name: "mod",
        path: "pkg.mod",
        filepath: "/repo/pkg/mod.py",
        docstring: { value: "Module summary." },
        members: {
          CONSTANT: {
            kind: "attribute",
            name: "CONSTANT",
            lineno: 3,
            annotation: { cls: "ExprName", name: "int" },
            value: "42",
            labels: ["module-attribute"],
            is_public: true,
          },
          Greeter: {
            kind: "class",
            name: "Greeter",
            lineno: 6,
            endlineno: 20,
            is_public: true,
            docstring: { value: "Greets people." },
            members: {
              greet: {
                kind: "function",
                name: "greet",
                lineno: 10,
                is_public: true,
                parameters: [
                  { name: "self", kind: "positional or keyword" },
                  { name: "target", annotation: { cls: "ExprName", name: "str" }, default: "'world'", kind: "positional or keyword" },
                ],
                returns: { cls: "ExprName", name: "str" },
              },
              __repr__: { kind: "function", name: "__repr__", lineno: 18, is_special: true },
            },
          },
          Color: {
            kind: "class",
            name: "Color",
            lineno: 22,
            is_public: true,
            bases: [{ cls: "ExprName", name: "Enum" }],
            members: {
              RED: { kind: "attribute", name: "RED", lineno: 23, value: "1", is_public: true },
            },
          },
          _hidden: { kind: "function", name: "_hidden", lineno: 30, is_public: false },
          Enum: { kind: "alias", name: "Enum", is_public: false },
        },
      },
    },
  };

  const ctx = {
    repoSlug: "myrepo",
    toRelPath: (fp: string) => (fp.startsWith("/repo/") ? fp.slice("/repo/".length) : null),
    readSource: () => "file contents",
  };

  it("emits one schema-valid DocFile per module with stable ids", () => {
    const files = mapGriffePackage(pkg, ctx);
    expect(files.map((f) => f.path)).toEqual(["pkg/__init__.py", "pkg/mod.py"]);
    for (const file of files) expect(() => DocFile.parse(file)).not.toThrow();

    const mod = files[1]!;
    expect(mod.id).toBe("myrepo:pkg/mod.py");
    expect(mod.moduleDoc?.summary).toBe("Module summary.");
    expect(mod.symbols.map((s) => [s.name, s.kind, s.exported])).toEqual([
      ["CONSTANT", "variable", true],
      ["Greeter", "class", true],
      ["Color", "enum", true],
      ["_hidden", "function", false],
    ]);
    const greeter = mod.symbols[1]!;
    expect(greeter.members?.map((m) => m.name)).toEqual(["greet"]); // __repr__ dropped
    expect(greeter.members?.[0]?.id).toBe("myrepo:pkg/mod.py#Greeter.greet");
    expect(greeter.members?.[0]?.kind).toBe("method");
    expect(greeter.members?.[0]?.signature).toBe("greet(self, target: str = 'world') -> str");
  });

  it("covers non-exported symbols (per-file sweep guarantee) and skips aliases", () => {
    const files = mapGriffePackage(pkg, ctx);
    const mod = files[1]!;
    expect(mod.symbols.some((s) => s.name === "_hidden" && !s.exported)).toBe(true);
    expect(mod.symbols.some((s) => s.name === "Enum")).toBe(false);
    expect(mod.exports).toEqual(["CONSTANT", "Greeter", "Color"]);
  });

  it("hashes symbols deterministically and independently of location", () => {
    const [a] = mapGriffePackage(pkg, ctx);
    const [b] = mapGriffePackage(pkg, ctx);
    expect(a!.symbols.map((s) => s.contentHash)).toEqual(b!.symbols.map((s) => s.contentHash));
  });

  it("skips modules whose files fall outside the repo", () => {
    const external: GriffeObject = { ...pkg, filepath: "/elsewhere/pkg/__init__.py", members: {} };
    expect(mapGriffePackage(external, ctx)).toEqual([]);
  });
});
