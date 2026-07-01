import type { Routine, RoutineContext } from "../bot.js";
import { ensureDocked, tryRefuel } from "./common.js";

export const stealthSkillGrindRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  while (bot.state === "running") {
    yield "dock_and_refuel";
    const docked = await ensureDocked(ctx);
    if (!docked) {
      ctx.log("error", "Could not dock at station — retrying next cycle");
      await ctx.sleep(30000);
      continue;
    }

    yield "check_fuel";
    await bot.refreshShip();
    const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    if (fuelPct < 5) {
      ctx.log("system", `Fuel low (${fuelPct}%) — refueling at station`);
      await tryRefuel(ctx);
      await bot.refreshShip();
    }

    yield "cloak_cycle";
    ctx.log("stealth", "Enabling cloak...");
    const cloakOnResp = await bot.exec("cloak", { enable: true });
    if (cloakOnResp.error) {
      const msg = cloakOnResp.error.message.toLowerCase();
      if (!msg.includes("already cloaked") && !msg.includes("already_cloaked")) {
        ctx.log("error", `Failed to enable cloak: ${cloakOnResp.error.message}`);
      }
    } else {
      ctx.log("stealth", "Cloak enabled");
    }

    if (cloakOnResp.notifications && Array.isArray(cloakOnResp.notifications) && cloakOnResp.notifications.length > 0) {
      for (const n of cloakOnResp.notifications) {
        const notification = n as Record<string, unknown>;
        const msg = (notification.message as string) || ((notification.data as Record<string, unknown>)?.message as string) || "";
        if (msg) ctx.log("stealth", msg);
      }
    }

    ctx.log("stealth", "Disabling cloak...");
    const cloakOffResp = await bot.exec("cloak");
    if (cloakOffResp.error) {
      ctx.log("error", `Failed to disable cloak: ${cloakOffResp.error.message}`);
    } else {
      ctx.log("stealth", "Cloak disabled");
    }

    if (cloakOffResp.notifications && Array.isArray(cloakOffResp.notifications) && cloakOffResp.notifications.length > 0) {
      for (const n of cloakOffResp.notifications) {
        const notification = n as Record<string, unknown>;
        const msg = (notification.message as string) || ((notification.data as Record<string, unknown>)?.message as string) || "";
        if (msg) ctx.log("stealth", msg);
      }
    }
  }
};