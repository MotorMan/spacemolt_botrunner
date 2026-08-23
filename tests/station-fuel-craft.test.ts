import { describe, it, expect, vi } from "vitest";

vi.mock("../src/botmanager", () => ({
  getBot: vi.fn(() => null),
  getDiscoveredBots: vi.fn(() => []),
  getBotStatuses: vi.fn(() => []),
}));

import { StationWebServer } from "../src/web/stationserver.js";

const STATION_ID = "cca9e51e6eaf8dada77f698ccc4a09c7";
const STATION_NAME = "The Obsidian Well";

function fuelJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    base_id: STATION_ID,
    base_name: STATION_NAME,
    facility_id: "74dd6b4ee581e747178a8898aa1414b5",
    job_id: "job-" + Math.random().toString(36).slice(2),
    mode: "craft",
    produces: [{ item_id: "fuel_reserve", name: "Fuel Reserve", quantity: 200 }],
    progress: 0,
    recipe: "Manufacture Fuel (H2O2)",
    runs_done: 0,
    runs_remaining: 2500,
    runs_total: 2500,
    status: "queued",
    venue: "Peroxide Reaction Cell",
    ...overrides,
  };
}

/** Sample `craft action=queue` payload: 1 active + 3 queued fuel jobs. */
const SAMPLE_JOBS = [
  fuelJob({ status: "active", progress: 0.25, runs_done: 224, runs_remaining: 2276, eta_ticks: 2375, position: 0 }),
  fuelJob({ position: 1, eta_ticks: 4984 }),
  fuelJob({ position: 2, eta_ticks: 7593 }),
  fuelJob({ position: 3, eta_ticks: 10201 }),
];

type Summarizer = {
  summarizeFuelCraft: (
    jobs: Record<string, unknown>[] | null,
    stationId: string,
    stationName: string,
  ) => { state: string; activeJobs: number; queuedJobs: number; runsRemaining: number; unitsRemaining: number; etaTicks: number | null; recipe: string | null };
  readCraftQueue: (
    bot: unknown,
    botName: string,
    cache: Map<string, Record<string, unknown>[] | null>,
  ) => Promise<Record<string, unknown>[] | null>;
};

function server(): Summarizer {
  return new StationWebServer(0) as unknown as Summarizer;
}

function summarize(jobs: Record<string, unknown>[] | null, stationId = STATION_ID, name = STATION_NAME) {
  return server().summarizeFuelCraft(jobs, stationId, name);
}

describe("station fuel craft detection", () => {
  it("reports active production from a real queue payload", () => {
    const s = summarize(SAMPLE_JOBS);
    expect(s.state).toBe("active");
    expect(s.activeJobs).toBe(1);
    expect(s.queuedJobs).toBe(3);
    expect(s.runsRemaining).toBe(2276 + 2500 * 3);
    expect(s.unitsRemaining).toBe((2276 + 2500 * 3) * 200);
    expect(s.etaTicks).toBe(2375);
    expect(s.recipe).toBe("Manufacture Fuel (H2O2)");
  });

  it("reports queued when nothing is running yet", () => {
    const s = summarize([fuelJob(), fuelJob()]);
    expect(s.state).toBe("queued");
    expect(s.activeJobs).toBe(0);
    expect(s.queuedJobs).toBe(2);
  });

  it("reports none when the queue only holds non-fuel jobs", () => {
    const other = fuelJob({
      status: "active",
      recipe: "Refine Alloy",
      produces: [{ item_id: "alloy_plate", name: "Alloy Plate", quantity: 5 }],
    });
    expect(summarize([other]).state).toBe("none");
  });

  it("reports none for an empty queue", () => {
    expect(summarize([]).state).toBe("none");
  });

  it("matches any recipe that outputs fuel_reserve", () => {
    const alt = fuelJob({
      status: "active",
      recipe: "Extract Fuel Cell",
      venue: "Hydrogen Processor",
      produces: [{ item_id: "fuel_reserve", name: "Fuel Reserve", quantity: 20 }],
      runs_remaining: 10,
    });
    const s = summarize([alt]);
    expect(s.state).toBe("active");
    expect(s.unitsRemaining).toBe(200);
    expect(s.recipe).toBe("Extract Fuel Cell");
  });

  it("ignores fuel jobs belonging to a different station", () => {
    const elsewhere = fuelJob({ status: "active", base_id: "other-base", base_name: "Somewhere Else" });
    expect(summarize([elsewhere]).state).toBe("none");
  });

  it("trusts jobs that carry no base info", () => {
    const bare = fuelJob({ status: "active", base_id: undefined, base_name: undefined });
    delete bare.base_id;
    delete bare.base_name;
    expect(summarize([bare]).state).toBe("active");
  });

  it("skips finished jobs", () => {
    expect(summarize([fuelJob({ status: "completed", runs_remaining: 0 })]).state).toBe("none");
  });

  it("returns unknown when the queue could not be read", () => {
    const s = summarize(null);
    expect(s.state).toBe("unknown");
    expect(s.activeJobs).toBe(0);
  });
});

describe("craft queue reader", () => {
  it("parses jobs from the plain result payload and caches per bot", async () => {
    const exec = vi.fn(async () => ({ result: { action: "queue", kind: "queue", jobs: SAMPLE_JOBS, total_jobs: 4 } }));
    const cache = new Map<string, Record<string, unknown>[] | null>();
    const srv = server();
    const jobs = await srv.readCraftQueue({ exec }, "drone-1", cache);
    expect(jobs).toHaveLength(4);
    await srv.readCraftQueue({ exec }, "drone-1", cache);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("unwraps a details-wrapped payload", async () => {
    const exec = vi.fn(async () => ({ result: { details: { jobs: [fuelJob({ status: "active" })] } } }));
    const jobs = await server().readCraftQueue({ exec }, "drone-2", new Map());
    expect(jobs).toHaveLength(1);
  });

  it("returns an empty list (not unknown) when nothing is queued", async () => {
    const exec = vi.fn(async () => ({ result: { action: "queue", jobs: [], total_jobs: 0 } }));
    const jobs = await server().readCraftQueue({ exec }, "drone-3", new Map());
    expect(jobs).toEqual([]);
  });

  it("returns null when the command fails", async () => {
    const exec = vi.fn(async () => ({ error: { code: "timeout", message: "craft timed out" } }));
    const jobs = await server().readCraftQueue({ exec }, "drone-4", new Map());
    expect(jobs).toBeNull();
  });
});
