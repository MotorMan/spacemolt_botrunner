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

  // Drop jobs that the server lists but that have made NO progress for longer
  // than `maxInactiveMs`. A stuck fuel job that the station drone never actually
  // crafts would otherwise sit as phantom "pending" until a process restart.
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
    await tracker.load();
    return tracker;
  }

  private async load(): Promise<void> {
    try {
      const { join } = require("path");
      const { existsSync, readFileSync } = require("fs");
      const path = join(process.cwd(), "data", CraftQueueTracker.CRAFTING_STATE_FILE);
      if (!existsSync(path)) return;
      const raw = readFileSync(path, "utf-8");
      const data = JSON.parse(raw);
      const loaded = (data.jobs as Array<{ jobId: string; recipeId: string; quantity: number; completed: number; deposited?: number; runsRemaining?: number; startedAt: number; lastUpdate: number; lastProgressAt?: number }>) || [];
      for (const j of loaded) {
        const job: QueuedJob = {
          jobId: j.jobId,
          recipeId: j.recipeId,
          quantity: j.quantity,
          completed: j.completed,
          deposited: j.deposited ?? 0,
          runsRemaining: j.runsRemaining ?? j.quantity,
          startedAt: j.startedAt,
          lastUpdate: j.lastUpdate,
          lastProgressAt: j.lastProgressAt ?? j.lastUpdate,
        };
        this.jobs.set(job.jobId, job);
        const existing = this.recipeIndex.get(job.recipeId) || [];
        if (!existing.includes(job.jobId)) {
          existing.push(job.jobId);
          this.recipeIndex.set(job.recipeId, existing);
        }
      }
    } catch {
      // ignore corrupted state
    }
  }

  save(): void {
    try {
      const { join, dirname } = require("path");
      const { writeFileSync, mkdirSync, existsSync } = require("fs");
      const path = join(process.cwd(), "data", CraftQueueTracker.CRAFTING_STATE_FILE);
      if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
      const payload = JSON.stringify(this.toJSON(), null, 2);
      writeFileSync(path, payload);
    } catch {
      // ignore write failures
    }
  }
}
