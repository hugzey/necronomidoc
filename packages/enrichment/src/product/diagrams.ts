import type {
  JourneyFrontmatter,
  ProductDoc,
  SessionFrontmatter,
} from "@necronomidoc/docmodel";

/**
 * Mermaid generation for product docs (decision 0023). Every diagram is drawn
 * from the structured frontmatter, so it can never disagree with the text:
 *
 *   - session flow      flowchart of steps → branches → outcomes
 *   - session sequence  user ↔ surface ↔ system message sequence
 *   - emotion curve     Mermaid `journey` (sessions with step emotions, journeys)
 *   - intent map        personas → jobs → sessions → stories, repo-wide
 */

function nodeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, "_");
}

/** Quoted flowchart labels: drop the quote/pipe delimiters and newlines. */
function label(text: string, max = 60): string {
  const clean = text.replace(/["|\r\n`]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Sequence/journey text: `;` ends a statement and `#` starts an entity code in
 * Mermaid, so both are encoded; journey task names can't contain `:` either.
 */
function plain(text: string, max = 80, noColon = false): string {
  let clean = text.replace(/[\r\n`]/g, " ").replace(/\s+/g, " ").trim();
  clean = clean.replace(/#/g, "#35;").replace(/;/g, "#59;");
  if (noColon) clean = clean.replace(/:/g, " -");
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const OUTCOME_CLASS: Record<string, string> = {
  fulfilled: "fill:#dcfce7,stroke:#16a34a,color:#14532d",
  partial: "fill:#fef9c3,stroke:#ca8a04,color:#713f12",
  diverted: "fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e",
  abandoned: "fill:#fee2e2,stroke:#dc2626,color:#7f1d1d",
  failed: "fill:#fee2e2,stroke:#991b1b,color:#7f1d1d",
};

const OUTCOME_MARK: Record<string, string> = {
  fulfilled: "✓",
  partial: "◐",
  diverted: "↪",
  abandoned: "✗",
  failed: "⚠",
};

/** The successor of each step: explicit `next`, a terminal `outcome`, or the following step. */
export function stepSuccessor(
  session: Pick<SessionFrontmatter, "steps">,
  index: number,
): string | undefined {
  const step = session.steps[index]!;
  if (step.next) return step.next;
  if (step.outcome) return step.outcome;
  return session.steps[index + 1]?.id;
}

export function sessionFlowDiagram(session: SessionFrontmatter): string {
  const lines = ["flowchart TD"];
  lines.push(`  intent(["${label(`Intent: ${session.intent}`, 80)}"])`);
  session.steps.forEach((step) => {
    lines.push(`  ${nodeId(step.id)}["${label(`${step.id} · ${step.action}`)}"]`);
  });
  for (const outcome of session.outcomes) {
    const mark = OUTCOME_MARK[outcome.kind] ?? "";
    lines.push(`  ${nodeId(outcome.id)}(["${label(`${mark} ${outcome.title}`)}"]):::${outcome.kind}`);
  }
  if (session.steps[0]) lines.push(`  intent --> ${nodeId(session.steps[0].id)}`);
  const known = new Set([...session.steps.map((s) => s.id), ...session.outcomes.map((o) => o.id)]);
  session.steps.forEach((step, i) => {
    const next = stepSuccessor(session, i);
    if (next && known.has(next)) lines.push(`  ${nodeId(step.id)} --> ${nodeId(next)}`);
    for (const branch of step.branches) {
      if (!known.has(branch.goto)) continue;
      lines.push(`  ${nodeId(step.id)} -.->|"${label(branch.when, 40)}"| ${nodeId(branch.goto)}`);
    }
  });
  for (const kind of new Set(session.outcomes.map((o) => o.kind))) {
    if (OUTCOME_CLASS[kind]) lines.push(`  classDef ${kind} ${OUTCOME_CLASS[kind]}`);
  }
  return lines.join("\n");
}

export function sessionSequenceDiagram(session: SessionFrontmatter, personaTitle?: string): string {
  const lines = ["sequenceDiagram"];
  lines.push(`  actor U as ${plain(personaTitle ?? "User", 40)}`);
  lines.push(`  participant A as ${plain(session.entry.channel ? `Product (${session.entry.channel})` : "Product", 40)}`);
  lines.push("  participant S as System");
  // Named external actors (an approver, a webhook sender…) get their own lane.
  const externals = new Map<string, string>();
  for (const step of session.steps) {
    const actor = step.actor.trim();
    if (!/^(user|system)$/i.test(actor) && !externals.has(actor)) {
      const alias = `X${externals.size + 1}`;
      externals.set(actor, alias);
      lines.push(`  participant ${alias} as ${plain(actor, 40)}`);
    }
  }
  lines.push(`  Note over U: ${plain(`Intent: ${session.intent}`, 100)}`);
  for (const step of session.steps) {
    const actor = step.actor.trim();
    const from = /^user$/i.test(actor) ? "U" : /^system$/i.test(actor) ? "S" : externals.get(actor)!;
    // The user acts on the product; the system acts toward the user (a
    // notification, a push); external actors act on the product.
    const to = from === "S" ? "U" : "A";
    lines.push(`  ${from}->>${to}: ${plain(`${step.id} ${step.action}`)}`);
    if (step.system) {
      lines.push(`  A->>S: ${plain(step.system)}`);
      lines.push("  S-->>A: response");
    }
    if (step.expects) lines.push(`  A-->>U: ${plain(step.expects)}`);
    if (step.branches.length > 0) {
      for (const branch of step.branches) {
        lines.push(`  opt ${plain(branch.when, 60)}`);
        lines.push(`    Note over U,A: goes to ${plain(branch.goto, 20)}`);
        lines.push("  end");
      }
    }
    if (step.outcome) {
      const outcome = session.outcomes.find((o) => o.id === step.outcome);
      lines.push(`  Note over U,S: ${plain(`${step.outcome}${outcome ? ` ${outcome.kind}: ${outcome.title}` : ""}`, 100)}`);
    }
  }
  return lines.join("\n");
}

/** Emotion curve for a session — only when its steps carry emotion scores. */
export function sessionEmotionDiagram(session: SessionFrontmatter, personaTitle?: string): string | undefined {
  const scored = session.steps.filter((s) => s.emotion !== undefined);
  if (scored.length === 0) return undefined;
  const actor = plain(personaTitle ?? "User", 30, true).replace(/,/g, " ");
  const lines = ["journey", `  title ${plain(session.title, 80, true)}`, `  section ${plain(session.intent, 60, true)}`];
  for (const step of scored) {
    lines.push(`    ${plain(`${step.id} ${step.action}`, 60, true)}: ${step.emotion}: ${actor}`);
  }
  return lines.join("\n");
}

export function journeyDiagram(journey: JourneyFrontmatter, personaTitle?: string): string {
  const actor = plain(personaTitle ?? "User", 30, true).replace(/,/g, " ");
  const lines = ["journey", `  title ${plain(journey.title, 80, true)}`];
  for (const stage of journey.stages) {
    lines.push(`  section ${plain(stage.name, 60, true)}`);
    const tasks = stage.actions.length > 0 ? stage.actions : [stage.goal ?? stage.name];
    for (const task of tasks) {
      lines.push(`    ${plain(task, 60, true)}: ${stage.emotion ?? 3}: ${actor}`);
    }
  }
  return lines.join("\n");
}

/** Cap so a large product set still renders as a readable diagram. */
const INTENT_MAP_MAX_NODES = 80;

/**
 * The repo-wide intent map: who (personas) wants what (jobs), how they go
 * about it (sessions), and which stories deliver it.
 */
export function intentMapDiagram(docs: ProductDoc[]): string | undefined {
  const order = ["persona", "job", "session", "story"] as const;
  const nodes = docs
    .filter((d) => (order as readonly string[]).includes(d.type))
    .sort((a, b) => order.indexOf(a.type as never) - order.indexOf(b.type as never))
    .slice(0, INTENT_MAP_MAX_NODES);
  if (nodes.length === 0) return undefined;
  const present = new Set(nodes.map((d) => d.id));
  const lines = ["flowchart LR"];
  const shape: Record<string, (id: string, text: string) => string> = {
    persona: (id, t) => `${id}(["${t}"]):::persona`,
    job: (id, t) => `${id}{{"${t}"}}:::job`,
    session: (id, t) => `${id}["${t}"]:::session`,
    story: (id, t) => `${id}[/"${t}"/]:::story`,
  };
  for (const doc of nodes) {
    lines.push(`  ${shape[doc.type]!(nodeId(doc.id), label(`${doc.id} ${doc.title}`, 48))}`);
  }
  const edge = (from: string, to: string): void => {
    if (present.has(from) && present.has(to)) lines.push(`  ${nodeId(from)} --> ${nodeId(to)}`);
  };
  for (const doc of nodes) {
    if (doc.type === "job") for (const p of doc.personas) edge(p, doc.id);
    if (doc.type === "session") edge(doc.job, doc.id);
    if (doc.type === "session") for (const s of doc.stories) edge(doc.id, s);
    if (doc.type === "story") {
      // Stories reached through a session are already connected; link the
      // rest straight to their jobs so none float unattached.
      const viaSession = nodes.some((d) => d.type === "session" && d.stories.includes(doc.id));
      if (!viaSession) for (const j of doc.jobs) edge(j, doc.id);
    }
  }
  lines.push(
    "  classDef persona fill:#ede9fe,stroke:#7c3aed,color:#3b0764",
    "  classDef job fill:#fef3c7,stroke:#d97706,color:#78350f",
    "  classDef session fill:#dbeafe,stroke:#2563eb,color:#1e3a8a",
    "  classDef story fill:#f1f5f9,stroke:#64748b,color:#0f172a",
  );
  return lines.join("\n");
}
