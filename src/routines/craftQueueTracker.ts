import type { Bot } from "../bot.js";

// How many consecutive `craft queue` syncs a job may be absent from before we
// consider it genuinely gone (completed/cancelled) and drop it. A single fetch
// is often transiently incomplete, so deleting on first absence caused the
// tracker to "forget" in-flight work and the crafter to re-queue it forever.
const MAX_MISSING_SYNCS = 3;

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
  // How many consecutive server syncs have NOT included this job. A single
  // `craft queue` fetch can be transiently incomplete (it is an instant command
  // and doesn't always echo every in-flight job), which previously caused
  // syncWithServer to delete the local record and "forget" pending work — the
  // crafter then re-queued the same recipe every pass and blew past its limit.
  // We only drop a job after it has been missing for several consecutive syncs.
  missingSyncs: number;
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
  // Job ids we have already warned about for being stalled, so the warning is
  // logged once per job instead of on every pass.
  private stallWarned: Set<string> = new Set();
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
      missingSyncs: 0,
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
    this.stallWarned.delete(jobId);
  }

  // Drop a job we deliberately cancelled on the server (e.g. an undrainable fuel
  // job whose tank is full) so it stops counting as in-flight pending.
  forgetJob(jobId: string): void {
    if (!this.jobs.has(jobId)) return;
    const job = this.jobs.get(jobId)!;
    this.bot.clearCraftingJobByRecipe(job.recipeId);
    this.jobs.delete(jobId);
    this.stallWarned.delete(jobId);
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

  // Report any job the server still lists that has made NO progress for longer
  // than `maxInactiveMs` (e.g. a fuel job whose station tank is full, so its last
  // runs can never deposit). Callers use this purely to tell the operator; the
  // job keeps counting as in-flight.
  //
  // NON-DESTRUCTIVE ON PURPOSE. The previous version deleted the job, which
  // never worked: the next syncWithServer re-added it straight from the live
  // `craft` queue (with a fresh lastProgressAt), so the same job was "dropped"
  // every 30 minutes forever while the underlying stall was untouched. Worse,
  // deleting it made the job stop counting as in-flight, so the planner could
  // stack duplicate work on top of it. A job the server still lists is real:
  // report it and let the operator decide.
  findStalledJobs(maxInactiveMs: number): QueuedJob[] {
    const now = Date.now();
    const stalled: QueuedJob[] = [];
    for (const job of Array.from(this.jobs.values())) {
      if (job.completed >= job.quantity) continue;
      if (now - job.lastProgressAt > maxInactiveMs) stalled.push(job);
    }
    return stalled;
  }

  // One-shot dedupe for the "job has stalled" warning so a long-lived stall does
  // not spam the log every pass. Returns true the first time a job is reported.
  markStallWarned(jobId: string): boolean {
    if (this.stallWarned.has(jobId)) return false;
    this.stallWarned.add(jobId);
    return true;
  }

  // Keep a stalled job's stall timestamp frozen across repeated live syncs.
  // syncWithServer() bumps lastProgressAt on every read even when the job has not
  // actually advanced, which would make a full-tank fuel job look perpetually
  // "fresh" and never qualify for auto-cancellation. A stalled job that is still
  // reported with runs remaining simply stays wedged at its original timestamp.
  pinStallSince(jobId: string, sinceMs: number): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (sinceMs < job.lastProgressAt) job.lastProgressAt = sinceMs;
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
    // A job absent from this fetch is NOT immediately deleted: a single `craft
    // queue` read is often incomplete. We only retire it once it has been
    // missing for MAX_MISSING_SYNCS consecutive syncs — by then it is genuinely
    // gone (the server would have echoed it otherwise). This prevents the
    // tracker from losing track of pending runs and the planner from re-queueing
    // the same recipe past its limit.
    for (const [jobId, job] of Array.from(this.jobs.entries())) {
      if (!currentIds.has(jobId)) {
        job.missingSyncs = (job.missingSyncs || 0) + 1;
        if (job.missingSyncs > MAX_MISSING_SYNCS) {
          this.jobs.delete(jobId);
          this.cleanupIndex(jobId);
        }
      } else {
        job.missingSyncs = 0;
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
          missingSyncs: 0,
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
    // A job that is gone can never stall again, so forget its warning state too
    // (this also keeps the set from growing for the life of the process).
    this.stallWarned.delete(jobId);
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
