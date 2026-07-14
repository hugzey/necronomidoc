import { describe, expect, it } from "vitest";
import { languageForPath, tokenizeLine, tokenizeLines, type Token } from "./highlight.js";

const types = (tokens: Token[]): string[] => tokens.map((t) => `${t.type}:${t.text}`);
const joined = (tokens: Token[]): string => tokens.map((t) => t.text).join("");

describe("languageForPath", () => {
  it("maps common extensions", () => {
    expect(languageForPath("src/a.tsx")).toBe("ts");
    expect(languageForPath("lib/x.py")).toBe("python");
    expect(languageForPath("Program.cs")).toBe("csharp");
    expect(languageForPath("styles.css")).toBe("css");
    expect(languageForPath("data.json")).toBe("json");
    expect(languageForPath("Makefile")).toBe("plain");
  });
});

describe("tokenizeLine", () => {
  it("is lossless: concatenated tokens reproduce the line", () => {
    const line = `export function f(x: number = 0x1F): string { return \`v=\${x}\`; } // done`;
    const { tokens } = tokenizeLine(line, "ts");
    expect(joined(tokens)).toBe(line);
  });

  it("classifies keywords, identifiers, strings, numbers, and comments", () => {
    const { tokens } = tokenizeLine(`const n = fetchModel("slug"); // load`, "ts");
    expect(types(tokens)).toEqual([
      "kw:const",
      "plain: ",
      "ident:n",
      "plain: = ",
      "ident:fetchModel",
      "plain:(",
      'str:"slug"',
      "plain:); ",
      "com:// load",
    ]);
  });

  it("does not treat quoted text as identifiers", () => {
    const { tokens } = tokenizeLine(`const s = "import fetchModel";`, "ts");
    const strToken = tokens.find((t) => t.type === "str");
    expect(strToken?.text).toBe('"import fetchModel"');
    expect(tokens.filter((t) => t.type === "ident").map((t) => t.text)).toEqual(["s"]);
  });

  it("carries block comments across lines", () => {
    const first = tokenizeLine("/* start", "ts");
    expect(first.next).toEqual({ kind: "block-comment" });
    const second = tokenizeLine("still comment", "ts", first.next);
    expect(types(second.tokens)).toEqual(["com:still comment"]);
    const third = tokenizeLine("end */ const x = 1;", "ts", second.next);
    expect(third.tokens[0]).toEqual({ type: "com", text: "end */" });
    expect(third.next).toEqual({ kind: "none" });
  });

  it("carries template literals across lines", () => {
    const first = tokenizeLine("const t = `line one", "ts");
    expect(first.next).toEqual({ kind: "template" });
    const second = tokenizeLine("line two`;", "ts", first.next);
    expect(second.tokens[0]).toEqual({ type: "str", text: "line two`" });
  });

  it("handles python comments and triple-quoted strings", () => {
    const { tokens } = tokenizeLine("def f():  # comment", "python");
    expect(tokens[0]).toEqual({ type: "kw", text: "def" });
    expect(tokens.at(-1)).toEqual({ type: "com", text: "# comment" });

    const open = tokenizeLine('doc = """start', "python");
    expect(open.next).toEqual({ kind: "triple", quote: '"""' });
    const close = tokenizeLine('end"""', "python", open.next);
    expect(close.tokens[0]).toEqual({ type: "str", text: 'end"""' });
    expect(close.next).toEqual({ kind: "none" });
  });

  it("does not treat quotes as strings in unknown ('plain') languages", () => {
    // A shell/SQL line with an apostrophe must not swallow the rest as a string.
    const { tokens } = tokenizeLine("echo don't run deployStack", "plain");
    expect(tokens.some((t) => t.type === "str")).toBe(false);
    expect(tokens.filter((t) => t.type === "ident").map((t) => t.text)).toContain("deployStack");
  });

  it("scans number literals without gluing on following punctuation", () => {
    // The old char-class loop glued "0x12" onto ".toString"; the sticky regex
    // stops at the number so the trailing identifier stays linkable.
    const chain = tokenizeLine("const s = 0x12.toString();", "ts");
    expect(chain.tokens.find((t) => t.type === "num")?.text).toBe("0x12");
    expect(chain.tokens.filter((t) => t.type === "ident").map((t) => t.text)).toContain("toString");
    const hex = tokenizeLine("const n = 0xFF_00 + 1.5e3;", "ts");
    expect(hex.tokens.filter((t) => t.type === "num").map((t) => t.text)).toEqual([
      "0xFF_00",
      "1.5e3",
    ]);
  });

  it("handles csharp keywords", () => {
    const { tokens } = tokenizeLine("public sealed record Point(int X);", "csharp");
    expect(tokens.filter((t) => t.type === "kw").map((t) => t.text)).toEqual([
      "public",
      "sealed",
      "record",
      "int",
    ]);
  });
});

describe("tokenizeLines", () => {
  it("tokenizes whole files line by line, preserving text", () => {
    const text = `import { x } from "./x.js";\n\n/**\n * Doc.\n */\nexport const y = x + 1;\n`;
    const lines = tokenizeLines(text, "ts");
    expect(lines).toHaveLength(7); // trailing newline yields a final empty line
    expect(lines.map(joined).join("\n")).toBe(text);
    expect(lines[3]!.map((t) => t.type)).toEqual(["com"]);
  });
});
