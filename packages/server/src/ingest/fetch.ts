import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { isLocalDir } from "../build.js";
import type { SourceRepo } from "./registry.js";

const execFileAsync = promisify(execFile);

export interface FetchResult {
  /** Checked-out working tree to run extraction against. */
  dir: string;
  commitSha?: string;
}

export function cloneDirFor(dataDir: string, repoId: string): string {
  return join(dataDir, "clones", repoId);
}

/**
 * Inject a credential into an https clone URL at exec time. `pat:` as the
 * username works for both GitHub PATs and Azure DevOps PATs. The authenticated
 * URL is never persisted — the registry and `.git/config` keep the clean URL.
 */
function withToken(url: string, token: string | undefined): string {
  if (!token || !/^https:\/\//i.test(url)) return url;
  return url.replace(/^https:\/\//i, `https://pat:${encodeURIComponent(token)}@`);
}

/** Replace any occurrence of the secret in a message before it can be logged. */
function scrub(message: string, token: string | undefined): string {
  if (!token) return message;
  return message.split(token).join("***").split(encodeURIComponent(token)).join("***");
}

/** Async git exec so long clones/fetches never block the server's event loop. */
async function git(args: string[], token: string | undefined, cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const detail = (e.stderr ?? e.message ?? "git failed").toString().trim();
    throw new Error(scrub(`git ${args[0]}: ${detail}`, token));
  }
}

async function revParse(dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    });
    return stdout.trim();
  } catch {
    return undefined; // not a git checkout — fine for local dirs
  }
}

/**
 * Materialize a source repo for building. Local directory URLs are built in
 * place; remote URLs get a persistent shallow clone under
 * `data/clones/<repoId>` — first build clones, later builds `fetch --depth 1`
 * + hard-reset (slice-2 work item 4). Credentials come from `tokenEnv` at
 * exec time only and are scrubbed from any error text.
 */
export async function fetchSource(
  repo: SourceRepo,
  dataDir: string,
  env: Record<string, string | undefined> = process.env,
): Promise<FetchResult> {
  if (isLocalDir(repo.url)) {
    const dir = resolve(repo.url);
    return { dir, commitSha: await revParse(dir) };
  }

  const token = repo.tokenEnv ? env[repo.tokenEnv] : undefined;
  const url = withToken(repo.url, token);
  const dir = cloneDirFor(dataDir, repo.id);

  if (!existsSync(join(dir, ".git"))) {
    rmSync(dir, { recursive: true, force: true });
    await git(
      ["clone", "--depth", "1", "--branch", repo.branch, "--single-branch", url, dir],
      token,
    );
  } else {
    // Fetch straight from the (possibly authenticated) URL so credentials
    // never touch .git/config, then hard-reset the tracked branch onto it.
    await git(["-C", dir, "fetch", "--depth", "1", url, repo.branch], token);
    await git(["-C", dir, "reset", "--hard", "FETCH_HEAD"], token);
    await git(["-C", dir, "clean", "-fdx"], token);
  }
  return { dir, commitSha: await revParse(dir) };
}

/** Disk cleanup when a repo is removed from the registry. */
export function removeClone(dataDir: string, repoId: string): void {
  rmSync(cloneDirFor(dataDir, repoId), { recursive: true, force: true });
}
