import type { RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import { navigateToSystem, ensureUndocked, ensureFueled } from "./common.js";
import {
  planFrontierRoute,
  type FrontierTravelConfig,
  type FrontierRoutePlan,
} from "./frontierPlanner.js";

export {
  planFrontierRoute,
  buildFrontierTravelConfig,
  type FrontierTravelConfig,
  type FrontierRoutePlan,
} from "./frontierPlanner.js";

export interface FrontierNavOpts {
  fuelThresholdPct: number;
  hullThresholdPct: number;
  skipBlacklist?: boolean;
  ignoreBlacklistWhenCloaked?: boolean;
  /** Systems that must not be transited (frontier already removed when unlocked). */
  blacklist?: string[];
  [key: string]: unknown;
}

/** Jump along a pre-computed list of systems (skipping the first, assumed current). */
async function hopAlongPath(
  ctx: RoutineContext,
  path: string[],
  opts: FrontierNavOpts,
): Promise<boolean> {
  const { bot } = ctx;
  for (let i = 1; i < path.length; i++) {
    if (bot.state !== "running") return false;
    const hop = path[i];
    await bot.refreshLocation();
    if ((bot.system || "").toLowerCase() === hop.toLowerCase()) continue;
    const ok = await navigateToSystem(ctx, hop, { ...opts, allowWormholes: false });
    if (!ok) {
      ctx.log("error", `[frontier] Failed to jump within frontier to ${hop}`);
      return false;
    }
    await bot.refreshLocation();
  }
  return true;
}

/** Toggle the ship's cloak. Returns true on success (or if already in that state). */
async function setCloak(ctx: RoutineContext, enable: boolean): Promise<boolean> {
  const { bot } = ctx;
  if (!!bot.isCloaked === enable) return true;
  try {
    const resp = await bot.exec("cloak", { enable });
    if (resp.error) {
      ctx.log("warn", `[frontier] Failed to ${enable ? "enable" : "disable"} cloak: ${resp.error.message}`);
      return false;
    }
    bot.isCloaked = enable;
    ctx.log("travel", `[frontier] Cloak ${enable ? "enabled" : "disabled"}`);
    return true;
  } catch (e) {
    ctx.log("warn", `[frontier] Cloak toggle failed: ${e}`);
    return false;
  }
}

/** Top up fuel before a pathfinder crossing when a station is reachable (main network only). */
async function ensurePathfinderFuel(
  ctx: RoutineContext,
  opts: FrontierNavOpts,
): Promise<void> {
  const { bot } = ctx;
  const fuelFloor = Math.max(opts.fuelThresholdPct, 60);
  await bot.refreshLocation();
  const sys = bot.system || "";
  const pct = bot.maxFuel > 0 ? (bot.fuel / bot.maxFuel) * 100 : 100;
  // No fuel stations in the Frontier — a crossing must be fuelled from the main side.
  if (mapStore.isFrontierSystem(sys)) {
    if (pct < fuelFloor) {
      ctx.log("warn", `[frontier] Low fuel (${Math.round(pct)}%) for a pathfinder crossing — attempting anyway`);
    }
    return;
  }
  if (pct < fuelFloor) {
    await ensureFueled(ctx, fuelFloor, { skipBlacklist: opts.skipBlacklist });
  }
}

async function executePathfinderRoute(
  ctx: RoutineContext,
  target: string,
  opts: FrontierNavOpts,
  plan: Extract<FrontierRoutePlan, { kind: "pathfinder" }>,
): Promise<boolean> {
  const { bot } = ctx;
  // Main-network legs may use permanent main-to-main wormholes (fast shortcuts
  // the explorers keep updated). Frontier wormholes are excluded inside routing.
  const mainOpts: FrontierNavOpts = { ...opts, allowWormholes: true };

  if (plan.outbound) {
    // main -> hub (normal jumps)
    await bot.refreshLocation();
    if ((bot.system || "").toLowerCase() !== plan.hub.toLowerCase()) {
      ctx.log("travel", `[frontier] Staging via main hub ${plan.hubName} (${plan.hub}) — ${plan.mainJumps} jump(s)`);
      const okHub = await navigateToSystem(ctx, plan.hub, mainOpts);
      if (!okHub) {
        ctx.log("error", `[frontier] Failed to reach staging hub ${plan.hubName}`);
        return false;
      }
    }

    // hub -> frontier entry (pathfinder jump)
    await ensurePathfinderFuel(ctx, opts);
    // Nothing in the void can see or attack us — drop the cloak for the flight
    // (it only burns fuel out here) and restore it once we land.
    const wasCloaked = bot.isCloaked;
    if (wasCloaked) await setCloak(ctx, false);
    await ensureUndocked(ctx);
    ctx.log(
      "travel",
      `[frontier] Pathfinder jump ${plan.hubName} -> ${plan.entryName} (${plan.entry}) at ${plan.bearing.toFixed(2)}°`,
    );
    const jump = await bot.performPathfinderJump(plan.entry);
    if (wasCloaked) await setCloak(ctx, true);
    await bot.refreshLocation();
    if (!jump.success || (bot.system || "").toLowerCase() !== plan.entry.toLowerCase()) {
      ctx.log(
        "error",
        `[frontier] Pathfinder jump to ${plan.entryName} failed (now at ${bot.system || "unknown"})`,
      );
      return false;
    }

    // entry -> target through the frontier group (regular jumps, reversed path)
    const inbound = plan.frontierPath.slice().reverse();
    return hopAlongPath(ctx, inbound, opts);
  }

  // return: frontier -> entry (regular jumps), entry -> hub (pathfinder), hub -> target (normal)
  const okEntry = await hopAlongPath(ctx, plan.frontierPath, opts);
  if (!okEntry) {
    ctx.log("error", `[frontier] Failed to reach frontier entry ${plan.entryName} for return`);
    return false;
  }

  await ensurePathfinderFuel(ctx, opts);
  // Drop the cloak for the void crossing, restore it after landing.
  const wasCloaked = bot.isCloaked;
  if (wasCloaked) await setCloak(ctx, false);
  await ensureUndocked(ctx);
  ctx.log(
    "travel",
    `[frontier] Return pathfinder jump ${plan.entryName} -> ${plan.hubName} (${plan.hub}) at ${plan.bearing.toFixed(2)}°`,
  );
  const jump = await bot.performPathfinderJump(plan.hub);
  if (wasCloaked) await setCloak(ctx, true);
  await bot.refreshLocation();
  if (!jump.success || (bot.system || "").toLowerCase() !== plan.hub.toLowerCase()) {
    ctx.log(
      "error",
      `[frontier] Return pathfinder jump to ${plan.hubName} failed (now at ${bot.system || "unknown"})`,
    );
    return false;
  }

  await bot.refreshLocation();
  if ((bot.system || "").toLowerCase() === target.toLowerCase()) return true;
  return navigateToSystem(ctx, target, mainOpts);
}

/**
 * Navigate to `target`, transparently bridging the frontier gap with a
 * Pathfinder Drive when needed. Falls back to plain navigation for same-side
 * travel or when no frontier route is available.
 */
export async function travelToSystemSmart(
  ctx: RoutineContext,
  target: string,
  opts: FrontierNavOpts,
  cfg: FrontierTravelConfig,
): Promise<boolean> {
  const { bot } = ctx;
  if (!target) return false;

  await bot.refreshLocation();
  if ((bot.system || "").toLowerCase() === target.toLowerCase()) {
    await bot.refreshLocation();
    return true;
  }

  const blacklist = Array.isArray(opts.blacklist) ? opts.blacklist : [];
  const from = bot.system;
  if (!from) return navigateToSystem(ctx, target, opts);

  const plan = planFrontierRoute(from, target, blacklist, cfg);

  if (plan.kind === "normal") {
    return navigateToSystem(ctx, target, opts);
  }

  if (plan.kind === "unreachable") {
    ctx.log("warn", `[frontier] ${plan.reason} — attempting normal navigation`);
    return navigateToSystem(ctx, target, opts);
  }

  if (plan.kind === "wormhole") {
    ctx.log(
      "travel",
      `[frontier] Using wormhole shortcut to ${target} (${plan.route.length - 1} jump(s), <= ${cfg.jumpThreshold})`,
    );
    const ok = await navigateToSystem(ctx, target, { ...opts, allowWormholes: true });
    if (ok) return true;
    if (!cfg.enabled) return false;
    ctx.log("warn", "[frontier] Wormhole route failed — falling back to a Pathfinder crossing");
    await bot.refreshLocation();
  }

  // pathfinder — re-plan from our (possibly moved) current location
  const current = bot.system || from;
  const pfPlan = planFrontierRoute(current, target, blacklist, cfg);
  if (pfPlan.kind !== "pathfinder") {
    if (pfPlan.kind === "normal") return navigateToSystem(ctx, target, opts);
    ctx.log(
      "error",
      `[frontier] ${pfPlan.kind === "unreachable" ? pfPlan.reason : "route changed"} — aborting frontier travel`,
    );
    return false;
  }

  ctx.log(
    "travel",
    `[frontier] Pathfinder route to ${target}: hub=${pfPlan.hubName}, entry=${pfPlan.entryName}, main=${pfPlan.mainJumps}j, frontier=${pfPlan.frontierJumps}j, total=${pfPlan.totalJumps}j (limit ${cfg.maxJumps}), jump=${Math.round(pfPlan.jumpSeconds / 60)}min (limit ${cfg.maxJumpMinutes}min), outbound=${pfPlan.outbound}`,
  );
  return executePathfinderRoute(ctx, target, opts, pfPlan);
}