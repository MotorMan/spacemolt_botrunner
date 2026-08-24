import type { Bot } from "../bot.js";

export interface QueuedJob {
  jobId: string;
  recipeId: string;
  quantity: number;
  completed: number;
  deposited: number;
  runsRemaining: number;
  startedAt: number;
  lastUpdate: number;
  // Last time the job actually made progress (a deposit/completion or a server
  // sync showing runs_remaining drop). Used to detect STUCK jobs that the
  // server keeps listing but never advances — without this the planner trusts
  // a phantom "pending" forever (e.g. 500k fuel_reserve that was never crafted).
  lastProgressAt: number;
}

export interface ServerJobInfo {
  jobId: string;
  recipeId: string;
  quantity: number;
  runsDone: number;
  runsRemaining: number;
}

export class CraftQueueTracker {
  private jobs: Map<string, QueuedJob> = new Map();
  private recipeIndex: Map<string, string[]> = new Map();
  private bot: Bot;
  // Job IDs this PROCESS actually queued via the `craft` command. Only these are
  // trusted as "credible pending" for goal coverage / duplicate detection. Jobs
  // the server still lists but that we did NOT queue this session (e.g. an
  // orphaned, long-running batch from a previous run that the station drone is
  // no longer actually fulfilling) must NOT satisfy a goal — otherwise the
  // crafter believes the item is "in flight", stops topping up, and the station
  // drains while a phantom "pending" (e.g. 148600 fuel_reserve) is credited
  // forever. See getProgress / hasPendingJob.
  private sessionQueued: Set<string> = new Set();

  private static CRAFTING_STATE_FILE = "crafting-state.json";

  constructor(bot: Bot) {
    this.bot = bot;
  }

  trackJob(jobId: string, recipeId: string, quantity: number): void {
    const now = Date.now();
    const job: QueuedJob = {
      jobId,
      recipeId,
      quantity,
      completed: 0,
      deposited: 0,
      runsRemaining: quantity,
      startedAt: now,
      lastUpdate: now,
      lastProgressAt: now,
    };
    this.jobs.set(jobId, job);
    this.sessionQueued.add(jobId);
    const existing = this.recipeIndex.get(recipeId) || [];
    if (!existing.includes(jobId)) {
      existing.push(jobId);
      this.recipeIndex.set(recipeId, existing);
    }
  }

  updateDeposited(jobId: string, depositedQuantity: number, runsRemaining?: number): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    job.completed += depositedQuantity;
    job.deposited += depositedQuantity;
    if (runsRemaining !== undefined) {
      // Only bump lastProgressAt when the server actually reports fewer runs
      // left — a sync that echoes the same runsRemaining is not progress.
      if (runsRemaining < job.runsRemaining) job.lastProgressAt = Date.now();
      job.runsRemaining = runsRemaining;
    }
    job.lastUpdate = Date.now();
    return job.completed >= job.quantity;
  }

  markCompleted(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.completed = job.quantity;
    job.lastProgressAt = Date.now();
    job.lastUpdate = Date.now();
    this.bot.clearCraftingJobByRecipe(job.recipeId);
    this.sessionQueued.delete(jobId);
    this.jobs.delete(jobId);
  }

  getActiveJobs(): QueuedJob[] {
    return Array.from(this.jobs.values());
  }

  // Core progress calculator. When `sessionOnly` is true, only jobs THIS process
  // actually queued (see `sessionQueued`) are counted as "pending". Orphaned jobs
  // the server still lists from a prior session are excluded so they can't
  // fabricate phantom "pending" output and block re-queuing (the fuel bug).
  private progressFor(recipeId: string, sessionOnly: boolean): { queued: number; completed: number; remaining: number } {
    const ids = this.recipeIndex.get(recipeId) || [];
    let queued = 0;
    let completed = 0;
    let remainingCap = 0;
    for (const id of ids) {
      if (sessionOnly && !this.sessionQueued.has(id)) continue;
      const job = this.jobs.get(id);
      if (job) {
        queued += job.quantity;
        completed += job.completed;
        remainingCap += Math.max(0, job.runsRemaining);
      }
    }
    // Bound the reported remaining by the server-authoritative runsRemaining so
    // a stalled/over-counted `completed` (from the item-vs-runs unit bug) cannot
    // inflate phantom "pending" output forever.
    return { queued, completed, remaining: Math.min(queued - completed, remainingCap) };
  }

  // Progress crediting ONLY jobs queued this session. This is what goal coverage
  // and duplicate detection use, so an old/orphaned server job can never satisfy
  // a goal or block a fresh top-up.
  getProgress(recipeId: string): { queued: number; completed: number; remaining: number } {
    return this.progressFor(recipeId, true);
  }

  // Progress across ALL known jobs (including orphaned ones) — used purely for
  // display in [Queue Status] so the operator still sees the real live queue.
  getProgressAll(recipeId: string): { queued: number; completed: number; remaining: number } {
    return this.progressFor(recipeId, false);
  }

  // Drop jobs that the server lists but that have made NO progress for longer
  // than `maxInactiveMs`. A stuck fuel job that the station drone never actually
  // crafts would otherwise sit as phantom "pending" until a process restart.
  // (Note: orphaned jobs are ALSO excluded from coverage via `sessionQueued`,
  // so this is now just hygiene/display cleanup rather than the sole guard.)
  pruneStaleInactiveJobs(maxInactiveMs: number): string[] {
    const now = Date.now();
    const toRemove: string[] = [];
    for (const [jobId, job] of Array.from(this.jobs.entries())) {
      if (job.completed >= job.quantity) continue;
      if (now - job.lastProgressAt > maxInactiveMs) {
        toRemove.push(jobId);
      }
    }
    for (const jobId of toRemove) {
      this.sessionQueued.delete(jobId);
      this.jobs.delete(jobId);
      this.cleanupIndex(jobId);
    }
    return toRemove;
  }

  getJob(jobId: string): QueuedJob | undefined {
    return this.jobs.get(jobId);
  }

  // Display-only view of the live (shared/account-wide) queue — shows EVERY job
  // the `craft` command returns, including other bots' jobs, so the operator can
  // see the real queue. Do NOT use this for goal coverage/duplicate detection:
  // those must use getProgress() (session-only) so one drone never credits
  // another drone's jobs as its own pending.
  getProgressByRecipe(): Map<string, { queued: number; completed: number; remaining: number }> {
    const result = new Map<string, { queued: number; completed: number; remaining: number }>();
    for (const [recipeId] of Array.from(this.recipeIndex.entries())) {
      result.set(recipeId, this.getProgressAll(recipeId));
    }
    return result;
  }

  // Only counts jobs THIS bot actually queued this session. A shared/account-wide
  // `craft` queue means every drone sees every other drone's jobs; crediting those
  // as our own pending would make us think an item is "in flight" (and stop
  // topping up) when another drone's job is the one producing it. This is the
  // core guard against drone 006 believing drone 001's 148k fuel_reserve is its
  // own pending.
  hasPendingJob(recipeId: string, quantity: number): boolean {
    const ids = this.recipeIndex.get(recipeId) || [];
    let remainingRuns = 0;
    for (const id of ids) {
      if (!this.sessionQueued.has(id)) continue;
      const job = this.jobs.get(id);
      if (job) {
        remainingRuns += job.quantity - job.completed;
      }
    }
    return remainingRuns >= quantity;
  }

syncWithServer(serverJobs: ServerJobInfo[]): void {
    if (serverJobs.length === 1 && serverJobs[0].jobId === "error") {
      return;
    }
    const currentIds = new Set(serverJobs.map(j => j.jobId));
    for (const [jobId, job] of Array.from(this.jobs.entries())) {
      if (!currentIds.has(jobId)) {
        this.sessionQueued.delete(jobId);
        this.jobs.delete(jobId);
        this.cleanupIndex(jobId);
      }
    }
    for (const serverJob of serverJobs) {
      if (!this.jobs.has(serverJob.jobId)) {
        const now = Date.now();
        const job: QueuedJob = {
          jobId: serverJob.jobId,
          recipeId: serverJob.recipeId,
          quantity: serverJob.quantity,
          completed: serverJob.runsDone,
          deposited: serverJob.runsDone,
          runsRemaining: serverJob.runsRemaining,
          startedAt: now,
          lastUpdate: now,
          lastProgressAt: now,
        };
        this.jobs.set(serverJob.jobId, job);
        const existing = this.recipeIndex.get(serverJob.recipeId) || [];
        if (!existing.includes(serverJob.jobId)) {
          existing.push(serverJob.jobId);
          this.recipeIndex.set(serverJob.recipeId, existing);
        }
      } else {
        const job = this.jobs.get(serverJob.jobId)!;
        job.quantity = serverJob.quantity;
        job.completed = serverJob.runsDone;
        job.deposited = serverJob.runsDone;
        if (serverJob.runsRemaining < job.runsRemaining) {
          job.lastProgressAt = Date.now();
        }
        job.runsRemaining = serverJob.runsRemaining;
        job.lastUpdate = Date.now();
      }
    }
  }

  // Drop locally-tracked jobs whose recipeId is no longer valid (e.g. stale
  // jobs rehydrated from a previous session, or jobs whose recipe string the
  // queue poller could never resolve to a catalog recipe_id). Such jobs can
  // never be reconciled against the live server queue, so they would otherwise
  // linger forever as phantom "pending" output and inflate the planner's
  // perceived stock (e.g. falsely reporting hundreds of thousands of water ice).
  prunePhantomJobs(validRecipeIds: Set<string>): void {
    const toRemove: string[] = [];
    for (const [jobId, job] of Array.from(this.jobs.entries())) {
      if (!validRecipeIds.has(job.recipeId)) {
        toRemove.push(jobId);
      }
    }
    for (const jobId of toRemove) {
      this.jobs.delete(jobId);
      this.cleanupIndex(jobId);
    }
  }

  clearCompleted(): void {
    const toRemove: string[] = [];
    for (const [jobId, job] of Array.from(this.jobs.entries())) {
      if (job.completed >= job.quantity) {
        toRemove.push(jobId);
      }
    }
    for (const jobId of toRemove) {
      this.jobs.delete(jobId);
      this.cleanupIndex(jobId);
    }
  }

  private cleanupIndex(jobId: string): void {
    for (const [recipeId, ids] of Array.from(this.recipeIndex.entries())) {
      const filtered = ids.filter(id => id !== jobId);
      if (filtered.length === 0) {
        this.recipeIndex.delete(recipeId);
      } else {
        this.recipeIndex.set(recipeId, filtered);
      }
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      jobs: Array.from(this.jobs.entries()).map(([jobId, job]) => ({
        jobId,
        recipeId: job.recipeId,
        quantity: job.quantity,
        completed: job.completed,
        deposited: job.deposited,
        runsRemaining: job.runsRemaining,
        startedAt: job.startedAt,
        lastUpdate: job.lastUpdate,
        lastProgressAt: job.lastProgressAt,
      })),
      recipeIndex: Array.from(this.recipeIndex.entries()).map(([recipeId, ids]) => ({
        recipeId,
        jobIds: ids,
      })),
    };
  }

  static async create(bot: Bot): Promise<CraftQueueTracker> {
    const tracker = new CraftQueueTracker(bot);
    // We deliberately do NOT rehydrate job state from disk. `craft` is an
    // instant (non-mutating) command that returns the authoritative live
    // queue, so the ONLY valid source of "pending" / "remaining runs" is a
    // fresh `craft` read reconciled via syncWithServer(). Persisting queue
    // state to a file (as the old load()/save() did) is always stale the
    // instant it is written: a job can complete or be cancelled on the server
    // seconds later, and a stale file would then report phantom "pending"
    // output that survives even a full client restart — which is exactly the
    // bug where the crafter believed thousands of fuel_reserve were "in flight"
    // when no such job ever existed. See also the no-op save() below.
    //
    // Best-effort cleanup of any legacy crafting-state.json so it can't be
    // mistaken for live state by operators or future code.
    try {
      const { join } = require("path");
      const { existsSync, unlinkSync } = require("fs");
      const path = join(process.cwd(), "data", CraftQueueTracker.CRAFTING_STATE_FILE);
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // ignore cleanup failures
    }
    return tracker;
  }

  // Rehydrating persisted queue state is intentionally a no-op. The live `craft`
  // command is the single source of truth and is reconciled every pass via
  // syncWithServer(); rebuilding from a file reintroduces the stale "phantom
  // pending" data this class previously suffered from.
  private async load(): Promise<void> {
    // Intentionally does nothing — see create().
  }

  // Persisting queue state to disk is intentionally a no-op for the same reason
  // as load(): the moment it is written it is outdated, and re-reading it would
  // resurrect phantom "pending" output. All truth lives in the live `craft`
  // command, which syncWithServer() applies to this in-memory tracker.
  save(): void {
    // Intentionally does nothing — see load()/create().
  }
}
