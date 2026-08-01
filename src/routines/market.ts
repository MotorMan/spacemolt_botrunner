import type { Routine, RoutineContext } from "../bot.js";
import { marketStreamStore } from "../marketstreamstore.js";
import { mapStore } from "../mapstore.js";
import { perf } from "../perf.js";

export const marketRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;
  let lastBaseId: string | null = null;

  while (bot.state === "running") {
    yield "market_monitor";

    if (!bot.docked) {
      ctx.log("warn", "Market routine requires being docked — waiting...");
      await ctx.sleep(5000);
      continue;
    }

    const currentBaseId = bot.poi;
    if (currentBaseId && currentBaseId !== lastBaseId) {
      ctx.log("info", `Subscribing to market at ${bot.system}/${bot.poi}...`);

      const subResp = await bot.exec("subscribe_market");
      if (subResp.error) {
        ctx.log("error", `subscribe_market failed: ${subResp.error.message}`);
        await ctx.sleep(10000);
        continue;
      }

      const snapshot = subResp.result as Record<string, unknown> | undefined;
      if (snapshot && typeof snapshot === "object") {
        const baseId = snapshot.base_id as string | undefined;
        const items = Array.isArray(snapshot.items)
          ? (snapshot.items as Array<Record<string, unknown>>)
          : [];

        if (baseId && items.length > 0) {
          marketStreamStore.update(baseId, 0, items as any);

          try {
            const normalized = items.map((it) => ({
              item_id: (it.item_id as string) || "",
              item_name: (it.item_name as string) || (it.item_id as string) || "",
              sell_orders: (it.sell_orders as Array<Record<string, unknown>>).map((o) => ({
                price: (o.price_each as number) || (o.price as number) || 0,
                quantity: (o.quantity as number) || 0,
                source: o.source as string | undefined,
              })),
              buy_orders: (it.buy_orders as Array<Record<string, unknown>>).map((o) => ({
                price: (o.price_each as number) || (o.price as number) || 0,
                quantity: (o.quantity as number) || 0,
                source: o.source as string | undefined,
              })),
            }));
            perf.timeSync("mapStore.updateMarket", () => mapStore.updateMarket(bot.system, bot.poi, { items: normalized }));
          } catch { /* ignore dashboard mirror errors */ }

          ctx.log("info", `Market subscription active: ${items.length} items at ${baseId}`);
        }
      }

      lastBaseId = currentBaseId;
    }

    await ctx.sleep(30000);
  }
};
