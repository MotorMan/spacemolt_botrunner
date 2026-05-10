export function parseFactionStorageItems(result: unknown): Array<{ itemId: string; name: string; quantity: number }> {
  if (!result || typeof result !== "object") return [];

  const r = result as Record<string, unknown>;
  let items: Array<Record<string, unknown>> = [];

  if (Array.isArray(r)) {
    items = r;
  } else {
    const possibleFields = ["items", "cargo", "storage", "stored_items", "faction_items", "faction_storage", "data", "result", "structuredContent"];
    for (const field of possibleFields) {
      if (Array.isArray(r[field])) {
        items = r[field] as Array<Record<string, unknown>>;
        break;
      }
    }
    if (items.length === 0 && r.structuredContent && typeof r.structuredContent === "object") {
      const sc = r.structuredContent as Record<string, unknown>;
      for (const field of possibleFields) {
        if (Array.isArray(sc[field])) {
          items = sc[field] as Array<Record<string, unknown>>;
          break;
        }
      }
    }
  }

  if (items.length === 0) return [];

  return items.map((item) => {
    const itemId = (item.item_id as string) ||
      (item.resource_id as string) ||
      (item.id as string) ||
      (item.itemId as string) ||
      "";
    const name = (item.name as string) ||
      (item.item_name as string) ||
      (item.resource_name as string) ||
      itemId || "";
    const quantity = (item.quantity as number) ||
      (item.count as number) ||
      (item.amount as number) ||
      (item.qty as number) || 0;
    return { itemId, name, quantity };
  }).filter(i => i.itemId && i.quantity > 0);
}

async function refreshFactionStorageV2(ctx: any, bot: any): Promise<void> {
  try {
    const resp = await bot.exec("view_storage", { target: "faction" });
    if (resp.error) {
      ctx.log("warn", "Failed to view faction storage: " + resp.error.message);
      bot.factionStorage = [];
      return;
    }
    if (resp.result === null || resp.result === undefined) {
      bot.factionStorage = [];
      return;
    }
    const items = parseFactionStorageItems(resp.result);
    bot.factionStorage = items;
    if (items.length > 0) {
      ctx.log("trade", "Faction storage: " + items.length + " item types (" + items.reduce((sum, i) => sum + i.quantity, 0) + " total)");
    }
  } catch (err) {
    ctx.log("error", "Error refreshing faction storage: " + err);
    bot.factionStorage = [];
  }
}
