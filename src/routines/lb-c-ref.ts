import type { Routine, RoutineContext } from "../bot.js";
import { enableCloakingIfPossible, ensureDocked, ensureUndocked, readSettings } from "./common.js";

interface LbCRefSettings {
  refuelTarget: string;
  refuelQuantity: number;
  dockedMode?: boolean;
  dockedPoi?: string;
  scanIntervalMs?: number;
  onlyNewArrivals?: boolean;
  refuelLowFuelPct?: number;
}

function getLbCRefSettings(botUsername?: string): LbCRefSettings {
  const all = readSettings();
  const global = ((all.lb_c_ref || {}) as Record<string, unknown>);
  const botOverrides = botUsername ? ((all[botUsername] || {}) as Record<string, unknown>) : {};
  const botLbCRef = ((botOverrides.lb_c_ref || {}) as Record<string, unknown>);
  const raw = { ...global, ...botLbCRef };
  return {
    refuelTarget: typeof raw.refuelTarget === "string" ? raw.refuelTarget : "",
    refuelQuantity: typeof raw.refuelQuantity === "number" ? raw.refuelQuantity : 1,
    dockedMode: typeof raw.dockedMode === "boolean" ? raw.dockedMode : false,
    dockedPoi: typeof raw.dockedPoi === "string" ? raw.dockedPoi : undefined,
    scanIntervalMs: typeof raw.scanIntervalMs === "number" ? raw.scanIntervalMs : 2000,
    onlyNewArrivals: typeof raw.onlyNewArrivals === "boolean" ? raw.onlyNewArrivals : true,
    refuelLowFuelPct: typeof raw.refuelLowFuelPct === "number" ? raw.refuelLowFuelPct : 0,
  };
}
export const lbCRefRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  while (bot.state !== "running") {
    await ctx.sleep(2000);
  }

  const settings = getLbCRefSettings(bot.username);
  if (!settings.refuelTarget) {
    ctx.log("error", "LB-C-ReF: No refuelTarget set in lb_c_ref settings");
    return;
  }

  ctx.log("system", `LB-C-ReF online â€” target=${settings.refuelTarget} qty=${settings.refuelQuantity} dockedMode=${settings.dockedMode}`);

  if (settings.dockedMode) {
    while (bot.state === "running") {
      const docked = await ensureDocked(ctx, true);
      if (!docked) {
        ctx.log("warn", "LB-C-ReF (docked): Could not dock â€” retrying in 5s");
        await ctx.sleep(5000);
        continue;
      }

      try {
        const obsResp = await bot.subscribeToObservation(false);
        if (obsResp.error) {
          ctx.log("warn", `LB-C-ReF (docked): subscribe_observation failed: ${obsResp.error.message}`);
        }
      } catch (err) {
        ctx.log("warn", `LB-C-ReF (docked): subscribe_observation error: ${err instanceof Error ? err.message : String(err)}`);
      }

      const recentlyRefueled = new Map<string, number>();
      const seen = new Set<string>();
      const lowFuelThreshold = settings.refuelLowFuelPct || 0;
      const onlyNew = settings.onlyNewArrivals !== false;
      const cooldownMs = 30000;

      let obsUnsub: (() => void) | null = null;
      try {
        const acct: any = (bot as any).account;
        if (acct && typeof acct.on === "function") {
          obsUnsub = acct.on("observation_update", () => {});
        }
      } catch {}

      ctx.log("system", "LB-C-ReF (docked): Monitoring for players to refuel...");

      while (bot.state === "running") {
        await bot.refreshShip();
        try {
          bot.trackNearbyPlayers(bot.getObservationResult());
        } catch {}

        const obs = bot.getObservationResult();
        const players = (obs.players || []) as any[];

        for (const player of players) {
          const username = (player.username as string) || (player.name as string) || (player.player_id as string);
          if (!username) continue;
          const key = username.toLowerCase();
          if (onlyNew && seen.has(key)) {
            if (lowFuelThreshold > 0) {
              const fuel = (player.fuel as number) || (player.current_fuel as number) || 0;
              const maxFuel = (player.max_fuel as number) || (player.fuel_capacity as number) || 0;
              if (maxFuel <= 0 || ((fuel / maxFuel) * 100) >= lowFuelThreshold) {
                continue;
              }
            } else {
              continue;
            }
          }
          const now = Date.now();
          const last = recentlyRefueled.get(username);
          if (last && now - last < cooldownMs) continue;

          try {
            yield `refuel_player_${username}`;
            const resp = await bot.exec("refuel", { target: username, quantity: settings.refuelQuantity });
            if (!resp.error) {
              recentlyRefueled.set(username, now);
              ctx.log("system", `LB-C-ReF (docked): Refueled ${username} (+${settings.refuelQuantity})`);
              const cutoff = now - cooldownMs * 2;
              for (const [k, t] of recentlyRefueled.entries()) {
                if (t < cutoff) recentlyRefueled.delete(k);
              }
            } else {
              const errMsg = String(resp.error.message || "").toLowerCase();
              if (errMsg.includes("not nearby") || errMsg.includes("too far") || errMsg.includes("must be closer")) {
                // ignore
              } else if (/rate limit|too many requests|temporarily blocked/.test(errMsg)) {
                ctx.log("warn", "LB-C-ReF (docked) rate limited");
                await ctx.sleep(10000);
                break;
              } else {
                ctx.log("warn", `LB-C-ReF (docked): Failed to refuel ${username}: ${resp.error.message}`);
              }
            }
          } catch (err) {
            ctx.log("warn", `LB-C-ReF (docked): Error refueling ${username}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        await ctx.sleep(settings.scanIntervalMs || 2000);
      }

      if (obsUnsub) {
        try { obsUnsub(); } catch {}
        obsUnsub = null;
      }
    }
    return;
  }

  while (bot.state === "running") {
    yield "init_cloak";
    const cloaked = await enableCloakingIfPossible(ctx);
    if (!cloaked) {
      ctx.log("warn", "LB-C-ReF: Could not enable cloaking â€” retrying next cycle");
      await ctx.sleep(5000);
      continue;
    }

    yield "refuel_loop";
    let refuelCount = 0;
    let failCount = 0;
    while (bot.state === "running") {
      await bot.refreshShip();
      const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      if (fuelPct <= 0) {
        ctx.log("system", `LB-C-ReF: Fuel depleted (${fuelPct}%) â€” breaking to dock`);
        break;
      }
      if (!bot.isCloaked) {
        ctx.log("system", "LB-C-ReF: Cloak dropped â€” breaking to re-cloak");
        break;
      }
      yield `refuel_${refuelCount}`;
      const resp = await bot.exec("refuel", { target: settings.refuelTarget, quantity: settings.refuelQuantity });
      if (!resp.error) {
        refuelCount++;
        failCount = 0;
        ctx.log("system", `LB-C-ReF: #${refuelCount} OK target=${settings.refuelTarget} qty=${settings.refuelQuantity}`);
      } else {
        failCount++;
        const msg = String(resp.error.message || "").toLowerCase();
        if (/rate limit|too many requests|temporarily blocked/.test(msg)) {
          ctx.log("warn", "LB-C-ReF rate limited â€” backing off 10s");
          await ctx.sleep(10000);
          continue;
        }
        ctx.log("warn", `LB-C-ReF refuel FAILED: ${resp.error.message}`);
        if (failCount >= 5) {
          ctx.log("error", `LB-C-ReF: ${failCount} consecutive refuel failures â€” breaking to dock`);
          break;
        }
      }
      const notifications = (resp as any).notifications || [];
      for (const n of notifications) {
        const notification = (n || {}) as Record<string, unknown>;
        const notifMsg = ((notification.data as Record<string, unknown>) || {}).message as string || (notification.message as string) || "";
        if (notifMsg) {
          ctx.log("rescue", `LB-C-ReF notification: ${notifMsg}`);
        }
      }
    }

    yield "dock_and_refuel";
    const docked = await ensureDocked(ctx, true);
    if (!docked) {
      ctx.log("error", "LB-C-ReF: Could not dock â€” retrying cloak loop");
      await ctx.sleep(5000);
      continue;
    }
    const refuelResp = await bot.exec("refuel");
    if (refuelResp.error) {
      ctx.log("error", `LB-C-ReF self-refuel failed: ${refuelResp.error.message}`);
    }
    await bot.refreshShip();
    ctx.log("system", `LB-C-ReF: Self-refueled to ${bot.fuel}/${bot.maxFuel}`);

    yield "undock_and_cloak";
    await ensureUndocked(ctx);
  }
};
