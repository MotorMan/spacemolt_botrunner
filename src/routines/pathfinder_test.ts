import type { Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import { ensureFueled, ensureUndocked, navigateToSystem } from "./common.js";
import { readSettings, writeSettings } from "./common.js";

const PATHFINDER_TEST_SETTINGS_KEY = "pathfinder_test";

interface PathfinderTestSettings {
  originSystem?: string;
  targetSystem?: string;
  refuelThreshold?: number;
}

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" && v ? v : fallback;
}
function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && !isNaN(v) ? v : fallback;
}

export function getPathfinderTestSettings(username?: string): PathfinderTestSettings {
  const all = readSettings();
  const botOverrides = (username ? (all[username] || {}) : {}) as Record<string, unknown>;
  const global = (all[PATHFINDER_TEST_SETTINGS_KEY] || {}) as Record<string, unknown>;
  return {
    originSystem: asString(botOverrides.originSystem, asString(global.originSystem, "sol")),
    targetSystem: asString(botOverrides.targetSystem, asString(global.targetSystem, "alpha")),
    refuelThreshold: asNumber(botOverrides.refuelThreshold, asNumber(global.refuelThreshold, 50)),
  };
}

export function setPathfinderTestOrigin(username: string, system: string): void {
  writeSettings({ [username]: { originSystem: system } });
}

export function setPathfinderTestTarget(username: string, system: string): void {
  writeSettings({ [username]: { targetSystem: system } });
}

export const pathfinderTestRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;
  const settings = getPathfinderTestSettings(bot.username);

  const originSystem = settings.originSystem || "sol";
  const targetSystem = settings.targetSystem || "alpha";

  ctx.log("system", `Pathfinder test routine started — origin: ${originSystem}, target: ${targetSystem}`);

  yield "prep";
  await bot.refreshStatus();

  ctx.log("travel", `Navigating to origin system ${originSystem} via normal jumps...`);
  const originArrived = await navigateToSystem(ctx, originSystem, {
    fuelThresholdPct: settings.refuelThreshold || 50,
    hullThresholdPct: 30,
  });
  if (!originArrived) {
    ctx.log("error", `Could not reach origin system ${originSystem} — aborting pathfinder test`);
    return;
  }
  ctx.log("travel", `At origin system ${originSystem} — ready for pathfinder jump`);

  yield "pathfinder_jump";
  const result = await bot.performPathfinderJump(targetSystem);
  if (result.success) {
    ctx.log("travel", `Pathfinder test SUCCESS: ${originSystem} -> ${targetSystem}, arrived at tick ${result.arrivedTick}`);
    ctx.log("travel", `Landing details: ${result.landing?.systemId} in ${result.landing?.ticks} ticks`);
  } else {
    ctx.log("error", `Pathfinder test FAILED: ${originSystem} -> ${targetSystem}`);
  }
};
