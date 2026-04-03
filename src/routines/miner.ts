import type { Routine, RoutineContext } from "../bot.js";
import { mapStore, isDepletionExpired } from "../mapstore.js";
import { getSystemBlacklist } from "../web/server.js";
import {
  isOreBeltPoi,
  isGasCloudPoi,
  isIceFieldPoi,
  findStation,
  parseOreFromMineResult,
  collectFromStorage,
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  repairShip,
  ensureFueled,
  navigateToSystem,
  refuelAtStation,
  factionDonateProfit,
  readSettings,
  scavengeWrecks,
  detectAndRecoverFromDeath,
  getSystemInfo,
  sleep,
} from "./common.js";
import {
  getActiveMiningSession,
  startMiningSession,
  updateMiningSession,
  completeMiningSession,
  failMiningSession,
  createMiningSession,
  type MiningSession,
} from "./minerActivity.js";
import {
  type BattleState,
  handleBattleNotifications,
  getBattleStatus,
  fleeFromBattle,
} from "./common.js";

// ── Mission helpers ───────────────────────────────────────────

/** Mission types and keywords that are suitable for miners. */
const MINER_MISSION_KEYWORDS = [
  "mine_resource", "mine", "mining", "extract", "harvest",
  "copper_requisition", "iron_supply_run", "prove_your_steel",
];

/** Accept available mining missions at current station. Respects 5-mission cap. */
async function checkAndAcceptMinerMissions(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked) return;

  const activeResp = await bot.exec("get_active_missions");
  let activeCount = 0;
  if (activeResp.result && typeof activeResp.result === "object") {
    const r = activeResp.result as Record<string, unknown>;
    const list = Array.isArray(r) ? r : Array.isArray(r.missions) ? r.missions : [];
    activeCount = (list as unknown[]).length;
  }
  if (activeCount >= 5) return;

  const availResp = await bot.exec("get_missions");
  if (!availResp.result || typeof availResp.result !== "object") return;
  const r = availResp.result as Record<string, unknown>;
  const available = (
    Array.isArray(r) ? r :
    Array.isArray(r.missions) ? r.missions : []
  ) as Array<Record<string, unknown>>;

  for (const mission of available) {
    if (activeCount >= 5) break;
    const missionId = (mission.id as string) || (mission.mission_id as string) || "";
    if (!missionId) continue;
    const name = ((mission.name as string) || "").toLowerCase();
    const desc = ((mission.description as string) || "").toLowerCase();
    const type = ((mission.type as string) || "").toLowerCase();
    const isMinerMission = MINER_MISSION_KEYWORDS.some(kw =>
      name.includes(kw) || desc.includes(kw) || type.includes(kw)
    );
    if (!isMinerMission) continue;
    const acceptResp = await bot.exec("accept_mission", { mission_id: missionId });
    if (!acceptResp.error) {
      activeCount++;
      ctx.log("trade", `Mission accepted: ${(mission.name as string) || missionId} (${activeCount}/5 active)`);
    }
  }
}

/** Complete any active missions while docked. */
async function completeActiveMissions(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked) return;

  const activeResp = await bot.exec("get_active_missions");
  if (!activeResp.result || typeof activeResp.result !== "object") return;
  const r = activeResp.result as Record<string, unknown>;
  const missions = (
    Array.isArray(r) ? r :
    Array.isArray(r.missions) ? r.missions : []
  ) as Array<Record<string, unknown>>;

  for (const mission of missions) {
    const missionId = (mission.id as string) || (mission.mission_id as string) || "";
    if (!missionId) continue;
    const completeResp = await bot.exec("complete_mission", { mission_id: missionId });
    if (!completeResp.error) {
      const reward = (mission.reward as number) || (mission.reward_credits as number) || 0;
      ctx.log("trade", `Mission complete: ${(mission.name as string) || missionId}${reward > 0 ? ` (+${reward} credits)` : ""}`);
      await bot.refreshStatus();
    }
  }
}

// ── Settings ─────────────────────────────────────────────────

type DepositMode = "storage" | "faction" | "sell";
type MiningType = "auto" | "ore" | "gas" | "ice";

function getMinerSettings(username?: string): {
  miningType: MiningType;
  depositMode: DepositMode;
  depositFallback: DepositMode;
  cargoThreshold: number;
  refuelThreshold: number;
  repairThreshold: number;
  homeSystem: string;
  system: string;
  depositBot: string;
  targetOre: string;
  targetGas: string;
  targetIce: string;
  oreQuotas: Record<string, number>;
  gasQuotas: Record<string, number>;
  iceQuotas: Record<string, number>;
  depletionTimeoutHours: number;
  ignoreDepletion: boolean;
  stayOutUntilFull: boolean;
  maxJumps: number;
  escortName: string;
  escortSignalChannel: "faction" | "local" | "file";
} {
  const all = readSettings();
  const m = all.miner || {};
  const botOverrides = username ? (all[username] || {}) : {};

  function parseDepositMode(val: unknown): DepositMode | null {
    if (val === "faction" || val === "sell" || val === "storage") return val;
    return null;
  }

  function parseMiningType(val: unknown): MiningType | null {
    if (val === "auto" || val === "ore" || val === "gas" || val === "ice") return val;
    return null;
  }

  function parseSignalChannel(val: unknown): "faction" | "local" | "file" | null {
    if (val === "faction" || val === "local" || val === "file") return val;
    return null;
  }

  return {
    miningType:
      parseMiningType(botOverrides.miningType) ??
      parseMiningType(m.miningType) ?? "auto",
    depositMode:
      parseDepositMode(botOverrides.depositMode) ??
      parseDepositMode(m.depositMode) ?? "storage",
    depositFallback:
      parseDepositMode(botOverrides.depositFallback) ??
      parseDepositMode(m.depositFallback) ?? "storage",
    cargoThreshold: (m.cargoThreshold as number) || 80,
    refuelThreshold: (m.refuelThreshold as number) || 50,
    repairThreshold: (m.repairThreshold as number) || 40,
    homeSystem: (botOverrides.homeSystem as string) || (m.homeSystem as string) || "",
    system: (m.system as string) || "",
    depositBot: (botOverrides.depositBot as string) || (m.depositBot as string) || "",
    targetOre: (botOverrides.targetOre as string) || (m.targetOre as string) || "",
    targetGas: (botOverrides.targetGas as string) || (m.targetGas as string) || "",
    targetIce: (botOverrides.targetIce as string) || (m.targetIce as string) || "",
    oreQuotas: (m.oreQuotas as Record<string, number>) || {},
    gasQuotas: (m.gasQuotas as Record<string, number>) || {},
    iceQuotas: (m.iceQuotas as Record<string, number>) || {},
    depletionTimeoutHours: (m.depletionTimeoutHours as number) || 3,
    ignoreDepletion: (m.ignoreDepletion as boolean) ?? false,
    stayOutUntilFull: (m.stayOutUntilFull as boolean) ?? false,
    maxJumps: (m.maxJumps as number) ?? 10,
    escortName: (botOverrides.escortName as string) || (m.escortName as string) || "",
    escortSignalChannel:
      parseSignalChannel(botOverrides.escortSignalChannel) ??
      parseSignalChannel(m.escortSignalChannel) ?? "faction",
  };
}

/** Detect mining type from ship modules. */
async function detectMiningType(ctx: RoutineContext): Promise<"ore" | "gas" | "ice" | null> {
  const { bot } = ctx;
  const shipResp = await bot.exec("get_ship");
  if (shipResp.error) {
    ctx.log("error", `Failed to get ship info: ${shipResp.error.message}`);
    return null;
  }

  const shipData = shipResp.result as Record<string, unknown>;
  const modules = Array.isArray(shipData.modules) ? shipData.modules : [];

  let hasMiningLaser = false;
  let hasGasHarvester = false;
  let hasIceHarvester = false;

  for (const mod of modules) {
    const modObj = typeof mod === "object" && mod !== null ? mod as Record<string, unknown> : null;
    const modId = (modObj?.id as string) || (modObj?.type_id as string) || "";
    const modName = (modObj?.name as string) || "";
    const modType = (modObj?.type as string) || "";

    const checkStr = `${modId} ${modName} ${modType}`.toLowerCase();

    if (checkStr.includes("mining_laser") || checkStr.includes("mining laser")) {
      hasMiningLaser = true;
    }
    if (checkStr.includes("gas_harvester") || checkStr.includes("gas harvester")) {
      hasGasHarvester = true;
    }
    if (checkStr.includes("ice_harvester") || checkStr.includes("ice harvester")) {
      hasIceHarvester = true;
    }
  }

  // Priority: ice > gas > ore (if multiple types present, use settings preference)
  const detectedTypes: string[] = [];
  if (hasMiningLaser) detectedTypes.push("ore");
  if (hasGasHarvester) detectedTypes.push("gas");
  if (hasIceHarvester) detectedTypes.push("ice");

  if (detectedTypes.length > 1) {
    ctx.log("info", `Multiple mining modules detected (${detectedTypes.join(", ")}) — using settings preference`);
    return "ore"; // Default to ore if multiple present
  }
  if (hasIceHarvester) {
    ctx.log("info", "Ice harvester detected — ice mining mode");
    return "ice";
  }
  if (hasGasHarvester) {
    ctx.log("info", "Gas harvester detected — gas harvesting mode");
    return "gas";
  }
  if (hasMiningLaser) {
    ctx.log("info", "Mining laser detected — ore mining mode");
    return "ore";
  }

  ctx.log("error", "No mining equipment detected on ship");
  return null;
}

/** Get expected mining type for a resource ID. */
function getMiningTypeForResource(resourceId: string): "ore" | "gas" | "ice" {
  const lower = resourceId.toLowerCase();
  if (lower.includes("gas")) return "gas";
  if (lower.includes("ice")) return "ice";
  return "ore";
}

/** Pick target resource based on quota deficits. Returns the resource ID with biggest deficit. */
function pickTargetFromQuotas(
  quotas: Record<string, number>,
  factionStorage: Array<{ itemId: string; quantity: number }>,
  miningType: "ore" | "gas" | "ice"
): string {
  const entries: Array<{ resourceId: string; deficit: number; current: number; target: number }> = [];

  for (const [resourceId, target] of Object.entries(quotas)) {
    if (target <= 0) continue;
    const current = factionStorage.find(i => i.itemId === resourceId)?.quantity || 0;
    const deficit = target - current;
    if (deficit > 0) {
      entries.push({ resourceId, deficit, current, target });
    }
  }

  if (entries.length === 0) return "";

  // Sort: biggest deficit first
  entries.sort((a, b) => b.deficit - a.deficit);
  return entries[0].resourceId;
}

/** Find appropriate POI based on mining type. */
function findMiningPoi(
  pois: Array<{ id: string; name: string; type: string }>,
  miningType: "ore" | "gas" | "ice",
  targetResource?: string
): { id: string; name: string } | null {
  if (miningType === "ice") {
    // Ice mining
    if (targetResource) {
      for (const poi of pois) {
        if (isIceFieldPoi(poi.type)) {
          const sysData = mapStore.getSystem(poi.id.split("-")[0] || "");
          const storedPoi = sysData?.pois.find(p => p.id === poi.id);
          if (storedPoi?.ores_found.some(o => o.item_id === targetResource)) {
            return { id: poi.id, name: poi.name };
          }
        }
      }
    }
    // Fallback: any ice field
    const iceField = pois.find(p => isIceFieldPoi(p.type));
    return iceField ? { id: iceField.id, name: iceField.name } : null;
  } else if (miningType === "ore") {
    // Ore mining
    if (targetResource) {
      for (const poi of pois) {
        if (isOreBeltPoi(poi.type)) {
          const sysData = mapStore.getSystem(poi.id.split("-")[0] || "");
          const storedPoi = sysData?.pois.find(p => p.id === poi.id);
          if (storedPoi?.ores_found.some(o => o.item_id === targetResource)) {
            return { id: poi.id, name: poi.name };
          }
        }
      }
    }
    // Fallback: any ore belt
    const oreBelt = pois.find(p => isOreBeltPoi(p.type));
    return oreBelt ? { id: oreBelt.id, name: oreBelt.name } : null;
  } else {
    // Gas harvesting
    if (targetResource) {
      for (const poi of pois) {
        if (isGasCloudPoi(poi.type)) {
          const sysData = mapStore.getSystem(poi.id.split("-")[0] || "");
          const storedPoi = sysData?.pois.find(p => p.id === poi.id);
          if (storedPoi?.ores_found.some(o => o.item_id === targetResource)) {
            return { id: poi.id, name: poi.name };
          }
        }
      }
    }
    // Fallback: any gas cloud
    const gasCloud = pois.find(p => isGasCloudPoi(p.type));
    return gasCloud ? { id: gasCloud.id, name: gasCloud.name } : null;
  }
}

// ── Escort signaling ─────────────────────────────────────────

/**
 * Send a coordination signal to escort bots.
 * Uses faction chat by default, can also use local log or file.
 */
async function signalEscort(
  ctx: RoutineContext,
  action: "jump" | "travel" | "dock" | "undock",
  systemId?: string,
  channel: "faction" | "local" | "file" = "faction",
): Promise<void> {
  const { bot } = ctx;
  const message = `[ESCORT] ${action}${systemId ? ` ${systemId}` : ""}`;

  if (channel === "faction") {
    await bot.exec("chat", { channel: "faction", content: message });
  } else if (channel === "local") {
    ctx.log("escort", `Signal: ${message}`);
  } else {
    // File-based signaling for cross-bot coordination on same machine
    const { writeFileSync, existsSync, mkdirSync } = await import("fs");
    const { join } = await import("path");
    const escortDir = join(process.cwd(), "data", "escort_signals");
    if (!existsSync(escortDir)) mkdirSync(escortDir, { recursive: true });
    const signalFile = join(escortDir, `${bot.username}.signal`);
    writeFileSync(signalFile, JSON.stringify({ action, systemId, timestamp: Date.now() }));
  }
}

// ── Miner routine ────────────────────────────────────────────

export const minerRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();
  const settings0 = getMinerSettings(bot.username);
  const homeSystem = settings0.homeSystem || bot.system;

  // ── Mining session recovery ──
  const activeSession = getActiveMiningSession(bot.username);
  let recoveredSession: MiningSession | null = null;
  if (activeSession) {
    ctx.log("mining", `Found incomplete mining session: ${activeSession.targetResourceName} (${activeSession.state})`);
    // Validate session - check if target resource is still valid
    if (activeSession.targetResourceId) {
      const locations = mapStore.findOreLocations(activeSession.targetResourceId);
      if (locations.length > 0) {
        ctx.log("mining", `Session validated: ${activeSession.targetResourceName} still available in map`);
        recoveredSession = activeSession;
      } else {
        ctx.log("error", `Session invalid: ${activeSession.targetResourceName} no longer in map - abandoning`);
        failMiningSession(bot.username, "Target resource no longer in map");
      }
    } else {
      ctx.log("error", "Session invalid: no target resource - abandoning");
      failMiningSession(bot.username, "No target resource");
    }
  }

  // ── Startup: return home and dump non-fuel cargo to storage ──
  await bot.refreshStatus();
  await bot.refreshCargo();
  const nonFuelCargo = bot.inventory.filter(i => {
    const lower = i.itemId.toLowerCase();
    return !lower.includes("fuel") && !lower.includes("energy_cell") && i.quantity > 0;
  });
  if (nonFuelCargo.length > 0) {
    // Validate bot.system before navigation
    if (!bot.system) {
      ctx.log("error", "Bot system not initialized — refreshing status...");
      await bot.refreshStatus();
    }
    if (bot.system && bot.system !== homeSystem) {
      ctx.log("harvesting", `Startup: returning to home system ${homeSystem} to deposit cargo...`);
      const fueled = await ensureFueled(ctx, 50);
      if (fueled) {
        await navigateToSystem(ctx, homeSystem, { fuelThresholdPct: 50, hullThresholdPct: 30 });
      }
    } else if (!bot.system) {
      ctx.log("error", "Cannot return home — bot system unknown");
    }
    await ensureDocked(ctx);
    const startupSettings = getMinerSettings(bot.username);
    for (const item of nonFuelCargo) {
      if (startupSettings.depositMode === "faction") {
        const fResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
        if (fResp.error) {
          await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
        }
      } else {
        await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
      }
    }
    const names = nonFuelCargo.map(i => `${i.quantity}x ${i.name}`).join(", ");
    ctx.log("harvesting", `Startup: deposited ${names} — cargo clear for harvesting`);
  }

  // ── Startup: accept missions after docking ──
  await completeActiveMissions(ctx);
  await checkAndAcceptMinerMissions(ctx);

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await sleep(30000); continue; }

    // ── Battle state tracking (per-cycle initialization) ──
    const battleState: BattleState = {
      inBattle: false,
      battleId: null,
      battleStartTick: null,
      lastHitTick: null,
      isFleeing: false,
    };

    const settings = getMinerSettings(bot.username);
    const cargoThresholdRatio = settings.cargoThreshold / 100;
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
    };
    const depletionTimeoutMs = settings.depletionTimeoutHours * 60 * 60 * 1000;

    // ── Re-evaluate mining type and target from settings each cycle ──
    let miningType: "ore" | "gas" | "ice" = "ore";
    if (settings.miningType === "auto") {
      const detected = await detectMiningType(ctx);
      if (!detected) {
        ctx.log("error", "Cannot determine mining type — please check ship equipment");
        await sleep(30000);
        continue;
      }
      miningType = detected;
    } else {
      miningType = settings.miningType;
    }

    const targetResource = miningType === "ice" ? settings.targetIce : (miningType === "ore" ? settings.targetOre : settings.targetGas);
    const resourceLabel = miningType === "ice" ? "ice" : (miningType === "ore" ? "ore" : "gas");

    // Log mining configuration (re-checked each cycle)
    if (targetResource) {
      ctx.log("mining", `Target ${resourceLabel}: ${targetResource} (mode: ${settings.miningType})`);
    } else {
      ctx.log("mining", `Mining any ${resourceLabel} (no specific target configured)`);
    }

    // ── Select quotas based on mining type ──
    const quotas = miningType === "ice" ? settings.iceQuotas : (miningType === "ore" ? settings.oreQuotas : settings.gasQuotas);

    // ── Determine priority target (global target or quota pick) ──
    const hasGlobalTarget = !!targetResource;
    if (hasGlobalTarget) {
      ctx.log("mining", `Global ${resourceLabel} target configured: ${targetResource} — overriding quotas`);
    }

    let quotaTargetResource = "";
    if (!hasGlobalTarget && Object.keys(quotas).length > 0) {
      await bot.refreshFactionStorage();
      quotaTargetResource = pickTargetFromQuotas(quotas, bot.factionStorage, miningType);
      if (quotaTargetResource) {
        ctx.log("mining", `Quota pick: ${quotaTargetResource} (biggest deficit)`);
      } else {
        ctx.log("mining", "All quotas met — mining locally");
      }
    }

    const priorityTarget = hasGlobalTarget ? targetResource : quotaTargetResource;

    // ── Recovered session handling ──
    // Validate recovered session against current priorities (global target and quotas)
    if (recoveredSession) {
      // Validate that the recovered session's target is compatible with currently detected mining type
      const sessionMiningType = getMiningTypeForResource(recoveredSession.targetResourceId);
      if (sessionMiningType !== miningType) {
        ctx.log("warn", `Recovered session target (${recoveredSession.targetResourceName}) incompatible with detected equipment (${miningType}) — discarding session`);
        failMiningSession(bot.username, "Equipment mismatch");
        recoveredSession = null;
      } else {
        // Check if recovered session target matches current priorities
        const sessionTarget = recoveredSession.targetResourceId;
        let shouldAbandon = false;
        let reason = "";

        // If there's a priority target (global or quota) that differs from session target, abandon session
        if (priorityTarget && sessionTarget !== priorityTarget) {
          shouldAbandon = true;
          reason = hasGlobalTarget ? `global target override (${targetResource})` : `quota priority (${quotaTargetResource})`;
        }

        if (shouldAbandon) {
          ctx.log("mining", `Abandoning recovered session: ${reason}`);
          failMiningSession(bot.username, reason);
          recoveredSession = null;
        } else {
          ctx.log("mining", `Resuming recovered session: ${recoveredSession.targetResourceName} @ ${recoveredSession.targetPoiName}`);
          // Update session state based on current position
          if (bot.system === recoveredSession.homeSystem && bot.docked) {
            recoveredSession.state = "depositing";
          } else if (bot.system === recoveredSession.targetSystemId) {
            recoveredSession.state = "mining";
          } else {
            recoveredSession.state = "traveling_to_ore";
          }
          updateMiningSession(bot.username, { state: recoveredSession.state });
        }
      }
    }

    // ── Determine effective target ──
    const effectiveTarget = recoveredSession ? recoveredSession.targetResourceId : priorityTarget;
    const isQuotaDriven = recoveredSession ? recoveredSession.isQuotaDriven : !!quotaTargetResource;

    // ── Status + fuel/hull checks ──
    yield "get_status";
    await bot.refreshStatus();

    yield "fuel_check";
    const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
    if (!fueled) {
      ctx.log("error", "Cannot refuel — waiting 30s...");
      await sleep(30000);
      continue;
    }

    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (hullPct <= 40) {
      ctx.log("system", `Hull critical (${hullPct}%) — returning to station for repair`);
      await ensureDocked(ctx);
      await repairShip(ctx);
    }

    // Signal escorts that we're undocking (they should prepare to follow)
    if (settings.escortName) {
      ctx.log("escort", "Signaling escorts: miner undocking...");
      await signalEscort(ctx, "undock", undefined, settings.escortSignalChannel);
    }

    await ensureUndocked(ctx);

    // ── Determine mining destination ──
    yield "find_destination";
    let targetSystemId = "";
    let targetPoiId = "";
    let targetPoiName = "";

    // If harvesting system is configured, prefer it
    const configuredSystem = settings.system;
    const maxJumps = settings.maxJumps || 10;

    if (effectiveTarget) {
      const allLocations = mapStore.findOreLocations(effectiveTarget);
      // Filter to matching POI type only (skip depleted)
      const locations = allLocations.filter(loc => {
        const sys = mapStore.getSystem(loc.systemId);
        const poi = sys?.pois.find(p => p.id === loc.poiId);
        if (!poi) return true; // keep if type unknown
        if (miningType === "ore") return isOreBeltPoi(poi.type);
        if (miningType === "gas") return isGasCloudPoi(poi.type);
        if (miningType === "ice") return isIceFieldPoi(poi.type);
        return true;
      }).filter(loc => {
        // Skip depleted ores (unless depletion has expired or ignoreDepletion is enabled)
        if (settings.ignoreDepletion) return true; // ignore depletion markings, mine anyway
        const sys = mapStore.getSystem(loc.systemId);
        const poi = sys?.pois.find(p => p.id === loc.poiId);
        const oreEntry = poi?.ores_found.find(o => o.item_id === effectiveTarget);
        if (!oreEntry?.depleted) return true;
        // Depleted but expired - can re-check
        return isDepletionExpired(oreEntry.depleted_at, depletionTimeoutMs);
      });

      if (locations.length === 0) {
        ctx.log("error", `Target ${resourceLabel} "${effectiveTarget}" not found in map — mining locally in ${bot.system}`);
        targetSystemId = bot.system;
        // Clear session if target not found
        if (recoveredSession) {
          failMiningSession(bot.username, "Target resource not found in map");
          recoveredSession = null;
        }
      } else {
        // Calculate jump distances and filter by maxJumps (use blacklist to avoid pirate systems)
        const blacklist = getSystemBlacklist();
        const locationsWithDistance = locations
          .map(loc => {
            const route = mapStore.findRoute(bot.system, loc.systemId, blacklist);
            const jumps = route ? route.length - 1 : 999;
            return { ...loc, jumps };
          })
          .filter(loc => loc.jumps <= maxJumps)
          .sort((a, b) => {
            // Sort by: jumps ascending, then hasStation descending, then totalMined descending
            if (a.jumps !== b.jumps) return a.jumps - b.jumps;
            if (a.hasStation !== b.hasStation) return (b.hasStation ? 1 : 0) - (a.hasStation ? 1 : 0);
            return b.totalMined - a.totalMined;
          });

        if (locationsWithDistance.length === 0) {
          ctx.log("warn", `No ${effectiveTarget} locations within ${maxJumps} jumps — mining locally instead`);
          targetSystemId = bot.system;
        } else {
          // Prefer location in configured harvesting system if set (regardless of distance)
          let chosenLoc: typeof locationsWithDistance[0] | undefined;
          if (configuredSystem) {
            chosenLoc = locationsWithDistance.find(loc => loc.systemId === configuredSystem);
            if (chosenLoc) {
              ctx.log("mining", `Found ${effectiveTarget} in configured harvesting system ${configuredSystem} (${chosenLoc.jumps} jumps)`);
            }
          }
          // If no location in configured system, prefer current system (0 jumps)
          if (!chosenLoc) {
            chosenLoc = locationsWithDistance.find(loc => loc.systemId === bot.system);
            if (chosenLoc) {
              ctx.log("mining", `Found ${effectiveTarget} in current system ${bot.system}`);
            }
          }
          // Pick best available (already sorted by jumps, station, totalMined)
          if (!chosenLoc) {
            chosenLoc = locationsWithDistance[0];
            ctx.log("mining", `Selected ${effectiveTarget} at ${chosenLoc.poiName} (${chosenLoc.jumps} jumps, ${chosenLoc.hasStation ? 'has station' : 'no station'}, ${chosenLoc.totalMined} total mined)`);
          }

          targetSystemId = chosenLoc.systemId;
          targetPoiId = chosenLoc.poiId;
          targetPoiName = chosenLoc.poiName;

          // Create mining session if we don't have one and we're traveling to a new target
          if (!recoveredSession && targetSystemId !== bot.system) {
            const sysData = mapStore.getSystem(targetSystemId);
            const session = createMiningSession({
              botUsername: bot.username,
              miningType: miningType,
              targetResourceId: effectiveTarget,
              targetResourceName: effectiveTarget,
              targetSystemId,
              targetSystemName: sysData?.name || targetSystemId,
              targetPoiId,
              targetPoiName,
              homeSystem,
              isQuotaDriven,
              quotaTarget: isQuotaDriven ? (quotas[effectiveTarget] || 0) : undefined,
            });
            startMiningSession(session);
            recoveredSession = session;
            ctx.log("mining", `Started mining session: ${session.targetResourceName} @ ${session.targetPoiName}`);
          }
        }
      }
    } else {
      // No specific target - mine in configured harvesting system or locally
      if (configuredSystem && configuredSystem !== bot.system) {
        ctx.log("mining", `No specific target - traveling to configured harvesting system ${configuredSystem}`);
        targetSystemId = configuredSystem;
      } else {
        ctx.log("mining", `No specific ${resourceLabel} target - mining locally in ${bot.system}`);
        targetSystemId = bot.system;
      }
      // Clear any active session since we're mining without a specific target
      if (recoveredSession) {
        completeMiningSession(bot.username);
        recoveredSession = null;
      }
    }

    // ── Navigate to target system if needed ──
    if (targetSystemId && targetSystemId !== bot.system) {
      yield "navigate_to_target";
      if (recoveredSession) {
        updateMiningSession(bot.username, { state: "traveling_to_ore" });
      }

      // Signal escorts before jumping
      const minerSettings = getMinerSettings(bot.username);
      if (minerSettings.escortName) {
        ctx.log("escort", `Signaling escorts to jump to ${targetSystemId}...`);
        await signalEscort(ctx, "jump", targetSystemId, minerSettings.escortSignalChannel);
        await sleep(2000); // Brief pause to let escorts read the signal
      }

      const arrived = await navigateToSystem(ctx, targetSystemId, safetyOpts);
      if (!arrived) {
        ctx.log("error", "Failed to reach target system — mining locally instead");
        targetSystemId = bot.system;
        targetPoiId = "";
        targetPoiName = "";
        if (recoveredSession) {
          updateMiningSession(bot.username, { state: "mining" });
        }
      }
    }

    if (bot.state !== "running") break;

    // ── Find mining POI and station in current system ──
    yield miningType === "ice" ? "find_ice_field" : (miningType === "ore" ? "find_ore_belt" : "find_gas_cloud");
    const { pois: initialPois, systemId } = await getSystemInfo(ctx);
    if (systemId) bot.system = systemId;

    let pois = initialPois;
    let miningPoi: { id: string; name: string } | null = null;
    let stationPoi: { id: string; name: string } | null = null;

    const station = findStation(pois);
    if (station) stationPoi = { id: station.id, name: station.name };

    // If targeting a specific POI, prefer it
    if (targetPoiId) {
      const match = pois.find(p => p.id === targetPoiId);
      if (match) {
        miningPoi = { id: match.id, name: match.name };
      }
    }

    // Fallback: find POI with target resource (skip depleted unless expired)
    if (!miningPoi && effectiveTarget) {
      for (const poi of pois) {
        const isMatchingType =
          (miningType === "ice" && isIceFieldPoi(poi.type)) ||
          (miningType === "ore" && isOreBeltPoi(poi.type)) ||
          (miningType === "gas" && isGasCloudPoi(poi.type));

        if (!isMatchingType) continue;

        // Check stored depletion status - skip if depleted and not expired
        const sysData = mapStore.getSystem(bot.system);
        const storedPoi = sysData?.pois.find(p => p.id === poi.id);
        const oreEntry = storedPoi?.ores_found.find(o => o.item_id === effectiveTarget);

        if (oreEntry && oreEntry.depleted && !isDepletionExpired(oreEntry.depleted_at, depletionTimeoutMs)) {
          if (settings.ignoreDepletion) {
            ctx.log("mining", `Mining depleted ${effectiveTarget} at ${poi.name} (ignoreDepletion enabled)`);
          } else {
            ctx.log("mining", `Skipping ${poi.name}: ${effectiveTarget} is depleted (waiting for timeout)`);
            continue;
          }
        }

        // Found a viable POI (not marked depleted in cache)
        miningPoi = { id: poi.id, name: poi.name };
        break;
      }
    }

    // Fallback: any matching POI type
    if (!miningPoi) {
      if (miningType === "ice") {
        const iceField = pois.find(p => isIceFieldPoi(p.type));
        if (iceField) miningPoi = { id: iceField.id, name: iceField.name };
      } else if (miningType === "ore") {
        const oreBelt = pois.find(p => isOreBeltPoi(p.type));
        if (oreBelt) miningPoi = { id: oreBelt.id, name: oreBelt.name };
      } else if (miningType === "gas") {
        const gasCloud = pois.find(p => isGasCloudPoi(p.type));
        if (gasCloud) miningPoi = { id: gasCloud.id, name: gasCloud.name };
      }
    }

    if (!miningPoi) {
      ctx.log("error", `No ${resourceLabel} field/cloud found in this system — waiting 30s before retry`);
      await sleep(30000);
      continue;
    }

    // ── Travel to mining location ──
    yield miningType === "ice" ? "travel_to_ice_field" : (miningType === "ore" ? "travel_to_belt" : "travel_to_cloud");
    const travelResp = await bot.exec("travel", { target_poi: miningPoi.id });
    
    // Check for battle notifications during travel
    if (travelResp.notifications && Array.isArray(travelResp.notifications)) {
      const battleDetected = await handleBattleNotifications(ctx, travelResp.notifications, battleState);
      if (battleDetected) {
        ctx.log("error", "Battle detected during travel - fleeing!");
        await sleep(5000);
        continue;
      }
    }
    
    if (travelResp.error && !travelResp.error.message.includes("already")) {
      ctx.log("error", `Travel failed: ${travelResp.error.message}`);
      await sleep(5000);
      continue;
    }
    bot.poi = miningPoi.id;

    // Check for pirates at mining location
    const nearbyResp = await bot.exec("get_nearby");

    // Check for battle notifications in get_nearby response
    if (nearbyResp.notifications && Array.isArray(nearbyResp.notifications)) {
      const battleDetected = await handleBattleNotifications(ctx, nearbyResp.notifications, battleState);
      if (battleDetected) {
        ctx.log("error", "Battle detected at mining location - fleeing!");
        await sleep(30000);
        continue;
      }
    }

    // Also check battle status directly (in case we missed notifications)
    const directBattleStatus = await getBattleStatus(ctx);
    if (directBattleStatus && directBattleStatus.is_participant) {
      ctx.log("combat", `Direct battle status check: IN BATTLE (ID: ${directBattleStatus.battle_id}) - fleeing!`);
      await fleeFromBattle(ctx, true, 35000);
      ctx.log("error", "Battle detected via status check - fled, will retry mining");
      await sleep(30000);
      continue;
    }

    if (nearbyResp.result && typeof nearbyResp.result === "object") {
      const { checkAndFleeFromPirates } = await import("./common.js");
      const fled = await checkAndFleeFromPirates(ctx, nearbyResp.result);
      if (fled) {
        ctx.log("error", "Pirates detected - fled mining location, will retry");
        await sleep(30000);
        continue;
      }
    }

    // Update session state to mining
    if (recoveredSession) {
      updateMiningSession(bot.username, {
        state: "mining",
        targetPoiId: miningPoi.id,
        targetPoiName: miningPoi.name,
      });
    }

    // ── Scavenge wrecks before harvesting ──
    yield "scavenge";
    await scavengeWrecks(ctx);

    // ── Harvest loop: mine until cargo threshold ──
    yield "harvest_loop";
    let harvestCycles = 0;
    let stopReason = "";
    const resourcesMinedMap = new Map<string, number>();
    let lastPoiCheck = 0;
    let lastBattleCheck = 0;
    const POI_CHECK_INTERVAL_MS = 60_000; // Check POI remaining every 60 seconds
    const BATTLE_CHECK_INTERVAL_MS = 8_000; // Check battle status every 8 seconds (< 1 game tick)

    while (bot.state === "running") {
      await bot.refreshStatus();

      const midHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
      if (midHull <= 40) { stopReason = `hull critical (${midHull}%)`; break; }

      const midFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      if (midFuel < safetyOpts.fuelThresholdPct) { stopReason = `fuel low (${midFuel}%)`; break; }

      // Periodic battle status check (backup detection in case notifications fail)
      const now = Date.now();
      if ((now - lastBattleCheck) > BATTLE_CHECK_INTERVAL_MS) {
        lastBattleCheck = now;
        const battleStatusCheck = await getBattleStatus(ctx);
        if (battleStatusCheck && battleStatusCheck.is_participant) {
          ctx.log("combat", `PERIODIC CHECK: IN BATTLE! Battle ID: ${battleStatusCheck.battle_id} - fleeing!`);
          battleState.inBattle = true;
          battleState.battleId = battleStatusCheck.battle_id;
          await fleeFromBattle(ctx, true, 35000);
          stopReason = "battle detected (status check)";
          break;
        }
      }

      // If we're in battle, re-issue flee command every cycle to ensure we stay in flee stance
      if (battleState.inBattle) {
        ctx.log("combat", "Re-issuing flee stance (ensuring we stay in flee mode)...");
        const fleeResp = await bot.exec("battle", { action: "stance", stance: "flee" });
        if (fleeResp.error) {
          ctx.log("error", `Flee re-issue failed: ${fleeResp.error.message}`);
        }
        // Check if we've successfully disengaged
        const currentBattleStatus = await getBattleStatus(ctx);
        if (!currentBattleStatus || !currentBattleStatus.is_participant) {
          ctx.log("combat", "Battle cleared - no longer in combat!");
          battleState.inBattle = false;
          battleState.battleId = null;
          battleState.isFleeing = false;
          stopReason = "battle escaped successfully";
          break;
        }
        // Still in battle - continue to next cycle to re-flee again
        await sleep(2000); // Brief pause before next flee attempt
        continue;
      }

      // Periodically check POI to see if resource is depleted (remaining: 0)
      if (effectiveTarget && bot.poi && !settings.ignoreDepletion &&
          (now - lastPoiCheck) > POI_CHECK_INTERVAL_MS) {
        lastPoiCheck = now;
        const poiResp = await bot.exec("get_poi", { poi_id: bot.poi });
        if (!poiResp.error && poiResp.result) {
          const result = poiResp.result as Record<string, unknown>;
          const resources = Array.isArray(result.resources)
            ? (result.resources as Array<Record<string, unknown>>)
            : Array.isArray((result.poi as Record<string, unknown>)?.resources)
            ? ((result.poi as Record<string, unknown>).resources as Array<Record<string, unknown>>)
            : [];

          for (const res of resources) {
            const resId = (res.resource_id as string) || (res.id as string) || "";
            if (resId === effectiveTarget) {
              const remaining = (res.remaining as number) ?? (res.quantity as number) ?? null;
              if (remaining !== null && remaining <= 0) {
                ctx.log("mining", `POI check: ${effectiveTarget} is depleted (remaining: ${remaining})`);
                mapStore.markOreDepleted(bot.system, bot.poi, effectiveTarget);
                
                // If stayOutUntilFull is enabled and cargo is not full, search for new POI
                if (settings.stayOutUntilFull) {
                  const fillRatio = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
                  if (fillRatio < cargoThresholdRatio) {
                    ctx.log("mining", "stayOutUntilFull enabled and cargo not full — searching for next POI...");
                    // Search for next available POI with same target
                    const newLocs = mapStore.findOreLocations(effectiveTarget).filter(loc => {
                      if (loc.poiId === bot.poi && loc.systemId === bot.system) return false; // Skip current POI
                      const sys = mapStore.getSystem(loc.systemId);
                      const poi = sys?.pois.find(p => p.id === loc.poiId);
                      if (miningType === "ore") return isOreBeltPoi(poi?.type || "");
                      if (miningType === "gas") return isGasCloudPoi(poi?.type || "");
                      if (miningType === "ice") return isIceFieldPoi(poi?.type || "");
                      return true;
                    }).filter(loc => {
                      const sys = mapStore.getSystem(loc.systemId);
                      const poi = sys?.pois.find(p => p.id === loc.poiId);
                      const oreEntry = poi?.ores_found.find(o => o.item_id === effectiveTarget);
                      if (!oreEntry?.depleted) return true;
                      return isDepletionExpired(oreEntry.depleted_at, depletionTimeoutMs);
                    });

                    if (newLocs.length > 0) {
                      const blacklist = getSystemBlacklist();
                      const locsWithDist = newLocs
                        .map(loc => {
                          const route = mapStore.findRoute(bot.system, loc.systemId, blacklist);
                          return { ...loc, jumps: route ? route.length - 1 : 999 };
                        })
                        .filter(loc => loc.jumps <= maxJumps)
                        .sort((a, b) => {
                          if (a.systemId === bot.system && b.systemId !== bot.system) return -1;
                          if (b.systemId === bot.system && a.systemId !== bot.system) return 1;
                          return a.jumps - b.jumps;
                        });

                      if (locsWithDist.length > 0) {
                        const chosen = locsWithDist[0];
                        ctx.log("mining", `Found next target: ${effectiveTarget} @ ${chosen.poiName} in ${chosen.systemId} (${chosen.jumps} jumps)`);
                        
                        // Travel to new system if needed
                        if (chosen.systemId !== bot.system) {
                          const arrived = await navigateToSystem(ctx, chosen.systemId, safetyOpts);
                          if (arrived) {
                            const { pois: newPois } = await getSystemInfo(ctx);
                            pois = newPois;
                            bot.system = chosen.systemId;
                          } else {
                            ctx.log("error", "Failed to reach new system");
                          }
                        }
                        
                        // Travel to new POI
                        const travelResp = await bot.exec("travel", { target_poi: chosen.poiId });
                        
                        // Check for battle notifications
                        if (travelResp.notifications && Array.isArray(travelResp.notifications)) {
                          const battleDetected = await handleBattleNotifications(ctx, travelResp.notifications, battleState);
                          if (battleDetected) {
                            ctx.log("combat", "Battle detected while changing POI - initiating flee!");
                            // Don't break - let the flee handling in main loop re-issue every cycle
                            battleState.isFleeing = false;
                          }
                        }
                        
                        if (!travelResp.error || travelResp.error.message.includes("already")) {
                          bot.poi = chosen.poiId;
                          miningPoi = { id: chosen.poiId, name: chosen.poiName };
                          ctx.log("mining", `Continuing at new POI: ${chosen.poiName}`);
                          lastPoiCheck = 0; // Reset POI check timer
                          continue; // Continue mining
                        }
                      }
                    }
                    ctx.log("mining", "No alternative POI found within range");
                  }
                }
                
                stopReason = `${effectiveTarget} depleted at this POI`;
                if (recoveredSession) {
                  failMiningSession(bot.username, "Resource depleted");
                  recoveredSession = null;
                }
                break;
              } else if (remaining !== null) {
                ctx.log("mining", `POI check: ${effectiveTarget} remaining: ${remaining}`);
              }
            }
          }
        }
        if (stopReason) break;
      }

      // Pre-mine battle check - prevents mine command from freezing if battle starts
      const preMineBattleCheck = await getBattleStatus(ctx);
      if (preMineBattleCheck && preMineBattleCheck.is_participant) {
        ctx.log("combat", `PRE-MINE CHECK: IN BATTLE! Battle ID: ${preMineBattleCheck.battle_id} - initiating flee!`);
        battleState.inBattle = true;
        battleState.battleId = preMineBattleCheck.battle_id;
        battleState.isFleeing = false;
        // Don't break - let the flee handling below re-issue flee every cycle
        await fleeFromBattle(ctx, false, 5000); // Initial flee, don't wait for disengage
      }

      const mineResp = await bot.exec("mine");

      // Check for battle notifications after mining
      if (mineResp.notifications && Array.isArray(mineResp.notifications)) {
        const battleDetected = await handleBattleNotifications(ctx, mineResp.notifications, battleState);
        if (battleDetected) {
          ctx.log("combat", "Battle detected while mining - initiating flee (will re-issue every cycle)!");
          // Don't break - let the flee handling below re-issue flee every cycle
          battleState.isFleeing = false; // Reset so the loop will re-issue
        }
      }

      if (mineResp.error) {
        const msg = mineResp.error.message.toLowerCase();
        if (msg.includes("depleted") || msg.includes("no resources") || msg.includes("no gas") || msg.includes("no ice") || msg.includes("no minable")) {
          // Mark this ore as depleted in the map (unless ignoreDepletion is enabled)
          if (effectiveTarget && bot.poi && !settings.ignoreDepletion) {
            mapStore.markOreDepleted(bot.system, bot.poi, effectiveTarget);
            ctx.log("mining", `Marked ${effectiveTarget} at ${bot.poi} as depleted`);
          }
          // Re-pick a new target from quotas, or find any nearby ore if no quotas remain
          ctx.log("mining", `${resourceLabel} field depleted — searching for new target...`);

          // Try to find a new target from quotas
          await bot.refreshFactionStorage();
          const newQuotaTarget = pickTargetFromQuotas(quotas, bot.factionStorage, miningType);

          let newTarget: string | null = null;
          let newPoiId: string | null = null;
          let newPoiName: string | null = null;
          let newSystemId: string | null = null;

          if (newQuotaTarget) {
            // Find locations for the new quota target
            const newLocs = mapStore.findOreLocations(newQuotaTarget).filter(loc => {
              const sys = mapStore.getSystem(loc.systemId);
              const poi = sys?.pois.find(p => p.id === loc.poiId);
              if (miningType === "ore") return isOreBeltPoi(poi?.type || "");
              if (miningType === "gas") return isGasCloudPoi(poi?.type || "");
              if (miningType === "ice") return isIceFieldPoi(poi?.type || "");
              return true;
            }).filter(loc => {
              if (settings.ignoreDepletion) return true;
              const sys = mapStore.getSystem(loc.systemId);
              const poi = sys?.pois.find(p => p.id === loc.poiId);
              const oreEntry = poi?.ores_found.find(o => o.item_id === newQuotaTarget);
              if (!oreEntry?.depleted) return true;
              return isDepletionExpired(oreEntry.depleted_at, depletionTimeoutMs);
            });

            if (newLocs.length > 0) {
              newTarget = newQuotaTarget;
              // Prefer current system, then closest by jumps (use blacklist)
              const blacklist = getSystemBlacklist();
              const locsWithDist = newLocs
                .map(loc => {
                  const route = mapStore.findRoute(bot.system, loc.systemId, blacklist);
                  return { ...loc, jumps: route ? route.length - 1 : 999 };
                })
                .filter(loc => loc.jumps <= maxJumps)
                .sort((a, b) => {
                  if (a.systemId === bot.system && b.systemId !== bot.system) return -1;
                  if (b.systemId === bot.system && a.systemId !== bot.system) return 1;
                  return a.jumps - b.jumps;
                });

              if (locsWithDist.length > 0) {
                const chosen = locsWithDist[0];
                newPoiId = chosen.poiId;
                newPoiName = chosen.poiName;
                newSystemId = chosen.systemId;
                ctx.log("mining", `Quota pick: ${newQuotaTarget} @ ${chosen.poiName} (${chosen.jumps} jumps${chosen.systemId !== bot.system ? ` in ${chosen.systemId}` : ''})`);
              }
            }
          }

          // If no quota target found and we're set for "any", find any nearby ore
          if (!newTarget && !targetResource) {
            // First try current system
            const allPois = miningType === "ice" ? pois.filter(p => isIceFieldPoi(p.type)) :
                           miningType === "ore" ? pois.filter(p => isOreBeltPoi(p.type)) :
                           pois.filter(p => isGasCloudPoi(p.type));

            for (const poi of allPois) {
              const sysData = mapStore.getSystem(bot.system);
              const storedPoi = sysData?.pois.find(p => p.id === poi.id);
              const availableOres = storedPoi?.ores_found.filter(o => {
                if (miningType === "ice" && !o.item_id.toLowerCase().includes("ice")) return false;
                if (miningType === "gas" && !o.item_id.toLowerCase().includes("gas")) return false;
                if (miningType === "ore" && (o.item_id.toLowerCase().includes("gas") || o.item_id.toLowerCase().includes("ice"))) return false;
                if (!o.depleted) return true;
                return isDepletionExpired(o.depleted_at, depletionTimeoutMs);
              }) || [];

              if (availableOres.length > 0) {
                newTarget = availableOres[0].item_id;
                newPoiId = poi.id;
                newPoiName = poi.name;
                newSystemId = bot.system;
                ctx.log("mining", `Found ${newTarget} @ ${poi.name} (no quota, mining any)`);
                break;
              }
            }

            // If stayOutUntilFull is enabled and cargo is not full, search other systems
            if (!newTarget && settings.stayOutUntilFull) {
              const fillRatio = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
              if (fillRatio < cargoThresholdRatio) {
                ctx.log("mining", "stayOutUntilFull enabled and cargo not full — searching other systems...");
                // Search all known systems for available POIs
                const allSystems = mapStore.getSystems();
                for (const sys of allSystems) {
                  if (sys.id === bot.system) continue; // Skip current system (already checked)
                  const sysPois = sys.pois.filter(p => {
                    if (miningType === "ice") return isIceFieldPoi(p.type);
                    if (miningType === "ore") return isOreBeltPoi(p.type);
                    if (miningType === "gas") return isGasCloudPoi(p.type);
                    return true;
                  });

                  for (const poi of sysPois) {
                    const availableOres = poi.ores_found.filter(o => {
                      if (miningType === "ice" && !o.item_id.toLowerCase().includes("ice")) return false;
                      if (miningType === "gas" && !o.item_id.toLowerCase().includes("gas")) return false;
                      if (miningType === "ore" && (o.item_id.toLowerCase().includes("gas") || o.item_id.toLowerCase().includes("ice"))) return false;
                      if (!o.depleted) return true;
                      return isDepletionExpired(o.depleted_at, depletionTimeoutMs);
                    });

                    if (availableOres.length > 0) {
                      // Check jump distance
                      const blacklist = getSystemBlacklist();
                      const route = mapStore.findRoute(bot.system, sys.id, blacklist);
                      const jumps = route ? route.length - 1 : 999;
                      if (jumps <= maxJumps) {
                        newTarget = availableOres[0].item_id;
                        newPoiId = poi.id;
                        newPoiName = poi.name;
                        newSystemId = sys.id;
                        ctx.log("mining", `Found ${newTarget} @ ${poi.name} in ${sys.id} (${jumps} jumps) - stayOutUntilFull`);
                        break;
                      }
                    }
                  }
                  if (newTarget) break;
                }
              }
            }
          }

          if (newTarget && newPoiId && newPoiName) {
            // Update target and continue mining
            const oldTarget = effectiveTarget;
            const oldPoi = miningPoi;

            // Update session if active
            if (recoveredSession) {
              updateMiningSession(bot.username, {
                targetResourceId: newTarget,
                targetResourceName: newTarget,
                targetPoiId: newPoiId,
                targetPoiName: newPoiName,
              });
            }

            // Travel to new POI (may be in different system)
            if (newSystemId && newSystemId !== bot.system) {
              // Need to jump to new system first
              ctx.log("mining", `Traveling to ${newTarget} in ${newSystemId} (${newPoiName}) - stayOutUntilFull`);
              const arrived = await navigateToSystem(ctx, newSystemId, safetyOpts);
              if (!arrived) {
                ctx.log("error", "Failed to reach new system — returning home");
                stopReason = `${resourceLabel} field depleted (travel failed)`;
                break;
              }
              // Update pois list for new system
              const { pois: newPois } = await getSystemInfo(ctx);
              pois = newPois;
              bot.system = newSystemId;
            }

            if (newPoiId !== bot.poi) {
              ctx.log("mining", `Traveling to new target: ${newTarget} @ ${newPoiName}`);
              const travelResp = await bot.exec("travel", { target_poi: newPoiId });
              
              // Check for battle notifications
              if (travelResp.notifications && Array.isArray(travelResp.notifications)) {
                const battleDetected = await handleBattleNotifications(ctx, travelResp.notifications, battleState);
                if (battleDetected) {
                  ctx.log("error", "Battle detected while traveling to new target - fleeing!");
                  stopReason = "battle detected";
                  break;
                }
              }
              
              if (travelResp.error && !travelResp.error.message.includes("already")) {
                ctx.log("error", `Travel to new target failed: ${travelResp.error.message}`);
                stopReason = `${resourceLabel} field depleted (travel failed)`;
                break;
              }
              bot.poi = newPoiId;
            }

            miningPoi = { id: newPoiId, name: newPoiName };
            ctx.log("mining", `Continuing mining session with new target: ${newTarget}`);
            continue; // Continue the harvest loop with new target
          } else {
            ctx.log("mining", `No alternative ${resourceLabel} found — ending mining cycle`);
            stopReason = `${resourceLabel} field depleted (no alternatives)`;
            break;
          }
        }
        if (msg.includes("cargo") && msg.includes("full")) {
          stopReason = "cargo full"; break;
        }
        if (msg.includes("harvester") || msg.includes("equipment") || msg.includes("mining")) {
          ctx.log("error", `Missing ${resourceLabel} harvesting module: ${mineResp.error.message}`);
          await sleep(30000);
          return;
        }
        ctx.log("error", `Harvest error: ${mineResp.error.message}`);
        break;
      }

      harvestCycles++;

      const { oreId, oreName } = parseOreFromMineResult(mineResp.result);
      if (oreId && bot.poi) {
        mapStore.recordMiningYield(bot.system, bot.poi, { item_id: oreId, name: oreName });
        resourcesMinedMap.set(oreName, (resourcesMinedMap.get(oreName) || 0) + 1);
        bot.stats.totalMined++;

        // Update session with mined resources
        if (recoveredSession) {
          const currentMined = recoveredSession.resourcesMined[oreName] || 0;
          updateMiningSession(bot.username, {
            resourcesMined: { ...recoveredSession.resourcesMined, [oreName]: currentMined + 1 },
            cyclesMined: recoveredSession.cyclesMined + 1,
          });
        }
      }

      await bot.refreshStatus();
      const fillRatio = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
      if (fillRatio >= cargoThresholdRatio) {
        stopReason = `cargo at ${Math.round(fillRatio * 100)}%`; break;
      }

      yield "harvesting";
    }

    // Harvest summary
    if (harvestCycles > 0) {
      const resourceList = [...resourcesMinedMap.entries()].map(([name, qty]) => `${qty}x ${name}`).join(", ");
      ctx.log("mining", `Harvested ${harvestCycles} cycles (${resourceList})${stopReason ? ` — ${stopReason}` : ""}`);
    } else if (stopReason) {
      ctx.log("mining", `Stopped before harvesting — ${stopReason}`);
    }

    if (bot.state !== "running") break;

    // ── Return to home system if we traveled away ──
    // When stayOutUntilFull is enabled, only return home if cargo is full
    const fillRatio = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
    const shouldReturnHome = settings.stayOutUntilFull 
      ? (fillRatio >= cargoThresholdRatio && bot.system !== homeSystem && homeSystem)
      : (bot.system !== homeSystem && homeSystem);

    if (shouldReturnHome) {
      yield "return_home";
      yield "pre_return_fuel";
      // Update session state
      if (recoveredSession) {
        updateMiningSession(bot.username, { state: "returning_home" });
      }
      const returnFueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (!returnFueled && stationPoi) {
        await refuelAtStation(ctx, stationPoi, safetyOpts.fuelThresholdPct);
      }

      const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
      if (!arrived) {
        ctx.log("error", "Failed to return to home system — docking at nearest station");
      }

      const { pois: homePois } = await getSystemInfo(ctx);
      const homeStation = findStation(homePois);
      stationPoi = homeStation ? { id: homeStation.id, name: homeStation.name } : null;
    }

    // ── Ensure we have a valid station to dock at ──
    if (!stationPoi || bot.system === homeSystem) {
      const { pois: currentPois } = await getSystemInfo(ctx);
      const currentStation = findStation(currentPois);
      if (currentStation) {
        stationPoi = { id: currentStation.id, name: currentStation.name };
      }
    }

    // ── Travel to station ──
    yield "travel_to_station";
    if (stationPoi) {
      const travelStationResp = await bot.exec("travel", { target_poi: stationPoi.id });
      if (travelStationResp.error && !travelStationResp.error.message.includes("already")) {
        ctx.log("error", `Travel to station failed: ${travelStationResp.error.message}`);
      }
    }

    // ── Dock ──
    yield "dock";

    // Signal escorts that we're docking (they should stay on patrol)
    const minerDockSettings = getMinerSettings(bot.username);
    if (minerDockSettings.escortName) {
      ctx.log("escort", "Signaling escorts: miner docking...");
      await signalEscort(ctx, "dock", undefined, minerDockSettings.escortSignalChannel);
    }

    const dockResp = await bot.exec("dock");
    if (dockResp.error && !dockResp.error.message.includes("already")) {
      ctx.log("error", `Dock failed: ${dockResp.error.message}`);
      const docked = await ensureDocked(ctx);
      if (!docked) {
        ctx.log("error", "Failed to find station — waiting before retry");
        await sleep(5000);
        continue;
      }
    } else {
      bot.docked = true;
    }

    // ── Collect storage + unload cargo ──
    await collectFromStorage(ctx);
    const creditsBefore = bot.credits;

    yield "unload_cargo";
    const cargoResp = await bot.exec("get_cargo");
    if (cargoResp.result && typeof cargoResp.result === "object") {
      const result = cargoResp.result as Record<string, unknown>;
      const cargoItems = (
        Array.isArray(result) ? result :
        Array.isArray(result.items) ? result.items :
        Array.isArray(result.cargo) ? result.cargo : []
      ) as Array<Record<string, unknown>>;

      const modeLabel: Record<string, string> = {
        storage: "station storage", faction: "faction storage", sell: "market",
      };
      const primaryLabel = settings.depositBot
        ? `${settings.depositBot}'s storage`
        : (modeLabel[settings.depositMode] || "storage");

      const unloadedItems: string[] = [];
      for (const item of cargoItems) {
        const itemId = (item.item_id as string) || "";
        const quantity = (item.quantity as number) || 0;
        if (!itemId || quantity <= 0) continue;
        const displayName = (item.name as string) || itemId;

        if (settings.depositMode === "sell") {
          const sellResp = await bot.exec("sell", { item_id: itemId, quantity });
          if (sellResp.error) {
            await bot.exec("deposit_items", { item_id: itemId, quantity });
          }
        } else if (settings.depositMode === "faction") {
          const fResp = await bot.exec("faction_deposit_items", { item_id: itemId, quantity });
          if (fResp.error) {
            await bot.exec("deposit_items", { item_id: itemId, quantity });
          }
        } else if (settings.depositBot) {
          const gResp = await bot.exec("send_gift", { recipient: settings.depositBot, item_id: itemId, quantity });
          if (gResp.error) {
            await bot.exec("deposit_items", { item_id: itemId, quantity });
          }
        } else {
          await bot.exec("deposit_items", { item_id: itemId, quantity });
        }
        unloadedItems.push(`${quantity}x ${displayName}`);
        yield "unloading";
      }

      if (unloadedItems.length > 0) {
        ctx.log("trade", `Unloaded ${unloadedItems.join(", ")} → ${primaryLabel}`);
      }

      // Update session state after depositing
      if (recoveredSession) {
        updateMiningSession(bot.username, { state: "depositing" });
      }
    }

    await bot.refreshStatus();
    await bot.refreshStorage();

    const earnings = bot.credits - creditsBefore;
    await factionDonateProfit(ctx, earnings);

    // Complete mining session after successful deposit
    if (recoveredSession) {
      completeMiningSession(bot.username);
      ctx.log("mining", `Mining session completed: ${recoveredSession.cyclesMined} cycles, ${Object.entries(recoveredSession.resourcesMined).map(([k, v]) => `${v}x ${k}`).join(", ")}`);
      recoveredSession = null;
    }

    // ── Mission handling: complete and accept missions ──
    yield "complete_missions";
    await completeActiveMissions(ctx);

    yield "accept_missions";
    await checkAndAcceptMinerMissions(ctx);

    // ── Refuel + Repair ──
    yield "refuel";
    await tryRefuel(ctx);
    yield "repair";
    await repairShip(ctx);

    yield "check_skills";
    await bot.checkSkills();

    await bot.refreshStatus();
    const endFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("info", `Cycle done — ${bot.credits} credits, ${endFuel}% fuel, ${bot.cargo}/${bot.cargoMax} cargo`);
  }
};
