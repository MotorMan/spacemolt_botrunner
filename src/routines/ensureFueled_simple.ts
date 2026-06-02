export async function ensureFueled(
  ctx: RoutineContext,
  thresholdPct: number,
  opts?: { noJettison?: boolean },
): Promise<boolean> {
  const { bot } = ctx;
  await bot.refreshStatus();
  const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (fuelPct >= thresholdPct) return true;

  ctx.log("system", `Fuel low (${fuelPct}%) — need to refuel (threshold: ${thresholdPct}%)...`);

  const approvedFuelStations = (readSettings()?.general as any)?.approvedFuelStations as string[] | undefined;

  if (!approvedFuelStations || approvedFuelStations.length === 0) {
    ctx.log("warn", "No approved fuel stations configured — skipping refuel");
    return false;
  }

  const { pois } = await getSystemInfo(ctx);

  const currentStation = pois.find(p => isStationPoi(p) && p.id === bot.poi);
  if (currentStation && isApprovedFuelStation(currentStation.id, readSettings(), bot.system)) {
    ctx.log("system", `Refueling at approved station ${currentStation.name}...`);
    const ok = await refuelAtStation(ctx, currentStation, thresholdPct);
    if (ok) return true;
  }

  const blacklist = getSystemBlacklist();
  const approvedSet = new Set<string>();
  for (const entry of approvedFuelStations) {
    approvedSet.add(entry);
    const parts = entry.split("|");
    if (parts.length === 2) approvedSet.add(parts[1]);
  }

  const nearest = mapStore.findNearestStationSystem(bot.system, blacklist, approvedSet);
  if (!nearest) {
    ctx.log("error", "No approved refuel station reachable");
    return false;
  }

  ctx.log("travel", `Going to approved refuel station ${nearest.poiName} in ${nearest.systemId} (${nearest.hops} jumps)...`);

  try {
    const poiResp = await bot.exec("get_poi", { poi_id: nearest.poiId });
    const fuel = (poiResp as any)?.base?.fuel;
    if (fuel !== null && fuel !== undefined && fuel <= 0 && nearest.poiId !== "sol_station") {
      ctx.log("system", `Approved station ${nearest.poiName} reports 0 fuel — will try anyway`);
    }
  } catch {}

  if (nearest.systemId !== bot.system) {
    await ensureUndocked(ctx);
    const route = mapStore.findRoute(bot.system, nearest.systemId, blacklist);
    if (route && route.length > 1) {
      for (let i = 1; i < route.length; i++) {
        ctx.log("travel", `Jumping to ${route[i]} (${i}/${route.length - 1})...`);
        const jumpResp = await bot.exec("jump", { target_system: route[i] });
        if (jumpResp.error) {
          ctx.log("error", `Jump failed: ${jumpResp.error.message}`);
          return false;
        }
        await bot.refreshStatus();
        const pct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
        if (pct < 5) {
          ctx.log("error", `Fuel critical (${pct}%) mid-jump — stranded`);
          return false;
        }
      }
    } else {
      const jumpResp = await bot.exec("jump", { target_system: nearest.systemId });
      if (jumpResp.error) {
        ctx.log("error", `Jump failed: ${jumpResp.error.message}`);
        return false;
      }
    }
  }

  await ensureUndocked(ctx);
  ctx.log("travel", `Traveling to ${nearest.poiName}...`);
  const tResp = await bot.exec("travel", { target_poi: nearest.poiId });
  if (tResp.error && !tResp.error.message.includes("already")) {
    ctx.log("error", `Travel failed: ${tResp.error.message}`);
    return false;
  }
  bot.poi = nearest.poiId;

  const dResp = await bot.exec("dock");
  if (!dResp.error || dResp.error.message.includes("already")) {
    bot.docked = true;
    await ensureInsured(ctx);
  } else {
    ctx.log("error", `Dock failed: ${dResp.error.message}`);
    return false;
  }

  const ok = await refuelAtStation(ctx, { id: nearest.poiId, name: nearest.poiName }, thresholdPct);
  await bot.refreshStatus();
  const finalPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  ctx.log("system", `Refuel complete at ${nearest.poiName} — Fuel: ${finalPct}%`);
  if (finalPct < thresholdPct) return false;

  ctx.log("system", "Undocking...");
  await bot.exec("undock");
  bot.docked = false;
  return true;
}
