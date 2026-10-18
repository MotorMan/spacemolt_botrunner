import type { Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import {
  navigateToSystem,
  readSettings,
  writeSettings,
  getSystemInfo,
  getFuelCellFuelValue,
} from "./common.js";
import { calculatePathfinderBearing, formatBearing, PATHFINDER_SPEED } from "../pathfinder.js";

const PATHFINDER_SETTINGS_KEY = "pathfinder";

interface PathfinderSettings {
  originSystem?: string;
  scanStartDegree?: number;
  scanStepDegrees?: number;
  scanWaitMinutes?: number;
  scanDelayTicks?: number;
  refuelThreshold?: number;
}

interface GalacticPos {
  x: number;
  y: number;
}

interface JumpResult {
  success: boolean;
  landedSystem: string;
  arrivalPos: GalacticPos | null;
  ticksTraveled: number;
}

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" && v ? v : fallback;
}
function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && !isNaN(v) ? v : fallback;
}

export function getPathfinderSettings(username?: string): PathfinderSettings {
  const all = readSettings();
  const botOverrides = (username ? (all[username] || {}) : {}) as Record<string, unknown>;
  const global = (all[PATHFINDER_SETTINGS_KEY] || {}) as Record<string, unknown>;
  return {
    originSystem: asString(botOverrides.originSystem, asString(global.originSystem, "sol")),
    scanStartDegree: asNumber(botOverrides.scanStartDegree, asNumber(global.scanStartDegree, 0)),
    scanStepDegrees: asNumber(botOverrides.scanStepDegrees, asNumber(global.scanStepDegrees, 12)),
    scanWaitMinutes: asNumber(botOverrides.scanWaitMinutes, asNumber(global.scanWaitMinutes, 5)),
    scanDelayTicks: asNumber(botOverrides.scanDelayTicks, asNumber(global.scanDelayTicks, 2)),
    refuelThreshold: asNumber(botOverrides.refuelThreshold, asNumber(global.refuelThreshold, 50)),
  };
}

export function setPathfinderOrigin(username: string, system: string): void {
  writeSettings({ [username]: { originSystem: system } });
}

export function setPathfinderScanStartDegree(username: string, degree: number): void {
  writeSettings({ [username]: { scanStartDegree: degree } });
}

export function setPathfinderScanStepDegrees(username: string, step: number): void {
  writeSettings({ [username]: { scanStepDegrees: step } });
}

export function setPathfinderScanWaitMinutes(username: string, minutes: number): void {
  writeSettings({ [username]: { scanWaitMinutes: minutes } });
}

export function setPathfinderRefuelThreshold(username: string, threshold: number): void {
  writeSettings({ [username]: { refuelThreshold: threshold } });
}

export function setPathfinderScanDelayTicks(username: string, ticks: number): void {
  writeSettings({ [username]: { scanDelayTicks: ticks } });
}

/** Perform a raw pathfinder jump at a given bearing and wait for arrival.
 *  Tracks galactic position by recording start/end ticks and applying the
 *  fixed pathfinder speed (10 GU/tick) along the jump bearing. */
async function pathfinderJumpAtBearing(
  ctx: RoutineContext,
  bearingDegrees: number,
  originPos: GalacticPos | null,
): Promise<JumpResult> {
  const { bot } = ctx;

  if (!bot.hasPathfinderDrive) {
    await bot.refreshShipMods();
  }
  if (!bot.hasPathfinderDrive) {
    ctx.log("error", "Pathfinder jump attempted without Pathfinder Drive module.");
    return { success: false, landedSystem: bot.system, arrivalPos: null, ticksTraveled: 0 };
  }

  await bot.refreshStatus();
  const originSystem = bot.system;
  const bearing = ((bearingDegrees % 360) + 360) % 360;

  // Record the tick we depart on so we can compute distance traveled.
  const startTick = await bot.pollCurrentTick();

  ctx.log("travel", `Pathfinder jump at bearing ${formatBearing(bearing, 2)}° from ${originSystem}`);

  const jumpResp = await bot.exec("jump", { target_system: bearing });
  if (jumpResp.error) {
    ctx.log("error", `Pathfinder jump at bearing ${formatBearing(bearing, 2)}° failed: ${jumpResp.error.message}`);
    return { success: false, landedSystem: bot.system, arrivalPos: null, ticksTraveled: 0 };
  }

  ctx.log("debug", `Pathfinder jump at bearing ${formatBearing(bearing, 2)}° raw result=${JSON.stringify(jumpResp.result)}`);

  const jr = jumpResp.result as Record<string, unknown> | undefined;
  const arrivalSystemId = (jr?.arrival_system_id as string) || "";
  const arrivalSystemName = (jr?.arrival_system as string) || "";
  if (arrivalSystemId) {
    ctx.log("travel", `Jump result: arrived at ${arrivalSystemName || '?'} (${arrivalSystemId})`);
  }

  // Wait for transit to complete, capturing the tick we land on.
  // Pathfinder jumps are fire-and-forget — the server may not register
  // transit immediately. Wait for in_transit to become TRUE first, then
  // wait for it to become FALSE before capturing the end tick.
  let inTransit = false;
  let ticksRemaining: number | null = null;
  let endTick: number | null = null;
  let poll = 0;
  const maxPolls = 720; // up to ~60 minutes at 5s polls

  // Phase 1: wait for transit to START (server may need a tick to register it)
  let startPolls = 0;
  const maxStartPolls = 24; // up to ~2 minutes to detect transit start
  while (bot.state === "running" && startPolls < maxStartPolls && !inTransit) {
    await ctx.sleep(5000);
    if (bot.state !== "running") break;
    startPolls++;
    const startPoi = await bot.exec("get_poi");
    if (startPoi.result && typeof startPoi.result === "object") {
      const p = startPoi.result as Record<string, unknown>;
      inTransit = (p.in_transit as boolean) ?? false;
      ticksRemaining = (p.ticks_remaining as number) ?? ticksRemaining;
    }
  }

  if (!inTransit && bot.state === "running") {
    ctx.log("error", `Pathfinder jump at bearing ${formatBearing(bearing, 2)}° — transit never started`);
    return { success: false, landedSystem: bot.system, arrivalPos: null, ticksTraveled: 0 };
  }

  // Phase 2: wait for transit to COMPLETE
  while (bot.state === "running" && poll < maxPolls && inTransit) {
    await ctx.sleep(5000);
    if (bot.state !== "running") break;
    poll++;

    const poiResp = await bot.exec("get_poi");
    if (poiResp.result && typeof poiResp.result === "object") {
      const p = poiResp.result as Record<string, unknown>;
      inTransit = (p.in_transit as boolean) ?? false;
      ticksRemaining = (p.ticks_remaining as number) ?? ticksRemaining;
    }

    // Capture ticks periodically so we have an end tick when transit finishes.
    if (poll % 6 === 0) {
      endTick = await bot.pollCurrentTick();
      ctx.log("travel", `Pathfinder in transit — ticks_remaining=${ticksRemaining ?? "?"}${endTick !== null ? `, tick=${endTick}` : ""}`);
    }
  }

  if (poll >= maxPolls && inTransit && bot.state === "running") {
    ctx.log("error", `Pathfinder jump at bearing ${formatBearing(bearing, 2)}° — transit did not complete after ${Math.round(maxPolls * 5 / 1000)}s, aborting`);
    return { success: false, landedSystem: bot.system, arrivalPos: null, ticksTraveled: 0 };
  }

  // Honor an immediate stop request — don't poll tick or continue processing.
  if (bot.state !== "running") {
    ctx.log("system", "Pathfinder jump aborted — bot stopped");
    return { success: false, landedSystem: bot.system, arrivalPos: null, ticksTraveled: 0 };
  }

  // Final tick capture at landing.
  endTick = await bot.pollCurrentTick();

  if (bot.state !== "running") {
    ctx.log("system", "Pathfinder jump aborted — bot stopped");
    return { success: false, landedSystem: bot.system, arrivalPos: null, ticksTraveled: 0 };
  }

  // Compute arrival galactic position from origin + bearing * speed * elapsed ticks.
  let arrivalPos: GalacticPos | null = null;
  if (originPos && startTick !== null && endTick !== null) {
    const ticksTraveled = Math.max(0, endTick - startTick);
    const distance = ticksTraveled * PATHFINDER_SPEED;
    const rad = (bearing * Math.PI) / 180;
    arrivalPos = {
      x: originPos.x + distance * Math.cos(rad),
      y: originPos.y + distance * Math.sin(rad),
    };
    ctx.log("travel", `Tracked position: elapsed ${ticksTraveled} ticks, ${distance.toFixed(1)} GU, arrival galactic (${arrivalPos.x.toFixed(1)}, ${arrivalPos.y.toFixed(1)})`);
  }

  // Refresh location to learn the system we landed at
  await bot.refreshLocation();
  await bot.refreshStatus();

  const landed = bot.system;
  ctx.log("travel", `Pathfinder jump at bearing ${formatBearing(bearing, 2)}° complete: arrived at ${landed}`);

  // If we landed at a known system in mapStore, prefer its exact position over our computed one.
  if (arrivalPos === null) {
    const landedSys = mapStore.getSystem(landed);
    if (landedSys?.position) {
      arrivalPos = landedSys.position;
    }
  }

  return { success: true, landedSystem: landed, arrivalPos, ticksTraveled: endTick !== null && startTick !== null ? Math.max(0, endTick - startTick) : 0 };
}

/** Return to a target system from our tracked position, using x/y math. */
async function returnToSystem(
  ctx: RoutineContext,
  targetSystem: string,
  currentPos: GalacticPos | null,
  originPos: GalacticPos | null,
): Promise<void> {
  const { bot } = ctx;

  // Option 1: calculated bearing from our tracked position to target (x/y math)
  if (currentPos && originPos) {
    const bearing = calculatePathfinderBearing(
      currentPos.x, currentPos.y,
      originPos.x, originPos.y,
    );
    ctx.log("travel", `Returning to ${targetSystem} at calculated bearing ${formatBearing(bearing, 2)}° from tracked position (${currentPos.x.toFixed(1)}, ${currentPos.y.toFixed(1)})`);
    const jump = await pathfinderJumpAtBearing(ctx, bearing, currentPos);
    if (jump.success && bot.system.toLowerCase() === targetSystem.toLowerCase()) {
      ctx.log("travel", `Returned to ${targetSystem}`);
      return;
    }
    ctx.log("warn", `Calculated return jump did not land at ${targetSystem} (now at ${bot.system})`);
  }

  // No position data available — cannot navigate back. We are in the void.
  ctx.log("error", `No valid return path to ${targetSystem} — no galactic position data to calculate bearing back (stranded in void)`);
}

interface FoundSystem {
  angle: number;
  systemId: string;
  systemName: string;
  known: boolean;
  atVoid: boolean;
}

interface FuelCheck {
  ok: boolean;
  availableFuel: number;
  neededFuel: number;
  fuelPerJump: number;
  totalJumps: number;
  jumpsPossible: number;
  militaryCells: number;
}

/** Pre-flight stupidity check: can this ship actually complete the configured scan? */
async function preflightFuelCheck(ctx: RoutineContext, totalJumps: number): Promise<FuelCheck> {
  const { bot } = ctx;

  // Tank fuel currently aboard.
  const tankFuel = bot.fuel;

  // Military fuel cells in cargo (100 fuel each for this ship's loadout).
  let militaryCells = 0;
  for (const item of bot.inventory) {
    if (item.itemId === "military_fuel_cell") militaryCells += item.quantity;
  }
  const cellFuel = getFuelCellFuelValue("military_fuel_cell"); // 100 per cell
  const availableFuel = tankFuel + militaryCells * cellFuel;

  // Pathfinder jumps use the Pathfinder Drive module which has its own
  // fuel burn rate — it does NOT match find_route's regular jump cost.
  // This ship consumes 25 fuel per pathfinder jump.
  const fuelPerJump = 25;

  const neededFuel = totalJumps * fuelPerJump;
  const jumpsPossible = fuelPerJump > 0 ? Math.floor(availableFuel / fuelPerJump) : 0;
  const ok = availableFuel >= neededFuel;

  return { ok, availableFuel, neededFuel, fuelPerJump, totalJumps, jumpsPossible, militaryCells };
}

export const pathfinderRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;
  const settings = getPathfinderSettings(bot.username);

  const originSystem = settings.originSystem || "sol";
  const scanStartDegree = settings.scanStartDegree ?? 0;
  const scanStepDegrees = Math.max(1, Math.min(180, settings.scanStepDegrees ?? 12));
  const scanWaitMinutes = settings.scanWaitMinutes ?? 5;
  const scanDelayTicks = settings.scanDelayTicks ?? 2;
  const refuelThreshold = settings.refuelThreshold ?? 50;

  const startDegree = ((scanStartDegree % 360) + 360) % 360;
  const numAngles = Math.floor(360 / scanStepDegrees);
  const totalJumps = numAngles * 2; // one out + one back per angle

  ctx.log("system", `Pathfinder scan routine started — origin: ${originSystem}, start: ${startDegree}°, step: ${scanStepDegrees}° (${numAngles} angles), wait: ${scanWaitMinutes} min`);

  yield "prep";
  await bot.refreshStatus();

  ctx.log("travel", `Navigating to origin system ${originSystem}...`);
  const originArrived = await navigateToSystem(ctx, originSystem, {
    fuelThresholdPct: refuelThreshold,
    hullThresholdPct: 30,
  });
  if (!originArrived) {
    ctx.log("error", `Could not reach origin system ${originSystem} — aborting pathfinder scan`);
    return;
  }
  ctx.log("travel", `At origin system ${originSystem}`);

  // ── Pre-flight stupidity check ──
  const fuel = await preflightFuelCheck(ctx, totalJumps);
  ctx.log("system", `=== Pathfinder fuel check ===`);
  ctx.log("system", `Tank fuel: ${bot.fuel}/${bot.maxFuel}  Military cells: ${fuel.militaryCells}x (${fuel.militaryCells * getFuelCellFuelValue("military_fuel_cell")} fuel)`);
  ctx.log("system", `Total available fuel: ${fuel.availableFuel}  Per-jump cost (this ship): ${fuel.fuelPerJump}`);
  ctx.log("system", `Planned jumps: ${fuel.totalJumps} (${numAngles} out + ${numAngles} back)  Needed: ${fuel.neededFuel} fuel`);
  ctx.log("system", `Jumps possible with current fuel: ${fuel.jumpsPossible}`);
  if (!fuel.ok) {
    ctx.log("error", `INSUFFICIENT FUEL: need ${fuel.neededFuel} for the full scan but only have ${fuel.availableFuel} (${fuel.jumpsPossible} jumps possible). Refuel or reduce scan angles before starting.`);
    return;
  }
  ctx.log("system", `Fuel check PASSED — enough fuel for the full scan.`);

  // Ensure origin position is known for return calculations
  await getSystemInfo(ctx);
  const originSys = mapStore.getSystem(originSystem);
  const originPos: GalacticPos | null = originSys?.position ?? null;
  if (!originPos) {
    ctx.log("warn", `Origin system ${originSystem} has no position data — return bearing cannot be calculated`);
  }

  const foundSystems: FoundSystem[] = [];

  for (let i = 0; i < numAngles && bot.state === "running"; i++) {
    const angle = (startDegree + i * scanStepDegrees) % 360;

    yield "scanning";

    ctx.log("hunt", `Scanning angle ${angle}° (${i + 1}/${numAngles})`);

    const jumped = await pathfinderJumpAtBearing(ctx, angle, originPos);
    if (!jumped.success) {
      ctx.log("error", `Pathfinder jump at ${angle}° failed — skipping angle`);
      if (bot.state !== "running") break;
      continue;
    }

    const landedSystem = jumped.landedSystem;
    const wasKnown = mapStore.getSystem(landedSystem) !== null;

    // Update tracked position from the jump result (computed or mapStore-exact).
    let currentPos: GalacticPos | null = jumped.arrivalPos;

    const atVoid = /void|empty|deep_space|interstellar|space/i.test(landedSystem);

    foundSystems.push({
      angle,
      systemId: landedSystem,
      systemName: landedSystem,
      known: wasKnown,
      atVoid,
    });

    if (atVoid) {
      ctx.log("hunt", `Angle ${angle}°: landed at void/empty space (no system)`);
    } else if (wasKnown) {
      ctx.log("hunt", `Angle ${angle}°: known system ${landedSystem}`);
    } else {
      ctx.log("hunt", `🎯 JACKPOT! Angle ${angle}°: discovered unknown/hidden system ${landedSystem}`);
    }

    // Wait to let distance accumulate before returning
    if (scanWaitMinutes > 0 && bot.state === "running") {
      ctx.log("system", `Waiting ${scanWaitMinutes} minute(s) before returning...`);
      await ctx.sleep(scanWaitMinutes * 60 * 1000);
    }

    if (bot.state !== "running") break;

    // Return to origin using x/y math from our tracked position.
    await returnToSystem(ctx, originSystem, currentPos, originPos);
    if (bot.state !== "running") break;

    // Delay between angles for aesthetic spacing on the fleet tracking map.
    // Set to 0 to skip (default 2 ticks = ~20 seconds).
    if (scanDelayTicks > 0 && bot.state === "running") {
      const startTick = await bot.pollCurrentTick();
      if (startTick !== null) {
        ctx.log("system", `Delaying ${scanDelayTicks} tick(s) between scan angles...`);
        while (bot.state === "running") {
          const now = await bot.pollCurrentTick();
          if (now !== null && now - startTick >= scanDelayTicks) break;
          await ctx.sleep(5000);
        }
      }
    }
  }

  // Final formatted report
  const knownCount = foundSystems.filter(f => f.known && !f.atVoid).length;
  const unknownCount = foundSystems.filter(f => !f.known && !f.atVoid).length;
  const voidCount = foundSystems.filter(f => f.atVoid).length;

  ctx.log("system", `=== Pathfinder Scan Complete ===`);
  ctx.log("system", `Origin: ${originSystem}`);
  ctx.log("system", `Angles scanned: ${numAngles} (start ${startDegree}°, step ${scanStepDegrees}°)`);
  ctx.log("system", `Systems found: ${foundSystems.length} (known: ${knownCount}, unknown/jackpot: ${unknownCount}, void: ${voidCount})`);

  if (foundSystems.length > 0) {
    ctx.log("system", `--- Targeted Systems List ---`);
    for (const f of foundSystems) {
      const tag = f.atVoid ? "[VOID]" : (f.known ? "KNOWN" : "UNKNOWN/JACKPOT");
      ctx.log("system", `${f.angle.toFixed(0)}°: ${f.systemId} — ${tag}`);
    }
    ctx.log("system", `--- End of List ---`);
  }

  ctx.log("system", `Back at ${bot.system} — pathfinder scan routine finished`);
  yield "done";
};
