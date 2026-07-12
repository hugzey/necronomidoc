import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DocModel } from "@necronomidoc/docmodel";
import { buildSubsystems, heuristicSubsystems, LLM_SUBSYSTEMS_FILE } from "./subsystems.js";

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
});
