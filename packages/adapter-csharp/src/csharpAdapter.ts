import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import {
  SCHEMA_VERSION,
  slugify,
  ToolchainError,
  type AdapterConfig,
  type AdapterMatch,
  type DocAdapter,
  type DocFile,
  type DocModel,
  type ToolchainRequirements,
  type ToolchainStatus,
} from "@necronomidoc/docmodel";
import { mapManagedReference, type MrefDocument } from "./mrefMap.js";

const execFileAsync = promisify(execFile);

const TOOLCHAIN_FIX =
  "Install the .NET SDK 8+ and `dotnet tool install -g docfx` " +
  "(or point NECRONOMIDOC_DOCFX at a docfx executable), " +
  "or build the Docker image with --build-arg WITH_DOTNET=1. " +
  "Alternatively publish pre-extracted IR from your own CI via POST /api/ir.";

/** Directories never scanned for C# projects. */
const IGNORED_DIRS = new Set(["node_modules", ".git", "bin", "obj", "packages", "artifacts"]);

/** Find .sln/.csproj (and count .cs) to decide whether this repo is C#. */
export function findDotnetProjects(repoDir: string): { projects: string[]; csFiles: number } {
  const projects: string[] = [];
  let csFiles = 0;
  const stack = [repoDir];
  let budget = 5000;
  while (stack.length > 0 && budget > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (--budget <= 0) break;
      if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(".csproj")) projects.push(full);
      else if (entry.name.endsWith(".cs")) csFiles++;
    }
  }
  return { projects, csFiles };
}

interface DocfxRuntime {
  dotnetVersion: string;
  docfxExe: string;
  docfxVersion: string;
}

function docfxCandidates(): string[] {
  const explicit = process.env["NECRONOMIDOC_DOCFX"];
  if (explicit) return [explicit];
  return ["docfx", join(homedir(), ".dotnet", "tools", "docfx")];
}

async function findRuntime(): Promise<DocfxRuntime | { missing: string[] }> {
  const missing: string[] = [];
  let dotnetVersion: string | undefined;
  try {
    const { stdout } = await execFileAsync("dotnet", ["--version"]);
    dotnetVersion = stdout.trim();
  } catch {
    missing.push(".NET SDK (dotnet)");
  }
  for (const exe of docfxCandidates()) {
    try {
      const { stdout } = await execFileAsync(exe, ["--version"]);
      if (dotnetVersion) return { dotnetVersion, docfxExe: exe, docfxVersion: stdout.trim() };
    } catch {
      // try the next candidate
    }
  }
  missing.push("docfx (dotnet global tool)");
  return { missing };
}

/**
 * C#/.NET adapter (slice 5, decision 0013): extraction via `docfx metadata`,
 * which drives Roslyn over the repo's .csproj files and emits ManagedReference
 * YAML — run out of process against a generated docfx.json. Roslyn compiles
 * the code to analyze it; it never runs it (decision 0007 holds).
 */
export class CSharpAdapter implements DocAdapter {
  readonly language = "csharp";
  readonly requires: ToolchainRequirements = {
    tools: { dotnet: ">=8" },
    dotnetTools: ["docfx"],
  };

  async detect(repoDir: string): Promise<AdapterMatch | null> {
    const { projects, csFiles } = findDotnetProjects(repoDir);
    if (projects.length === 0) return null; // docfx needs a project to drive Roslyn
    return {
      language: this.language,
      reason: `found ${projects.length} .csproj (${csFiles} .cs files)`,
      globs: ["**/*.cs"],
    };
  }

  async checkToolchain(): Promise<ToolchainStatus> {
    const runtime = await findRuntime();
    if ("missing" in runtime) return { ok: false, missing: runtime.missing, fix: TOOLCHAIN_FIX };
    return {
      ok: true,
      details: `dotnet ${runtime.dotnetVersion}, docfx ${runtime.docfxVersion} (${runtime.docfxExe})`,
    };
  }

  async extract(repoDir: string, config: AdapterConfig): Promise<DocModel> {
    const runtime = await findRuntime();
    if ("missing" in runtime) {
      throw new ToolchainError(
        `.NET toolchain for the csharp adapter is not available on this host (missing: ${runtime.missing.join(", ")}).`,
        TOOLCHAIN_FIX,
      );
    }

    const repoName = config.repoName ?? slugify(repoDir);
    const repoSlug = slugify(repoName);
    const realRepoDir = realpathSync(resolve(repoDir));

    const workDir = mkdtempSync(join(tmpdir(), "necronomidoc-docfx-"));
    try {
      const apiDir = join(workDir, "api");
      writeFileSync(
        join(workDir, "docfx.json"),
        JSON.stringify(
          {
            metadata: [
              {
                src: [{ files: ["**/*.csproj"], src: realRepoDir }],
                dest: "api",
                // Private members too: the same per-file coverage guarantee
                // the ts-morph sweep gives TypeScript (they stay unexported).
                includePrivateMembers: true,
              },
            ],
          },
          null,
          2,
        ),
      );
      await execFileAsync(runtime.docfxExe, ["metadata", join(workDir, "docfx.json")], {
        timeout: 600_000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" },
      });

      const documents = readManagedReferenceDocs(apiDir);
      if (documents.length === 0) {
        throw new Error(
          "csharp adapter: docfx metadata produced no ManagedReference output " +
            "(does the repo build? are there public APIs?)",
        );
      }

      const files = mapManagedReference(documents, {
        repoSlug,
        resolveSourcePath: (docfxRelative) => toRepoRelative(realRepoDir, resolve(workDir, docfxRelative)),
        readSource: (relPath) => {
          try {
            return readFileSync(join(realRepoDir, relPath), "utf8");
          } catch {
            return null;
          }
        },
      });

      return {
        schemaVersion: SCHEMA_VERSION,
        repo: { name: repoName, slug: repoSlug, url: config.repoUrl, ref: config.ref, commit: config.commit },
        files,
        generatedAt: new Date().toISOString(),
      };
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

/** Parse every `### YamlMime:ManagedReference` file in the metadata output. */
export function readManagedReferenceDocs(apiDir: string): MrefDocument[] {
  if (!existsSync(apiDir)) return [];
  const documents: MrefDocument[] = [];
  for (const name of readdirSync(apiDir)) {
    if (!name.endsWith(".yml") || name === "toc.yml") continue;
    const text = readFileSync(join(apiDir, name), "utf8");
    if (!text.startsWith("### YamlMime:ManagedReference")) continue;
    documents.push(parseYaml(text) as MrefDocument);
  }
  return documents;
}

/** Absolute source path → repo-relative posix path (null if outside). */
function toRepoRelative(realRepoDir: string, absPath: string): string | null {
  let real: string;
  try {
    real = realpathSync(isAbsolute(absPath) ? absPath : resolve(absPath));
  } catch {
    return null;
  }
  const rel = relative(realRepoDir, real);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}
