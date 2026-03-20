import type { Routine, RoutineContext, BotStatus } from "../bot.js";
import {
  findStation,
  getSystemInfo,
  collectFromStorage,
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  ensureFueled,
  navigateToSystem,
  scavengeWrecks,
  detectAndRecoverFromDeath,
  readSettings,
  sleep,
  logStatus,
} from "./common.js";
import { getNextMayday, markMaydayHandled, isLegitimateMayday, type MaydayRequest } from "../mayday.js";

// ── Settings ─────────────────────────────────────────────────

function getRescueSettings(): {
  fuelThreshold: number;
  rescueFuelCells: number;
  rescueCredits: number;
  scanIntervalSec: number;
  refuelThreshold: number;
} {
  const all = readSettings();
  const r = all.rescue || {};
  return {
    /** Fuel % below which a bot is considered in need of rescue. */
    fuelThreshold: (r.fuelThreshold as number) || 10,
    /** Number of fuel cells to deliver per rescue. */
    rescueFuelCells: (r.rescueFuelCells as number) || 10,
    /** Credits to send per rescue (if docked at same station). */
    rescueCredits: (r.rescueCredits as number) || 500,
    /** Seconds between fleet scans. */
    scanIntervalSec: (r.scanIntervalSec as number) || 30,
    /** Keep own fuel above this %. */
    refuelThreshold: (r.refuelThreshold as number) || 60,
  };
}

// ── Helpers ──────────────────────────────────────────────────

interface RescueTarget {
  username: string;
  system: string;
  poi: string;
  fuelPct: number;
  docked: boolean;
}

/** Find bots that need fuel rescue. */
function findStrandedBots(
  fleet: BotStatus[],
  selfName: string,
  fuelThreshold: number,
): RescueTarget[] {
  const targets: RescueTarget[] = [];
  for (const bot of fleet) {
    if (bot.username === selfName) continue;
    if (bot.state !== "running" && bot.state !== "idle") continue;
    const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    if (fuelPct <= fuelThreshold) {
      targets.push({
        username: bot.username,
        system: bot.system,
        poi: bot.poi,
        fuelPct,
        docked: bot.docked,
      });
    }
  }
  // Sort by most critical first
  targets.sort((a, b) => a.fuelPct - b.fuelPct);
  return targets;
}

/**
 * Check if the ship has the refueling_pump module installed.
 * Returns true if the module is found, false otherwise.
 */
async function hasRefuelingPump(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  
  try {
    const shipResp = await bot.exec("get_ship");
    if (shipResp.error) {
      ctx.log("warn", `Could not get ship info: ${shipResp.error.message}`);
      return false;
    }
    
    const shipData = shipResp.result as Record<string, unknown> | undefined;
    if (!shipData) return false;
    
    const modules = Array.isArray(shipData.modules) ? shipData.modules : [];
    
    for (const mod of modules) {
      const m = mod as Record<string, unknown>;
      const moduleId = (m.type_id as string) || (m.id as string) || "";
      const moduleName = (m.name as string) || "";
      
      if (moduleId.includes("refueling_pump") || moduleName.toLowerCase().includes("refueling pump")) {
        ctx.log("rescue", "✓ Refueling Pump module detected");
        return true;
      }
    }
    
    ctx.log("warn", "Refueling Pump module NOT detected on this ship");
    return false;
  } catch (err) {
    ctx.log("warn", `Error checking for Refueling Pump: ${err}`);
    return false;
  }
}

// ── FuelTransfer routine (using refuel command) ─────────────────

/**
 * FuelTransfer routine — uses a dedicated fuel transfer ship to directly
 * refuel stranded ships in the field using the 'refuel' command.
 *
 * 1. Scan fleet status for bots with dangerously low fuel
 * 2. Navigate to stranded bot's system
 * 3. Travel to stranded bot's POI
 * 4. Issue 'refuel target=player_id' command to transfer fuel
 * 5. Return to idle scanning
 */
export const fuelTransferRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();
  const homeSystem = bot.system;

  ctx.log("system", "FuelTransfer bot online — ready to refuel stranded ships...");

  // Check for Refueling Pump module at startup
  const hasPump = await hasRefuelingPump(ctx);
  if (!hasPump) {
    ctx.log("error", "Refueling Pump module not installed! This routine requires the refueling_pump module.");
    ctx.log("info", "Switching to fuel cell delivery fallback mode...");
  }

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await sleep(30000); continue; }

    const settings = getRescueSettings();

    // ── Check fleet status ──
    yield "scan_fleet";
    const fleet = ctx.getFleetStatus?.() || [];
    if (fleet.length === 0) {
      ctx.log("info", "No fleet data available — waiting...");
      await sleep(settings.scanIntervalSec * 1000);
      continue;
    }

    const targets = findStrandedBots(fleet, bot.username, settings.fuelThreshold);

    if (targets.length === 0) {
      // No one needs help — idle
      yield "idle";
      await sleep(settings.scanIntervalSec * 1000);
      continue;
    }

    // ── Rescue the most critical bot ──
    const target = targets[0];
    ctx.log("rescue", `RESCUE NEEDED: ${target.username} at ${target.fuelPct}% fuel in ${target.system} (POI: ${target.poi || "unknown"})`);

    // ── Check for Refueling Pump before each mission ──
    const hasPumpNow = hasPump || await hasRefuelingPump(ctx);

    // ── Ensure we have enough fuel to share ──
    yield "self_check";
    await bot.refreshStatus();
    logStatus(ctx);

    if (hasPumpNow) {
      // Need extra fuel beyond our own threshold to transfer
      const minFuelForTransfer = Math.round(bot.maxFuel * (settings.refuelThreshold / 100)) + 100;
      if (bot.fuel < minFuelForTransfer) {
        ctx.log("rescue", "Insufficient fuel for transfer — refueling self first...");
        const fueled = await ensureFueled(ctx, settings.refuelThreshold);
        if (!fueled) {
          ctx.log("error", "Cannot refuel self — waiting before retry...");
          await sleep(settings.scanIntervalSec * 1000);
          continue;
        }
      }
    } else {
      // Fallback: need fuel cells instead
      ctx.log("rescue", "No Refueling Pump — will use fuel cell delivery method");
    }

    // ── Navigate to stranded bot's system ──
    yield "navigate_to_target";
    await ensureUndocked(ctx);

    if (target.system && target.system !== bot.system) {
      ctx.log("rescue", `Navigating to ${target.system}...`);
      const safetyOpts = { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: 30 };
      const arrived = await navigateToSystem(ctx, target.system, safetyOpts);
      if (!arrived) {
        ctx.log("error", `Could not reach ${target.system} — will retry next scan`);
        await sleep(settings.scanIntervalSec * 1000);
        continue;
      }
    }

    if (bot.state !== "running") break;

    // ── Travel to stranded bot's POI ──
    if (target.poi) {
      yield "travel_to_target";
      ctx.log("rescue", `Traveling to ${target.username}'s location (${target.poi})...`);
      const travelResp = await bot.exec("travel", { target_poi: target.poi });
      if (travelResp.error && !travelResp.error.message.includes("already")) {
        ctx.log("error", `Travel failed: ${travelResp.error.message}`);
      }
      bot.poi = target.poi;
    }

    // ── Transfer fuel ──
    yield "transfer_fuel";

    if (hasPumpNow) {
      // Use refuel command with Refueling Pump
      ctx.log("rescue", `Initiating fuel transfer to ${target.username} using Refueling Pump...`);

      // Need to get the target's player ID for the refuel command
      const targetPlayerId = await findPlayerId(ctx, target.username);

      if (!targetPlayerId) {
        ctx.log("error", `Could not find player ID for ${target.username} — aborting transfer`);
        await sleep(settings.scanIntervalSec * 1000);
        continue;
      }

      // Issue the refuel command
      const refuelResp = await bot.exec("refuel", { target: targetPlayerId });

      if (refuelResp.error) {
        ctx.log("error", `Refuel command failed: ${refuelResp.error.message}`);
      } else {
        // Parse and log the result
        const result = refuelResp.result as Record<string, unknown> | undefined;
        if (result) {
          const fuelDelta = result.fuel as number || 0;
          const fuelNow = result.fuel_now as number || bot.fuel;
          const targetFuelNow = result.target_fuel_now as number || 0;
          const targetName = result.target_player_name as string || target.username;

          ctx.log("rescue", `✓ Transferred ${Math.abs(fuelDelta)} fuel to ${targetName}`);
          ctx.log("rescue", `  Our fuel: ${fuelNow}, Their fuel: ${targetFuelNow}`);
        } else {
          ctx.log("rescue", `✓ Fuel transfer complete for ${target.username}`);
        }
      }
    } else {
      // Fallback: Use fuel cell delivery method (jettison for them to collect)
      ctx.log("rescue", `Delivering fuel cells to ${target.username} (no Refueling Pump)...`);

      // Dock first to get fuel cells from storage
      await ensureDocked(ctx);
      await collectFromStorage(ctx);

      // Check if we have fuel cells in cargo
      await bot.refreshCargo();
      const fuelItem = bot.inventory.find(i =>
        i.itemId.includes("fuel_cell") || i.itemId.includes("fuel") || i.itemId.includes("energy_cell")
      );

      if (fuelItem && fuelItem.quantity > 0) {
        // Undock and jettison at target location
        await ensureUndocked(ctx);

        ctx.log("rescue", `Jettisoning ${fuelItem.quantity}x ${fuelItem.name} for ${target.username} to collect...`);
        const jetResp = await bot.exec("jettison", {
          item_id: fuelItem.itemId,
          quantity: fuelItem.quantity,
        });

        if (jetResp.error) {
          ctx.log("error", `Jettison failed: ${jetResp.error.message}`);
        } else {
          ctx.log("rescue", `✓ Fuel cells jettisoned at ${bot.poi} — ${target.username} should scavenge them`);
        }
      } else {
        // No fuel cells in cargo — try to buy them
        ctx.log("rescue", "No fuel cells in cargo — attempting to purchase...");

        // Need to dock to buy
        const { pois } = await getSystemInfo(ctx);
        const station = findStation(pois);

        if (station) {
          ctx.log("rescue", `Traveling to ${station.name} to purchase fuel cells...`);
          await bot.exec("travel", { target_poi: station.id });
          await bot.exec("dock");
          bot.docked = true;
          await collectFromStorage(ctx);

          // Try buying fuel cells
          const marketResp = await bot.exec("view_market");
          let boughtCells = false;

          if (marketResp.result && typeof marketResp.result === "object") {
            const mData = marketResp.result as Record<string, unknown>;
            const items = (
              Array.isArray(mData) ? mData :
              Array.isArray(mData.items) ? mData.items :
              Array.isArray(mData.market) ? mData.market :
              []
            ) as Array<Record<string, unknown>>;

            const fuelItem = items.find(i => {
              const id = ((i.item_id as string) || (i.id as string) || "").toLowerCase();
              return id.includes("fuel_cell") || id.includes("fuel") || id.includes("energy_cell");
            });

            if (fuelItem) {
              const fuelId = (fuelItem.item_id as string) || (fuelItem.id as string) || "";
              const price = (fuelItem.price as number) || (fuelItem.buy_price as number) || 0;
              const available = (fuelItem.quantity as number) || (fuelItem.stock as number) || 0;
              const qty = Math.min(settings.rescueFuelCells, available);

              if (qty > 0 && (price * qty) <= bot.credits) {
                ctx.log("rescue", `Buying ${qty}x fuel cells (${price}cr each)...`);
                const buyResp = await bot.exec("buy", { item_id: fuelId, quantity: qty });
                if (!buyResp.error) {
                  boughtCells = true;
                  ctx.log("rescue", `Acquired ${qty}x fuel cells`);
                }
              }
            }
          }

          if (boughtCells) {
            // Return to target and jettison
            await ensureUndocked(ctx);
            if (target.poi) {
              await bot.exec("travel", { target_poi: target.poi });
              bot.poi = target.poi;
            }

            await bot.refreshCargo();
            const purchasedItem = bot.inventory.find(i =>
              i.itemId.includes("fuel_cell") || i.itemId.includes("fuel") || i.itemId.includes("energy_cell")
            );

            if (purchasedItem) {
              const jetResp = await bot.exec("jettison", {
                item_id: purchasedItem.itemId,
                quantity: purchasedItem.quantity,
              });

              if (jetResp.error) {
                ctx.log("error", `Jettison failed: ${jetResp.error.message}`);
              } else {
                ctx.log("rescue", `✓ Fuel cells jettisoned at ${bot.poi} — ${target.username} should scavenge them`);
              }
            }
          } else {
            ctx.log("error", "Could not acquire fuel cells — mission failed");
          }
        } else {
          ctx.log("error", "No station found to acquire fuel cells");
        }
      }
    }

    // ── Return to home system ──
    if (homeSystem && bot.system !== homeSystem) {
      yield "return_home";
      ctx.log("rescue", `Returning to home system ${homeSystem}...`);
      await ensureUndocked(ctx);
      const safetyOpts = { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: 30 };
      await navigateToSystem(ctx, homeSystem, safetyOpts);
    }

    // ── Refuel self ──
    yield "self_refuel";
    await ensureFueled(ctx, settings.refuelThreshold);
    await bot.refreshStatus();
    logStatus(ctx);

    ctx.log("rescue", `=== Fuel transfer mission for ${target.username} complete ===`);

    // Short cooldown before next scan
    await sleep(10000);
  }
};

// ── Manual Player Rescue routine ────────────────────────────

interface ManualRescueParams {
  targetSystem: string;
  targetPOI: string;
  targetPlayer: string;
}

/**
 * Manual Player Rescue routine — rescues a specific player at a specified location.
 * Parameters are passed via ctx.bot.params or similar mechanism.
 *
 * 1. Navigate to the specified system
 * 2. Travel to the specified POI
 * 3. Use get_nearby to find the target player
 * 4. If player not found (typo), try fuzzy matching or refuel all nearby ships
 * 5. Refuel the target player(s)
 * 6. Return home, dock, and refuel
 */
export const manualPlayerRescueRoutine: Routine = async function* (ctx: RoutineContext, params?: ManualRescueParams) {
  const { bot } = ctx;

  await bot.refreshStatus();
  const homeSystem = bot.system;

  // Get parameters (passed from botmanager via action.params)
  const rescueParams = params || (bot as unknown as Record<string, unknown>).routineParams as ManualRescueParams | undefined;

  if (!rescueParams) {
    ctx.log("error", "No rescue parameters provided! Need targetSystem, targetPOI, and targetPlayer.");
    await sleep(5000);
    return;
  }

  const { targetSystem, targetPOI, targetPlayer } = rescueParams;
  
  ctx.log("rescue", `🚀 Manual Player Rescue Mission initiated!`);
  ctx.log("rescue", `Target: ${targetPlayer} at ${targetSystem} / ${targetPOI}`);

  const settings = getRescueSettings();

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await sleep(30000); continue; }

    // ── Check for Refueling Pump ──
    const hasPump = await hasRefuelingPump(ctx);
    if (!hasPump) {
      ctx.log("error", "Refueling Pump module not installed! Cannot perform direct fuel transfer.");
      ctx.log("info", "Falling back to fuel cell delivery method...");
    }

    // ── Ensure we have enough fuel ──
    yield "self_check";
    await bot.refreshStatus();
    logStatus(ctx);

    if (hasPump) {
      const minFuelForTransfer = Math.round(bot.maxFuel * (settings.refuelThreshold / 100)) + 100;
      if (bot.fuel < minFuelForTransfer) {
        ctx.log("rescue", "Insufficient fuel for transfer — refueling self first...");
        const fueled = await ensureFueled(ctx, settings.refuelThreshold);
        if (!fueled) {
          ctx.log("error", "Cannot refuel self — aborting mission");
          await sleep(5000);
          return;
        }
      }
    }

    // ── Navigate to target system ──
    yield "navigate_to_target";
    await ensureUndocked(ctx);

    if (targetSystem && targetSystem !== bot.system) {
      ctx.log("rescue", `Navigating to ${targetSystem}...`);
      const safetyOpts = { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: 30 };
      const arrived = await navigateToSystem(ctx, targetSystem, safetyOpts);
      if (!arrived) {
        ctx.log("error", `Could not reach ${targetSystem} — aborting mission`);
        await sleep(5000);
        return;
      }
    }

    if (bot.state !== "running") break;

    // ── Travel to target POI ──
    yield "travel_to_target";
    ctx.log("rescue", `Traveling to target location (${targetPOI})...`);
    const travelResp = await bot.exec("travel", { target_poi: targetPOI });
    if (travelResp.error && !travelResp.error.message.includes("already")) {
      ctx.log("error", `Travel failed: ${travelResp.error.message}`);
      // Continue anyway, we might already be there
    }
    bot.poi = targetPOI;

    // ── Find the target player using get_nearby ──
    yield "scan_target";
    ctx.log("rescue", `Scanning for player: ${targetPlayer}...`);
    
    const nearbyResp = await bot.exec("get_nearby");
    let nearbyPlayers: Array<{ playerId: string; username: string; shipType?: string }> = [];
    
    if (!nearbyResp.error && nearbyResp.result) {
      const data = nearbyResp.result as Record<string, unknown>;
      const players = Array.isArray(data.players) ? data.players :
                      Array.isArray(data.nearby) ? data.nearby :
                      Array.isArray(data.ships) ? data.ships : [];
      
      for (const p of players as Array<Record<string, unknown>>) {
        const playerId = (p.player_id as string) || (p.id as string);
        const username = (p.username as string) || (p.name as string);
        const shipType = p.ship_type as string | undefined;
        if (playerId && username) {
          nearbyPlayers.push({ playerId, username, shipType });
        }
      }
      
      ctx.log("rescue", `Found ${nearbyPlayers.length} nearby ship(s)`);
    }

    if (nearbyPlayers.length === 0) {
      ctx.log("error", `No ships found at ${targetPOI}. Target may have left or location is wrong.`);
      ctx.log("rescue", `Returning home...`);
      break;
    }

    // ── Find target player (exact match or fuzzy) ──
    let targetEntry: { playerId: string; username: string; shipType?: string } | null = nearbyPlayers.find(p => p.username.toLowerCase() === targetPlayer.toLowerCase()) || null;

    if (!targetEntry) {
      // Fuzzy match - find closest by name similarity
      ctx.log("warn", `Exact match not found for "${targetPlayer}" — trying fuzzy match...`);

      let bestMatch: { playerId: string; username: string; shipType?: string } | null = null;
      let bestScore = 0;

      for (const p of nearbyPlayers) {
        // Simple similarity: check if one name contains the other or has high character overlap
        const name1 = p.username.toLowerCase();
        const name2 = targetPlayer.toLowerCase();

        // Check containment
        if (name1.includes(name2) || name2.includes(name1)) {
          bestMatch = p;
          break;
        }

        // Check character overlap (simple Levenshtein-like heuristic)
        let matches = 0;
        for (const char of name2) {
          if (name1.includes(char)) matches++;
        }
        const score = matches / Math.max(name1.length, name2.length);

        if (score > bestScore && score > 0.6) {
          bestScore = score;
          bestMatch = p;
        }
      }

      if (bestMatch) {
        ctx.log("warn", `Fuzzy match found: "${bestMatch.username}" (confidence: ${(bestScore * 100).toFixed(0)}%)`);
        targetEntry = bestMatch;
      } else {
        ctx.log("error", `Could not find player "${targetPlayer}" or any close match.`);
        ctx.log("rescue", `Will refuel all nearby ships as fallback...`);
      }
    }

    // ── Refuel target(s) ──
    yield "transfer_fuel";

    const playersToRefuel: Array<{ playerId: string; username: string; shipType?: string }> = targetEntry ? [targetEntry] : nearbyPlayers;
    
    for (const player of playersToRefuel) {
      if (hasPump) {
        // Direct refuel using refuel command
        ctx.log("rescue", `Refueling ${player.username}${player.shipType ? ` (${player.shipType})` : ''}...`);
        
        const refuelResp = await bot.exec("refuel", { target: player.playerId });
        
        if (refuelResp.error) {
          ctx.log("error", `Refuel failed: ${refuelResp.error.message}`);
        } else {
          const result = refuelResp.result as Record<string, unknown> | undefined;
          if (result) {
            const fuelDelta = result.fuel as number || 0;
            const targetFuelNow = result.target_fuel_now as number || 0;
            ctx.log("rescue", `✓ Transferred ${Math.abs(fuelDelta)} fuel to ${player.username}`);
            ctx.log("rescue", `  Their fuel: ${targetFuelNow}`);
          } else {
            ctx.log("rescue", `✓ Refueled ${player.username}`);
          }
        }
      } else {
        // Fallback: jettison fuel cells
        ctx.log("rescue", `No Refueling Pump — jettisoning fuel cells for ${player.username}...`);
        
        await ensureDocked(ctx);
        await collectFromStorage(ctx);
        
        await bot.refreshCargo();
        const fuelItem = bot.inventory.find(i =>
          i.itemId.includes("fuel_cell") || i.itemId.includes("fuel") || i.itemId.includes("energy_cell")
        );
        
        if (fuelItem && fuelItem.quantity > 0) {
          await ensureUndocked(ctx);
          
          const jetResp = await bot.exec("jettison", {
            item_id: fuelItem.itemId,
            quantity: fuelItem.quantity,
          });
          
          if (jetResp.error) {
            ctx.log("error", `Jettison failed: ${jetResp.error.message}`);
          } else {
            ctx.log("rescue", `✓ Jettisoned ${fuelItem.quantity}x ${fuelItem.name} for ${player.username}`);
          }
        } else {
          ctx.log("error", "No fuel cells available for delivery");
        }
      }
    }

    // ── Mission complete — return home ──
    ctx.log("rescue", `=== Rescue mission complete ===`);
    break;
  }

  // ── Return to home system ──
  if (homeSystem && bot.system !== homeSystem) {
    yield "return_home";
    ctx.log("rescue", `Returning to home system ${homeSystem}...`);
    await ensureUndocked(ctx);
    const safetyOpts = { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: 30 };
    await navigateToSystem(ctx, homeSystem, safetyOpts);
  }

  // ── Dock and refuel self ──
  yield "self_refuel";
  await ensureDocked(ctx);
  
  // Always refuel to 100% after a rescue mission, regardless of current fuel level
  ctx.log("rescue", "Refueling to full capacity after mission...");
  await bot.refreshStatus();
  
  // Call refuel command directly since we're docked
  const refuelResp = await bot.exec("refuel");
  if (refuelResp.error) {
    ctx.log("error", `Refuel failed: ${refuelResp.error.message}`);
    // Try ensureFueled as fallback
    await ensureFueled(ctx, settings.refuelThreshold);
  } else {
    await bot.refreshStatus();
    const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("rescue", `Fuel: ${fuelPct}% (${bot.fuel}/${bot.maxFuel})`);
  }
  
  await bot.refreshStatus();
  logStatus(ctx);

  ctx.log("rescue", `✓ Bot is docked, refueled, and ready for next mission`);

  // Clear routine params after completion (also cleared in botmanager, but good to do here too)
  (bot as unknown as Record<string, unknown>).routineParams = undefined;
}

// ── MaydayRescue routine ────────────────────────────────────

/**
 * MaydayRescue routine — automatically responds to MAYDAY emergency chat messages.
 *
 * 1. Monitor MAYDAY queue for emergency rescue requests
 * 2. Validate request (fuel < 25% to avoid ambushes)
 * 3. Calculate route and send AI-generated "on my way" message
 * 4. Navigate to stranded pilot's location
 * 5. Refuel them using refuel command (if pump installed) or fuel cells
 * 6. Send AI-generated "rescue complete" message
 * 7. Return home and refuel
 * 8. Continue monitoring for next MAYDAY
 */
export const maydayRescueRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();
  const homeSystem = bot.system;

  ctx.log("rescue", "🚨 MaydayRescue bot online — monitoring emergency channel for distress calls...");

  const settings = getRescueSettings();
  const maydayFuelThreshold = 25; // Only respond if target fuel < 25%
  const aiChatService = (globalThis as any).aiChatService;

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await sleep(30000); continue; }

    // ── Check for pending MAYDAY requests ──
    yield "scan_mayday";
    const mayday = getNextMayday();

    if (!mayday) {
      // No pending MAYDAYs - idle and wait
      ctx.log("mayday", "No pending MAYDAY requests - standing by...");
      yield "idle";
      await sleep(10000); // Check every 10 seconds
      continue;
    }

    ctx.log("mayday", `🚨 MAYDAY received: ${mayday.sender} at ${mayday.system}/${mayday.poi} (${mayday.fuelPct}% fuel)`);

    // ── Validate MAYDAY (avoid ambushes) ──
    if (!isLegitimateMayday(mayday, maydayFuelThreshold)) {
      ctx.log("mayday", `⚠️ Ignoring MAYDAY from ${mayday.sender} - fuel at ${mayday.fuelPct}% (threshold: ${maydayFuelThreshold}%) - possible ambush`);
      markMaydayHandled(mayday); // Mark as handled so we don't process again
      continue;
    }

    ctx.log("mayday", `✓ MAYDAY validated - launching rescue mission for ${mayday.sender}`);

    // ── Check for Refueling Pump ──
    const hasPump = await hasRefuelingPump(ctx);
    if (!hasPump) {
      ctx.log("mayday", "⚠️ Refueling Pump not installed - will use fuel cell delivery method");
    }

    // ── Ensure we have enough fuel ──
    yield "self_check";
    await bot.refreshStatus();
    logStatus(ctx);

    if (hasPump) {
      const minFuelForTransfer = Math.round(bot.maxFuel * (settings.refuelThreshold / 100)) + 100;
      if (bot.fuel < minFuelForTransfer) {
        ctx.log("mayday", "Insufficient fuel for transfer - refueling self first...");
        const fueled = await ensureFueled(ctx, settings.refuelThreshold);
        if (!fueled) {
          ctx.log("error", "Cannot refuel self - cannot respond to MAYDAY");
          await sleep(30000);
          continue;
        }
      }
    }

    // ── Calculate route and send "on my way" message ──
    let jumpsToTarget = 0;
    let estimatedFuel = 0;

    if (mayday.system && mayday.system !== bot.system) {
      try {
        const routeResp = await bot.exec("find_route", { system: mayday.system });
        if (!routeResp.error && routeResp.result) {
          const route = routeResp.result as Record<string, unknown>;
          jumpsToTarget = (route.total_jumps as number) || 0;
          estimatedFuel = (route.estimated_fuel as number) || 0;
          ctx.log("mayday", `Route calculated: ${jumpsToTarget} jumps, ~${estimatedFuel} fuel`);
        }
      } catch (e) {
        ctx.log("warn", `Could not calculate route: ${e}`);
      }
    }

    // Send AI-generated "on my way" message via private chat
    if (aiChatService && typeof aiChatService.sendPrivateMessage === "function") {
      try {
        await aiChatService.sendPrivateMessage(bot, mayday.sender, {
          situation: `You are responding to their MAYDAY distress call. You are coming to rescue them with fuel.`,
          currentSystem: bot.system,
          targetSystem: mayday.system,
          jumps: jumpsToTarget > 0 ? jumpsToTarget : undefined,
          playerFuelPct: mayday.fuelPct,
        });
      } catch (e) {
        ctx.log("warn", `AI message failed: ${e}`);
      }
    } else {
      // Fallback: simple hardcoded message
      const etaMsg = jumpsToTarget > 0 ? `ETA: ${jumpsToTarget} jumps` : "Arriving shortly";
      ctx.log("mayday", `Sending rescue confirmation to ${mayday.sender}`);
      // Note: Would need private chat command here
    }

    // ── Navigate to target system ──
    yield "navigate_to_target";
    await ensureUndocked(ctx);

    if (mayday.system && mayday.system !== bot.system) {
      ctx.log("mayday", `Jumping to ${mayday.system}...`);
      const safetyOpts = { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: 30 };
      const arrived = await navigateToSystem(ctx, mayday.system, safetyOpts);
      if (!arrived) {
        ctx.log("error", `Could not reach ${mayday.system} - MAYDAY response failed`);
        markMaydayHandled(mayday);
        await sleep(5000);
        continue;
      }
    }

    if (bot.state !== "running") break;

    // ── Travel to target POI ──
    yield "travel_to_target";
    ctx.log("mayday", `Traveling to ${mayday.poi}...`);
    const travelResp = await bot.exec("travel", { target_poi: mayday.poi });
    if (travelResp.error && !travelResp.error.message.includes("already")) {
      ctx.log("error", `Travel failed: ${travelResp.error.message}`);
    }
    bot.poi = mayday.poi;

    // ── Find and refuel target ──
    yield "scan_target";
    ctx.log("mayday", `Scanning for ${mayday.sender}...`);

    const nearbyResp = await bot.exec("get_nearby");
    let targetPlayerId: string | null = null;
    let targetFuelBefore = 0;

    if (!nearbyResp.error && nearbyResp.result) {
      const data = nearbyResp.result as Record<string, unknown>;
      const players = Array.isArray(data.players) ? data.players :
                      Array.isArray(data.nearby) ? data.nearby :
                      Array.isArray(data.ships) ? data.ships : [];

      for (const p of players as Array<Record<string, unknown>>) {
        const playerId = (p.player_id as string) || (p.id as string);
        const username = (p.username as string) || (p.name as string);
        const fuelNow = (p.fuel_now as number) || (p.fuel as number) || 0;
        if (username && username.toLowerCase() === mayday.sender.toLowerCase()) {
          targetPlayerId = playerId;
          targetFuelBefore = fuelNow;
          break;
        }
      }
    }

    // ── Refuel target ──
    yield "transfer_fuel";
    let fuelTransferred = 0;

    if (targetPlayerId) {
      if (hasPump) {
        // Direct refuel using refuel command
        ctx.log("mayday", `Refueling ${mayday.sender}...`);
        const refuelResp = await bot.exec("refuel", { target: targetPlayerId });

        if (refuelResp.error) {
          ctx.log("error", `Refuel failed: ${refuelResp.error.message}`);
        } else {
          const result = refuelResp.result as Record<string, unknown> | undefined;
          if (result) {
            fuelTransferred = Math.abs(result.fuel as number || 0);
            const targetFuelNow = result.target_fuel_now as number || 0;
            ctx.log("mayday", `✓ Transferred ${fuelTransferred} fuel to ${mayday.sender}`);
            ctx.log("mayday", `  Their fuel: ${targetFuelNow}`);
          }
        }
      } else {
        // Fallback: jettison fuel cells
        ctx.log("mayday", `No Refueling Pump - jettisoning fuel cells for ${mayday.sender}...`);
        await ensureDocked(ctx);
        await collectFromStorage(ctx);
        await bot.refreshCargo();
        const fuelItem = bot.inventory.find(i =>
          i.itemId.includes("fuel_cell") || i.itemId.includes("fuel") || i.itemId.includes("energy_cell")
        );
        if (fuelItem && fuelItem.quantity > 0) {
          await ensureUndocked(ctx);
          const jetResp = await bot.exec("jettison", {
            item_id: fuelItem.itemId,
            quantity: fuelItem.quantity,
          });
          if (jetResp.error) {
            ctx.log("error", `Jettison failed: ${jetResp.error.message}`);
          } else {
            fuelTransferred = fuelItem.quantity * 10; // Approximate fuel value
            ctx.log("mayday", `✓ Jettisoned ${fuelItem.quantity}x ${fuelItem.name} for ${mayday.sender}`);
          }
        }
      }
    } else {
      ctx.log("warn", `Could not find ${mayday.sender} at location - they may have left or it was a false MAYDAY`);
    }

    // Send AI-generated "rescue complete" message
    if (aiChatService && typeof aiChatService.sendPrivateMessage === "function") {
      try {
        await aiChatService.sendPrivateMessage(bot, mayday.sender, {
          situation: fuelTransferred > 0 
            ? `You have successfully refueled the stranded pilot. They are now safe and can continue their journey.`
            : `You arrived to help but couldn't provide fuel. You did your best to assist.`,
          currentSystem: mayday.system, // Now at same system
          targetSystem: mayday.system,
          fuelRefueled: fuelTransferred > 0 ? fuelTransferred : undefined,
          playerFuelPct: targetFuelBefore,
        });
      } catch (e) {
        ctx.log("warn", `AI completion message failed: ${e}`);
      }
    }

    // Mark MAYDAY as handled
    markMaydayHandled(mayday);
    ctx.log("mayday", `=== MAYDAY response complete for ${mayday.sender} ===`);

    // ── Return home ──
    if (homeSystem && bot.system !== homeSystem) {
      yield "return_home";
      ctx.log("mayday", `Returning to home system ${homeSystem}...`);
      await ensureUndocked(ctx);
      const safetyOpts = { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: 30 };
      await navigateToSystem(ctx, homeSystem, safetyOpts);
    }

    // ── Dock and refuel self ──
    yield "self_refuel";
    await ensureDocked(ctx);

    ctx.log("mayday", "Refueling to full capacity after mission...");
    await bot.refreshStatus();
    const refuelResp = await bot.exec("refuel");
    if (refuelResp.error) {
      ctx.log("error", `Refuel failed: ${refuelResp.error.message}`);
      await ensureFueled(ctx, settings.refuelThreshold);
    } else {
      await bot.refreshStatus();
      const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      ctx.log("mayday", `Fuel: ${fuelPct}% (${bot.fuel}/${bot.maxFuel})`);
    }

    await bot.refreshStatus();
    logStatus(ctx);
    ctx.log("mayday", "✓ Bot is docked, refueled, and ready for next MAYDAY");

    // Short cooldown before next scan
    await sleep(5000);
  }
};

/**
 * Look up a player's ID from their username.
 * Uses view_fleet or view_player to resolve the ID.
 */
async function findPlayerId(ctx: RoutineContext, username: string): Promise<string | null> {
  const { bot } = ctx;
  
  // First, check if we can get it from fleet status (extended fields)
  const fleet = ctx.getFleetStatus?.() || [];
  for (const member of fleet) {
    if (member.username === username) {
      // Check for player_id in extended fields
      const memberRecord = member as unknown as Record<string, unknown>;
      if (memberRecord.player_id && typeof memberRecord.player_id === 'string') {
        return memberRecord.player_id;
      }
    }
  }
  
  // Try using view_fleet to get player IDs
  try {
    const resp = await bot.exec("view_fleet");
    if (!resp.error && resp.result) {
      const data = resp.result as Record<string, unknown>;
      const members = Array.isArray(data.members) ? data.members : 
                      Array.isArray(data.fleet) ? data.fleet :
                      Array.isArray(data.bots) ? data.bots : [];
      
      for (const member of members) {
        const m = member as Record<string, unknown>;
        if (m.username === username || m.name === username) {
          const playerId = m.player_id as string || m.id as string;
          if (playerId) {
            return playerId;
          }
        }
      }
    }
  } catch {
    // Ignore errors
  }
  
  // Try using view_player as fallback
  try {
    const resp = await bot.exec("view_player", { player: username });
    if (!resp.error && resp.result) {
      const data = resp.result as Record<string, unknown>;
      const playerId = data.id as string || data.player_id as string;
      if (playerId) {
        return playerId;
      }
    }
  } catch {
    // Ignore errors from unsupported commands
  }
  
  // If we can't find the player ID, log warning and return null
  ctx.log("warn", `Could not resolve player ID for ${username}`);
  return null;
}

// ── FuelRescue routine ──────────────────────────────────────

/**
 * FuelRescue routine — monitors fleet and rescues stranded bots:
 *
 * 1. Scan fleet status for bots with dangerously low fuel
 * 2. Buy fuel cells at nearest station (or use existing stock)
 * 3. Navigate to stranded bot's system
 * 4. Travel to stranded bot's POI
 * 5. If same station: send_gift credits. If in space: jettison fuel cells
 * 6. Scavenge loop on the stranded bot picks up the fuel cells
 * 7. Return to idle scanning
 */
export const rescueRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();
  const homeSystem = bot.system;

  ctx.log("system", "FuelRescue bot online — monitoring fleet for stranded ships...");

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await sleep(30000); continue; }

    const settings = getRescueSettings();

    // ── Check fleet status ──
    yield "scan_fleet";
    const fleet = ctx.getFleetStatus?.() || [];
    if (fleet.length === 0) {
      ctx.log("info", "No fleet data available — waiting...");
      await sleep(settings.scanIntervalSec * 1000);
      continue;
    }

    const targets = findStrandedBots(fleet, bot.username, settings.fuelThreshold);

    if (targets.length === 0) {
      // No one needs help — scavenge where we are and idle
      yield "idle_scavenge";
      if (!bot.docked) {
        await scavengeWrecks(ctx);
      }
      await sleep(settings.scanIntervalSec * 1000);
      continue;
    }

    // ── Rescue the most critical bot ──
    const target = targets[0];
    ctx.log("rescue", `RESCUE NEEDED: ${target.username} at ${target.fuelPct}% fuel in ${target.system} (POI: ${target.poi || "unknown"})`);

    // ── Ensure we have fuel ourselves ──
    yield "self_check";
    await bot.refreshStatus();
    logStatus(ctx);

    const fueled = await ensureFueled(ctx, settings.refuelThreshold);
    if (!fueled) {
      ctx.log("error", "Cannot refuel self — waiting before retry...");
      await sleep(settings.scanIntervalSec * 1000);
      continue;
    }

    // ── Stock up on fuel cells for delivery ──
    yield "acquire_fuel";
    await ensureDocked(ctx);

    // Try buying fuel cells from market
    ctx.log("rescue", "Checking market for fuel cells...");
    const marketResp = await bot.exec("view_market");
    let hasFuelCells = false;

    if (marketResp.result && typeof marketResp.result === "object") {
      const mData = marketResp.result as Record<string, unknown>;
      const items = (
        Array.isArray(mData) ? mData :
        Array.isArray(mData.items) ? mData.items :
        Array.isArray(mData.market) ? mData.market :
        []
      ) as Array<Record<string, unknown>>;

      const fuelItem = items.find(i => {
        const id = ((i.item_id as string) || (i.id as string) || "").toLowerCase();
        return id.includes("fuel_cell") || id.includes("fuel") || id.includes("energy_cell");
      });

      if (fuelItem) {
        const fuelId = (fuelItem.item_id as string) || (fuelItem.id as string) || "";
        const price = (fuelItem.price as number) || (fuelItem.buy_price as number) || 0;
        const available = (fuelItem.quantity as number) || (fuelItem.stock as number) || 0;
        const qty = Math.min(settings.rescueFuelCells, available);

        if (qty > 0 && (price * qty) <= bot.credits) {
          ctx.log("rescue", `Buying ${qty}x fuel cells (${price}cr each)...`);
          const buyResp = await bot.exec("buy", { item_id: fuelId, quantity: qty });
          if (!buyResp.error) {
            hasFuelCells = true;
            ctx.log("rescue", `Acquired ${qty}x fuel cells`);
          } else {
            ctx.log("rescue", `Buy failed: ${buyResp.error.message}`);
          }
        }
      }
    }

    // Check if we already have fuel cells in cargo
    if (!hasFuelCells) {
      await bot.refreshCargo();
      const fuelInCargo = bot.inventory.find(i =>
        i.itemId.includes("fuel_cell") || i.itemId.includes("fuel") || i.itemId.includes("energy_cell")
      );
      if (fuelInCargo && fuelInCargo.quantity > 0) {
        hasFuelCells = true;
        ctx.log("rescue", `Already have ${fuelInCargo.quantity}x ${fuelInCargo.name} in cargo`);
      }
    }

    // If we can't get fuel cells, send credits instead (if at same station)
    const willSendCredits = !hasFuelCells && bot.credits >= settings.rescueCredits;

    if (!hasFuelCells && !willSendCredits) {
      ctx.log("error", "No fuel cells available and not enough credits to help — waiting for better situation...");
      await sleep(settings.scanIntervalSec * 1000);
      continue;
    }

    // ── Navigate to stranded bot's system ──
    yield "navigate_to_target";
    await ensureUndocked(ctx);

    if (target.system && target.system !== bot.system) {
      ctx.log("rescue", `Navigating to ${target.system}...`);
      const safetyOpts = { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: 30 };
      const arrived = await navigateToSystem(ctx, target.system, safetyOpts);
      if (!arrived) {
        ctx.log("error", `Could not reach ${target.system} — will retry next scan`);
        await sleep(settings.scanIntervalSec * 1000);
        continue;
      }
    }

    if (bot.state !== "running") break;

    // ── Travel to stranded bot's POI ──
    if (target.poi) {
      yield "travel_to_target";
      ctx.log("rescue", `Traveling to ${target.username}'s location (${target.poi})...`);
      const travelResp = await bot.exec("travel", { target_poi: target.poi });
      if (travelResp.error && !travelResp.error.message.includes("already")) {
        ctx.log("error", `Travel failed: ${travelResp.error.message}`);
        // Try docking at station to send gift instead
      }
      bot.poi = target.poi;
    }

    // ── Deliver fuel ──
    yield "deliver_fuel";

    if (target.docked) {
      // Target is docked — dock at same station and send gift
      ctx.log("rescue", `${target.username} is docked — docking to send gift...`);
      const dockResp = await bot.exec("dock");
      if (!dockResp.error || dockResp.error.message.includes("already")) {
        bot.docked = true;
        await collectFromStorage(ctx);

        if (hasFuelCells) {
          // Send fuel cells
          await bot.refreshCargo();
          const fuelItem = bot.inventory.find(i =>
            i.itemId.includes("fuel_cell") || i.itemId.includes("fuel") || i.itemId.includes("energy_cell")
          );
          if (fuelItem) {
            ctx.log("rescue", `Sending ${fuelItem.quantity}x ${fuelItem.name} to ${target.username}...`);
            await bot.exec("send_gift", {
              recipient: target.username,
              item_id: fuelItem.itemId,
              quantity: fuelItem.quantity,
              message: "Emergency fuel delivery from FuelRescue bot!",
            });
          }
        }

        if (willSendCredits || bot.credits >= settings.rescueCredits) {
          ctx.log("rescue", `Sending ${settings.rescueCredits} credits to ${target.username}...`);
          await bot.exec("send_gift", {
            recipient: target.username,
            credits: settings.rescueCredits,
            message: "Emergency credits from FuelRescue bot — refuel ASAP!",
          });
        }

        ctx.log("rescue", `Delivery complete for ${target.username}!`);
      }
    } else {
      // Target is in space — jettison fuel cells for them to scavenge
      if (hasFuelCells) {
        await bot.refreshCargo();
        const fuelItem = bot.inventory.find(i =>
          i.itemId.includes("fuel_cell") || i.itemId.includes("fuel") || i.itemId.includes("energy_cell")
        );
        if (fuelItem) {
          ctx.log("rescue", `Jettisoning ${fuelItem.quantity}x ${fuelItem.name} for ${target.username} to collect...`);
          const jetResp = await bot.exec("jettison", {
            item_id: fuelItem.itemId,
            quantity: fuelItem.quantity,
          });
          if (jetResp.error) {
            ctx.log("error", `Jettison failed: ${jetResp.error.message}`);
          } else {
            ctx.log("rescue", `Fuel cells jettisoned at ${target.poi || bot.poi} — ${target.username} should scavenge them`);
          }
        }
      } else {
        // Can't help in space without fuel cells — dock at nearest station and send credits
        ctx.log("rescue", "No fuel cells to jettison — looking for station to send credits...");
        const { pois } = await getSystemInfo(ctx);
        const station = findStation(pois);
        if (station) {
          ctx.log("rescue", `Docking at ${station.name} to send credits...`);
          await bot.exec("travel", { target_poi: station.id });
          await bot.exec("dock");
          bot.docked = true;
          await collectFromStorage(ctx);
          if (bot.credits >= settings.rescueCredits) {
            await bot.exec("send_gift", {
              recipient: target.username,
              credits: settings.rescueCredits,
              message: "Emergency credits — dock here to collect and refuel!",
            });
            ctx.log("rescue", `Sent ${settings.rescueCredits} credits to ${target.username}'s storage at ${station.name}`);
          }
        }
      }
    }

    // ── Return to home system ──
    if (homeSystem && bot.system !== homeSystem) {
      yield "return_home";
      ctx.log("rescue", `Returning to home system ${homeSystem}...`);
      await ensureUndocked(ctx);
      const safetyOpts = { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: 30 };
      await navigateToSystem(ctx, homeSystem, safetyOpts);
    }

    // ── Refuel self ──
    yield "self_refuel";
    await ensureFueled(ctx, settings.refuelThreshold);
    await bot.refreshStatus();
    logStatus(ctx);

    ctx.log("rescue", `=== Rescue mission for ${target.username} complete ===`);

    // Short cooldown before next scan
    await sleep(10000);
  }
};
