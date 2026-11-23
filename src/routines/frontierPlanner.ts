import { mapStore } from "../mapstore.js";

/**
 * Pure frontier route planning (no side effects, no navigation).
 *
 * Kept separate from the execution half (frontierTravel.ts) so it can be unit
 * tested without pulling in the routine/bot module graph.
 *
 * The galaxy splits into the main ~506-system jump-gate network and the
 * Frontier systems outside it. Frontier systems interconnect with regular
 * connections internally, but the main<->frontier gap is only crossable by a
 * temporary wormhole or a Pathfinder Drive jump. This module decides which to
 * use and, for a pathfinder crossing, picks the cheapest safe frontier entry.
 */

export interface FrontierTravelConfig {
  /** True when the ship has a Pathfinder Drive and may cross the frontier gap. */
  enabled: boolean;
  /**
   * If a wormhole route to the target is at most this many jumps, it is used
   * instead of a pathfinder crossing (short wormholes are quicker than a slow
   * mining ship flying the long way around).
   */
  jumpThreshold: number;
  /**
   * Hard cap on a pathfinder frontier trip, counted as:
   *   main-network jumps to the staging hub + 1 (the pathfinder jump)
   *   + frontier jumps from the entry to the target.
   * Candidates whose total exceeds this are rejected. Defaults to 10.
   */
  maxJumps: number;
  /**
   * Reject a candidate if the pathfinder flight itself would take longer than
   * this many minutes (ticks * 10s). Most hops are 5-10 min; anything over this
   * is a waste. Defaults to 15.
   */
  maxJumpMinutes: number;
}

export type FrontierRoutePlan =
  | { kind: "normal" }
  | { kind: "wormhole"; route: string[] }
  | {
      kind: "pathfinder";
      /** True when travelling from the main network into the frontier. */
      outbound: boolean;
      /** Main-network system to stage the pathfinder jump from/to. */
      hub: string;
      hubName: string;
      /** Frontier system the pathfinder jump lands on / departs from. */
      entry: string;
      entryName: string;
      /** Absolute bearing of the safe pathfinder jump. */
      bearing: number;
      /** Regular-connection route between the frontier endpoint and the entry. */
      frontierPath: string[];
      mainJumps: number;
      frontierJumps: number;
      /** Total jumps for the trip: mainJumps + frontierJumps + 1 pathfinder jump. */
      totalJumps: number;
      /** Pathfinder flight time in seconds (ticks * 10). */
      jumpSeconds: number;
      cost: number;
    }
  | { kind: "unreachable"; reason: string };

const DEFAULT_JUMP_THRESHOLD = 15;
const DEFAULT_MAX_JUMPS = 10;
const DEFAULT_MAX_JUMP_MINUTES = 15;

export function buildFrontierTravelConfig(
  settings:
    | {
        pathfinderFrontierJumpThreshold?: number;
        pathfinderFrontierMaxJumps?: number;
        pathfinderJumpTimeLimitMin?: number;
      }
    | undefined,
  hasPathfinderDrive: boolean | undefined,
): FrontierTravelConfig {
  const threshold =
    typeof settings?.pathfinderFrontierJumpThreshold === "number" &&
    !isNaN(settings.pathfinderFrontierJumpThreshold)
      ? settings.pathfinderFrontierJumpThreshold
      : DEFAULT_JUMP_THRESHOLD;
  const maxJumps =
    typeof settings?.pathfinderFrontierMaxJumps === "number" &&
    !isNaN(settings.pathfinderFrontierMaxJumps)
      ? settings.pathfinderFrontierMaxJumps
      : DEFAULT_MAX_JUMPS;
  const maxJumpMinutes =
    typeof settings?.pathfinderJumpTimeLimitMin === "number" &&
    !isNaN(settings.pathfinderJumpTimeLimitMin)
      ? settings.pathfinderJumpTimeLimitMin
      : DEFAULT_MAX_JUMP_MINUTES;
  return {
    enabled: hasPathfinderDrive === true,
    jumpThreshold: threshold,
    maxJumps,
    maxJumpMinutes,
  };
}

/** Collect the frontier component (regular-connection reachable) containing `start`. */
function frontierComponent(start: string): string[] {
  const startKey = start.toLowerCase();
  const seen = new Set<string>([startKey]);
  const queue: string[] = [startKey];
  const out: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    out.push(cur);
    for (const conn of mapStore.getConnections(cur)) {
      const id = (conn.system_id || "").toLowerCase();
      if (!id || seen.has(id)) continue;
      // The main network and the frontier are disconnected in the map graph;
      // restricting to frontier keeps this traversal inside one frontier pocket.
      if (!mapStore.isFrontierSystem(id)) continue;
      seen.add(id);
      queue.push(id);
    }
  }
  return out;
}

interface HubCandidate {
  id: string;
  name: string;
  x: number;
  y: number;
  distance: number;
}

/**
 * Nearest main-network systems (with positions) to a point, closest first.
 * Pirate hubs are naturally excluded because findRoute refuses to route to them
 * when a blacklist is supplied (and a cloaked miner is allowed to use them).
 */
function nearestMainHubs(
  x: number,
  y: number,
  blacklist: string[],
  limit: number,
): HubCandidate[] {
  const bl = new Set(blacklist.map((s) => s.toLowerCase()));
  const out: HubCandidate[] = [];
  for (const sys of mapStore.getSystems()) {
    if (!sys.position || typeof sys.position.x !== "number" || typeof sys.position.y !== "number") continue;
    if (mapStore.isFrontierSystem(sys.id)) continue;
    if (bl.has(sys.id.toLowerCase())) continue;
    const dx = sys.position.x - x;
    const dy = sys.position.y - y;
    out.push({
      id: sys.id,
      name: sys.name || sys.id,
      x: sys.position.x,
      y: sys.position.y,
      distance: Math.sqrt(dx * dx + dy * dy),
    });
  }
  out.sort((a, b) => a.distance - b.distance);
  return out.slice(0, limit);
}

function systemHasStation(systemId: string): boolean {
  const sys = mapStore.getSystem(systemId);
  if (!sys || !Array.isArray(sys.pois)) return false;
  return sys.pois.some(
    (p) => p.has_base || !!p.base_id || (p.type || "").toLowerCase() === "station",
  );
}

/**
 * Decide how to get from `from` to `to`.
 *
 * - Same side of the gap (both main or both frontier): normal navigation.
 * - Opposite sides: use a short wormhole if one exists (<= threshold jumps),
 *   otherwise a pathfinder crossing via the cheapest safe frontier entry.
 */
export function planFrontierRoute(
  from: string,
  to: string,
  blacklist: string[],
  cfg: FrontierTravelConfig,
): FrontierRoutePlan {
  const fromL = from.toLowerCase();
  const toL = to.toLowerCase();
  if (fromL === toL) return { kind: "normal" };

  const fromFrontier = mapStore.isFrontierSystem(from);
  const toFrontier = mapStore.isFrontierSystem(to);
  if (fromFrontier === toFrontier) return { kind: "normal" };

  // Short wormhole shortcut? (Only when the route is genuinely short.)
  let wormholeRoute: string[] | null = null;
  try {
    wormholeRoute = mapStore.findRouteWithMode(from, to, blacklist, blacklist.length > 0, true);
  } catch {
    wormholeRoute = null;
  }
  if (wormholeRoute && wormholeRoute.length > 1 && wormholeRoute.length - 1 <= cfg.jumpThreshold) {
    return { kind: "wormhole", route: wormholeRoute };
  }

  if (!cfg.enabled) {
    return {
      kind: "unreachable",
      reason: "target is across the frontier gap and no Pathfinder Drive is fitted",
    };
  }

  const frontierEnd = fromFrontier ? from : to;
  const mainEnd = fromFrontier ? to : from;
  const group = frontierComponent(frontierEnd);

  let best:
    | {
        hub: HubCandidate;
        entry: string;
        entryName: string;
        bearing: number;
        frontierPath: string[];
        mainJumps: number;
        frontierJumps: number;
        totalJumps: number;
        jumpSeconds: number;
        cost: number;
      }
    | null = null;

  for (const entryId of group) {
    const entrySys = mapStore.getSystem(entryId);
    if (!entrySys || !entrySys.position) continue;

    const frontierPath = mapStore.findRoute(frontierEnd, entryId, blacklist);
    if (!frontierPath) continue;
    const frontierJumps = Math.max(0, frontierPath.length - 1);

    const hubs = nearestMainHubs(entrySys.position.x, entrySys.position.y, blacklist, 80);
    for (const hub of hubs) {
      const jumpFrom = fromFrontier ? hub.id : entryId;
      const jumpTo = fromFrontier ? entryId : hub.id;
      const safe = mapStore.computeSafePathfinderBearing(jumpFrom, jumpTo);
      if (!safe || !safe.safe) continue;

      // Pathfinder flight time: ticks * 10s (10 GU per tick). Reject hops that
      // would take longer than the configured cap — anything over ~15 min is a
      // waste when most hops are 5-10 min.
      const jumpTicks = safe.landing?.ticks ?? Math.ceil(hub.distance / 10);
      const jumpSeconds = jumpTicks * 10;
      if (jumpSeconds > cfg.maxJumpMinutes * 60) continue;

      const mainRoute = mapStore.findRouteWithMode(
        mainEnd,
        hub.id,
        blacklist,
        blacklist.length > 0,
        true, // allowWormholes — main-to-main permanent wormholes are fair game
        true, // excludeFrontierWormholes — never route through one-way frontier wormholes
      );
      if (!mainRoute) continue;
      const mainJumps = Math.max(0, mainRoute.length - 1);

      // Total trip = main jumps to the hub + 1 pathfinder jump + frontier jumps.
      // Reject anything beyond the configured frontier jump limit.
      const totalJumps = mainJumps + frontierJumps + 1;
      if (totalJumps > cfg.maxJumps) continue;

      // Approximate travel time in seconds: ~60s per jump-gate jump, ~1s per GU of
      // pathfinder flight (10 GU per tick, ~10s per tick), ~60s per frontier jump.
      // This favours a hub with a SHORT pathfinder hop over one that is merely a
      // few jumps closer — a long pathfinder flight is what actually makes the
      // trip slow (e.g. 17 jumps to a hub that then needs a 189-tick hop).
      const serviceBonus = systemHasStation(hub.id) ? 120 : 0;
      const cost = mainJumps * 60 + hub.distance + frontierJumps * 60 - serviceBonus;

      if (!best || cost < best.cost) {
        best = {
          hub,
          entry: entryId,
          entryName: entrySys.name || entryId,
          bearing: safe.bearing,
          frontierPath,
          mainJumps,
          frontierJumps,
          totalJumps,
          jumpSeconds,
          cost,
        };
      }
    }
  }

  if (!best) {
    return {
      kind: "unreachable",
      reason: `no safe Pathfinder jump within the ${cfg.maxJumps}-jump frontier limit`,
    };
  }

  return {
    kind: "pathfinder",
    outbound: !fromFrontier,
    hub: best.hub.id,
    hubName: best.hub.name,
    entry: best.entry,
    entryName: best.entryName,
    bearing: best.bearing,
    frontierPath: best.frontierPath,
    mainJumps: best.mainJumps,
    frontierJumps: best.frontierJumps,
    totalJumps: best.totalJumps,
    jumpSeconds: best.jumpSeconds,
    cost: best.cost,
  };
}