/**
 * One trust score per answer (decision 0024). Responses already carry
 * `provenance` and `stale`; this folds those together with code-binding drift
 * and test coverage into a single number an agent can act on: rely on a
 * `high` answer, re-verify a `low` one against the source.
 */

export interface TrustInput {
  /** human | llm | heuristic (enrichment), repo | override (core/product docs). */
  provenance?: string;
  /** The code changed since the description was written. */
  stale?: boolean;
  /** A doc comment in the code itself backs the description. */
  documented?: boolean;
  /** States of product-doc bindings targeting the code. */
  bindings?: ("ok" | "changed" | "broken")[];
  /** Tests exercise the code (imports) or cite intents bound to it. */
  tested?: boolean;
}

export interface Trust {
  /** 0..1, two decimals. */
  score: number;
  level: "high" | "medium" | "low";
  /** The factors that moved the score, comma-joined (short). */
  why: string;
}

const BASE: Record<string, number> = {
  human: 0.9,
  repo: 0.9,
  override: 0.85,
  llm: 0.65,
  heuristic: 0.4,
};

export function trustScore(input: TrustInput): Trust {
  const why: string[] = [];
  let score = BASE[input.provenance ?? "heuristic"] ?? 0.4;
  why.push(input.provenance ?? "heuristic");
  if (input.provenance === "heuristic" && input.documented) {
    // A heuristic summary that comes from the code's own doc comment is as
    // good as that comment.
    score = 0.6;
    why.push("from doc comment");
  }
  if (input.stale) {
    score -= 0.35;
    why.push("stale");
  }
  const states = input.bindings ?? [];
  if (states.includes("broken")) {
    score -= 0.2;
    why.push("broken binding");
  } else if (states.includes("changed")) {
    score -= 0.1;
    why.push("changed binding");
  }
  if (input.tested) {
    score += 0.1;
    why.push("tested");
  }
  score = Math.max(0, Math.min(1, Math.round(score * 100) / 100));
  return { score, level: score >= 0.75 ? "high" : score >= 0.5 ? "medium" : "low", why: why.join(", ") };
}
