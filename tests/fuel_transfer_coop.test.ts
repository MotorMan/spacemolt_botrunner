/**
 * Regression tests for the fuel transport co-op / full-delivery bugs:
 *
 *  - a force-full loadout was cancelled by the station's existing stock, so the
 *    bot planned a trip and immediately aborted it in a tight loop
 *  - a force-full loadout was marked "completed" from station stock alone,
 *    without ever hauling the requested amount
 *  - a bot counted its own delivery lock against itself and then reported
 *    "others handling rest" while running alone
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// The tracking / coordination modules resolve their data directory from the
// cwd at import time — point them at a throwaway directory so the tests never
// touch the real data/ folder.
const tmpRoot = mkdtempSync(join(tmpdir(), 'ft-coop-'));
const originalCwd = process.cwd();
process.chdir(tmpRoot);

const planning = await import('../src/routines/fuelTransferPlanning.ts');
const tracking = await import('../src/routines/fuelTransferTracking.ts');
const coordination = await import('../src/routines/fuelTransferCoordination.ts');

process.chdir(originalCwd);

const {
  buildLoadoutNeeds,
  evaluateLoadoutSatisfaction,
  canSkipAsAlreadyStocked,
  remainingDepositNeed,
  splitForceCredit,
  loadoutItemIds,
} = planning;

const STATION = 'ef377cbdf4962c2b8c8a8b4e4665742e';
const size1 = () => 1;

function loadout(overrides: Partial<any> = {}): any {
  return {
    name: 'Fuel Tank Expansion Build',
    items: [{ itemId: 'steel_plate', itemName: 'Steel Plate', targetQuantity: 6500 }],
    createdAt: new Date().toISOString(),
    active: true,
    forceFullDelivery: false,
    ...overrides,
  };
}

beforeEach(() => {
  tracking.clearAllCompletions();
  coordination.resetCoordinationTracking();
  coordination.resetInTransitData();
});

afterAll(() => {
  coordination.shutdownCoordination();
  process.chdir(originalCwd);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('buildLoadoutNeeds', () => {
  it('keeps the full demand for a force-full loadout even when the station is already at target', () => {
    const needs = buildLoadoutNeeds(STATION, [loadout({ forceFullDelivery: true })], { steel_plate: 6500 }, size1);

    expect(needs).toHaveLength(1);
    expect(needs[0].needed).toBe(6500);
    expect(needs[0].forceQty).toBe(6500);
    expect(needs[0].stationTarget).toBe(0);
    expect(needs[0].forceLoadouts).toEqual([
      { loadoutName: 'Fuel Tank Expansion Build', target: 6500, remaining: 6500 },
    ]);
  });

  it('produces no work for a normal loadout whose station is already at target', () => {
    const needs = buildLoadoutNeeds(STATION, [loadout()], { steel_plate: 6500 }, size1);
    expect(needs).toEqual([]);
  });

  it('tops a normal loadout up by the shortfall only', () => {
    const needs = buildLoadoutNeeds(STATION, [loadout()], { steel_plate: 4000 }, size1);
    expect(needs).toHaveLength(1);
    expect(needs[0].needed).toBe(2500);
    expect(needs[0].stationTarget).toBe(6500);
    expect(needs[0].forceQty).toBe(0);
  });

  it('shrinks force demand as deliveries are recorded and stops at the target', () => {
    const forced = loadout({ name: 'Forced', forceFullDelivery: true });

    tracking.addLoadoutDeliveredQty(STATION, 'Forced', 'steel_plate', 1535, 6500);
    let needs = buildLoadoutNeeds(STATION, [forced], { steel_plate: 6500 }, size1);
    expect(needs[0].needed).toBe(6500 - 1535);

    tracking.addLoadoutDeliveredQty(STATION, 'Forced', 'steel_plate', 6500 - 1535, 6500);
    needs = buildLoadoutNeeds(STATION, [forced], { steel_plate: 0 }, size1);
    expect(needs).toEqual([]);
  });

  it('adds force demand on top of a separate top-up loadout for the same item', () => {
    const needs = buildLoadoutNeeds(
      STATION,
      [
        loadout({ name: 'Forced', forceFullDelivery: true, items: [{ itemId: 'steel_plate', itemName: 'Steel Plate', targetQuantity: 1000 }] }),
        loadout({ name: 'TopUp', items: [{ itemId: 'steel_plate', itemName: 'Steel Plate', targetQuantity: 500 }] }),
      ],
      { steel_plate: 200 },
      size1
    );

    expect(needs).toHaveLength(1);
    expect(needs[0].forceQty).toBe(1000);
    expect(needs[0].stationTarget).toBe(500);
    expect(needs[0].needed).toBe(1000 + 300);
  });

  it('restarts force progress when the loadout target changes', () => {
    tracking.addLoadoutDeliveredQty(STATION, 'Forced', 'steel_plate', 1000, 1000);
    const retargeted = loadout({
      name: 'Forced',
      forceFullDelivery: true,
      items: [{ itemId: 'steel_plate', itemName: 'Steel Plate', targetQuantity: 2000 }],
    });

    const needs = buildLoadoutNeeds(STATION, [retargeted], {}, size1);
    expect(needs[0].needed).toBe(2000);
  });

  it('reports the item ids covered by loadouts', () => {
    const ids = loadoutItemIds([loadout({ items: [{ itemId: 'a', itemName: 'A', targetQuantity: 1 }, { itemId: 'b', itemName: 'B', targetQuantity: 2 }] })]);
    expect([...ids].sort()).toEqual(['a', 'b']);
  });
});

describe('evaluateLoadoutSatisfaction', () => {
  it('does not complete a force-full loadout from station stock alone', () => {
    const status = evaluateLoadoutSatisfaction(STATION, loadout({ forceFullDelivery: true }), { steel_plate: 999999 });
    expect(status.complete).toBe(false);
    expect(status.shortfall).toMatchObject({ itemId: 'steel_plate', have: 0, target: 6500, forceFull: true });
  });

  it('completes a force-full loadout once the full amount was hauled', () => {
    tracking.addLoadoutDeliveredQty(STATION, 'Fuel Tank Expansion Build', 'steel_plate', 6500, 6500);
    const status = evaluateLoadoutSatisfaction(STATION, loadout({ forceFullDelivery: true }), {});
    expect(status.complete).toBe(true);
  });

  it('completes a normal loadout from station stock', () => {
    expect(evaluateLoadoutSatisfaction(STATION, loadout(), { steel_plate: 6500 }).complete).toBe(true);
    expect(evaluateLoadoutSatisfaction(STATION, loadout(), { steel_plate: 6499 }).complete).toBe(false);
  });

  it('never completes an empty loadout', () => {
    expect(evaluateLoadoutSatisfaction(STATION, loadout({ items: [] }), {}).complete).toBe(false);
  });
});

describe('pre-departure and deposit gates', () => {
  const forcePlan = { stationTarget: 0, forceQty: 2360 };
  const topUpPlan = { stationTarget: 6500, forceQty: 0 };

  it('never cancels a force-full load before departure', () => {
    expect(canSkipAsAlreadyStocked(forcePlan, 6500)).toBe(false);
    expect(canSkipAsAlreadyStocked(topUpPlan, 6500)).toBe(true);
    expect(canSkipAsAlreadyStocked(topUpPlan, 100)).toBe(false);
  });

  it('still deposits force-full cargo at a station that is already at target', () => {
    expect(remainingDepositNeed(forcePlan, 6500).total).toBe(2360);
    expect(remainingDepositNeed(topUpPlan, 6500).total).toBe(0);
    expect(remainingDepositNeed({ stationTarget: 6500, forceQty: 1000 }, 6000).total).toBe(1500);
  });

  it('splits delivery credit across the force loadouts waiting for the item', () => {
    const credits = splitForceCredit(
      [
        { loadoutName: 'A', target: 100, remaining: 100 },
        { loadoutName: 'B', target: 200, remaining: 200 },
      ],
      150
    );
    expect(credits).toEqual([
      { loadoutName: 'A', target: 100, credit: 100 },
      { loadoutName: 'B', target: 200, credit: 50 },
    ]);
  });

  it('drops credit that exceeds the outstanding force demand', () => {
    expect(splitForceCredit([{ loadoutName: 'A', target: 100, remaining: 10 }], 80)).toEqual([
      { loadoutName: 'A', target: 100, credit: 10 },
    ]);
    expect(splitForceCredit([], 80)).toEqual([]);
  });
});

describe('delivery lock accounting', () => {
  it('does not count a bot own existing lock against itself', async () => {
    const first = await coordination.acquireDeliveryLockAtomic({
      botUsername: 'hauler',
      itemId: 'steel_plate',
      itemName: 'Steel Plate',
      quantity: 2360,
      remoteStationId: STATION,
      totalNeed: 6500,
    });
    expect(first.lockedQty).toBe(2360);

    // Same bot, next trip planning pass while the old lock is still active.
    const second = await coordination.acquireDeliveryLockAtomic({
      botUsername: 'hauler',
      itemId: 'steel_plate',
      itemName: 'Steel Plate',
      quantity: 2360,
      remoteStationId: STATION,
      totalNeed: 6500,
    });
    expect(second.success).toBe(true);
    expect(second.lockedQty).toBe(2360);
  });

  it('still caps a bot against locks held by other bots', async () => {
    await coordination.acquireDeliveryLockAtomic({
      botUsername: 'other',
      itemId: 'steel_plate',
      itemName: 'Steel Plate',
      quantity: 6000,
      remoteStationId: STATION,
      totalNeed: 6500,
    });

    const mine = await coordination.acquireDeliveryLockAtomic({
      botUsername: 'hauler',
      itemId: 'steel_plate',
      itemName: 'Steel Plate',
      quantity: 2360,
      remoteStationId: STATION,
      totalNeed: 6500,
    });
    expect(mine.lockedQty).toBe(500);
  });
});

describe('in-transit tracking', () => {
  beforeEach(() => {
    coordination.addInTransitItems('hauler', STATION, [
      { itemId: 'steel_plate', itemName: 'Steel Plate', quantity: 2360 },
    ]);
  });

  it('does not mutate the caller load plan while removing', () => {
    const plan = [{ itemId: 'steel_plate', quantity: 1535 }];
    coordination.removeInTransitItems('hauler', STATION, plan);

    expect(plan[0].quantity).toBe(1535);
    expect(coordination.getInTransitQuantity('steel_plate', STATION)).toBe(825);
  });

  it('clears leftovers for an item across every destination', () => {
    coordination.addInTransitItems('hauler', 'other_station', [
      { itemId: 'steel_plate', itemName: 'Steel Plate', quantity: 40 },
    ]);

    const cleared = coordination.clearInTransitForItem('hauler', 'steel_plate');

    expect(cleared).toBe(2400);
    expect(coordination.getInTransitQuantity('steel_plate', STATION)).toBe(0);
    expect(coordination.getInTransitQuantity('steel_plate', 'other_station')).toBe(0);
  });

  it('leaves other bots in-transit claims alone', () => {
    coordination.addInTransitItems('other', STATION, [
      { itemId: 'steel_plate', itemName: 'Steel Plate', quantity: 90 },
    ]);

    coordination.clearInTransitForItem('hauler', 'steel_plate');

    expect(coordination.getInTransitQuantity('steel_plate', STATION)).toBe(90);
  });
});
