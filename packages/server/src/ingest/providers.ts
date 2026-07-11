import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import type { SourceRepo } from "./registry.js";

/** Normalized trigger event — the common currency of all providers (decision 0001). */
export interface TriggerEvent {
  repoId: string;
  /** Branch name (not the full refs/heads/... ref). */
  ref: string;
  commitSha?: string;
  provider: string;
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
 * Azure DevOps URLs are canonicalized so the SSH form
 * (`git@ssh.dev.azure.com:v3/org/proj/repo`) and the service-hook remoteUrl
 * (`https://dev.azure.com/org/proj/_git/repo`) compare equal.
 */
export function normalizeRepoUrl(url: string): string {
  let s = url.trim().toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
  const ssh = /^git@([^:]+):(.+)$/.exec(s);
  if (ssh) s = `${ssh[1]}/${ssh[2]}`;
  else {
    s = s.replace(/^[a-z+]+:\/\//, "");
    s = s.replace(/^[^@/]+@/, "");
  }
  s = s.replace(/^ssh\.dev\.azure\.com\/v3\//, "dev.azure.com/");
  s = s.replace(/\/_git\//, "/");
  return s;
}

/**
 * How well a candidate identifies this repo: 2 = full URL match,
 * 1 = bare `org/repo` full-name suffix match, 0 = no match. Exact matches
 * outrank suffix matches when resolving ambiguity.
 */
function matchRank(repo: SourceRepo, candidates: (string | undefined)[]): number {
  const target = normalizeRepoUrl(repo.url);
  let rank = 0;
  for (const c of candidates) {
    if (!c) continue;
    const n = normalizeRepoUrl(c);
    if (n === target) return 2;
    if (!c.includes("://") && !c.includes("@") && target.endsWith(`/${n}`)) rank = Math.max(rank, 1);
  }
  return rank;
}

function branchOfRef(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

const ZERO_SHA = /^0+$/;

export interface ProviderContext {
  /** Registered repos (all providers; the driver filters to the firing one). */
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

// ---- Provider adapter interface (decision 0001) ----

export interface WebhookHeaders {
  get(name: string): string | undefined;
}

/**
 * A push extracted from a payload (one entry per updated ref — providers like
 * ADO batch several refs into one event), or the reason the event isn't one.
 */
export type ParsedEvent =
  | { kind: "push"; refs: { ref?: string; sha?: string }[] }
  | { kind: "ignored"; reason: string };

/** The payload's own claim of what it parsed to (verified before trusting). */
export interface ParsedWebhook {
  /** Candidate URLs / full names identifying the repo. */
  repoCandidates: (string | undefined)[];
  /** Authenticate the request against the matched repo's secret; null = ok. */
  authenticate(secret: string): string | null;
  /** Classify the (now authenticated) event. */
  event(): ParsedEvent;
}

/**
 * One trigger source. Adding a provider (GitLab, Bitbucket, Gitea...) means
 * writing one adapter and adding it to `providers` — the driver, routes, and
 * registry are provider-agnostic.
 */
export interface GitProviderAdapter {
  readonly id: string;
  /** Parse body+headers into normalized pieces; a string = malformed (400). */
  parse(body: string, headers: WebhookHeaders): ParsedWebhook | string;
}

const githubProvider: GitProviderAdapter = {
  id: "github",
  parse(body, headers) {
    let payload: {
      ref?: string;
      after?: string;
      repository?: { clone_url?: string; ssh_url?: string; html_url?: string; full_name?: string };
    };
    try {
      payload = JSON.parse(body) as typeof payload;
    } catch {
      return "malformed JSON payload";
    }
    const r = payload.repository;
    const event = headers.get("x-github-event");
    const signature = headers.get("x-hub-signature-256");
    return {
      repoCandidates: [r?.clone_url, r?.ssh_url, r?.html_url, r?.full_name],
      // Verify the X-Hub-Signature-256 HMAC over the *raw body* before
      // trusting anything (constant-time compare).
      authenticate(secret) {
        if (!signature) return "missing X-Hub-Signature-256 header";
        const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
        return safeEqual(signature, expected) ? null : "signature mismatch";
      },
      event() {
        if (event === "ping") return { kind: "ignored", reason: "ping" };
        if (event !== "push") return { kind: "ignored", reason: `event "${event}" is not push` };
        return { kind: "push", refs: [{ ref: payload.ref, sha: payload.after }] };
      },
    };
  },
};

const adoProvider: GitProviderAdapter = {
  id: "ado",
  parse(body, headers) {
    let payload: {
      eventType?: string;
      resource?: {
        repository?: { remoteUrl?: string; webUrl?: string; name?: string };
        refUpdates?: { name?: string; newObjectId?: string }[];
      };
    };
    try {
      payload = JSON.parse(body) as typeof payload;
    } catch {
      return "malformed JSON payload";
    }
    const r = payload.resource?.repository;
    const authorization = headers.get("authorization");
    return {
      repoCandidates: [r?.remoteUrl, r?.webUrl],
      // ADO service hooks authenticate via the basic-auth credential set on
      // the hook URL. The configured secret may be `user:password` or just
      // the password.
      authenticate(secret) {
        const basic = /^Basic\s+(.+)$/i.exec(authorization ?? "");
        if (!basic) return "missing basic-auth credential";
        let decoded: string;
        try {
          decoded = Buffer.from(basic[1]!, "base64").toString("utf8");
        } catch {
          return "malformed basic-auth credential";
        }
        const password = decoded.includes(":") ? decoded.slice(decoded.indexOf(":") + 1) : decoded;
        return safeEqual(decoded, secret) || safeEqual(password, secret) ? null : "credential mismatch";
      },
      event() {
        if (payload.eventType !== "git.push") {
          return { kind: "ignored", reason: `eventType "${payload.eventType}" is not git.push` };
        }
        // A push may update several refs; report all of them so the driver
        // can find the tracked branch wherever it sits in the list.
        const updates = payload.resource?.refUpdates ?? [];
        return { kind: "push", refs: updates.map((u) => ({ ref: u.name, sha: u.newObjectId })) };
      },
    };
  },
};

/** Registered trigger sources, keyed by the id used in `/hooks/:provider`. */
export const providers: Record<string, GitProviderAdapter> = {
  github: githubProvider,
  ado: adoProvider,
};

/** Provider values a registry entry may carry. */
export const KNOWN_PROVIDERS = [...Object.keys(providers), "generic"];

function acceptPush(
  repo: SourceRepo,
  provider: string,
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
 * The provider-agnostic webhook driver: parse → identify the repo → verify
 * the credential for *that* repo → classify the event → normalize. The repo
 * is identified from the (untrusted) payload first because per-repo secrets
 * require knowing which secret to verify against; nothing is trusted until
 * `authenticate` passes.
 */
export function verifyWebhook(
  provider: GitProviderAdapter,
  body: string,
  headers: WebhookHeaders,
  ctx: ProviderContext,
): TriggerResult {
  const parsed = provider.parse(body, headers);
  if (typeof parsed === "string") return { kind: "rejected", reason: parsed, status: 400 };

  const ranked = ctx.repos
    .filter((r) => r.provider === provider.id)
    .map((r) => ({ repo: r, rank: matchRank(r, parsed.repoCandidates) }))
    .filter((m) => m.rank > 0);
  const best = Math.max(0, ...ranked.map((m) => m.rank));
  const matches = ranked.filter((m) => m.rank === best);
  if (matches.length === 0) {
    return {
      kind: "rejected",
      reason: `payload matches no registered ${provider.id} repo`,
      status: 404,
    };
  }
  if (matches.length > 1) {
    const ids = matches.map((m) => m.repo.id).join(", ");
    return {
      kind: "rejected",
      reason: `payload ambiguously matches several repos (${ids}) — register full clone URLs`,
      status: 409,
    };
  }
  const repo = matches[0]!.repo;

  const secret = repoSecret(repo, ctx);
  if (!secret) {
    return {
      kind: "rejected",
      reason: `no webhook secret configured for "${repo.id}"`,
      status: 403,
    };
  }
  const authError = parsed.authenticate(secret);
  if (authError) return { kind: "rejected", reason: authError, status: 401 };

  // Authenticated from here on.
  const event = parsed.event();
  if (event.kind === "ignored") return { kind: "ignored", reason: event.reason };

  // Multi-ref pushes: prefer the update for the tracked branch wherever it
  // sits in the list; fall back to the first so the "untracked ref" ignore
  // message names what was actually pushed.
  const tracked =
    event.refs.find((u) => branchOfRef(u.ref) === repo.branch) ?? event.refs[0] ?? {};
  return acceptPush(repo, provider.id, tracked.ref, tracked.sha, ctx);
}

function headersOf(record: Record<string, string | undefined>): WebhookHeaders {
  const lower = new Map(
    Object.entries(record)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k.toLowerCase(), v as string]),
  );
  return { get: (name) => lower.get(name.toLowerCase()) };
}

/** GitHub `push` webhook (thin wrapper over the driver; kept for tests/API). */
export function verifyGithub(
  opts: { body: string; signature: string | undefined; event: string | undefined },
  ctx: ProviderContext,
): TriggerResult {
  return verifyWebhook(
    githubProvider,
    opts.body,
    headersOf({ "x-hub-signature-256": opts.signature, "x-github-event": opts.event }),
    ctx,
  );
}

/** Azure DevOps `git.push` service hook (thin wrapper over the driver). */
export function verifyAdo(
  opts: { body: string; authorization: string | undefined },
  ctx: ProviderContext,
): TriggerResult {
  return verifyWebhook(adoProvider, opts.body, headersOf({ authorization: opts.authorization }), ctx);
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
