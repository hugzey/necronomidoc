import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkDocStandard, scaffoldDocs } from "./docstandard.js";

describe("doc standard scaffold + checks", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "necro-docstd-"));
  });

  afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

  it("scaffolds all four core-doc templates plus the README", () => {
    const result = scaffoldDocs(repoDir);
    expect(result.written).toEqual([
      "docs/overview.md",
      "docs/conventions.md",
      "docs/packages.md",
      "docs/architecture.md",
      "README.md",
    ]);
    const architecture = readFileSync(
      join(repoDir, ".necronomidoc", "docs", "architecture.md"),
      "utf8",
    );
    expect(architecture).toContain("```mermaid");
    expect(architecture).toContain("TODO(doc):");
  });

  it("never overwrites existing docs unless forced", () => {
    const docsDir = join(repoDir, ".necronomidoc", "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "overview.md"), "# Curated\n");

    const kept = scaffoldDocs(repoDir);
    expect(kept.skipped).toEqual(["docs/overview.md"]);
    expect(readFileSync(join(docsDir, "overview.md"), "utf8")).toBe("# Curated\n");

    const forced = scaffoldDocs(repoDir, { force: true });
    expect(forced.written).toContain("docs/overview.md");
    expect(readFileSync(join(docsDir, "overview.md"), "utf8")).not.toBe("# Curated\n");
  });

  it("reports uncurated repos as info, not warnings", () => {
    const findings = checkDocStandard(repoDir);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.level).toBe("info");
    expect(findings[0]!.message).toContain("init-docs");
  });

  it("warns on leftover TODO markers and a diagram-less architecture doc", () => {
    scaffoldDocs(repoDir);
    const docsDir = join(repoDir, ".necronomidoc", "docs");
    writeFileSync(join(docsDir, "architecture.md"), "# Architecture\n\nWords only.\n");

    const findings = checkDocStandard(repoDir);
    const warnings = findings.filter((f) => f.level === "warn").map((f) => f.message);
    // The other three docs still carry template TODO markers…
    expect(warnings.filter((m) => m.includes("TODO(doc)"))).toHaveLength(3);
    // …and the rewritten architecture doc lost its required diagram.
    expect(warnings.some((m) => m.includes("mermaid"))).toBe(true);
  });

  it("passes a fully curated repo", () => {
    scaffoldDocs(repoDir);
    const docsDir = join(repoDir, ".necronomidoc", "docs");
    for (const kind of ["overview", "conventions", "packages"]) {
      writeFileSync(join(docsDir, `${kind}.md`), `# ${kind}\n\nDone.\n`);
    }
    writeFileSync(
      join(docsDir, "architecture.md"),
      "# Architecture\n\n```mermaid\ngraph LR\n a --> b\n```\n",
    );
    const findings = checkDocStandard(repoDir);
    expect(findings).toEqual([{ level: "ok", message: "core docs curated and complete." }]);
  });
});
