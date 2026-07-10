import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import type { SourceRepo } from "./registry.js";

/** Normalized trigger event — the common currency of all providers (decision 0001). */
export interface TriggerEvent {
  repoId: string;
  /** Branch name (not the full refs/heads/... ref). */
  ref: string;
  commitSha?: string;
  provider: "github" | "ado" | "generic";
  receivedAt: string;
}

/**
 * Outcome of verifying + parsing an inbound notification.
 * - `accepted` → enqueue a build.
 * - `ignored` → authenticated but not actionable (ping, untracked branch...);
 *   respond 2xx so the sender doesn't retry or flag the hook.
 * - `rejected` → unauthenticated or malformed; log and return `status`.
 */
export type TriggerResult =
  | { kind: "accepted"; event: TriggerEvent }
  | { kind: "ignored"; reason: string }
  | { kind: "rejected"; reason: string; status: number };

/** Constant-time string comparison, safe for unequal lengths (hash first). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Normalize a repo URL for identity comparison: strip protocol, credentials,
 * trailing `.git` and slashes; lowercase. `git@host:org/repo` → `host/org/repo`.
 */
export function normalizeRepoUrl(url: string): string {
  let s = url.trim().toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
  const ssh = /^git@([^:]+):(.+)$/.exec(s);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  s = s.replace(/^[a-z+]+:\/\//, "");
  s = s.replace(/^[^@/]+@/, "");
  return s;
}

/** Does any of the payload's candidate URLs/names identify this registered repo? */
function matchesRepo(repo: SourceRepo, candidates: (string | undefined)[]): boolean {
  const target = normalizeRepoUrl(repo.url);
  for (const c of candidates) {
    if (!c) continue;
    const n = normalizeRepoUrl(c);
    // Exact URL match, or a bare `org/repo` full-name suffix match.
    if (n === target || (!c.includes("://") && !c.includes("@") && target.endsWith(`/${n}`))) {
      return true;
    }
  }
  return false;
}

function branchOfRef(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

const ZERO_SHA = /^0+$/;

export interface ProviderContext {
  /** Registered repos (all providers; each verifier filters to its own). */
  repos: SourceRepo[];
  /** Environment to resolve `secretEnv` names against (injectable for tests). */
  env: Record<string, string | undefined>;
  /** Shared fallback webhook secret (config `webhookSecret`); per-repo wins. */
  sharedSecret?: string;
  now: () => string;
}

function repoSecret(repo: SourceRepo, ctx: ProviderContext): string | undefined {
  const perRepo = repo.secretEnv ? ctx.env[repo.secretEnv] : undefined;
  return perRepo ?? ctx.sharedSecret ?? undefined;
}

/** Common tail shared by both webhook providers once the repo is identified. */
function acceptPush(
  repo: SourceRepo,
  provider: "github" | "ado",
  ref: string | undefined,
  sha: string | undefined,
  ctx: ProviderContext,
): TriggerResult {
  if (!repo.enabled) return { kind: "ignored", reason: `repo "${repo.id}" is disabled` };
  const branch = branchOfRef(ref);
  if (branch !== repo.branch) {
    return { kind: "ignored", reason: `ref "${ref}" is not the tracked branch "${repo.branch}"` };
  }
  if (sha && ZERO_SHA.test(sha)) {
    return { kind: "ignored", reason: "branch deleted" };
  }
  return {
    kind: "accepted",
    event: {
      repoId: repo.id,
      ref: branch,
      commitSha: sha,
      provider,
      receivedAt: ctx.now(),
    },
  };
}

/**
 * GitHub `push` webhook: identify the repo from the payload, then verify the
 * `X-Hub-Signature-256` HMAC over the *raw body* with that repo's secret
 * before trusting anything (constant-time compare, decision 0001).
 */
export function verifyGithub(
  opts: {
    body: string;
    /** `x-hub-signature-256` header, e.g. `sha256=<hex>`. */
    signature: string | undefined;
    /** `x-github-event` header. */
    event: string | undefined;
  },
  ctx: ProviderContext,
): TriggerResult {
  let payload: {
    ref?: string;
    after?: string;
    repository?: { clone_url?: string; ssh_url?: string; html_url?: string; full_name?: string };
  };
  try {
    payload = JSON.parse(opts.body) as typeof payload;
  } catch {
    return { kind: "rejected", reason: "malformed JSON payload", status: 400 };
  }

  const r = payload.repository;
  const repo = ctx.repos.find(
    (candidate) =>
      candidate.provider === "github" &&
      matchesRepo(candidate, [r?.clone_url, r?.ssh_url, r?.html_url, r?.full_name]),
  );
  if (!repo) return { kind: "rejected", reason: "payload matches no registered github repo", status: 404 };

  const secret = repoSecret(repo, ctx);
  if (!secret) {
    return { kind: "rejected", reason: `no webhook secret configured for "${repo.id}"`, status: 403 };
  }
  if (!opts.signature) {
    return { kind: "rejected", reason: "missing X-Hub-Signature-256 header", status: 401 };
  }
  const expected = `sha256=${createHmac("sha256", secret).update(opts.body).digest("hex")}`;
  if (!safeEqual(opts.signature, expected)) {
    return { kind: "rejected", reason: "signature mismatch", status: 401 };
  }

  // Authenticated from here on.
  if (opts.event === "ping") return { kind: "ignored", reason: "ping" };
  if (opts.event !== "push") return { kind: "ignored", reason: `event "${opts.event}" is not push` };
  return acceptPush(repo, "github", payload.ref, payload.after, ctx);
}

/**
 * Azure DevOps `git.push` service hook: authenticated by the basic-auth
 * credential configured on the hook URL (ADO's supported mechanism). The
 * configured secret may be `user:password` or just the password.
 */
export function verifyAdo(
  opts: {
    body: string;
    /** `authorization` header, e.g. `Basic <base64>`. */
    authorization: string | undefined;
  },
  ctx: ProviderContext,
): TriggerResult {
  let payload: {
    eventType?: string;
    resource?: {
      repository?: { remoteUrl?: string; webUrl?: string; name?: string };
      refUpdates?: { name?: string; newObjectId?: string }[];
    };
  };
  try {
    payload = JSON.parse(opts.body) as typeof payload;
  } catch {
    return { kind: "rejected", reason: "malformed JSON payload", status: 400 };
  }

  const r = payload.resource?.repository;
  const repo = ctx.repos.find(
    (candidate) =>
      candidate.provider === "ado" && matchesRepo(candidate, [r?.remoteUrl, r?.webUrl]),
  );
  if (!repo) return { kind: "rejected", reason: "payload matches no registered ado repo", status: 404 };

  const secret = repoSecret(repo, ctx);
  if (!secret) {
    return { kind: "rejected", reason: `no hook credential configured for "${repo.id}"`, status: 403 };
  }
  const basic = /^Basic\s+(.+)$/i.exec(opts.authorization ?? "");
  if (!basic) return { kind: "rejected", reason: "missing basic-auth credential", status: 401 };
  let decoded: string;
  try {
    decoded = Buffer.from(basic[1]!, "base64").toString("utf8");
  } catch {
    return { kind: "rejected", reason: "malformed basic-auth credential", status: 401 };
  }
  const password = decoded.includes(":") ? decoded.slice(decoded.indexOf(":") + 1) : decoded;
  if (!safeEqual(decoded, secret) && !safeEqual(password, secret)) {
    return { kind: "rejected", reason: "credential mismatch", status: 401 };
  }

  if (payload.eventType !== "git.push") {
    return { kind: "ignored", reason: `eventType "${payload.eventType}" is not git.push` };
  }
  const update = payload.resource?.refUpdates?.[0];
  return acceptPush(repo, "ado", update?.name, update?.newObjectId, ctx);
}

/**
 * Bearer-token check for the generic REST trigger: the global token may build
 * anything; a per-repo token (`apiTokenEnv`) is scoped to its own repo.
 */
export function authorizeRestTrigger(
  opts: { authorization: string | undefined; repo?: SourceRepo },
  ctx: ProviderContext & { globalToken?: string },
): boolean {
  const bearer = /^Bearer\s+(.+)$/i.exec(opts.authorization ?? "")?.[1];
  if (!bearer) return false;
  if (ctx.globalToken && safeEqual(bearer, ctx.globalToken)) return true;
  const scoped = opts.repo?.apiTokenEnv ? ctx.env[opts.repo.apiTokenEnv] : undefined;
  return scoped !== undefined && safeEqual(bearer, scoped);
}
