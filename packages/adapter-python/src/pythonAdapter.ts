import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
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
import { mapGriffePackage, type GriffeObject } from "./griffeMap.js";

const execFileAsync = promisify(execFile);

/** griffe range we test against; the Dockerfile pins an exact version. */
export const GRIFFE_RANGE = "griffe>=1.0";

const TOOLCHAIN_FIX =
  `Install Python 3.9+ and \`pip install "${GRIFFE_RANGE}"\`, ` +
  "point NECRONOMIDOC_PYTHON at an interpreter that has griffe, " +
  "or build the Docker image with --build-arg WITH_PYTHON=1. " +
  "Alternatively publish pre-extracted IR from your own CI via POST /api/ir.";

/** Directories never scanned for Python packages/modules. */
const IGNORED_DIRS = new Set([
  "node_modules",
  "__pycache__",
  "venv",
  ".venv",
  "env",
  ".git",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".eggs",
  "build",
  "dist",
  "site-packages",
]);

/** Top-level single-file modules that are packaging/test plumbing, not docs. */
const IGNORED_MODULES = new Set(["setup", "conftest"]);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface PythonTargets {
  /** griffe search paths, in priority order (src-layout first). */
  searchPaths: string[];
  /** Importable names to dump: packages (dirs with __init__.py) + modules. */
  names: string[];
}

/** Find the packages and top-level modules griffe should load. */
export function discoverPythonTargets(repoDir: string): PythonTargets {
  const roots: string[] = [];
  const srcDir = join(repoDir, "src");
  if (isDir(srcDir)) roots.push(srcDir);
  roots.push(repoDir);

  const names: string[] = [];
  const searchPaths: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let used = false;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
      let name: string | undefined;
      if (entry.isDirectory() && existsSync(join(root, entry.name, "__init__.py"))) {
        name = entry.name;
      } else if (entry.isFile() && entry.name.endsWith(".py")) {
        const stem = entry.name.slice(0, -3);
        if (!IGNORED_MODULES.has(stem)) name = stem;
      }
      if (name && IDENTIFIER.test(name) && !seen.has(name)) {
        seen.add(name);
        names.push(name);
        used = true;
      }
    }
    if (used) searchPaths.push(root);
  }
  return { searchPaths, names };
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Count .py files (shallow bound) just to report a detection reason. */
function countPyFiles(dir: string, budget = 2000): number {
  let count = 0;
  const stack = [dir];
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
      if (entry.isDirectory()) stack.push(join(current, entry.name));
      else if (entry.name.endsWith(".py")) count++;
    }
  }
  return count;
}

interface PythonRuntime {
  exe: string;
  pythonVersion: string;
  griffeVersion: string;
}

async function probe(exe: string): Promise<PythonRuntime | null> {
  try {
    const { stdout } = await execFileAsync(exe, [
      "-c",
      "import platform, griffe, importlib.metadata as m; print(platform.python_version()); print(m.version('griffe'))",
    ]);
    const [pythonVersion = "unknown", griffeVersion = "unknown"] = stdout.trim().split("\n");
    return { exe, pythonVersion, griffeVersion };
  } catch {
    return null;
  }
}

/**
 * Interpreter candidates, most specific first. `NECRONOMIDOC_PYTHON` (or the
 * Docker image's `necronomidoc-python` shim) lets hosts isolate our griffe
 * install from system Python.
 */
function pythonCandidates(): string[] {
  const explicit = process.env["NECRONOMIDOC_PYTHON"];
  if (explicit) return [explicit];
  return ["necronomidoc-python", "python3", "python"];
}

async function findRuntime(): Promise<PythonRuntime | null> {
  for (const exe of pythonCandidates()) {
    const runtime = await probe(exe);
    if (runtime) return runtime;
  }
  return null;
}

/**
 * Python adapter (slice 5, decision 0013): static extraction via a pinned
 * `griffe dump --full`, run out of process — target-repo code is parsed,
 * never imported or executed (griffe static analysis; decision 0007 holds).
 */
export class PythonAdapter implements DocAdapter {
  readonly language = "python";
  readonly requires: ToolchainRequirements = {
    tools: { python: ">=3.9" },
    pip: [GRIFFE_RANGE],
  };

  async detect(repoDir: string): Promise<AdapterMatch | null> {
    const { names } = discoverPythonTargets(repoDir);
    if (names.length === 0) return null;
    const markers = ["pyproject.toml", "setup.py", "setup.cfg"].filter((m) =>
      existsSync(join(repoDir, m)),
    );
    const reason =
      markers.length > 0
        ? `found ${markers.join(", ")}`
        : `found ${countPyFiles(repoDir)} Python file(s)`;
    return { language: this.language, reason, globs: ["**/*.py"] };
  }

  async checkToolchain(): Promise<ToolchainStatus> {
    const runtime = await findRuntime();
    if (runtime) {
      return { ok: true, details: `Python ${runtime.pythonVersion}, griffe ${runtime.griffeVersion} (${runtime.exe})` };
    }
    const hasBarePython = (await Promise.all(pythonCandidates().map(canRunVersion))).some(Boolean);
    return {
      ok: false,
      missing: hasBarePython ? [`pip package "${GRIFFE_RANGE}"`] : ["python interpreter", `pip package "${GRIFFE_RANGE}"`],
      fix: TOOLCHAIN_FIX,
    };
  }

  async extract(repoDir: string, config: AdapterConfig): Promise<DocModel> {
    const runtime = await findRuntime();
    if (!runtime) {
      throw new ToolchainError("Python toolchain for the python adapter is not available on this host.", TOOLCHAIN_FIX);
    }

    const repoName = config.repoName ?? slugify(repoDir);
    const repoSlug = slugify(repoName);
    const realRepoDir = realpathSync(resolve(repoDir));
    const { searchPaths, names } = discoverPythonTargets(realRepoDir);

    const files: DocFile[] = [];
    const seenPaths = new Set<string>();
    const failures: string[] = [];
    for (const name of names) {
      let root: GriffeObject;
      try {
        root = await this.dumpPackage(runtime.exe, name, searchPaths);
      } catch (err) {
        failures.push(`${name}: ${(err as Error).message}`);
        continue; // one broken package must not take down the rest
      }
      const mapped = mapGriffePackage(root, {
        repoSlug,
        toRelPath: (filepath) => toRepoRelative(realRepoDir, filepath),
        readSource: (relPath) => {
          try {
            return readFileSync(join(realRepoDir, relPath), "utf8");
          } catch {
            return null;
          }
        },
      });
      for (const file of mapped) {
        if (!seenPaths.has(file.path)) {
          seenPaths.add(file.path);
          files.push(file);
        }
      }
    }
    if (files.length === 0 && failures.length > 0) {
      throw new Error(`python adapter: griffe failed for every target — ${failures.join("; ")}`);
    }
    files.sort((a, b) => a.path.localeCompare(b.path));

    return {
      schemaVersion: SCHEMA_VERSION,
      repo: { name: repoName, slug: repoSlug, url: config.repoUrl, ref: config.ref, commit: config.commit },
      files,
      generatedAt: new Date().toISOString(),
    };
  }

  private async dumpPackage(exe: string, name: string, searchPaths: string[]): Promise<GriffeObject> {
    const outDir = mkdtempSync(join(tmpdir(), "necronomidoc-griffe-"));
    const outFile = join(outDir, "dump.json");
    try {
      const args = ["-m", "griffe", "dump", name, "--full", "-d", "auto", "-L", "error", "-o", outFile];
      for (const path of searchPaths) args.push("-s", path);
      await execFileAsync(exe, args, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
      const dump = JSON.parse(readFileSync(outFile, "utf8")) as Record<string, GriffeObject>;
      const root = dump[name];
      if (!root) throw new Error(`griffe dump produced no entry for "${name}"`);
      return root;
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
}

async function canRunVersion(exe: string): Promise<boolean> {
  try {
    await execFileAsync(exe, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/** Absolute module filepath → repo-relative posix path (null if outside). */
function toRepoRelative(realRepoDir: string, filepath: string): string | null {
  let real: string;
  try {
    real = realpathSync(isAbsolute(filepath) ? filepath : resolve(filepath));
  } catch {
    return null;
  }
  const rel = relative(realRepoDir, real);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}
