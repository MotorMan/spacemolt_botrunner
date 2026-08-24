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
    this.jobs.delete(jobId);
  }

  getActiveJobs(): QueuedJob[] {
    return Array.from(this.jobs.values());
  }

  // Progress across the bot's OWN crafting queue (the `craft` command only ever
  // returns this bot's jobs, since each bot has its own websocket — see
  // bot.craftQueueCache). Every job in here is legitimately this bot's pending
  // output, so it is all counted toward "pending" for goal coverage / dedup.
  getProgress(recipeId: string): { queued: number; completed: number; remaining: number } {
    const ids = this.recipeIndex.get(recipeId) || [];
    let queued = 0;
    let completed = 0;
    let remainingCap = 0;
    for (const id of ids) {
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

  // Clean up any job the server still lists that has made NO progress for longer
  // than `maxInactiveMs` (e.g. a fuel job the station drone never actually
  // fulfills). This keeps "pending" honest so a genuinely stuck job can't sit
  // forever and block a fresh top-up.
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
      this.jobs.delete(jobId);
      this.cleanupIndex(jobId);
    }
    return toRemove;
  }

  getJob(jobId: string): QueuedJob | undefined {
    return this.jobs.get(jobId);
  }

  getProgressByRecipe(): Map<string, { queued: number; completed: number; remaining: number }> {
    const result = new Map<string, { queued: number; completed: number; remaining: number }>();
    for (const [recipeId] of Array.from(this.recipeIndex.entries())) {
      result.set(recipeId, this.getProgress(recipeId));
    }
    return result;
  }

  // True when this bot already has enough pending runs of `recipeId` queued to
  // cover `quantity`. Every job in the tracker is this bot's own (the `craft`
  // command only returns this bot's queue), so all are counted.
  hasPendingJob(recipeId: string, quantity: number): boolean {
    const ids = this.recipeIndex.get(recipeId) || [];
    let remainingRuns = 0;
    for (const id of ids) {
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
