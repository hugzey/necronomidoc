import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TriggerEvent } from "./providers.js";
import { BuildQueue, queueJournalPath, type BuildOutcome } from "./queue.js";
import { upsertSourceRepo } from "./registry.js";
import { readBuildStatus } from "./status.js";

function event(repoId: string, sha?: string): TriggerEvent {
  return {
    repoId,
    ref: "main",
    commitSha: sha,
    provider: "generic",
    receivedAt: new Date().toISOString(),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("BuildQueue", () => {
  let dataDir: string;
  let queues: BuildQueue[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "necro-queue-"));
    queues = [];
    for (const id of ["alpha", "beta"]) {
      upsertSourceRepo(dataDir, { id, provider: "generic", url: `/nowhere/${id}` });
    }
  });

  afterEach(() => {
    for (const q of queues) q.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function makeQueue(opts: {
    debounceMs?: number;
    concurrency?: number;
    buildTimeoutMs?: number;
    runBuild: (repoId: string, event: TriggerEvent) => Promise<BuildOutcome>;
  }): BuildQueue {
    const q = new BuildQueue({
      dataDir,
      debounceMs: opts.debounceMs ?? 30,
      concurrency: opts.concurrency,
      buildTimeoutMs: opts.buildTimeoutMs,
      runBuild: (repo, e) => opts.runBuild(repo.id, e),
      log: () => {},
    });
    queues.push(q);
    return q;
  }

  it("coalesces rapid pushes into one build of the latest sha", async () => {
    const built: string[] = [];
    const queue = makeQueue({
      runBuild: async (_repo, e) => {
        built.push(e.commitSha ?? "?");
        return {};
      },
    });
    for (let i = 1; i <= 5; i++) queue.enqueue(event("alpha", `sha${i}`));
    await queue.drain();
    expect(built).toEqual(["sha5"]);
  });

  it("never runs two builds of one repo concurrently, and caps global concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    const perRepoActive = new Map<string, number>();
    const queue = makeQueue({
      debounceMs: 1,
      concurrency: 2,
      runBuild: async (repoId) => {
        active++;
        perRepoActive.set(repoId, (perRepoActive.get(repoId) ?? 0) + 1);
        expect(perRepoActive.get(repoId)).toBe(1);
        maxActive = Math.max(maxActive, active);
        await sleep(40);
        perRepoActive.set(repoId, perRepoActive.get(repoId)! - 1);
        active--;
        return {};
      },
    });
    queue.enqueue(event("alpha", "a1"));
    queue.enqueue(event("beta", "b1"));
    await sleep(15); // past debounce: both should be running now
    queue.enqueue(event("alpha", "a2")); // queued behind the running alpha build
    await queue.drain();
    expect(maxActive).toBe(2);
  });

  it("records failures with a log tail and keeps processing", async () => {
    const queue = makeQueue({
      runBuild: async (repoId) => {
        if (repoId === "alpha") throw new Error("extraction exploded");
        return { fileCount: 3, symbolCount: 9 };
      },
    });
    queue.enqueue(event("alpha", "bad"));
    queue.enqueue(event("beta", "good"));
    await queue.drain();
    const status = readBuildStatus(dataDir);
    expect(status.builds["alpha"]![0]).toMatchObject({
      result: "error",
      error: "extraction exploded",
    });
    expect(status.builds["alpha"]![0]!.logTail).toContain("extraction exploded");
    expect(status.builds["beta"]![0]).toMatchObject({ result: "ok", fileCount: 3 });
  });

  it("journals accepted triggers and restores them after a restart", async () => {
    // First queue accepts a trigger but is stopped before the debounce fires.
    const first = makeQueue({ debounceMs: 60_000, runBuild: async () => ({}) });
    first.enqueue(event("alpha", "sha-restored"));
    first.stop();
    expect(JSON.parse(readFileSync(queueJournalPath(dataDir), "utf8")).items).toHaveLength(1);

    // A new queue (fresh process) picks the journaled item up and builds it.
    const built: string[] = [];
    const second = makeQueue({
      debounceMs: 1,
      runBuild: async (_repo, e) => {
        built.push(e.commitSha ?? "?");
        return {};
      },
    });
    await second.drain();
    expect(built).toEqual(["sha-restored"]);
    expect(JSON.parse(readFileSync(queueJournalPath(dataDir), "utf8")).items).toHaveLength(0);
  });

  it("records a timeout as a failed build", async () => {
    const queue = makeQueue({
      debounceMs: 1,
      buildTimeoutMs: 30,
      runBuild: async () => {
        await sleep(200);
        return {};
      },
    });
    queue.enqueue(event("alpha"));
    await queue.drain();
    const status = readBuildStatus(dataDir);
    expect(status.builds["alpha"]![0]).toMatchObject({ result: "error" });
    expect(status.builds["alpha"]![0]!.error).toContain("timed out");
  });

  it("records an error when the repo was unregistered before the build ran", async () => {
    const queue = makeQueue({ debounceMs: 1, runBuild: async () => ({}) });
    queue.enqueue(event("ghost"));
    await queue.drain();
    expect(readBuildStatus(dataDir).builds["ghost"]![0]).toMatchObject({ result: "error" });
  });
});
