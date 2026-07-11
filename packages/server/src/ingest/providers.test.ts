import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authorizeRestTrigger,
  normalizeRepoUrl,
  verifyAdo,
  verifyGithub,
  type ProviderContext,
} from "./providers.js";
import type { SourceRepo } from "./registry.js";

const githubRepo: SourceRepo = {
  id: "widgets",
  provider: "github",
  url: "https://github.com/acme/widgets.git",
  branch: "main",
  secretEnv: "WIDGETS_SECRET",
  enabled: true,
};

const adoRepo: SourceRepo = {
  id: "gadgets",
  provider: "ado",
  url: "https://dev.azure.com/acme/proj/_git/gadgets",
  branch: "main",
  secretEnv: "GADGETS_SECRET",
  enabled: true,
};

function ctx(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    repos: [githubRepo, adoRepo],
    env: { WIDGETS_SECRET: "gh-secret", GADGETS_SECRET: "hookuser:hookpass" },
    now: () => "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

function githubPush(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ref: "refs/heads/main",
    after: "abc123def456",
    repository: {
      clone_url: "https://github.com/acme/widgets.git",
      full_name: "acme/widgets",
    },
    ...overrides,
  });
}

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("normalizeRepoUrl", () => {
  it("equates https, ssh, and .git variants", () => {
    expect(normalizeRepoUrl("https://github.com/Acme/Widgets.git")).toBe("github.com/acme/widgets");
    expect(normalizeRepoUrl("git@github.com:acme/widgets.git")).toBe("github.com/acme/widgets");
    expect(normalizeRepoUrl("https://user@github.com/acme/widgets/")).toBe("github.com/acme/widgets");
  });
});

describe("verifyGithub", () => {
  it("accepts a correctly signed push to the tracked branch", () => {
    const body = githubPush();
    const result = verifyGithub(
      { body, signature: sign(body, "gh-secret"), event: "push" },
      ctx(),
    );
    expect(result).toEqual({
      kind: "accepted",
      event: {
        repoId: "widgets",
        ref: "main",
        commitSha: "abc123def456",
        provider: "github",
        receivedAt: "2026-07-10T00:00:00.000Z",
      },
    });
  });

  it("rejects a forged signature", () => {
    const body = githubPush();
    const result = verifyGithub(
      { body, signature: sign(body, "wrong-secret"), event: "push" },
      ctx(),
    );
    expect(result).toMatchObject({ kind: "rejected", status: 401 });
  });

  it("rejects a missing signature", () => {
    const result = verifyGithub({ body: githubPush(), signature: undefined, event: "push" }, ctx());
    expect(result).toMatchObject({ kind: "rejected", status: 401 });
  });

  it("rejects when the payload matches no registered repo", () => {
    const body = githubPush({ repository: { clone_url: "https://github.com/other/repo.git" } });
    const result = verifyGithub({ body, signature: sign(body, "gh-secret"), event: "push" }, ctx());
    expect(result).toMatchObject({ kind: "rejected", status: 404 });
  });

  it("rejects when no secret is configured anywhere", () => {
    const result = verifyGithub(
      { body: githubPush(), signature: "sha256=whatever", event: "push" },
      ctx({ env: {} }),
    );
    expect(result).toMatchObject({ kind: "rejected", status: 403 });
  });

  it("falls back to the shared secret when the repo has none", () => {
    const body = githubPush();
    const result = verifyGithub(
      { body, signature: sign(body, "shared"), event: "push" },
      ctx({ env: {}, sharedSecret: "shared" }),
    );
    expect(result.kind).toBe("accepted");
  });

  it("ignores pushes to untracked branches (after verifying)", () => {
    const body = githubPush({ ref: "refs/heads/feature/x" });
    const result = verifyGithub({ body, signature: sign(body, "gh-secret"), event: "push" }, ctx());
    expect(result).toMatchObject({ kind: "ignored" });
  });

  it("ignores ping events", () => {
    const body = githubPush();
    const result = verifyGithub({ body, signature: sign(body, "gh-secret"), event: "ping" }, ctx());
    expect(result).toEqual({ kind: "ignored", reason: "ping" });
  });

  it("ignores branch deletions (zero sha)", () => {
    const body = githubPush({ after: "0000000000000000000000000000000000000000" });
    const result = verifyGithub({ body, signature: sign(body, "gh-secret"), event: "push" }, ctx());
    expect(result).toMatchObject({ kind: "ignored" });
  });

  it("rejects malformed JSON", () => {
    const result = verifyGithub({ body: "not json", signature: undefined, event: "push" }, ctx());
    expect(result).toMatchObject({ kind: "rejected", status: 400 });
  });
});

function adoPush(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    eventType: "git.push",
    resource: {
      repository: { remoteUrl: "https://dev.azure.com/acme/proj/_git/gadgets" },
      refUpdates: [{ name: "refs/heads/main", newObjectId: "fedcba987654" }],
    },
    ...overrides,
  });
}

function basic(cred: string): string {
  return `Basic ${Buffer.from(cred).toString("base64")}`;
}

describe("verifyAdo", () => {
  it("accepts a git.push with the configured basic-auth credential", () => {
    const result = verifyAdo(
      { body: adoPush(), authorization: basic("hookuser:hookpass") },
      ctx(),
    );
    expect(result).toEqual({
      kind: "accepted",
      event: {
        repoId: "gadgets",
        ref: "main",
        commitSha: "fedcba987654",
        provider: "ado",
        receivedAt: "2026-07-10T00:00:00.000Z",
      },
    });
  });

  it("accepts when the secret is just the password part", () => {
    const result = verifyAdo(
      { body: adoPush(), authorization: basic("anyuser:hookuser:hookpass") },
      ctx(),
    );
    expect(result.kind).toBe("accepted");
  });

  it("rejects a wrong credential", () => {
    const result = verifyAdo({ body: adoPush(), authorization: basic("bad:cred") }, ctx());
    expect(result).toMatchObject({ kind: "rejected", status: 401 });
  });

  it("rejects a missing credential", () => {
    const result = verifyAdo({ body: adoPush(), authorization: undefined }, ctx());
    expect(result).toMatchObject({ kind: "rejected", status: 401 });
  });

  it("ignores non-push event types (after verifying)", () => {
    const result = verifyAdo(
      { body: adoPush({ eventType: "git.pullrequest.created" }), authorization: basic("hookuser:hookpass") },
      ctx(),
    );
    expect(result).toMatchObject({ kind: "ignored" });
  });

  it("finds the tracked branch in a multi-ref push, wherever it sits", () => {
    const body = adoPush({
      resource: {
        repository: { remoteUrl: "https://dev.azure.com/acme/proj/_git/gadgets" },
        refUpdates: [
          { name: "refs/heads/feature/x", newObjectId: "aaa111" },
          { name: "refs/heads/main", newObjectId: "bbb222" },
        ],
      },
    });
    const result = verifyAdo({ body, authorization: basic("hookuser:hookpass") }, ctx());
    expect(result).toMatchObject({
      kind: "accepted",
      event: { repoId: "gadgets", ref: "main", commitSha: "bbb222" },
    });
  });

  it("matches a repo registered by its SSH URL against the hook's https remoteUrl", () => {
    const sshRepo: SourceRepo = {
      ...adoRepo,
      id: "gadgets-ssh",
      url: "git@ssh.dev.azure.com:v3/acme/proj/gadgets",
      secretEnv: "GADGETS_SECRET",
    };
    const result = verifyAdo(
      { body: adoPush(), authorization: basic("hookuser:hookpass") },
      ctx({ repos: [sshRepo] }),
    );
    expect(result).toMatchObject({ kind: "accepted", event: { repoId: "gadgets-ssh" } });
  });
});

describe("repo identity resolution", () => {
  it("prefers an exact clone-URL match over a bare full-name suffix match", () => {
    const mirror: SourceRepo = {
      ...githubRepo,
      id: "widgets-mirror",
      url: "https://mirror.example.com/acme/widgets.git",
    };
    const body = githubPush(); // clone_url matches githubRepo exactly; full_name suffix-matches both
    const result = verifyGithub(
      { body, signature: sign(body, "gh-secret"), event: "push" },
      ctx({ repos: [mirror, githubRepo] }),
    );
    expect(result).toMatchObject({ kind: "accepted", event: { repoId: "widgets" } });
  });

  it("rejects a payload that ambiguously matches several repos", () => {
    const mirror: SourceRepo = {
      ...githubRepo,
      id: "widgets-mirror",
      url: "https://mirror.example.com/acme/widgets.git",
    };
    // Only a full_name candidate: suffix-matches both registered repos.
    const body = githubPush({ repository: { full_name: "acme/widgets" } });
    const result = verifyGithub(
      { body, signature: sign(body, "gh-secret"), event: "push" },
      ctx({ repos: [mirror, githubRepo] }),
    );
    expect(result).toMatchObject({ kind: "rejected", status: 409 });
  });
});

describe("authorizeRestTrigger", () => {
  const restRepo: SourceRepo = { ...githubRepo, provider: "generic", apiTokenEnv: "WIDGETS_API" };
  const restCtx = { ...ctx({ env: { WIDGETS_API: "scoped-token" } }), globalToken: "admin-token" };

  it("accepts the global token for any repo", () => {
    expect(
      authorizeRestTrigger({ authorization: "Bearer admin-token", repo: restRepo }, restCtx),
    ).toBe(true);
    expect(authorizeRestTrigger({ authorization: "Bearer admin-token" }, restCtx)).toBe(true);
  });

  it("accepts a per-repo scoped token only for its repo", () => {
    expect(
      authorizeRestTrigger({ authorization: "Bearer scoped-token", repo: restRepo }, restCtx),
    ).toBe(true);
    expect(authorizeRestTrigger({ authorization: "Bearer scoped-token" }, restCtx)).toBe(false);
  });

  it("rejects wrong or missing tokens", () => {
    expect(authorizeRestTrigger({ authorization: "Bearer nope", repo: restRepo }, restCtx)).toBe(false);
    expect(authorizeRestTrigger({ authorization: undefined, repo: restRepo }, restCtx)).toBe(false);
  });
});
