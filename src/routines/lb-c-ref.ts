import type { Routine, RoutineContext } from "../bot.js";
import { enableCloakingIfPossible, ensureDocked, ensureUndocked, sleep, readSettings } from "./common.js";

interface LbCRefSettings {
  refuelTarget: string;
  refuelIntervalMs: number;
  refuelQuantity: number;
}

function getLbCRefSettings(botUsername?: string): LbCRefSettings {
  const all = readSettings();
  const global = ((all.lb_c_ref || {}) as Record<string, unknown>);
  const botOverrides = botUsername ? ((all[botUsername] || {}) as Record<string, unknown>) : {};
  const botLbCRef = ((botOverrides.lb_c_ref || {}) as Record<string, unknown>);
  const raw = { ...global, ...botLbCRef };
  return {
    refuelTarget: typeof raw.refuelTarget === "string" ? raw.refuelTarget : "",
    refuelIntervalMs: typeof raw.refuelIntervalMs === "number" ? raw.refuelIntervalMs : 1000,
    refuelQuantity: typeof raw.refuelQuantity === "number" ? raw.refuelQuantity : 1,
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

  ctx.log("system", `LB-C-ReF online — target=${settings.refuelTarget} qty=${settings.refuelQuantity}`);

  while (bot.state === "running") {
    yield "init_cloak";
    const cloaked = await enableCloakingIfPossible(ctx);
    if (!cloaked) {
      ctx.log("warn", "LB-C-ReF: Could not enable cloaking — retrying next cycle");
      await ctx.sleep(5000);
      continue;
    }

    yield "refuel_loop";
    let refuelCount = 0;
    while (bot.state === "running") {
      await bot.refreshShip();
      const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;

      if (fuelPct <= 0) {
        ctx.log("system", `LB-C-ReF: Fuel depleted (${fuelPct}%) — breaking to dock`);
        break;
      }

      if (!bot.isCloaked) {
        ctx.log("system", "LB-C-ReF: Cloak dropped — breaking to re-cloak");
        break;
      }

      yield `refuel_${refuelCount}`;
      const resp = await bot.exec("refuel", {
        target: settings.refuelTarget,
        quantity: settings.refuelQuantity,
      });
      if (!resp.error) {
        refuelCount++;
        if (refuelCount % 100 === 0) {
          ctx.log("system", `LB-C-ReF: refuelCount=${refuelCount} target=${settings.refuelTarget}`);
        }
      } else {
        const msg = String(resp.error.message || "").toLowerCase();
        if (!/rate limit|too many requests|temporarily blocked/.test(msg)) {
          ctx.log("warn", `LB-C-ReF refuel error: ${resp.error.message}`);
        }
      }

      await ctx.sleep(settings.refuelIntervalMs);
    }

    yield "dock_and_refuel";
    const docked = await ensureDocked(ctx, true);
    if (!docked) {
      ctx.log("error", "LB-C-ReF: Could not dock — retrying cloak loop");
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
