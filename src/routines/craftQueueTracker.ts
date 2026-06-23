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

  private static CRAFTING_STATE_FILE = "data/crafting-state.json";

  constructor(bot: Bot) {
    this.bot = bot;
  }

  trackJob(jobId: string, recipeId: string, quantity: number): void {
    const job: QueuedJob = {
      jobId,
      recipeId,
      quantity,
      completed: 0,
      deposited: 0,
      runsRemaining: quantity,
      startedAt: Date.now(),
      lastUpdate: Date.now(),
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
      job.runsRemaining = runsRemaining;
    }
    job.lastUpdate = Date.now();
    return job.completed >= job.quantity;
  }

  markCompleted(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.completed = job.quantity;
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
    for (const id of ids) {
      const job = this.jobs.get(id);
      if (job) {
        queued += job.quantity;
        completed += job.completed;
      }
    }
    return { queued, completed, remaining: queued - completed };
  }

  getDetailedProgress(recipeId: string): { 
    queued: number; 
    completed: number; 
    remaining: number; 
    jobs: Array<{ jobId: string; quantity: number; completed: number; runsRemaining: number }>
  } {
    const ids = this.recipeIndex.get(recipeId) || [];
    let queued = 0;
    let completed = 0;
    const jobDetails: Array<{ jobId: string; quantity: number; completed: number; runsRemaining: number }> = [];
    for (const id of ids) {
      const job = this.jobs.get(id);
      if (job) {
        queued += job.quantity;
        completed += job.completed;
        jobDetails.push({
          jobId: job.jobId,
          quantity: job.quantity,
          completed: job.completed,
          runsRemaining: job.runsRemaining,
        });
      }
    }
    return { queued, completed, remaining: queued - completed, jobs: jobDetails };
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
    const currentIds = new Set(serverJobs.map(j => j.jobId));
    for (const [jobId, job] of Array.from(this.jobs.entries())) {
      if (!currentIds.has(jobId)) {
        this.jobs.delete(jobId);
        this.cleanupIndex(jobId);
      }
    }
    for (const serverJob of serverJobs) {
      if (!this.jobs.has(serverJob.jobId)) {
        const job: QueuedJob = {
          jobId: serverJob.jobId,
          recipeId: serverJob.recipeId,
          quantity: serverJob.quantity,
          completed: serverJob.runsDone,
          deposited: serverJob.runsDone,
          runsRemaining: serverJob.runsRemaining,
          startedAt: Date.now(),
          lastUpdate: Date.now(),
        };
        this.jobs.set(serverJob.jobId, job);
        const existing = this.recipeIndex.get(serverJob.recipeId) || [];
        if (!existing.includes(serverJob.jobId)) {
          existing.push(serverJob.jobId);
          this.recipeIndex.set(serverJob.recipeId, existing);
        }
      } else {
        const job = this.jobs.get(serverJob.jobId)!;
        job.completed = serverJob.runsDone;
        job.deposited = serverJob.runsDone;
        job.runsRemaining = serverJob.runsRemaining;
        job.lastUpdate = Date.now();
      }
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
      const path = `${import.meta.dir}/../../${CraftQueueTracker.CRAFTING_STATE_FILE}`;
      const exists = await Bun.file(path).exists();
      if (!exists) return;
      const raw = await Bun.file(path).text();
      const data = JSON.parse(raw);
const loaded = (data.jobs as Array<{ jobId: string; recipeId: string; quantity: number; completed: number; deposited?: number; runsRemaining?: number; startedAt: number; lastUpdate: number }>) || [];
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
      const payload = JSON.stringify(this.toJSON(), null, 2);
      const path = `${import.meta.dir}/../../${CraftQueueTracker.CRAFTING_STATE_FILE}`;
      Bun.write(path, payload);
    } catch {
      // ignore write failures
    }
  }
}
