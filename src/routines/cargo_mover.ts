/** Cargo Mover routine — hauls specified items from one station to another.
 *
 * This routine:
 * 1. Withdraws items from source station (faction or personal storage)
 * 2. Travels to destination station
 * 3. Deposits items to destination (faction storage, personal storage, or send_gift to a bot)
 *
 * All configuration is done via the web UI settings.
 */
import type { Bot, Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import {
  ensureUndocked,
  ensureFueled,
  tryRefuel,
  repairShip,
  navigateToSystem,
  detectAndRecoverFromDeath,
  readSettings,
  writeSettings,
  sleep,
  logFactionActivity,
} from "./common.js";

/** Simple dock function that does NOT call collectFromStorage. */
async function dockAtStation(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  if (bot.docked) return true;
  
  const dockResp = await bot.exec("dock");
  if (!dockResp.error || dockResp.error.message.includes("already")) {
    bot.docked = true;
    return true;
  }
  ctx.log("error", `Dock failed: ${dockResp.error.message}`);
  return false;
}

/** Simple undock function. */
async function undockStation(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked) return;
  
  await bot.exec("undock");
  bot.docked = false;
}

interface CargoMoveItem {
  itemId: string;
  itemName: string;
  quantity: number;
  category?: string;
  storageType?: 'faction' | 'personal';
  sourceBot?: string;
  totalDelivered?: number;  // Track total items delivered for this config
  totalToDeliver?: number;  // Optional target: when totalDelivered reaches this, item is considered complete
}

interface CargoMoverSettings {
  sourceStation: string;
  destinationStation: string;
  destinationStorageType: "faction" | "personal" | "send_gift";
  destinationBotName: string;
  items: CargoMoveItem[];
  personalStorageBot?: string;
  factionStorageBot?: string;
  refuelThreshold: number;
  repairThreshold: number;
}

function getCargoMoverSettings(username?: string): CargoMoverSettings {
  const all = readSettings();
  const general = all.general || {};
  const t = all.cargo_mover || {};
  const botOverrides = username ? (all[username] || {}) : {};

  const rawItems = (t.items as Array<Record<string, unknown>>) || [];
  const items: CargoMoveItem[] = rawItems
    .filter((item) => item.itemId && (item.quantity as number) >= 0)
    .map((item) => ({
      itemId: item.itemId as string,
      itemName: (item.itemName as string) || (item.itemId as string),
      quantity: (item.quantity as number) || 0,
      category: item.category as string | undefined,
      storageType: (item.storageType as 'faction' | 'personal') || 'faction',
      sourceBot: item.sourceBot as string | undefined,
      totalDelivered: item.totalDelivered as number | undefined,
      totalToDeliver: item.totalToDeliver as number | undefined,
    }));

  return {
    sourceStation: (botOverrides.sourceStation as string) ||
      (t.sourceStation as string) ||
      (general.factionStorageStation as string) ||
      "",
    destinationStation: (botOverrides.destinationStation as string) ||
      (t.destinationStation as string) ||
      "",
    destinationStorageType: (t.destinationStorageType as "faction" | "personal" | "send_gift") || "faction",
    destinationBotName: (botOverrides.destinationBotName as string) ||
      (t.destinationBotName as string) ||
      "",
    items,
    personalStorageBot: (t.personalStorageBot as string) || '',
    factionStorageBot: (t.factionStorageBot as string) || '',
    refuelThreshold: (t.refuelThreshold as number) || 50,
    repairThreshold: (t.repairThreshold as number) || 40,
  };
}

/** Resolve station ID to system ID using mapStore. */
function resolveStationSystem(stationId: string): string | null {
  if (!stationId) return null;
  const allSystems = mapStore.getAllSystems();
  for (const [sysId, sys] of Object.entries(allSystems)) {
    for (const poi of sys.pois) {
      if (poi.id === stationId || poi.base_id === stationId) {
        return sysId;
      }
    }
  }
  return null;
}

interface MoveJob {
  itemId: string;
  itemName: string;
  targetQty: number;
  availableQty: number;
  storageType: 'faction' | 'personal';
  sourceSystem: string;
  sourceStation: string;
  destSystem: string;
  destStation: string;
  jumps: number;
}

function getFreeSpace(bot: Bot): number {
  if (bot.cargoMax <= 0) return 999;
  return Math.max(0, bot.cargoMax - bot.cargo);
}

/** Withdraw items from specified storage type into cargo. */
async function withdrawFromStorage(
  ctx: RoutineContext,
  itemId: string,
  quantity: number,
  storageType: 'faction' | 'personal',
): Promise<{ success: boolean; withdrawnQty: number }> {
  const { bot } = ctx;

  // Check how much we have in cargo before withdrawing
  const cargoBefore = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;

  if (storageType === 'faction') {
    const inFaction = bot.factionStorage.find((i) => i.itemId === itemId);
    ctx.log("cargo", `Withdraw check: faction has ${inFaction?.quantity || 0}x ${itemId}`);
    if (!inFaction || inFaction.quantity <= 0) {
      ctx.log("error", `Withdraw from faction failed: ${itemId} not available`);
      return { success: false, withdrawnQty: 0 };
    }
    const actualQty = Math.min(quantity, inFaction.quantity);
    const wResp = await bot.exec("faction_withdraw_items", { item_id: itemId, quantity: actualQty });
    if (!wResp.error) {
      await bot.refreshCargo();
      const cargoAfter = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;
      const withdrawn = Math.max(0, cargoAfter - cargoBefore);
      return { success: withdrawn > 0, withdrawnQty: withdrawn };
    }
    if (wResp.error.message.includes("cargo_full")) {
      // Try to parse available space from error message
      const match = wResp.error.message.match(/only (\d+) available/);
      const availableSpace = match ? parseInt(match[1], 10) : Math.max(1, Math.floor(actualQty / 2));
      if (availableSpace > 0) {
        const smallWResp = await bot.exec("faction_withdraw_items", { item_id: itemId, quantity: availableSpace });
        if (!smallWResp.error) {
          await bot.refreshCargo();
          const cargoAfter = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;
          const withdrawn = Math.max(0, cargoAfter - cargoBefore);
          return { success: withdrawn > 0, withdrawnQty: withdrawn };
        }
      }
    }
    ctx.log("error", `Withdraw from faction failed: ${wResp.error.message}`);
    return { success: false, withdrawnQty: 0 };
  } else {
    // Personal storage - check current bot's storage
    const inPersonal = bot.storage.find((i) => i.itemId === itemId);
    ctx.log("cargo", `Withdraw check: personal storage has ${inPersonal?.quantity || 0}x ${itemId} (looking for ${quantity})`);
    ctx.log("cargo", `Personal storage contents: ${bot.storage.map(i => `${i.quantity}x ${i.itemId}`).join(", ") || "empty"}`);

    if (!inPersonal || inPersonal.quantity <= 0) {
      ctx.log("error", `Withdraw from personal storage failed: ${itemId} not available in current bot's storage`);
      // Check if we might need to use a different bot's storage
      if (bot.storage.length === 0) {
        ctx.log("error", `Current bot's storage is completely empty — items may be in another bot's storage`);
      }
      return { success: false, withdrawnQty: 0 };
    }
    const actualQty = Math.min(quantity, inPersonal.quantity);
    ctx.log("cargo", `Withdrawing ${actualQty}x ${itemId} from personal storage...`);
    // Use withdraw_items command (API v1) instead of storage action=withdraw (API v2)
    const wResp = await bot.exec("withdraw_items", { item_id: itemId, quantity: actualQty });
    if (!wResp.error) {
      await bot.refreshCargo();
      const cargoAfter = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;
      const withdrawn = Math.max(0, cargoAfter - cargoBefore);
      ctx.log("cargo", `Withdraw successful: got ${withdrawn}x ${itemId}`);
      return { success: withdrawn > 0, withdrawnQty: withdrawn };
    }
    ctx.log("error", `Withdraw from personal storage failed: ${wResp.error.message}`);
    if (wResp.error.message.includes("cargo_full")) {
      // Try to parse available space from error message
      const match = wResp.error.message.match(/only (\d+) available/);
      const availableSpace = match ? parseInt(match[1], 10) : Math.max(1, Math.floor(actualQty / 2));
      ctx.log("cargo", `Cargo full error - parsed available space: ${availableSpace}`);
      if (availableSpace > 0) {
        const smallWResp = await bot.exec("withdraw_items", { item_id: itemId, quantity: availableSpace });
        if (!smallWResp.error) {
          await bot.refreshCargo();
          const cargoAfter = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;
          const withdrawn = Math.max(0, cargoAfter - cargoBefore);
          ctx.log("cargo", `Withdraw successful (partial): got ${withdrawn}x ${itemId}`);
          return { success: withdrawn > 0, withdrawnQty: withdrawn };
        }
      }
    }
    return { success: false, withdrawnQty: 0 };
  }
}

/** Deposit items to specified storage type or send as gift. */
async function depositToDestination(
  ctx: RoutineContext,
  itemId: string,
  quantity: number,
  storageType: "faction" | "personal" | "send_gift",
  destinationBotName?: string,
): Promise<{ success: boolean; depositedQty: number }> {
  const { bot } = ctx;

  ctx.log("cargo", `Attempting deposit: ${quantity}x ${itemId} to ${storageType}${destinationBotName ? ` (${destinationBotName})` : ''}`);

  if (storageType === "send_gift") {
    if (!destinationBotName) {
      ctx.log("error", "send_gift requires destinationBotName to be set");
      return { success: false, depositedQty: 0 };
    }
    const sResp = await bot.exec("send_gift", {
      item_id: itemId,
      quantity,
      recipient_username: destinationBotName,
    });
    if (!sResp.error) {
      ctx.log("cargo", `Sent gift: ${quantity}x ${itemId} to ${destinationBotName}`);
      return { success: true, depositedQty: quantity };
    }
    ctx.log("error", `send_gift failed: ${sResp.error.message}`);
    return { success: false, depositedQty: 0 };
  }

  if (storageType === "faction") {
    const dResp = await bot.exec("faction_deposit_items", { item_id: itemId, quantity });
    if (!dResp.error) {
      logFactionActivity(ctx, "deposit", `Deposited ${quantity}x ${itemId} (cargo mover)`);
      ctx.log("cargo", `Deposited to faction storage: ${quantity}x ${itemId}`);
      return { success: true, depositedQty: quantity };
    }
    ctx.log("error", `Faction deposit failed: ${dResp.error.message}`);
    return { success: false, depositedQty: 0 };
  }

  // Personal storage - use deposit_items command (cargo → personal storage)
  const dResp = await bot.exec("deposit_items", { item_id: itemId, quantity });
  if (!dResp.error) {
    ctx.log("cargo", `Deposited to personal storage: ${quantity}x ${itemId}`);
    return { success: true, depositedQty: quantity };
  }
  ctx.log("error", `Personal storage deposit failed: ${dResp.error.message}`);
  return { success: false, depositedQty: 0 };
}

function findMoveJobs(
  ctx: RoutineContext,
  settings: CargoMoverSettings,
  sourceSystem: string,
  destSystem: string,
): MoveJob[] {
  const { bot } = ctx;
  const jobs: MoveJob[] = [];

  if (settings.items.length === 0) return jobs;

  ctx.log("cargo", `findMoveJobs: bot.storage has ${bot.storage.length} items, bot.factionStorage has ${bot.factionStorage.length} items`);

  for (const configItem of settings.items) {
    // Skip if item has reached its delivery target (totalDelivered >= totalToDeliver)
    if (configItem.totalToDeliver !== undefined && configItem.totalToDeliver > 0) {
      const delivered = configItem.totalDelivered || 0;
      if (delivered >= configItem.totalToDeliver) {
        ctx.log("cargo", `  ${configItem.itemName}: delivery target reached (${delivered}/${configItem.totalToDeliver}) — skipping`);
        continue;
      }
    }

    const storageType = configItem.storageType || 'faction';
    // Get quantity from configured storage (faction or personal)
    const inStorage = storageType === 'faction'
      ? (bot.factionStorage.find(i => i.itemId === configItem.itemId)?.quantity || 0)
      : (bot.storage.find(i => i.itemId === configItem.itemId)?.quantity || 0);

    // Also count what's already in cargo hold
    const inCargo = bot.inventory.find(i => i.itemId === configItem.itemId)?.quantity || 0;

    // Total available = in storage + already in cargo
    const availableQty = inStorage + inCargo;
    const targetQty = configItem.quantity > 0 ? configItem.quantity : availableQty;

    ctx.log("cargo", `  ${configItem.itemName}: inStorage=${inStorage}, inCargo=${inCargo}, available=${availableQty} (storageType=${storageType})`);

    if (targetQty > 0 && availableQty > 0) {
      const route = mapStore.findRoute(sourceSystem, destSystem);
      const jumps = route ? route.length - 1 : 999;

      jobs.push({
        itemId: configItem.itemId,
        itemName: configItem.itemName,
        targetQty,
        availableQty: Math.min(targetQty, availableQty),
        storageType,
        sourceSystem,
        sourceStation: settings.sourceStation,
        destSystem,
        destStation: settings.destinationStation,
        jumps,
      });
    }
  }

  return jobs;
}

/** Update delivery tracking for items after successful delivery. */
function updateDeliveryTracking(itemIds: string[], quantities: number[]): void {
  const all = readSettings();
  const cargoMover = all.cargo_mover || {};
  const items = (cargoMover.items as Array<Record<string, unknown>>) || [];
  
  let updated = false;
  for (let i = 0; i < itemIds.length; i++) {
    const itemId = itemIds[i];
    const qty = quantities[i];
    const item = items.find((it) => it.itemId === itemId);
    if (item) {
      const current = (item.totalDelivered as number) || 0;
      item.totalDelivered = current + qty;
      updated = true;
      console.log(`[CargoMover] Updated ${itemId}: ${current} -> ${current + qty} delivered`);
    }
  }
  
  if (updated) {
    writeSettings({ cargo_mover: { items } });
  }
}

export const cargoMoverRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();

  while (bot.state === "running") {
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) {
      await sleep(30000);
      continue;
    }

    const settings = getCargoMoverSettings(bot.username);
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
    };

    ctx.log("cargo", `Settings loaded: source=${settings.sourceStation}, dest=${settings.destinationStation}, destStorage=${settings.destinationStorageType}, items=${settings.items.length}`);
    for (const item of settings.items) {
      ctx.log("cargo", `  - ${item.itemName}: ${item.quantity || 'all'} from ${item.storageType || 'faction'}${item.sourceBot ? ` (${item.sourceBot})` : ''}`);
    }

    if (settings.items.length === 0) {
      ctx.log("error", "No items configured — check Cargo Mover settings");
      await sleep(60000);
      continue;
    }

    if (!settings.sourceStation) {
      ctx.log("error", "No source station configured");
      await sleep(60000);
      continue;
    }

    if (!settings.destinationStation) {
      ctx.log("error", "No destination station configured");
      await sleep(60000);
      continue;
    }

    if (settings.destinationStorageType === "send_gift" && !settings.destinationBotName) {
      ctx.log("error", "destinationBotName required for send_gift");
      await sleep(60000);
      continue;
    }

    const sourceSystem = resolveStationSystem(settings.sourceStation);
    const destSystem = resolveStationSystem(settings.destinationStation);

    if (!sourceSystem) {
      ctx.log("error", `Unknown source station: ${settings.sourceStation}`);
      await sleep(60000);
      continue;
    }

    if (!destSystem) {
      ctx.log("error", `Unknown destination station: ${settings.destinationStation}`);
      await sleep(60000);
      continue;
    }

    // Navigate to source station only if not already there
    yield "navigate_to_source";

    let justDockedAtSource = false;

    if (bot.system !== sourceSystem) {
      await ensureUndocked(ctx);
      const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (!fueled) {
        ctx.log("error", "Cannot refuel to reach source system");
        await sleep(30000);
        continue;
      }
      ctx.log("travel", `Heading to source system ${sourceSystem}...`);
      const arrived = await navigateToSystem(ctx, sourceSystem, safetyOpts);
      if (!arrived) {
        ctx.log("error", `Failed to reach ${sourceSystem}`);
        await sleep(30000);
        continue;
      }
      justDockedAtSource = true;
    }

    // Only travel to and dock at source station if not already there
    if (!bot.docked || bot.poi !== settings.sourceStation) {
      await ensureUndocked(ctx);
      if (bot.poi !== settings.sourceStation) {
        ctx.log("travel", `Traveling to source station ${settings.sourceStation}...`);
        const tResp = await bot.exec("travel", { target_poi: settings.sourceStation });
        if (tResp.error && !tResp.error.message.includes("already")) {
          ctx.log("error", `Travel to source failed: ${tResp.error.message}`);
          await sleep(30000);
          continue;
        }
        bot.poi = settings.sourceStation;
      }

      yield "dock_source";
      if (!await dockAtStation(ctx)) {
        ctx.log("error", "Could not dock at source");
        await sleep(30000);
        continue;
      }
      justDockedAtSource = true;
    }

    // Only do maintenance if we just docked
    if (justDockedAtSource) {
      yield "maintenance_source";
      await tryRefuel(ctx);
      await repairShip(ctx);
    }

    // Clear ALL unrelated cargo items to personal storage before starting
    // This ensures we start with a clean cargo hold and load fresh from storage
    yield "clear_cargo";
    await bot.refreshCargo();
    if (bot.inventory.length > 0) {
      const itemsToClear = bot.inventory.filter(item => {
        // Keep fuel/energy cells for operations
        const lower = item.itemId.toLowerCase();
        if (lower.includes("fuel") || lower.includes("energy_cell")) return false;
        // Deposit everything else to personal storage
        return true;
      });
      if (itemsToClear.length > 0) {
        const deposited: string[] = [];
        for (const item of itemsToClear) {
          if (item.quantity <= 0) continue;
          const dResp = await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
          if (!dResp.error) deposited.push(`${item.quantity}x ${item.name}`);
        }
        if (deposited.length > 0) {
          ctx.log("cargo", `Cleared cargo to personal storage: ${deposited.join(", ")}`);
        }
        await bot.refreshCargo();
      }
    }
    
    // Refresh storage after clearing cargo to get accurate counts
    // This prevents race conditions where items just deposited aren't counted
    await bot.refreshStorage();
    await bot.refreshFactionStorage();

    yield "find_jobs";
    await bot.refreshStatus();
    // Re-find jobs now that storage is updated with cleared items
    let jobs = findMoveJobs(ctx, settings, sourceSystem, destSystem);
    if (jobs.length === 0) {
      ctx.log("info", "No items available to move — waiting 60s");
      await sleep(60000);
      continue;
    }

    ctx.log("cargo", `Found ${jobs.length} item(s) to move`);

    let totalMoved = 0;
    let totalTrips = 0;
    let allJobsCompleted = true;

    // Track remaining quantities for each job
    const jobRemaining = new Map<string, number>();
    for (const job of jobs) {
      jobRemaining.set(job.itemId, job.availableQty);
    }

    // Main loading loop: keep loading until cargo is full or all jobs done
    while (bot.state === "running") {
      await bot.refreshStatus();
      await bot.refreshCargo();
      const freeSpace = getFreeSpace(bot);

      // If cargo is full, go deliver
      if (freeSpace <= 0) {
        ctx.log("cargo", "Cargo full — delivering...");
        break;
      }

      // Try to load from each job that still has items
      let loadedThisIteration = false;
      for (const job of jobs) {
        const remaining = jobRemaining.get(job.itemId) || 0;
        if (remaining <= 0) continue;

        await bot.refreshCargo();
        const currentFree = getFreeSpace(bot);
        if (currentFree <= 0) break;

        ctx.log("cargo", `Loading loop: ${job.itemName} remaining=${remaining}, freeSpace=${currentFree}, cargo=${bot.cargo}/${bot.cargoMax}`);

        // Calculate how much we can actually load (limited by both remaining and free space)
        const loadQty = Math.min(remaining, currentFree);
        if (loadQty <= 0) continue;

        ctx.log("cargo", `Attempting to withdraw ${loadQty}x ${job.itemName} from ${job.storageType}`);
        yield "withdraw_items";
        const withdrawResult = await withdrawFromStorage(ctx, job.itemId, loadQty, job.storageType);
        ctx.log("cargo", `Withdraw result: success=${withdrawResult.success}, withdrawnQty=${withdrawResult.withdrawnQty}`);

        if (!withdrawResult.success || withdrawResult.withdrawnQty <= 0) {
          ctx.log("error", `Failed to withdraw ${job.itemId} from ${job.storageType} — no more available`);
          jobRemaining.set(job.itemId, 0);
          continue;
        }

        const newRemaining = remaining - withdrawResult.withdrawnQty;
        jobRemaining.set(job.itemId, newRemaining);
        totalMoved += withdrawResult.withdrawnQty;
        ctx.log("cargo", `Loaded ${withdrawResult.withdrawnQty}x ${job.itemName} (${newRemaining} remaining)`);
        loadedThisIteration = true;

        // If we couldn't load the full amount due to cargo space, mark job as done for this trip
        if (withdrawResult.withdrawnQty < loadQty) {
          ctx.log("cargo", `Partial load: got ${withdrawResult.withdrawnQty} of ${loadQty} requested (cargo nearly full)`);
        }
      }

      // If we didn't load anything this iteration, all jobs are done
      if (!loadedThisIteration) {
        ctx.log("cargo", "No more items to load — all jobs completed");
        allJobsCompleted = true;
        break;
      }
    }

    // Now travel to destination and deliver what we loaded
    yield "travel_to_dest";
    await ensureUndocked(ctx);
    const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
    if (!fueled) {
      ctx.log("error", "Cannot refuel for delivery");
      allJobsCompleted = false;
      break;
    }

    if (bot.system !== destSystem) {
      ctx.log("travel", `Heading to ${destSystem}...`);
      const arrived = await navigateToSystem(ctx, destSystem, safetyOpts);
      if (!arrived) {
        ctx.log("error", `Failed to reach ${destSystem}`);
        allJobsCompleted = false;
        break;
      }
    }

    await ensureUndocked(ctx);
    if (bot.poi !== settings.destinationStation) {
      ctx.log("travel", `Traveling to ${settings.destinationStation}...`);
      const tResp = await bot.exec("travel", { target_poi: settings.destinationStation });
      if (tResp.error && !tResp.error.message.includes("already")) {
        ctx.log("error", `Travel to dest failed: ${tResp.error.message}`);
        allJobsCompleted = false;
        break;
      }
      bot.poi = settings.destinationStation;
    }

    yield "dock_dest";
    if (!await dockAtStation(ctx)) {
      ctx.log("error", "Could not dock at destination");
      allJobsCompleted = false;
      break;
    }

    yield "deposit_items";
    await bot.refreshCargo();
    // Deposit ALL items in cargo to the destination
    const itemsToDeposit = [...bot.inventory];
    const deliveredItems: { itemId: string; quantity: number }[] = [];
    
    if (itemsToDeposit.length > 0) {
      for (const item of itemsToDeposit) {
        if (item.quantity <= 0) continue;
        // Skip fuel/energy cells
        const lower = item.itemId.toLowerCase();
        if (lower.includes("fuel") || lower.includes("energy_cell")) continue;

        const depositResult = await depositToDestination(
          ctx,
          item.itemId,
          item.quantity,
          settings.destinationStorageType,
          settings.destinationBotName,
        );
        if (depositResult.success) {
          ctx.log("cargo", `Delivered ${depositResult.depositedQty}x ${item.name}`);
          deliveredItems.push({ itemId: item.itemId, quantity: depositResult.depositedQty });
        } else {
          allJobsCompleted = false;
        }
      }
      totalTrips++;
      
      // Update delivery tracking after successful delivery
      if (deliveredItems.length > 0) {
        const itemIds = deliveredItems.map((d) => d.itemId);
        const quantities = deliveredItems.map((d) => d.quantity);
        updateDeliveryTracking(itemIds, quantities);
      }
    }

    await bot.refreshCargo();

    // Check if all jobs are complete (no remaining items for any job)
    for (const job of jobs) {
      const remaining = jobRemaining.get(job.itemId) || 0;
      if (remaining > 0) {
        allJobsCompleted = false;
        ctx.log("cargo", `${remaining}x ${job.itemName} still to move`);
      }
    }

    if (totalMoved > 0) {
      ctx.log("cargo", `Moved ${totalMoved} items in ${totalTrips} trip(s)`);
    } else {
      ctx.log("cargo", "No items moved");
    }

    // If all jobs completed successfully, wait longer before restarting
    if (allJobsCompleted && jobs.length > 0) {
      ctx.log("info", "All items moved successfully. Waiting 5 minutes before next cycle...");
      yield "return_or_wait";
      await dockAtStation(ctx);
      await tryRefuel(ctx);
      await repairShip(ctx);
      await sleep(300000);
      continue;
    }

    // Not all jobs completed — return to source station to continue
    ctx.log("cargo", "Returning to source station to continue moving items...");
    yield "return_to_source";

    // Travel back to source system if needed
    if (bot.system !== sourceSystem) {
      await ensureUndocked(ctx);
      const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (!fueled) {
        ctx.log("error", "Cannot refuel to return to source");
        await sleep(30000);
        continue;
      }
      ctx.log("travel", `Heading back to ${sourceSystem}...`);
      const arrived = await navigateToSystem(ctx, sourceSystem, safetyOpts);
      if (!arrived) {
        ctx.log("error", `Failed to reach ${sourceSystem}`);
        await sleep(30000);
        continue;
      }
    }

    // Travel to source station and dock
    await ensureUndocked(ctx);
    if (bot.poi !== settings.sourceStation) {
      ctx.log("travel", `Traveling back to ${settings.sourceStation}...`);
      const tResp = await bot.exec("travel", { target_poi: settings.sourceStation });
      if (tResp.error && !tResp.error.message.includes("already")) {
        ctx.log("error", `Travel to source failed: ${tResp.error.message}`);
        await sleep(30000);
        continue;
      }
      bot.poi = settings.sourceStation;
    }

    if (!await dockAtStation(ctx)) {
      ctx.log("error", "Could not dock at source");
      await sleep(30000);
      continue;
    }

    ctx.log("cargo", "Back at source station — continuing operations");
    await sleep(5000);
  }
};
