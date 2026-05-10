/**
 * Faction Storage V2 API Helpers
 *
 * Parse faction storage items from V2 API response.
 * Handles multiple possible response formats from spacemolt_storage/view.
 */
export function parseFactionStorageFromV2(result: unknown): Array<{ itemId: string; name: string; quantity: number }> {
  if (!result || typeof result !== "object") return [];

  const r = result as Record<string, unknown>;
  let items: unknown[] = [];

  // Check if result is directly an array
  if (Array.isArray(r)) {
    items = r as unknown[];
  } else {
    // Check various possible field names from V2 API
    const possibleFields = ["items", "cargo", "storage", "stored_items", "faction_items", "faction_storage", "data", "result"];
    for (const field of possibleFields) {
      if (Array.isArray(r[field])) {
        items = r[field] as unknown[];
        break;
      }
    }
  }

  if (items.length === 0) return [];

  // Parse each item using a simple for loop
  const parsed: Array<{ itemId: string; name: string; quantity: number }> = [];
  for (const item of items) {
    const i = item as Record<string, unknown>;
    const itemId = (i.item_id as string) ||
      (i.resource_id as string) ||
      (i.id as string) ||
      "";
    const name = (i.name as string) ||
      (i.item_name as string) ||
      (i.resource_name as string) ||
      itemId ||
      "";
    const quantity = (i.quantity as number) ||
      (i.count as number) ||
      (i.amount as number) ||
      (i.qty as number) ||
      0;
    if (itemId && quantity > 0) {
      parsed.push({ itemId, name, quantity });
    }
  }
  return parsed;
}
