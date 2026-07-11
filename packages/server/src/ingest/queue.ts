import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSourceRepo, type SourceRepo } from "./registry.js";
import type { TriggerEvent } from "./providers.js";
import { recordBuild } from "./status.js";

interface QueueItem extends TriggerEvent {
  /** Epoch ms before which this item must not start (debounce window). */
  notBefore: number;
  state: "pending" | "running";
}

interface QueueJournal {
  schemaVersion: 1;
  items: QueueItem[];
}

export interface BuildOutcome {
  fileCount?: number;
  symbolCount?: number;
  commitSha?: string;
}

export interface BuildQueueOptions {
  dataDir: string;
  /** Run the full fetch→extract→publish pipeline for one repo. */
  runBuild: (repo: SourceRepo, event: TriggerEvent) => Promise<BuildOutcome>;
  /** Called after a successful publish (hot-reload manifests). */
  onPublished?: (repoId: string) => void;
  /** Coalescing window for rapid pushes. */
  debounceMs?: number;
  /** Max builds running at once (per-repo serialization always holds). */
  concurrency?: number;
  /** A build exceeding this is recorded as failed. */
  buildTimeoutMs?: number;
  log?: (message: string) => void;
}

export function queueJournalPath(dataDir: string): string {
  return join(dataDir, "queue.json");
}

/**
 * In-process build queue, journaled to `queue.json` so accepted triggers
 * survive restarts (slice-2 work item 3). Rapid pushes to one repo coalesce
 * within the debounce window; one repo never builds twice concurrently; a
 * global cap bounds total concurrency. Failures are captured to the status
 * file and the repo keeps serving its last good docs (the pipeline only
 * publishes atomically on success).
 *
 * Scheduling: a single timer is armed for the *earliest future* deadline and
 * never pushed later by new triggers (no starvation). Items that are due but
 * blocked — by the concurrency cap or by a running build of the same repo —
 * need no timer at all: the blocking build's release re-runs `tick()`.
 */
export class BuildQueue {
  private items: QueueItem[] = [];
  /** repoIds with a build in flight (held until the build promise settles). */
  private readonly running = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private timerDeadline = Infinity;
  private idleWaiters: (() => void)[] = [];
  private stopped = false;
  private readonly debounceMs: number;
  private readonly concurrency: number;
  private readonly buildTimeoutMs: number;
  private readonly log: (message: string) => void;

  constructor(private readonly opts: BuildQueueOptions) {
    this.debounceMs = opts.debounceMs ?? 10_000;
    this.concurrency = Math.max(1, opts.concurrency ?? 1);
    this.buildTimeoutMs = opts.buildTimeoutMs ?? 10 * 60_000;
    this.log = opts.log ?? ((m) => console.log(m));
    this.restoreJournal();
  }

  /** Reload accepted-but-unfinished work from a previous process. */
  private restoreJournal(): void {
    const file = queueJournalPath(this.opts.dataDir);
    if (!existsSync(file)) return;
    try {
      const journal = JSON.parse(readFileSync(file, "utf8")) as QueueJournal;
      // Items that were mid-build when the process died go back to pending;
      // stale debounce deadlines shrink to one fresh window from now.
      const maxDeadline = Date.now() + this.debounceMs;
      this.items = (journal.items ?? []).map((i) => ({
        ...i,
        state: "pending" as const,
        notBefore: Math.min(i.notBefore, maxDeadline),
      }));
    } catch {
      this.items = [];
    }
    if (this.items.length > 0) {
      this.log(`[queue] restored ${this.items.length} journaled trigger(s)`);
      // Defer the first tick so builds never start inside the constructor.
      this.armTimerAt(Date.now());
    }
  }

  private journal(): void {
    mkdirSync(this.opts.dataDir, { recursive: true });
    const journal: QueueJournal = { schemaVersion: 1, items: this.items };
    writeFileSync(queueJournalPath(this.opts.dataDir), JSON.stringify(journal, null, 2) + "\n");
  }

  /**
   * Accept a normalized trigger. A pending item for the same repo is
   * coalesced — its target sha updates and the debounce window restarts —
   * so five rapid pushes produce ~one build.
   */
  enqueue(event: TriggerEvent): { coalesced: boolean } {
    const notBefore = Date.now() + this.debounceMs;
    const pending = this.items.find((i) => i.repoId === event.repoId && i.state === "pending");
    let coalesced = false;
    if (pending) {
      pending.ref = event.ref;
      pending.commitSha = event.commitSha;
      pending.provider = event.provider;
      pending.receivedAt = event.receivedAt;
      pending.notBefore = notBefore;
      coalesced = true;
    } else {
      this.items.push({ ...event, notBefore, state: "pending" });
    }
    this.journal();
    this.tick(); // starts anything already due and re-arms the timer
    return { coalesced };
  }

  /** Pending + running item count (for the status surface). */
  depth(): number {
    return this.items.length;
  }

  snapshot(): { repoId: string; provider: string; state: string; receivedAt: string }[] {
    return this.items.map(({ repoId, provider, state, receivedAt }) => ({
      repoId,
      provider,
      state,
      receivedAt,
    }));
  }

  /** Resolves once the queue is fully drained (tests / graceful shutdown). */
  drain(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  /**
   * Serialize an ad-hoc build (a target with no registry entry, e.g. the
   * legacy `/api/build {path}` form) against queued builds that would publish
   * under the same slug.
   */
  async withRepoLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
    while (this.running.has(repoId)) {
      await new Promise((r) => setTimeout(r, 25));
    }
    this.running.add(repoId);
    try {
      return await fn();
    } finally {
      this.running.delete(repoId);
      this.tick();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private isIdle(): boolean {
    return this.items.length === 0 && this.running.size === 0;
  }

  private maybeResolveIdle(): void {
    if (this.isIdle()) {
      for (const waiter of this.idleWaiters.splice(0)) waiter();
    }
  }

  /** Arm the single timer, only ever moving its deadline *earlier*. */
  private armTimerAt(deadline: number): void {
    if (this.stopped) return;
    if (this.timer && this.timerDeadline <= deadline) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerDeadline = deadline;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerDeadline = Infinity;
      this.tick();
    }, Math.max(0, deadline - Date.now()));
    this.timer.unref?.();
  }

  private tick(): void {
    if (this.stopped) return;
    const now = Date.now();
    for (const item of this.items) {
      if (this.running.size >= this.concurrency) break;
      if (item.state !== "pending" || item.notBefore > now) continue;
      if (this.running.has(item.repoId)) continue; // per-repo serialization
      item.state = "running";
      this.running.add(item.repoId);
      this.journal();
      void this.run(item);
    }
    // A timer is only needed for items whose debounce lies in the future.
    // Due-but-blocked items are re-examined when the blocking build settles
    // (its release calls tick()), so no polling and no busy-loop.
    const future = this.items
      .filter((i) => i.state === "pending" && i.notBefore > now)
      .map((i) => i.notBefore);
    if (future.length > 0) this.armTimerAt(Math.min(...future));
    this.maybeResolveIdle();
  }

  private finish(item: QueueItem): void {
    this.items = this.items.filter((i) => i !== item);
    this.journal();
  }

  private async run(item: QueueItem): Promise<void> {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const base = {
      repoId: item.repoId,
      ref: item.ref,
      commitSha: item.commitSha,
      trigger: item.provider,
      startedAt,
    };
    let release = () => {
      this.running.delete(item.repoId);
      this.tick(); // there may be a coalesced follow-up for this repo
    };
    try {
      const repo = getSourceRepo(this.opts.dataDir, item.repoId);
      if (!repo) throw new Error(`repo "${item.repoId}" is no longer registered`);
      const build = this.opts.runBuild(repo, item);
      // On timeout we record the failure but hold the per-repo lock until the
      // orphaned build actually settles, so serialization is never violated.
      const outcome = await withTimeout(build, this.buildTimeoutMs, () => {
        const held = release;
        release = () => {};
        void build.catch(() => {}).finally(held);
      });
      recordBuild(this.opts.dataDir, {
        ...base,
        commitSha: outcome.commitSha ?? item.commitSha,
        durationMs: Date.now() - t0,
        result: "ok",
        fileCount: outcome.fileCount,
        symbolCount: outcome.symbolCount,
      });
      this.opts.onPublished?.(item.repoId);
      this.log(`[queue] built ${item.repoId} (${item.provider}) in ${Date.now() - t0}ms`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? (err.stack ?? message) : message;
      recordBuild(this.opts.dataDir, {
        ...base,
        durationMs: Date.now() - t0,
        result: "error",
        error: message.slice(0, 500),
        logTail: stack.split("\n").slice(-40).join("\n"),
      });
      this.log(`[queue] build failed for ${item.repoId}: ${message}`);
    } finally {
      this.finish(item);
      release();
      this.maybeResolveIdle();
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      onTimeout();
      rejectPromise(new Error(`build timed out after ${ms}ms`));
    }, ms);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolvePromise(v);
      },
      (e) => {
        clearTimeout(timer);
        rejectPromise(e);
      },
    );
  });
}
