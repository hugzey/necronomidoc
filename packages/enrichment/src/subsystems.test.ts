import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DocModel } from "@necronomidoc/docmodel";
import {
  buildSubsystems,
  generateSubsystemDiagram,
  heuristicSubsystems,
  LLM_SUBSYSTEMS_FILE,
  resolveModule,
  subsystemsFromResponse,
} from "./subsystems.js";

function model(): DocModel {
  return {
    schemaVersion: 1,
    repo: { name: "demo", slug: "demo" },
    files: [
      {
        id: "demo:src/auth/index.ts",
        path: "src/auth/index.ts",
        contentHash: "h1",
        format: "source",
        imports: [],
        exports: [],
        symbols: [],
      },
      {
        id: "demo:src/api.ts",
        path: "src/api.ts",
        contentHash: "h2",
        format: "source",
        imports: [],
        exports: [],
        symbols: [],
      },
      {
        id: "demo:README.md",
        path: "README.md",
        contentHash: "h3",
        format: "markdown",
        imports: [],
        exports: [],
        symbols: [],
      },
    ],
  };
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "necro-subsys-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("subsystems", () => {
  it("falls back to a heuristic map from top-level directories", () => {
    const subs = heuristicSubsystems(model());
    expect(subs.map((s) => s.name)).toEqual(["(root)", "src"]);
    const src = subs.find((s) => s.name === "src")!;
    expect(src.provenance).toBe("heuristic");
    expect(src.entryPoints).toEqual(["src/auth/index.ts"]);
    expect(src.dirs).toEqual(["src"]);
  });

  it("prefers a human subsystems.yaml over everything else", () => {
    const humanDir = tempDir();
    writeFileSync(
      join(humanDir, "subsystems.yaml"),
      [
        "subsystems:",
        "  - id: auth",
        "    name: Auth",
        "    purpose: Owns login, sessions and tokens.",
        "    owns: [session issuance]",
        "    notOwns: [user profile data]",
        "    entryPoints: [src/auth/index.ts]",
        "    dirs: [src/auth]",
      ].join("\n"),
    );
    const llmDir = tempDir();
    writeFileSync(
      join(llmDir, LLM_SUBSYSTEMS_FILE),
      JSON.stringify([{ id: "guessed", name: "Guessed", purpose: "LLM guess.", dirs: ["src"] }]),
    );
    const manifest = buildSubsystems(model(), { humanDirs: [humanDir], llmDir });
    expect(manifest.subsystems).toHaveLength(1);
    expect(manifest.subsystems[0]!.id).toBe("auth");
    expect(manifest.subsystems[0]!.provenance).toBe("human");
    expect(manifest.subsystems[0]!.notOwns).toEqual(["user profile data"]);
  });

  it("uses LLM proposals when no human map exists", () => {
    const llmDir = tempDir();
    writeFileSync(
      join(llmDir, LLM_SUBSYSTEMS_FILE),
      JSON.stringify([{ id: "guessed", name: "Guessed", purpose: "LLM guess.", dirs: ["src"] }]),
    );
    const manifest = buildSubsystems(model(), { humanDirs: [tempDir()], llmDir });
    expect(manifest.subsystems[0]!.id).toBe("guessed");
    expect(manifest.subsystems[0]!.provenance).toBe("llm");
  });

  it("later human dirs override earlier ones (server-side curation wins)", () => {
    const repoDir = tempDir();
    const serverDir = tempDir();
    writeFileSync(
      join(repoDir, "subsystems.yaml"),
      "subsystems:\n  - {id: a, name: A, purpose: From repo.}",
    );
    writeFileSync(
      join(serverDir, "subsystems.yaml"),
      "subsystems:\n  - {id: b, name: B, purpose: From server.}",
    );
    const manifest = buildSubsystems(model(), { humanDirs: [repoDir, serverDir] });
    expect(manifest.subsystems.map((s) => s.id)).toEqual(["b"]);
  });

  it("ignores invalid entries but keeps valid ones", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "subsystems.yaml"),
      "subsystems:\n  - {id: ok, name: OK, purpose: Fine.}\n  - {name: 42}",
    );
    const manifest = buildSubsystems(model(), { humanDirs: [dir] });
    expect(manifest.subsystems.map((s) => s.id)).toEqual(["ok"]);
  });

  it("ignores missing dirs entirely", () => {
    mkdirSync(join(tempDir(), "nope"), { recursive: true });
    const manifest = buildSubsystems(model(), { humanDirs: [join(tmpdir(), "does-not-exist-xyz")] });
    expect(manifest.subsystems.length).toBeGreaterThan(0); // heuristic floor
    expect(manifest.subsystems[0]!.provenance).toBe("heuristic");
  });

  it("infers cross-group edges and entry points from the import graph", () => {
    // ui/App.tsx imports state/useCounter.ts → an edge ui→state, and
    // useCounter is the import-derived entry point of the state group.
    const m: DocModel = {
      schemaVersion: 1,
      repo: { name: "demo", slug: "demo" },
      files: [
        {
          id: "demo:ui/App.tsx",
          path: "ui/App.tsx",
          contentHash: "h1",
          format: "source",
          imports: [{ moduleSpecifier: "../state/useCounter", names: ["useCounter"], isTypeOnly: false }],
          exports: [],
          symbols: [],
        },
        {
          id: "demo:ui/Button.tsx",
          path: "ui/Button.tsx",
          contentHash: "h2",
          format: "source",
          imports: [],
          exports: [],
          symbols: [],
        },
        {
          id: "demo:state/useCounter.ts",
          path: "state/useCounter.ts",
          contentHash: "h3",
          format: "source",
          imports: [],
          exports: [],
          symbols: [],
        },
      ],
    };
    const subs = heuristicSubsystems(m);
    const ui = subs.find((s) => s.id === "ui")!;
    const state = subs.find((s) => s.id === "state")!;
    expect(ui.related.map((r) => r.to)).toContain("state");
    expect(state.entryPoints).toEqual(["state/useCounter.ts"]);
    // The reverse edge does not exist — state never imports ui.
    expect(state.related).toHaveLength(0);
  });

  it("generates a Mermaid diagram from internal edges only", () => {
    const diagram = generateSubsystemDiagram([
      { id: "ui", name: "UI", purpose: "", owns: [], notOwns: [], entryPoints: [], dirs: [], provenance: "human", related: [{ to: "state", relation: "renders" }, { name: "External SaaS", relation: "calls" }] },
      { id: "state", name: "State", purpose: "", owns: [], notOwns: [], entryPoints: [], dirs: [], provenance: "human", related: [] },
    ]);
    expect(diagram).toContain("graph LR");
    expect(diagram).toContain('ui -->|"renders"| state');
    // The name-only external edge is not drawn (no node to point at).
    expect(diagram).not.toContain("External SaaS");
  });

  it("resolves module specifiers across language conventions", () => {
    const paths = new Set(["a/b.ts", "a/c/index.ts", "a/d.py"]);
    expect(resolveModule("a/x.ts", "./b", paths)).toBe("a/b.ts");
    expect(resolveModule("a/x.ts", "./c", paths)).toBe("a/c/index.ts");
    expect(resolveModule("a/x.py", "./d", paths)).toBe("a/d.py");
    expect(resolveModule("a/x.ts", "react", paths)).toBeUndefined();
  });

  it("carries the overview and diagram from a human file", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "subsystems.yaml"),
      [
        "overview: The app is a UI over hooks.",
        "diagram: |",
        "  graph TD",
        "    ui --> state",
        "subsystems:",
        "  - id: ui",
        "    name: UI",
        "    purpose: The shell.",
        "    related:",
        "      - to: state",
        "        relation: renders",
        "  - id: state",
        "    name: State",
        "    purpose: Hooks.",
      ].join("\n"),
    );
    const manifest = buildSubsystems(model(), { humanDirs: [dir] });
    expect(manifest.overview).toBe("The app is a UI over hooks.");
    expect(manifest.overviewProvenance).toBe("human");
    // A curated diagram wins over the generated one.
    expect(manifest.diagram).toContain("graph TD");
    expect(manifest.diagramProvenance).toBe("human");
  });

  it("does not let a container-root group double-claim per-package files", () => {
    // A loose file directly under `packages/` must not create a `packages`
    // subsystem whose `dirs: [packages]` overlaps every per-package subsystem.
    const m: DocModel = {
      schemaVersion: 1,
      repo: { name: "mono", slug: "mono" },
      files: ["packages/tsconfig.json", "packages/mcp/index.ts", "packages/docmodel/a.ts", "packages/site/b.ts"].map(
        (p) => ({ id: `mono:${p}`, path: p, contentHash: "h", format: "source" as const, imports: [], exports: [], symbols: [] }),
      ),
    };
    const subs = heuristicSubsystems(m);
    const root = subs.find((s) => s.id === "packages")!;
    // The container-root group owns only its loose file by exact path, so it
    // cannot prefix-match packages/mcp/**, packages/docmodel/**, etc.
    expect(root.dirs).toEqual(["packages/tsconfig.json"]);
    expect(subs.map((s) => s.id).sort()).toEqual(["docmodel", "mcp", "packages", "site"]);
  });

  it("keeps a human overview even when its subsystem entries are invalid", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "subsystems.yaml"),
      ["overview: The curated story.", "subsystems:", "  - {name: 42}"].join("\n"),
    );
    const manifest = buildSubsystems(model(), { humanDirs: [dir] });
    // The invalid entry drops to the heuristic map, but the narrative survives.
    expect(manifest.overview).toBe("The curated story.");
    expect(manifest.overviewProvenance).toBe("human");
    expect(manifest.subsystems[0]!.provenance).toBe("heuristic");
  });

  it("stamps a generated diagram as heuristic even over a human map", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "subsystems.yaml"),
      [
        "subsystems:",
        "  - {id: a, name: A, purpose: p, related: [{to: b, relation: uses}]}",
        "  - {id: b, name: B, purpose: p}",
      ].join("\n"),
    );
    const manifest = buildSubsystems(model(), { humanDirs: [dir] });
    expect(manifest.subsystems[0]!.provenance).toBe("human");
    // No `diagram:` override → the diagram is machine-drawn → heuristic.
    expect(manifest.diagram).toContain('a -->|"uses"| b');
    expect(manifest.diagramProvenance).toBe("heuristic");
  });

  it("strips the pipe character from generated diagram labels", () => {
    const diagram = generateSubsystemDiagram([
      { id: "a", name: "A", purpose: "", owns: [], notOwns: [], entryPoints: [], dirs: [], provenance: "human", related: [{ to: "b", relation: "reads | writes" }] },
      { id: "b", name: "B", purpose: "", owns: [], notOwns: [], entryPoints: [], dirs: [], provenance: "human", related: [] },
    ]);
    // The pipe inside the relation would otherwise terminate the edge label.
    expect(diagram).toContain('a -->|"reads writes"| b');
    expect(diagram).not.toContain("reads | writes");
  });

  it("resolves LLM relationship names to subsystem ids", () => {
    const source = subsystemsFromResponse(
      JSON.stringify({
        overview: "Two parts.",
        subsystems: [
          { name: "Web UI", purpose: "p", dirs: ["ui"], related: [{ to: "State Layer", relation: "renders" }] },
          { name: "State Layer", purpose: "p", dirs: ["state"], related: [] },
        ],
      }),
    );
    expect(source.overview).toBe("Two parts.");
    const ui = source.subsystems.find((s) => s.name === "Web UI")!;
    // "State Layer" (a name) is rewired to that subsystem's slug id.
    expect(ui.related[0]).toEqual({ to: "state-layer", relation: "renders" });
  });
});
