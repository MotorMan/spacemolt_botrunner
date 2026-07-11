import type { Bot } from "./bot.js";

export async function collectTaxesFromBots(bots: Bot[]): Promise<void> {
  const promises = bots.map(async (bot) => {
    try {
      await bot.updateTaxEstimate();
      await bot.updateFactionTaxEstimate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      bot.log("error", `Tax collection failed: ${msg}`);
    }
  });
  await Promise.allSettled(promises);
}