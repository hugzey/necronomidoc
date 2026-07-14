/**
 * Lightweight line-based syntax highlighting for the source viewer — close
 * enough for readable code without shipping a highlighting library. Each line
 * is tokenized independently with a small carry-over state for constructs
 * that span lines (block comments, template literals, triple-quoted strings).
 * Identifier tokens are kept separate so the viewer can turn ones that
 * resolve to documented symbols into links.
 */

export type TokenType =
  | "kw" // language keyword
  | "str" // string literal
  | "com" // comment
  | "num" // number literal
  | "ident" // identifier (candidate for cross-reference linking)
  | "plain"; // everything else (operators, punctuation, whitespace)

export interface Token {
  type: TokenType;
  text: string;
}

export type Language = "ts" | "python" | "csharp" | "css" | "json" | "plain";

/** What a multi-line construct leaves open at the end of a line. */
export type LineCarry =
  | { kind: "none" }
  | { kind: "block-comment" }
  | { kind: "template" } // JS/TS backtick template literal
  | { kind: "triple"; quote: '"""' | "'''" }; // Python triple-quoted string

const NO_CARRY: LineCarry = { kind: "none" };

/** Pick a highlighting language from a file path's extension. */
export function languageForPath(path: string): Language {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"].includes(ext)) return "ts";
  if (ext === "py" || ext === "pyi") return "python";
  if (ext === "cs") return "csharp";
  if (ext === "css" || ext === "scss" || ext === "less") return "css";
  if (ext === "json") return "json";
  return "plain";
}

const TS_KEYWORDS = new Set(
  (
    "abstract any as async await boolean break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let namespace never new null number object of override private protected public readonly return satisfies set static string super switch this throw true try type typeof undefined unknown var void while with yield"
  ).split(" "),
);

const PY_KEYWORDS = new Set(
  (
    "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self cls"
  ).split(" "),
);

const CS_KEYWORDS = new Set(
  (
    "abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach get goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly record ref return sbyte sealed set short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile when where while yield"
  ).split(" "),
);

const KEYWORDS: Partial<Record<Language, Set<string>>> = {
  ts: TS_KEYWORDS,
  python: PY_KEYWORDS,
  csharp: CS_KEYWORDS,
  json: new Set(["true", "false", "null"]),
};

const IDENT_START = /[A-Za-z_$]/;
const IDENT_CHAR = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

/** Tokenize a whole file: one token array per line. */
export function tokenizeLines(text: string, lang: Language): Token[][] {
  const lines = text.split(/\r?\n/);
  const out: Token[][] = [];
  let carry: LineCarry = NO_CARRY;
  for (const line of lines) {
    const { tokens, next } = tokenizeLine(line, lang, carry);
    out.push(tokens);
    carry = next;
  }
  return out;
}

/** Tokenize one line given the carry-over state from the previous line. */
export function tokenizeLine(
  line: string,
  lang: Language,
  carry: LineCarry = NO_CARRY,
): { tokens: Token[]; next: LineCarry } {
  const tokens: Token[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain) {
      tokens.push({ type: "plain", text: plain });
      plain = "";
    }
  };
  const push = (type: TokenType, text: string): void => {
    if (!text) return;
    flush();
    tokens.push({ type, text });
  };

  const keywords = KEYWORDS[lang];
  let i = 0;

  // Resume a construct left open by the previous line.
  if (carry.kind === "block-comment") {
    const end = line.indexOf("*/");
    if (end === -1) {
      push("com", line);
      return { tokens, next: carry };
    }
    push("com", line.slice(0, end + 2));
    i = end + 2;
  } else if (carry.kind === "template") {
    const end = scanTemplateEnd(line, 0);
    if (end === -1) {
      push("str", line);
      return { tokens, next: carry };
    }
    push("str", line.slice(0, end + 1));
    i = end + 1;
  } else if (carry.kind === "triple") {
    const end = line.indexOf(carry.quote);
    if (end === -1) {
      push("str", line);
      return { tokens, next: carry };
    }
    push("str", line.slice(0, end + 3));
    i = end + 3;
  }

  while (i < line.length) {
    const ch = line[i]!;
    const two = line.slice(i, i + 2);

    // Comments.
    if ((lang === "ts" || lang === "csharp" || lang === "css") && two === "/*") {
      const end = line.indexOf("*/", i + 2);
      if (end === -1) {
        push("com", line.slice(i));
        return { tokens, next: { kind: "block-comment" } };
      }
      push("com", line.slice(i, end + 2));
      i = end + 2;
      continue;
    }
    if ((lang === "ts" || lang === "csharp") && two === "//") {
      push("com", line.slice(i));
      break;
    }
    if (lang === "python" && ch === "#") {
      push("com", line.slice(i));
      break;
    }

    // Strings.
    if (lang === "python" && (line.startsWith('"""', i) || line.startsWith("'''", i))) {
      const quote = line.slice(i, i + 3) as '"""' | "'''";
      const end = line.indexOf(quote, i + 3);
      if (end === -1) {
        push("str", line.slice(i));
        return { tokens, next: { kind: "triple", quote } };
      }
      push("str", line.slice(i, end + 3));
      i = end + 3;
      continue;
    }
    if (lang === "ts" && ch === "`") {
      const end = scanTemplateEnd(line, i + 1);
      if (end === -1) {
        push("str", line.slice(i));
        return { tokens, next: { kind: "template" } };
      }
      push("str", line.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = scanStringEnd(line, i + 1, ch);
      push("str", line.slice(i, end + 1));
      i = end + 1;
      continue;
    }

    // Numbers (good enough: digits, hex, dots, exponents, separators).
    if (DIGIT.test(ch) || (ch === "." && DIGIT.test(line[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < line.length && /[0-9a-fA-FxXoObB_.eE+-]/.test(line[j]!)) {
        // `+`/`-` only continue a number straight after an exponent marker.
        if ((line[j] === "+" || line[j] === "-") && !/[eE]/.test(line[j - 1]!)) break;
        j++;
      }
      push("num", line.slice(i, j));
      i = j;
      continue;
    }

    // Identifiers / keywords.
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < line.length && IDENT_CHAR.test(line[j]!)) j++;
      const word = line.slice(i, j);
      push(keywords?.has(word) ? "kw" : "ident", word);
      i = j;
      continue;
    }

    plain += ch;
    i++;
  }

  flush();
  return { tokens, next: NO_CARRY };
}

/** Index of an unescaped closing quote, or end-of-line (unterminated). */
function scanStringEnd(line: string, from: number, quote: string): number {
  for (let i = from; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === quote) return i;
  }
  return line.length - 1;
}

/**
 * Index of the closing backtick of a template literal, or -1 when the line
 * ends inside it. Interpolations are left as string text — close enough.
 */
function scanTemplateEnd(line: string, from: number): number {
  for (let i = from; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === "`") return i;
  }
  return -1;
}
