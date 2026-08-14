/**
 * Pure planning helpers for the fuel transport routine.
 *
 * These are split out of `fuelTransfer.ts` because the "how much of this item
 * still has to move" question is where the routine kept going wrong, and it is
 * far easier to reason about (and test) without the travel/dock/deposit
 * machinery around it.
 *
 * Two independent kinds of demand exist and they are satisfied in completely
 * different ways:
 *
 *  - Station top-up (`stationTarget`): "keep station X stocked with N units".
 *    Satisfied by whatever already sits in the station's faction storage, so
 *    it shrinks as the station fills and is done at `currentQty >= target`.
 *  - Full delivery (`forceQty`, from `forceFullDelivery` loadouts): "actually
 *    haul N units there". Station stock says nothing about it — only units we
 *    delivered ourselves count (tracked in the progress file). None of the
 *    "already at target" shortcuts may cancel this demand, otherwise the bot
 *    plans a trip, immediately re-verifies it away and loops forever.
 */

import { getLoadoutDeliveredQty, type FacilityTransferLoadout } from "./fuelTransferTracking.js";

/** One item the bot may need to haul to a remote station this cycle. */
export interface FtNeededItem {
  itemId: string;
  itemName: string;
  /** forceQty + outstanding station top-up. */
  needed: number;
  itemSize: number;
  /** Combined target of the non-force loadouts / configured items (0 if none). */
  stationTarget: number;
  /** Units still to be hauled for force-full loadouts (0 if none). */
  forceQty: number;
  /** Force-full loadouts awaiting this item, used to credit deliveries. */
  forceLoadouts: Array<{ loadoutName: string; target: number; remaining: number }>;
}

/** A needed item resolved into an actual load for one trip. */
export interface FtLoadPlanItem {
  itemId: string;
  itemName: string;
  qty: number;
  source: string;
  stationTarget: number;
  forceQty: number;
  forceLoadouts: Array<{ loadoutName: string; target: number; remaining: number }>;
}

export interface FtLoadoutSatisfaction {
  complete: boolean;
  /** Per item: how much counts towards the target right now. */
  progress: Array<{ itemId: string; quantity: number; target: number }>;
  /** First item that is not there yet (undefined when complete). */
  shortfall?: { itemId: string; have: number; target: number; forceFull: boolean };
}

/**
 * Aggregate every pending loadout into per-item demand for one station.
 *
 * Items with nothing outstanding are omitted, so an empty result means "this
 * station needs no trip" — the caller must not treat a non-empty loadout list
 * as work on its own.
 */
export function buildLoadoutNeeds(
  remoteStationId: string,
  loadouts: FacilityTransferLoadout[],
  stationQtyCache: Record<string, number>,
  getItemSizeFn: (itemId: string) => number
): FtNeededItem[] {
  const aggregated = new Map<string, FtNeededItem>();

  for (const loadout of loadouts) {
    const isForceFull = loadout.forceFullDelivery === true;
    for (const item of loadout.items || []) {
      let entry = aggregated.get(item.itemId);
      if (!entry) {
        entry = {
          itemId: item.itemId,
          itemName: item.itemName || item.itemId,
          needed: 0,
          itemSize: getItemSizeFn(item.itemId),
          stationTarget: 0,
          forceQty: 0,
          forceLoadouts: [],
        };
        aggregated.set(item.itemId, entry);
      }

      if (isForceFull) {
        const alreadyHauled = getLoadoutDeliveredQty(remoteStationId, loadout.name, item.itemId, item.targetQuantity);
        const remaining = Math.max(0, item.targetQuantity - alreadyHauled);
        if (remaining > 0) {
          entry.forceQty += remaining;
          entry.forceLoadouts.push({ loadoutName: loadout.name, target: item.targetQuantity, remaining });
        }
      } else {
        entry.stationTarget += item.targetQuantity;
      }
    }
  }

  const needs: FtNeededItem[] = [];
  for (const entry of aggregated.values()) {
    entry.needed = entry.forceQty + stationTopUp(entry.stationTarget, stationQtyCache[entry.itemId] || 0);
    if (entry.needed > 0) needs.push(entry);
  }
  return needs;
}

/** Item ids referenced by the given loadouts (so config items don't duplicate them). */
export function loadoutItemIds(loadouts: FacilityTransferLoadout[]): Set<string> {
  const ids = new Set<string>();
  for (const loadout of loadouts) {
    for (const item of loadout.items || []) ids.add(item.itemId);
  }
  return ids;
}

function stationTopUp(stationTarget: number, currentQty: number): number {
  return stationTarget > 0 ? Math.max(0, stationTarget - currentQty) : 0;
}

/**
 * Is a loadout finished for this station?
 *
 * Force-full loadouts are judged by what we hauled there, NOT by the station's
 * stock — otherwise a station that happens to already hold the target amount
 * gets marked complete without a single unit being delivered.
 */
export function evaluateLoadoutSatisfaction(
  remoteStationId: string,
  loadout: FacilityTransferLoadout,
  stationQtyCache: Record<string, number>
): FtLoadoutSatisfaction {
  const isForceFull = loadout.forceFullDelivery === true;
  const progress: FtLoadoutSatisfaction["progress"] = [];

  if (!loadout.items || loadout.items.length === 0) {
    return { complete: false, progress };
  }

  for (const item of loadout.items) {
    const have = isForceFull
      ? getLoadoutDeliveredQty(remoteStationId, loadout.name, item.itemId, item.targetQuantity)
      : (stationQtyCache[item.itemId] || 0);
    progress.push({ itemId: item.itemId, quantity: have, target: item.targetQuantity });
    if (have < item.targetQuantity) {
      return {
        complete: false,
        progress,
        shortfall: { itemId: item.itemId, have, target: item.targetQuantity, forceFull: isForceFull },
      };
    }
  }

  return { complete: true, progress };
}

/**
 * How much of a loaded item should still be deposited on arrival.
 *
 * The force-full portion is always deposited; only the top-up portion is
 * reduced by what the station already holds.
 */
export function remainingDepositNeed(
  plan: Pick<FtLoadPlanItem, "stationTarget" | "forceQty">,
  currentStationQty: number
): { total: number; stationNeed: number; forceNeed: number } {
  const stationNeed = stationTopUp(plan.stationTarget, currentStationQty);
  const forceNeed = Math.max(0, plan.forceQty);
  return { total: forceNeed + stationNeed, stationNeed, forceNeed };
}

/**
 * Can a planned load be cancelled before departure because the station is
 * already stocked? Only ever true for pure top-up demand.
 */
export function canSkipAsAlreadyStocked(
  plan: Pick<FtLoadPlanItem, "stationTarget" | "forceQty">,
  currentStationQty: number
): boolean {
  return plan.forceQty <= 0 && plan.stationTarget > 0 && currentStationQty >= plan.stationTarget;
}

/** Split a delivered quantity across the force-full loadouts waiting for it. */
export function splitForceCredit(
  forceLoadouts: Array<{ loadoutName: string; target: number; remaining: number }>,
  deliveredQty: number
): Array<{ loadoutName: string; target: number; credit: number }> {
  const credits: Array<{ loadoutName: string; target: number; credit: number }> = [];
  let left = Math.max(0, deliveredQty);
  for (const forceLoadout of forceLoadouts) {
    if (left <= 0) break;
    const credit = Math.min(left, forceLoadout.remaining);
    if (credit <= 0) continue;
    credits.push({ loadoutName: forceLoadout.loadoutName, target: forceLoadout.target, credit });
    left -= credit;
  }
  return credits;
}
