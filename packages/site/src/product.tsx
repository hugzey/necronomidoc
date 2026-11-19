import { useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import {
  fetchModel,
  fetchProduct,
  type DocModel,
  type ProductDoc,
  type ProductManifest,
} from "./api.js";
import { Loading, ProvenanceBadge, ScrollToAnchor, useAsync } from "./components.js";
import { MarkdownDoc, MermaidBlock } from "./markdown.js";
import { anchorForSymbol, fileHref } from "./resolve.js";

/**
 * Product documentation pages (decision 0023): the intent map + coverage
 * overview, the story map, the traceability matrix, and one page per
 * document — personas, jobs, epics, stories, journeys and intent interaction
 * sessions — all cross-linked both ways and bound to the code they exercise.
 */

type Binding = ProductDoc["bindings"][number];
type DocOf<T extends ProductDoc["type"]> = Extract<ProductDoc, { type: T }>;

/** `STORY-007.AC-02` → `STORY-7.AC-2` (mirrors docmodel's normalizeProductRef without zod). */
function normalizeRef(ref: string): string {
  const m = /^([A-Z]+)-0*(\d+)(?:[./:_]([A-Z]+)-?0*(\d+))?$/i.exec(ref.trim());
  if (!m) return ref.trim();
  const head = `${m[1]!.toUpperCase()}-${m[2]}`;
  return m[3] ? `${head}.${m[3]!.toUpperCase()}-${m[4]}` : head;
}

export function productHref(slug: string, id?: string): string {
  return `/r/${slug}/product${id ? `/${id}` : ""}`;
}

const TYPE_LABEL: Record<ProductDoc["type"], [string, string]> = {
  persona: ["Persona", "Personas"],
  job: ["Job / intent", "Jobs to be done"],
  epic: ["Epic", "Epics"],
  story: ["Story", "Stories"],
  journey: ["Journey", "Journeys"],
  session: ["Interaction session", "Interaction sessions"],
};

const TYPE_BADGE: Record<ProductDoc["type"], string> = {
  persona: "badge-secondary",
  job: "badge-warning",
  epic: "badge-neutral",
  story: "badge-ghost",
  journey: "badge-accent",
  session: "badge-info",
};

const STATUS_BADGE: Record<string, string> = {
  draft: "badge-ghost",
  proposed: "badge-warning badge-outline",
  accepted: "badge-success badge-outline",
  implemented: "badge-success",
  deprecated: "badge-error badge-outline",
};

const OUTCOME_BADGE: Record<string, string> = {
  fulfilled: "badge-success",
  partial: "badge-warning",
  diverted: "badge-info",
  abandoned: "badge-error badge-outline",
  failed: "badge-error",
};

const BINDING_BADGE: Record<Binding["state"], string> = {
  ok: "badge-success badge-outline",
  changed: "badge-warning",
  broken: "badge-error",
};

/** The one-sentence statement form of a document. */
export function statementOf(doc: ProductDoc, titleOf: (id: string) => string): string {
  switch (doc.type) {
    case "persona":
    case "epic":
      return doc.summary;
    case "job":
      return `When ${doc.situation}, I want to ${doc.motivation}, so I can ${doc.outcome}.`;
    case "story":
      return `As a ${titleOf(doc.persona)}, I want ${doc.want}, so that ${doc.soThat}.`;
    case "journey":
      return doc.stages.map((s) => s.name).join(" → ");
    case "session":
      return `“${doc.intent}”`;
  }
}

function useProduct(slug: string) {
  const product = useAsync<ProductManifest | undefined>(() => fetchProduct(slug), [slug]);
  const model = useAsync<DocModel>(() => fetchModel(slug), [slug]);
  const index = useMemo(() => {
    const byId = new Map((product.data?.docs ?? []).map((d) => [normalizeRef(d.id), d]));
    return {
      get: (id: string) => byId.get(normalizeRef(id)),
      titleOf: (id: string) => byId.get(normalizeRef(id))?.title ?? id,
    };
  }, [product.data]);
  return { product: product.data, model: model.data, loading: product.loading || model.loading, index };
}

// ---- Small shared pieces ----

function DocLink({ slug, id, title }: { slug: string; id: string; title?: string }) {
  return (
    <Link to={productHref(slug, id)} className="xref">
      <span className="font-mono text-xs">{id}</span>
      {title && <span className="ml-1">{title}</span>}
    </Link>
  );
}

function DocLinks({ slug, ids, titleOf }: { slug: string; ids: string[]; titleOf?: (id: string) => string }) {
  if (ids.length === 0) return <span className="text-base-content/40">—</span>;
  return (
    <span className="inline-flex flex-wrap gap-x-3 gap-y-1">
      {ids.map((id) => (
        <DocLink key={id} slug={slug} id={id} title={titleOf?.(id)} />
      ))}
    </span>
  );
}

/** Plain text with `backticked` spans shown as inline code. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
          <code key={i} className="text-[0.9em]">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

/**
 * The body minus what the page already renders structurally: the `# title`
 * and the acceptance-criteria / EARS sections. What remains is the authors'
 * free-form notes.
 */
function notesOf(body: string): string {
  const withoutTitle = body.replace(/^\s*#\s+.*\n?/, "");
  const sections = withoutTitle.split(/^(?=##\s)/m);
  return sections
    .filter((sec) => !/^##\s+(acceptance criteria|requirements)/i.test(sec))
    .join("")
    .trim();
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 py-1 text-sm">
      <div className="text-base-content/60">{label}</div>
      <div>{children}</div>
    </div>
  );
}

function List({ items, empty = "—" }: { items: string[]; empty?: string }) {
  if (items.length === 0) return <span className="text-base-content/40">{empty}</span>;
  return (
    <ul className="list-inside list-disc">
      {items.map((item, i) => (
        <li key={i}>
          <Inline text={item} />
        </li>
      ))}
    </ul>
  );
}

function Section({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section className="mb-6 scroll-mt-20" id={id}>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-base-content/60">{title}</h2>
      {children}
    </section>
  );
}

function Diagram({ code, title }: { code?: string; title: string }) {
  if (!code) return null;
  return (
    <div className="mb-4 rounded-box border border-base-300 bg-base-100 p-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-base-content/50">{title}</div>
      <MermaidBlock code={code} />
    </div>
  );
}

const GHERKIN_KEYWORD = /^(\s*)(Feature|Rule|Background|Scenario Outline|Scenario Template|Scenario|Example|Examples|Given|When|Then|And|But|\*)(:?)(.*)$/;

/** Gherkin with keywords and tags picked out. */
function GherkinText({ text }: { text: string }) {
  return (
    <pre className="overflow-x-auto rounded-box bg-base-200 p-3 text-sm leading-relaxed">
      <code>
        {text.split("\n").map((line, i) => {
          if (line.trim().startsWith("@")) {
            return (
              <div key={i} className="text-secondary">
                {line}
              </div>
            );
          }
          const m = GHERKIN_KEYWORD.exec(line);
          if (!m) return <div key={i}>{line}</div>;
          return (
            <div key={i}>
              {m[1]}
              <span className="font-semibold text-primary">
                {m[2]}
                {m[3]}
              </span>
              {m[4]}
            </div>
          );
        })}
      </code>
    </pre>
  );
}

function bindingHref(slug: string, b: Binding, files: DocModel["files"]): string | undefined {
  const t = b.target;
  if (!t) return undefined;
  if (t.kind === "dir") {
    const first = files.find((f) => f.path.startsWith(`${t.path}/`));
    return first ? fileHref(slug, first.path) : undefined;
  }
  if (t.kind === "file") return fileHref(slug, t.path);
  const isEndpoint = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s/i.test(t.name ?? "");
  return fileHref(slug, t.path, anchorForSymbol(isEndpoint ? "endpoint" : undefined, t.name ?? ""));
}

function BindingChips({ slug, bindings, files }: { slug: string; bindings: Binding[]; files: DocModel["files"] }) {
  if (bindings.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {bindings.map((b, i) => {
        const href = bindingHref(slug, b, files);
        const title =
          b.state === "broken"
            ? "No longer resolves — the doc has drifted from the code"
            : b.state === "changed"
              ? "The code changed since this doc was last edited/verified"
              : b.inferred
                ? "Bound automatically from a backticked mention"
                : "Bound";
        return (
          <span key={i} className="inline-flex items-center gap-1" title={title}>
            {href ? (
              <Link to={href} className="xref font-mono text-xs">
                {b.ref}
              </Link>
            ) : (
              <code className="text-xs">{b.ref}</code>
            )}
            {b.state !== "ok" && <span className={`badge badge-xs ${BINDING_BADGE[b.state]}`}>{b.state}</span>}
            {b.inferred && <span className="badge badge-ghost badge-xs">auto</span>}
          </span>
        );
      })}
    </div>
  );
}

function TestCites({ refs }: { refs: ProductDoc["tests"] }) {
  if (refs.length === 0) return <span className="badge badge-ghost badge-sm">untested</span>;
  return (
    <span className="badge badge-success badge-sm" title={refs.map((r) => `${r.path}:${r.line}`).join("\n")}>
      {refs.length} test{refs.length === 1 ? "" : "s"}
    </span>
  );
}

function testsFor(doc: ProductDoc, subId?: string): ProductDoc["tests"] {
  const want = normalizeRef(subId ? `${doc.id}.${subId}` : doc.id);
  return doc.tests.filter((t) => t.ref === want);
}

function ProductTabs({ slug, active }: { slug: string; active: "overview" | "map" | "trace" }) {
  const tabs = [
    ["overview", "Overview", productHref(slug)],
    ["map", "Story map", `/r/${slug}/product/map`],
    ["trace", "Traceability", `/r/${slug}/product/trace`],
  ] as const;
  return (
    <div role="tablist" className="tabs tabs-border mb-4">
      {tabs.map(([key, label, href]) => (
        <Link key={key} role="tab" to={href} className={`tab ${key === active ? "tab-active" : ""}`}>
          {label}
        </Link>
      ))}
    </div>
  );
}

function NoProduct({ manifest }: { manifest?: ProductManifest }) {
  return (
    <div className="alert alert-info">
      <span>
        {manifest
          ? "No product documentation yet."
          : "No product manifest published for this repo — rebuild it with a current server."}{" "}
        Scaffold <code>docs/product/</code> with <code>necronomidoc product init</code>, add documents with{" "}
        <code>necronomidoc product new session --title "…"</code>, or draft a set with{" "}
        <code>necronomidoc enrich &lt;repo&gt; --product</code>.
      </span>
    </div>
  );
}

function SourceNote({ manifest }: { manifest: ProductManifest }) {
  if (manifest.source !== "llm") return null;
  return (
    <div className="alert alert-warning mb-4">
      <span>
        LLM-drafted product docs (status <em>proposed</em>)
        {manifest.stale ? " — the code changed since they were drafted" : ""}. Review them, then promote with{" "}
        <code>necronomidoc product export {manifest.repo} --out docs/product</code> and commit.
      </span>
    </div>
  );
}

// ---- Overview ----

function Stat({ label, value, total, tone }: { label: string; value: number; total?: number; tone?: string }) {
  return (
    <div className="stat px-4 py-3">
      <div className="stat-title text-xs">{label}</div>
      <div className={`stat-value text-2xl ${tone ?? ""}`}>
        {value}
        {total !== undefined && <span className="text-base font-normal text-base-content/50"> / {total}</span>}
      </div>
    </div>
  );
}

function FindingsList({ manifest, slug, docId }: { manifest: ProductManifest; slug: string; docId?: string }) {
  const findings = docId ? manifest.findings.filter((f) => f.docId === docId) : manifest.findings;
  const [showAll, setShowAll] = useState(false);
  if (findings.length === 0) return null;
  const shown = showAll ? findings : findings.slice(0, 12);
  const icon = { error: "✗", warn: "⚠", info: "ℹ" } as const;
  const tone = { error: "text-error", warn: "text-warning", info: "text-info" } as const;
  return (
    <Section title={`Findings (${findings.length})`}>
      <ul className="space-y-1 text-sm">
        {shown.map((f, i) => (
          <li key={i} className="flex gap-2">
            <span className={tone[f.level]}>{icon[f.level]}</span>
            <span>
              {!docId && f.docId && (
                <>
                  <DocLink slug={slug} id={f.docId} />{" "}
                </>
              )}
              {f.message} <span className="text-xs text-base-content/40">[{f.code}]</span>
            </span>
          </li>
        ))}
      </ul>
      {findings.length > shown.length && (
        <button type="button" className="btn btn-ghost btn-xs mt-1" onClick={() => setShowAll(true)}>
          Show all {findings.length}
        </button>
      )}
    </Section>
  );
}

export function ProductView() {
  const { slug = "" } = useParams();
  const { product, loading, index } = useProduct(slug);
  if (loading) return <Loading />;
  if (!product || product.docs.length === 0) {
    return (
      <div>
        <h1 className="mb-4 text-2xl font-bold">Product</h1>
        <ProductTabs slug={slug} active="overview" />
        <NoProduct manifest={product} />
        {product && product.surfaces.length > 0 && <SurfacesTable slug={slug} manifest={product} />}
      </div>
    );
  }
  const c = product.coverage;
  const errors = product.findings.filter((f) => f.level === "error").length;
  const groups = (["session", "job", "persona", "journey", "epic", "story"] as const)
    .map((type) => [type, product.docs.filter((d) => d.type === type)] as const)
    .filter(([, docs]) => docs.length > 0);
  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">Product</h1>
      <p className="mb-4 text-base-content/60">
        Who uses this, the intents they arrive with, and how each intent plays out end to end.
      </p>
      <ProductTabs slug={slug} active="overview" />
      <SourceNote manifest={product} />
      {product.overview && (
        <div className="mb-6 rounded-box border border-base-300 bg-base-100 p-5">
          <MarkdownDoc content={product.overview} slug={slug} path="docs/product/README.md" />
        </div>
      )}
      <div className="stats stats-vertical mb-6 w-full border border-base-300 sm:stats-horizontal">
        <Stat label="Acceptance criteria tested" value={c.criteriaTested} total={c.criteria} />
        <Stat label="Session outcomes tested" value={c.outcomesTested} total={c.outcomes} />
        <Stat label="Surfaces in a session" value={c.surfacesCovered} total={c.surfaces} />
        <Stat
          label="Code bindings drifted"
          value={c.bindingsBroken + c.bindingsChanged}
          total={c.bindings}
          tone={c.bindingsBroken > 0 ? "text-error" : c.bindingsChanged > 0 ? "text-warning" : ""}
        />
        <Stat label="Errors" value={errors} tone={errors > 0 ? "text-error" : ""} />
      </div>
      {!c.testsScanned && (
        <p className="mb-4 text-xs text-base-content/50">
          Tests were not scanned for this build (pre-extracted IR) — coverage counts are unknown.
        </p>
      )}
      <Diagram code={product.diagram} title="Intent map — personas → jobs → sessions → stories" />
      {groups.map(([type, docs]) => (
        <Section key={type} title={TYPE_LABEL[type][1]}>
          <div className="grid gap-2 sm:grid-cols-2">
            {docs.map((doc) => (
              <Link
                key={doc.id}
                to={productHref(slug, doc.id)}
                className="card card-border bg-base-100 transition-shadow hover:shadow-md"
              >
                <div className="card-body gap-1 p-4">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-xs text-base-content/60">{doc.id}</span>
                    <span className={`badge badge-xs ${STATUS_BADGE[doc.status] ?? "badge-ghost"}`}>{doc.status}</span>
                    {doc.stale && <span className="badge badge-xs badge-warning">drift</span>}
                  </div>
                  <div className="font-medium">{doc.title}</div>
                  <div className="line-clamp-2 text-sm text-base-content/70">{statementOf(doc, index.titleOf)}</div>
                </div>
              </Link>
            ))}
          </div>
        </Section>
      ))}
      <FindingsList manifest={product} slug={slug} />
      <SurfacesTable slug={slug} manifest={product} />
    </div>
  );
}

function SurfacesTable({ slug, manifest }: { slug: string; manifest: ProductManifest }) {
  if (manifest.surfaces.length === 0) return null;
  const sorted = [...manifest.surfaces].sort((a, b) => a.coveredBy.length - b.coveredBy.length);
  return (
    <Section title="Interaction surfaces">
      <p className="mb-2 text-sm text-base-content/60">
        API operations and screens found in the code. A surface no session touches is an intent the docs
        don't describe yet.
      </p>
      <div className="overflow-x-auto">
        <table className="table table-sm">
          <thead>
            <tr>
              <th>Surface</th>
              <th>Kind</th>
              <th>Sessions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => (
              <tr key={s.id}>
                <td className="font-mono text-xs">
                  <Link
                    to={fileHref(slug, s.path, anchorForSymbol(s.kind === "api" ? "endpoint" : undefined, s.name))}
                    className="xref"
                  >
                    {s.name}
                  </Link>
                </td>
                <td>
                  <span className="badge badge-ghost badge-sm">{s.kind}</span>
                </td>
                <td>
                  {s.coveredBy.length > 0 ? (
                    <DocLinks slug={slug} ids={s.coveredBy} />
                  ) : (
                    <span className="badge badge-warning badge-sm badge-outline">uncovered</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

// ---- Story map ----

export function StoryMapView() {
  const { slug = "" } = useParams();
  const { product, loading } = useProduct(slug);
  if (loading) return <Loading />;
  const stories = (product?.docs ?? []).filter((d): d is DocOf<"story"> => d.type === "story");
  if (!product || stories.length === 0) {
    return (
      <div>
        <h1 className="mb-4 text-2xl font-bold">Story map</h1>
        <ProductTabs slug={slug} active="map" />
        {product ? (
          <div className="alert alert-info">
            <span>No stories yet. Give stories an <code>activity</code>, <code>step</code> and <code>release</code> to place them on the map.</span>
          </div>
        ) : (
          <NoProduct />
        )}
      </div>
    );
  }
  // Backbone: activities (columns) → steps (sub-columns), in first-seen order;
  // rows are release slices.
  const activities: { name: string; steps: string[] }[] = [];
  for (const s of stories) {
    const activity = s.activity ?? "Unmapped";
    const step = s.step ?? "—";
    let a = activities.find((x) => x.name === activity);
    if (!a) activities.push((a = { name: activity, steps: [] }));
    if (!a.steps.includes(step)) a.steps.push(step);
  }
  const releases = [...new Set(stories.map((s) => s.release ?? "Unscheduled"))];
  const columns = activities.flatMap((a) => a.steps.map((step) => ({ activity: a.name, step })));
  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">Story map</h1>
      <p className="mb-4 text-base-content/60">Activities across the top, the steps within them, release slices down the side.</p>
      <ProductTabs slug={slug} active="map" />
      <div className="overflow-x-auto">
        <table className="table table-sm border-separate border-spacing-1">
          <thead>
            <tr>
              <th />
              {activities.map((a) => (
                <th key={a.name} colSpan={a.steps.length} className="rounded bg-warning/20 text-center">
                  {a.name}
                </th>
              ))}
            </tr>
            <tr>
              <th />
              {columns.map((c) => (
                <th key={`${c.activity}/${c.step}`} className="rounded bg-base-200 text-center font-normal">
                  {c.step}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {releases.map((release) => (
              <tr key={release}>
                <th className="whitespace-nowrap align-top text-xs uppercase text-base-content/60">{release}</th>
                {columns.map((c) => (
                  <td key={`${c.activity}/${c.step}`} className="min-w-40 align-top">
                    {stories
                      .filter(
                        (s) =>
                          (s.activity ?? "Unmapped") === c.activity &&
                          (s.step ?? "—") === c.step &&
                          (s.release ?? "Unscheduled") === release,
                      )
                      .map((s) => (
                        <Link
                          key={s.id}
                          to={productHref(slug, s.id)}
                          className="mb-1 block rounded border border-base-300 bg-base-100 p-2 text-xs hover:shadow"
                        >
                          <div className="flex items-center gap-1">
                            <span className="font-mono text-base-content/50">{s.id}</span>
                            {s.priority && <span className="badge badge-ghost badge-xs">{s.priority}</span>}
                          </div>
                          <div>{s.title}</div>
                        </Link>
                      ))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Traceability ----

export function TraceabilityView() {
  const { slug = "" } = useParams();
  const { product, loading, index } = useProduct(slug);
  if (loading) return <Loading />;
  if (!product || product.docs.length === 0) {
    return (
      <div>
        <h1 className="mb-4 text-2xl font-bold">Traceability</h1>
        <ProductTabs slug={slug} active="trace" />
        <NoProduct manifest={product} />
      </div>
    );
  }
  const jobs = product.docs.filter((d): d is DocOf<"job"> => d.type === "job");
  const sessions = product.docs.filter((d): d is DocOf<"session"> => d.type === "session");
  const stories = product.docs.filter((d): d is DocOf<"story"> => d.type === "story");
  const orphanSessions = sessions.filter((s) => !jobs.some((j) => normalizeRef(j.id) === normalizeRef(s.job)));
  const drift = (doc: ProductDoc) => {
    const broken = doc.bindings.filter((b) => b.state === "broken").length;
    const changed = doc.bindings.filter((b) => b.state === "changed").length;
    return (
      <span className="flex flex-wrap gap-1">
        <span className="badge badge-ghost badge-sm">{doc.bindings.length} bound</span>
        {broken > 0 && <span className="badge badge-error badge-sm">{broken} broken</span>}
        {changed > 0 && <span className="badge badge-warning badge-sm">{changed} changed</span>}
      </span>
    );
  };
  const rowsFor = (sessionList: DocOf<"session">[]) =>
    sessionList.map((s) => (
      <tr key={s.id}>
        <td className="align-top">
          <DocLink slug={slug} id={s.id} title={s.title} />
        </td>
        <td className="align-top">
          <ul className="space-y-1">
            {s.outcomes.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-1">
                <span className={`badge badge-xs ${OUTCOME_BADGE[o.kind] ?? "badge-ghost"}`}>{o.kind}</span>
                <span className="font-mono text-xs">{o.id}</span>
                <TestCites refs={testsFor(s, o.id)} />
              </li>
            ))}
          </ul>
        </td>
        <td className="align-top">
          <DocLinks slug={slug} ids={s.stories} titleOf={index.titleOf} />
        </td>
        <td className="align-top">{drift(s)}</td>
      </tr>
    ));
  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">Traceability</h1>
      <p className="mb-4 text-base-content/60">
        Intent → session → outcome → test, and story → acceptance criterion → test, with the code each is bound to.
        Tests trace by citing ids (<code>SES-001.OUT-1</code>, <code>STORY-001.AC-2</code>) in their names or tags.
      </p>
      <ProductTabs slug={slug} active="trace" />
      <Section title="Intents → sessions → outcomes">
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Session</th>
                <th>Outcomes · tests</th>
                <th>Stories</th>
                <th>Code</th>
              </tr>
            </thead>
            {jobs.map((job) => (
              <tbody key={job.id}>
                <tr className="bg-base-200">
                  <td colSpan={4}>
                    <DocLink slug={slug} id={job.id} title={job.title} />
                  </td>
                </tr>
                {rowsFor(sessions.filter((s) => normalizeRef(s.job) === normalizeRef(job.id)))}
              </tbody>
            ))}
            {orphanSessions.length > 0 && <tbody>{rowsFor(orphanSessions)}</tbody>}
          </table>
        </div>
      </Section>
      <Section title="Stories → acceptance criteria">
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Story</th>
                <th>Criteria · tests</th>
                <th>Jobs</th>
                <th>Code</th>
              </tr>
            </thead>
            <tbody>
              {stories.map((s) => (
                <tr key={s.id}>
                  <td className="align-top">
                    <DocLink slug={slug} id={s.id} title={s.title} />
                  </td>
                  <td className="align-top">
                    <ul className="space-y-1">
                      {[...s.acceptance, ...s.requirements].map((c) => (
                        <li key={c.id} className="flex flex-wrap items-center gap-1">
                          <span className="font-mono text-xs">{c.id}</span>
                          <TestCites refs={testsFor(s, c.id)} />
                        </li>
                      ))}
                      {s.acceptance.length + s.requirements.length === 0 && (
                        <li className="text-base-content/40">no criteria</li>
                      )}
                    </ul>
                  </td>
                  <td className="align-top">
                    <DocLinks slug={slug} ids={s.jobs} titleOf={index.titleOf} />
                  </td>
                  <td className="align-top">{drift(s)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

// ---- One document ----

function Backlinks({ slug, doc, titleOf }: { slug: string; doc: ProductDoc; titleOf: (id: string) => string }) {
  if (doc.referencedBy.length === 0) return null;
  return (
    <Section title="Referenced by">
      <ul className="space-y-1 text-sm">
        {doc.referencedBy.map((l, i) => (
          <li key={i}>
            ← <DocLink slug={slug} id={l.id} title={titleOf(l.id)} />{" "}
            <span className="text-xs text-base-content/50">via {l.rel}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function SessionBody({ slug, doc, files, titleOf }: { slug: string; doc: DocOf<"session">; files: DocModel["files"]; titleOf: (id: string) => string }) {
  const [diagram, setDiagram] = useState<"flow" | "sequence" | "journey">("flow");
  const journeyRef = doc.journey ? (typeof doc.journey === "string" ? { id: doc.journey } : doc.journey) : undefined;
  return (
    <>
      <div className="mb-6 rounded-box border border-info/40 bg-info/5 p-5">
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-info">Intent on arrival</div>
        <p className="mb-3 text-lg italic">“{doc.intent}”</p>
        <Field label="Who">
          <DocLink slug={slug} id={doc.persona} title={titleOf(doc.persona)} />
        </Field>
        <Field label="Job to be done">
          <DocLink slug={slug} id={doc.job} title={titleOf(doc.job)} />
        </Field>
        {doc.trigger && <Field label="Trigger">{doc.trigger}</Field>}
        {(doc.entry.channel || doc.entry.auth) && (
          <Field label="Entry">{[doc.entry.channel, doc.entry.auth].filter(Boolean).join(" · ")}</Field>
        )}
        {doc.entry.preconditions.length > 0 && (
          <Field label="Preconditions">
            <List items={doc.entry.preconditions} />
          </Field>
        )}
        {journeyRef && (
          <Field label="Journey">
            <DocLink slug={slug} id={journeyRef.id} title={titleOf(journeyRef.id)} />
            {"stage" in journeyRef && journeyRef.stage && <span className="text-base-content/60"> · stage {journeyRef.stage}</span>}
          </Field>
        )}
      </div>

      <div role="tablist" className="tabs tabs-box tabs-sm mb-2 w-fit">
        {(
          [
            ["flow", "Flow"],
            ["sequence", "Sequence"],
            ["journey", "Emotion"],
          ] as const
        )
          .filter(([key]) => doc.diagrams[key])
          .map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              className={`tab ${diagram === key ? "tab-active" : ""}`}
              onClick={() => setDiagram(key)}
            >
              {label}
            </button>
          ))}
      </div>
      <Diagram code={doc.diagrams[diagram]} title={{ flow: "Steps, branches and outcomes", sequence: "User ↔ product ↔ system", journey: "How it feels" }[diagram]} />

      <Section title={`Steps (${doc.steps.length})`}>
        <ol className="space-y-2">
          {doc.steps.map((step) => {
            const bindings = doc.bindings.filter((b) => b.step === step.id);
            return (
              <li key={step.id} id={step.id} className="scroll-mt-20 rounded-box border border-base-300 bg-base-100 p-4">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <span className="badge badge-neutral badge-sm font-mono">{step.id}</span>
                  {step.actor !== "user" && <span className="badge badge-ghost badge-sm">{step.actor}</span>}
                  <span className="font-medium">
                    <Inline text={step.action} />
                  </span>
                  {step.emotion !== undefined && (
                    <span className="text-xs text-base-content/50" title="emotion 1–5">
                      {"●".repeat(step.emotion)}
                      {"○".repeat(5 - step.emotion)}
                    </span>
                  )}
                </div>
                {step.surface && <Field label="Surface"><Inline text={step.surface} /></Field>}
                {step.system && <Field label="System"><Inline text={step.system} /></Field>}
                {step.expects && <Field label="User sees"><Inline text={step.expects} /></Field>}
                {bindings.length > 0 && (
                  <Field label="Code">
                    <BindingChips slug={slug} bindings={bindings} files={files} />
                  </Field>
                )}
                {(step.branches.length > 0 || step.outcome || step.next) && (
                  <Field label="Then">
                    <ul className="space-y-0.5">
                      {step.next && <li>→ {step.next}</li>}
                      {step.outcome && (
                        <li>
                          ends in <a href={`#${step.outcome}`} className="xref font-mono">{step.outcome}</a>
                        </li>
                      )}
                      {step.branches.map((b, i) => (
                        <li key={i}>
                          if <em>{b.when}</em> → <a href={`#${b.goto}`} className="xref font-mono">{b.goto}</a>
                        </li>
                      ))}
                    </ul>
                  </Field>
                )}
              </li>
            );
          })}
        </ol>
      </Section>

      <Section title="Outcomes">
        <div className="grid gap-2 sm:grid-cols-2">
          {doc.outcomes.map((o) => (
            <div key={o.id} id={o.id} className="scroll-mt-20 rounded-box border border-base-300 bg-base-100 p-4">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">{o.id}</span>
                <span className={`badge badge-sm ${OUTCOME_BADGE[o.kind] ?? "badge-ghost"}`}>{o.kind}</span>
                <TestCites refs={testsFor(doc, o.id)} />
              </div>
              <div className="mb-1 font-medium">{o.title}</div>
              <div className="text-sm text-base-content/80">
                <List items={o.criteria} empty="no criteria" />
              </div>
            </div>
          ))}
        </div>
      </Section>
      {doc.stories.length > 0 && (
        <Section title="Stories exercised">
          <DocLinks slug={slug} ids={doc.stories} titleOf={titleOf} />
        </Section>
      )}
      {doc.metrics.length > 0 && (
        <Section title="Metrics">
          <List items={doc.metrics} />
        </Section>
      )}
    </>
  );
}

function StoryBody({ slug, doc, files, titleOf }: { slug: string; doc: DocOf<"story">; files: DocModel["files"]; titleOf: (id: string) => string }) {
  return (
    <>
      <p className="mb-4 text-lg">
        As a <DocLink slug={slug} id={doc.persona} title={titleOf(doc.persona)} />, I want {doc.want}, so that {doc.soThat}.
      </p>
      <div className="mb-6">
        <Field label="Jobs">
          <DocLinks slug={slug} ids={doc.jobs} titleOf={titleOf} />
        </Field>
        {doc.epic && (
          <Field label="Epic">
            <DocLink slug={slug} id={doc.epic} title={titleOf(doc.epic)} />
          </Field>
        )}
        {(doc.activity || doc.step || doc.release) && (
          <Field label="Story map">
            <Link to={`/r/${slug}/product/map`} className="xref">
              {[doc.activity, doc.step, doc.release].filter(Boolean).join(" · ")}
            </Link>
          </Field>
        )}
        {doc.priority && <Field label="Priority">{doc.priority}</Field>}
        {doc.bindings.length > 0 && (
          <Field label="Code">
            <BindingChips slug={slug} bindings={doc.bindings} files={files} />
          </Field>
        )}
      </div>
      <Section title={`Acceptance criteria (${doc.acceptance.length})`}>
        {doc.acceptance.length === 0 && <p className="text-sm text-base-content/50">None yet — add tagged Gherkin scenarios to the story body.</p>}
        {doc.acceptance.map((ac) => (
          <div key={ac.id} id={ac.id} className="mb-3 scroll-mt-20">
            <div className="mb-1 flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono">{doc.id}.{ac.id}</span>
              <span className="font-medium">{ac.title}</span>
              <TestCites refs={testsFor(doc, ac.id)} />
            </div>
            <GherkinText text={ac.text} />
          </div>
        ))}
      </Section>
      {doc.requirements.length > 0 && (
        <Section title="Requirements (EARS)">
          <ul className="space-y-2 text-sm">
            {doc.requirements.map((r) => (
              <li key={r.id} id={r.id} className="flex flex-wrap items-start gap-2">
                <span className="font-mono">{r.id}</span>
                <span className={`badge badge-sm ${r.pattern === "unrecognized" ? "badge-warning" : "badge-ghost"}`}>{r.pattern}</span>
                <TestCites refs={testsFor(doc, r.id)} />
                <span className="basis-full">{r.text}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

function JourneyBody({ slug, doc, titleOf }: { slug: string; doc: DocOf<"journey">; titleOf: (id: string) => string }) {
  const rows: [string, (s: DocOf<"journey">["stages"][number]) => ReactNode][] = [
    ["Goal", (s) => s.goal ?? ""],
    ["Actions", (s) => <List items={s.actions} />],
    ["Touchpoints", (s) => <List items={s.touchpoints} />],
    ["Thinking", (s) => <List items={s.thoughts} />],
    ["Emotion", (s) => (s.emotion !== undefined ? `${"●".repeat(s.emotion)}${"○".repeat(5 - s.emotion)}` : "—")],
    ["Pain points", (s) => <List items={s.painPoints} />],
    ["Opportunities", (s) => <List items={s.opportunities} />],
    ["Sessions", (s) => <DocLinks slug={slug} ids={s.sessions} titleOf={titleOf} />],
    ["Stories", (s) => <DocLinks slug={slug} ids={s.stories} titleOf={titleOf} />],
  ];
  return (
    <>
      <div className="mb-4">
        <Field label="Who">
          <DocLink slug={slug} id={doc.persona} title={titleOf(doc.persona)} />
        </Field>
        <Field label="Jobs">
          <DocLinks slug={slug} ids={doc.jobs} titleOf={titleOf} />
        </Field>
      </div>
      <Diagram code={doc.diagrams.journey} title="Journey" />
      <div className="mb-6 overflow-x-auto">
        <table className="table table-sm">
          <thead>
            <tr>
              <th />
              {doc.stages.map((s) => (
                <th key={s.name} className="min-w-40">
                  {s.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, render]) => (
              <tr key={label}>
                <th className="whitespace-nowrap align-top text-xs font-normal text-base-content/60">{label}</th>
                {doc.stages.map((s) => (
                  <td key={s.name} className="align-top text-sm">
                    {render(s)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function ProductDocView() {
  const { slug = "", id = "" } = useParams();
  const { product, model, loading, index } = useProduct(slug);
  if (loading) return <Loading />;
  const doc = index.get(id);
  if (!product || !doc) {
    return (
      <div className="alert alert-warning">
        <span>
          No product document <code>{id}</code>. <Link to={productHref(slug)} className="link">Back to the product overview</Link>.
        </span>
      </div>
    );
  }
  const files = model?.files ?? [];
  const inModel = files.some((f) => f.path === doc.path);
  return (
    <div>
      <ScrollToAnchor />
      <div className="breadcrumbs mb-1 text-sm">
        <ul>
          <li>
            <Link to={productHref(slug)}>Product</Link>
          </li>
          <li className="text-base-content/60">{TYPE_LABEL[doc.type][1]}</li>
        </ul>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className={`badge ${TYPE_BADGE[doc.type]}`}>{TYPE_LABEL[doc.type][0]}</span>
        <span className="font-mono text-sm text-base-content/60">{doc.id}</span>
        <span className={`badge badge-sm ${STATUS_BADGE[doc.status] ?? "badge-ghost"}`}>{doc.status}</span>
        <ProvenanceBadge provenance={doc.provenance} stale={doc.stale} />
        {doc.tags.map((t) => (
          <span key={t} className="badge badge-ghost badge-sm">
            #{t}
          </span>
        ))}
      </div>
      <h1 className="mb-1 text-2xl font-bold">{doc.title}</h1>
      <p className="mb-5 text-xs text-base-content/50">
        {inModel ? (
          <Link to={fileHref(slug, doc.path)} className="link-hover link font-mono">
            {doc.path}
          </Link>
        ) : (
          <span className="font-mono">{doc.path}</span>
        )}
        {doc.owner && <> · owner {doc.owner}</>}
        {doc.verified && <> · verified {doc.verified}</>}
      </p>
      {doc.provenance === "llm" && <SourceNote manifest={product} />}

      {doc.type === "session" && <SessionBody slug={slug} doc={doc} files={files} titleOf={index.titleOf} />}
      {doc.type === "story" && <StoryBody slug={slug} doc={doc} files={files} titleOf={index.titleOf} />}
      {doc.type === "journey" && <JourneyBody slug={slug} doc={doc} titleOf={index.titleOf} />}
      {doc.type === "job" && (
        <>
          <p className="mb-4 text-lg">{statementOf(doc, index.titleOf)}</p>
          <Field label="Held by">
            <DocLinks slug={slug} ids={doc.personas} titleOf={index.titleOf} />
          </Field>
          {doc.importance && <Field label="Importance">{doc.importance}</Field>}
          <Field label="Success metrics">
            <List items={doc.successMetrics} />
          </Field>
          <div className="mb-6" />
        </>
      )}
      {doc.type === "epic" && (
        <>
          <p className="mb-4">{doc.summary}</p>
          <Field label="Jobs">
            <DocLinks slug={slug} ids={doc.jobs} titleOf={index.titleOf} />
          </Field>
          <div className="mb-6" />
        </>
      )}
      {doc.type === "persona" && (
        <div className="mb-6">
          <p className="mb-3 text-lg">{doc.summary}</p>
          {doc.role && <Field label="Role">{doc.role}</Field>}
          {doc.expertise && <Field label="Expertise">{doc.expertise}</Field>}
          {doc.context && <Field label="Context">{doc.context}</Field>}
          <Field label="Goals">
            <List items={doc.goals} />
          </Field>
          <Field label="Frustrations">
            <List items={doc.frustrations} />
          </Field>
          <Field label="Permissions">
            <List items={doc.permissions} />
          </Field>
        </div>
      )}

      <FindingsList manifest={product} slug={slug} docId={doc.id} />
      <Backlinks slug={slug} doc={doc} titleOf={index.titleOf} />
      {doc.tests.length > 0 && (
        <Section title="Tests citing this document">
          <ul className="space-y-0.5 font-mono text-xs">
            {doc.tests.map((t, i) => (
              <li key={i}>
                {t.ref} —{" "}
                {files.some((f) => f.path === t.path) ? (
                  <Link to={fileHref(slug, t.path)} className="xref">
                    {t.path}:{t.line}
                  </Link>
                ) : (
                  `${t.path}:${t.line}`
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {notesOf(doc.body) && (
        <Section title="Notes">
          <div className="rounded-box border border-base-300 bg-base-100 p-5">
            <MarkdownDoc content={notesOf(doc.body)} slug={slug} path={doc.path} files={files} />
          </div>
        </Section>
      )}
    </div>
  );
}

/**
 * File-page chips: the product docs whose code bindings point at this file —
 * the both-way link from code back to the user intents it serves.
 */
export function FileIntents({ slug, path }: { slug: string; path: string }) {
  const { data: product } = useAsync<ProductManifest | undefined>(() => fetchProduct(slug), [slug]);
  const productDoc = product?.docs.find((d) => d.path === path);
  const hits = (product?.docs ?? []).filter((d) =>
    d.bindings.some((b) => {
      const t = b.target;
      if (!t) return false;
      return t.kind === "dir" ? path.startsWith(`${t.path}/`) : t.path === path;
    }),
  );
  if (!productDoc && hits.length === 0) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5 text-sm">
      {productDoc && (
        <Link to={productHref(slug, productDoc.id)} className="badge badge-info gap-1">
          structured view: {productDoc.id}
        </Link>
      )}
      {hits.length > 0 && <span className="text-base-content/50">serves intents:</span>}
      {hits.map((d) => (
        <Link key={d.id} to={productHref(slug, d.id)} className={`badge gap-1 ${TYPE_BADGE[d.type]}`} title={d.title}>
          {d.id}
        </Link>
      ))}
    </div>
  );
}
