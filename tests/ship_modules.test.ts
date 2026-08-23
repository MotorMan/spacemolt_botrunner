import { describe, test, expect, vi } from "vitest";

import { extractShipModules, moduleTypeId, moduleHaystack } from "../src/shipmodules.js";
import {
  detectAfterburnerModule,
  planAfterburnerTrip,
  clearAfterburnerModuleCache,
  AfterburnerBooster,
} from "../src/routines/afterburner.js";

/**
 * Real `get_ship` shape (trimmed): the ship carries only instance UUIDs, the
 * detail objects live in the top-level `modules` array.
 */
function getShipPayload() {
  return {
    ship: {
      id: "5e0c1a4a234e7aabb6c059348b30277c",
      class_id: "logistics_prime",
      speed: 3,
      cargo_used: 1224,
      cargo_capacity: 2160,
      modules: [
        "c30c4babd4bbfe7421db1f577d19f8cf",
        "f5494eaf2787c419fbc7892a403063f8",
        "de38b81c1a252eb36d3f77b5028844f5",
      ],
    },
    modules: [
      {
        id: "c30c4babd4bbfe7421db1f577d19f8cf",
        type_id: "phase_cloaking_device",
        name: "Phase Cloaking Device",
        type: "utility",
        slot: "utility",
        cloak_strength: 95,
      },
      {
        id: "f5494eaf2787c419fbc7892a403063f8",
        type_id: "afterburner_ii",
        name: "Afterburner II",
        type: "utility",
        slot: "utility",
        speed_bonus: 2,
      },
      {
        id: "de38b81c1a252eb36d3f77b5028844f5",
        type_id: "expanded_fuel_tank",
        name: "Expanded Fuel Tank",
        type: "utility",
        slot: "utility",
        max_fuel_bonus: 100,
      },
    ],
  };
}

function makeCtx(shipResult: unknown, opts: { username?: string } = {}) {
  const logs: string[] = [];
  const bot: any = {
    username: opts.username ?? `Tester_${Math.random().toString(36).slice(2)}`,
    shipSpeed: 3,
    exec: async (command: string) => {
      if (command === "get_ship") {
        return { result: shipResult, error: undefined, notifications: [] };
      }
      return { result: {}, error: undefined, notifications: [] };
    },
  };
  const ctx: any = {
    bot,
    log: (_cat: string, msg: string) => logs.push(msg),
    sleep: async () => {},
  };
  return { ctx, bot, logs };
}

describe("extractShipModules", () => {
  test("resolves ship.modules instance ids against the top-level detail array", () => {
    const { modules, unresolvedIds, resolved } = extractShipModules(getShipPayload());

    expect(resolved).toBe(true);
    expect(unresolvedIds).toEqual([]);
    expect(modules.map(m => m.type_id)).toEqual([
      "phase_cloaking_device",
      "afterburner_ii",
      "expanded_fuel_tank",
    ]);
  });

  test("handles the legacy shape where detail objects are inline", () => {
    const payload = {
      ship: { speed: 4, modules: [{ type_id: "afterburner_iii", name: "Afterburner III" }] },
    };
    const { modules, resolved } = extractShipModules(payload);
    expect(resolved).toBe(true);
    expect(modules).toHaveLength(1);
    expect(modules[0].type_id).toBe("afterburner_iii");
  });

  test("bare type-id strings are classifiable, opaque hashes are not", () => {
    const typed = extractShipModules({ ship: { modules: ["afterburner_i"] } });
    expect(typed.resolved).toBe(true);
    expect(moduleTypeId(typed.modules[0])).toBe("afterburner_i");

    const opaque = extractShipModules({ ship: { modules: ["f5494eaf2787c419fbc7892a403063f8"] } });
    expect(opaque.resolved).toBe(false);
    expect(opaque.modules).toEqual([]);
    expect(opaque.unresolvedIds).toEqual(["f5494eaf2787c419fbc7892a403063f8"]);
  });

  test("the slot/category label is never mistaken for a module type id", () => {
    const mod = { id: "f5494eaf2787c419fbc7892a403063f8", type: "utility", name: "Afterburner II" };
    expect(moduleTypeId(mod)).toBe("");
    expect(moduleHaystack(mod)).toContain("afterburner ii");
  });

  test("an empty ship list does not shadow populated top-level details", () => {
    const payload = getShipPayload() as any;
    payload.ship.modules = [];
    const { modules, resolved } = extractShipModules(payload);
    expect(resolved).toBe(true);
    expect(modules.map(m => m.type_id)).toContain("afterburner_ii");
  });

  test("a genuinely empty fit is conclusive, a missing list is not", () => {
    expect(extractShipModules({ ship: { modules: [] } })).toEqual({
      modules: [], unresolvedIds: [], resolved: true,
    });
    expect(extractShipModules({ ship: { speed: 3 } })).toEqual({
      modules: [], unresolvedIds: [], resolved: false,
    });
  });
});

describe("detectAfterburnerModule", () => {
  test("finds a fitted Afterburner II behind the instance-id indirection", async () => {
    clearAfterburnerModuleCache();
    const { ctx } = makeCtx(getShipPayload(), { username: "AfterburnerDetect" });

    const info = await detectAfterburnerModule(ctx, { force: true });

    expect(info.unknown).toBe(false);
    expect(info.hasModule).toBe(true);
    expect(info.moduleId).toBe("afterburner_ii");
    expect(info.moduleName).toBe("Afterburner II");
    expect(info.speedBonus).toBe(2);
    expect(info.shipSpeed).toBe(3);
    expect(info.boostedSpeed).toBe(6);
  });

  test("a boosted trip is planned instead of logging 'no afterburner module fitted'", async () => {
    clearAfterburnerModuleCache();
    const { ctx } = makeCtx(getShipPayload(), { username: "AfterburnerPlan" });

    const info = await detectAfterburnerModule(ctx, { force: true });
    const plan = planAfterburnerTrip(info, { mode: "auto", roundTripJumps: 28, jumpsPerFuel: 1, fuelBuffer: 2 });

    expect(plan.boost).toBe(true);
    expect(plan.fuelUnitsNeeded).toBe(30);
    expect(plan.reason).toContain("Afterburner II");
  });

  test("a ship with no afterburner is still reported as definitively unfitted", async () => {
    clearAfterburnerModuleCache();
    const payload = getShipPayload();
    payload.ship.modules = ["c30c4babd4bbfe7421db1f577d19f8cf"];
    const { ctx } = makeCtx(payload, { username: "NoAfterburner" });

    const info = await detectAfterburnerModule(ctx, { force: true });
    expect(info.unknown).toBe(false);
    expect(info.hasModule).toBe(false);

    const plan = planAfterburnerTrip(info, { mode: "auto", roundTripJumps: 28 });
    expect(plan.boost).toBe(false);
    expect(plan.reason).toBe("no afterburner module fitted");
  });

  test("unresolvable module ids report 'unknown' rather than 'not fitted'", async () => {
    clearAfterburnerModuleCache();
    const { ctx } = makeCtx(
      { ship: { speed: 3, modules: ["f5494eaf2787c419fbc7892a403063f8"] } },
      { username: "UnknownModules" },
    );

    const info = await detectAfterburnerModule(ctx, { force: true });
    expect(info.unknown).toBe(true);
    expect(info.hasModule).toBe(false);

    const plan = planAfterburnerTrip(info, { mode: "auto", roundTripJumps: 28 });
    expect(plan.boost).toBe(false);
    expect(plan.reason).toContain("could not read ship modules");
  });

  test("an inconclusive read is not cached, so the next cycle retries", async () => {
    clearAfterburnerModuleCache();
    let payload: unknown = { ship: { speed: 3, modules: ["f5494eaf2787c419fbc7892a403063f8"] } };
    const logs: string[] = [];
    const bot: any = {
      username: "RetryAfterUnknown",
      shipSpeed: 3,
      exec: async () => ({ result: payload, error: undefined, notifications: [] }),
    };
    const ctx: any = { bot, log: (_c: string, m: string) => logs.push(m), sleep: async () => {} };

    const first = await detectAfterburnerModule(ctx);
    expect(first.unknown).toBe(true);

    // Same TTL window, but the payload is now complete — detection must re-run.
    payload = getShipPayload();
    const second = await detectAfterburnerModule(ctx);
    expect(second.unknown).toBe(false);
    expect(second.hasModule).toBe(true);
  });
});

describe("AfterburnerBooster.burnBeforeJump", () => {
  function makeBooster(units: number, jumpsPerFuel = 1) {
    const calls = { useItem: 0 };
    const logs: string[] = [];
    const bot: any = {
      exec: async (command: string, _payload?: Record<string, unknown>) => {
        if (command === "use_item") {
          calls.useItem++;
          return {
            result: { quantity_remaining: Math.max(0, units - calls.useItem), active_buffs: [{ stat: "speed", amount: 100 }] },
            error: undefined,
            notifications: [],
          };
        }
        return { result: {}, error: undefined, notifications: [] };
      },
    };
    const ctx: any = { bot, log: (_c: string, m: string) => logs.push(m), sleep: async () => {} };
    const booster = new AfterburnerBooster(ctx, { enabled: true, jumpsPerFuel, unitsInCargo: units });
    return { booster, calls, logs };
  }

  test("burns exactly one unit per jump at jumpsPerFuel=1", async () => {
    const { booster, calls } = makeBooster(3);
    await booster.burnBeforeJump("arneb", 1);
    await booster.burnBeforeJump("mebsuta", 2);
    await booster.burnBeforeJump("adhara", 3);
    expect(calls.useItem).toBe(3);
    expect(booster.remainingUnits).toBe(0);
    expect(booster.usedUnits).toBe(3);
  });

  test("does not re-burn a retry of the same jump within the guard window", async () => {
    const { booster, calls } = makeBooster(5);
    await booster.burnBeforeJump("arneb", 1);
    await booster.burnBeforeJump("arneb", 1); // same key, retry
    expect(calls.useItem).toBe(1);
  });

  test("rides a single buff across jumps when jumpsPerFuel > 1", async () => {
    const { booster, calls } = makeBooster(2, 3);
    await booster.burnBeforeJump("a", 1);
    await booster.burnBeforeJump("b", 2);
    await booster.burnBeforeJump("c", 3);
    await booster.burnBeforeJump("d", 4); // buff lapsed → new unit
    expect(calls.useItem).toBe(2);
  });

  test("disables and stops when cargo runs out of afterburner fuel", async () => {
    const { booster, logs } = makeBooster(1);
    await booster.burnBeforeJump("arneb", 1);
    expect(booster.remainingUnits).toBe(0);
    expect(logs.some(l => l.includes("Afterburner engaged"))).toBe(true);
  });

  test("fireUseItem is non-blocking so the jump can queue in the same tick", async () => {
    // The whole point of fireUseItem: navigateToSystem must be able to issue
    // `jump` immediately after without waiting for use_item to resolve, so both
    // mutations land in the same server tick (library command queueing).
    let resolved = false;
    const bot: any = {
      exec: async (command: string) => {
        if (command === "use_item") {
          await new Promise(r => setTimeout(r, 50));
          resolved = true;
          return { result: { quantity_remaining: 0, active_buffs: [] }, error: undefined, notifications: [] };
        }
        return { result: {}, error: undefined, notifications: [] };
      },
    };
    const ctx: any = { bot, log: () => {}, sleep: async () => {} };
    const booster = new AfterburnerBooster(ctx, { enabled: true, unitsInCargo: 1 });

    booster.fireUseItem("arneb", 1);
    // Returned synchronously — use_item has NOT resolved yet.
    expect(resolved).toBe(false);

    await new Promise(r => setTimeout(r, 80));
    expect(resolved).toBe(true);
    expect(booster.remainingUnits).toBe(0);
    expect(booster.usedUnits).toBe(1);
  });
});
