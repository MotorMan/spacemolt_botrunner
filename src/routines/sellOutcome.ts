/**
 * Authoritative parsing of a `sell` command result.
 *
 * Kept in its own module because it is a pure function over the API response
 * and must stay importable without dragging in the routine graph.
 *
 * The V2 `SellResponse` schema (`/api/v2/spacemolt/sell`) is
 * `additionalProperties: false` and exposes exactly:
 *   `quantity_sold`, `total_earned`, `unsold`,
 *   `fills[] { price_each, quantity, subtotal, counterparty }`
 *
 * `faction_trader.ts` used to read `credits_earned` / `total` / `revenue`. None
 * of those fields exist, so the parsed revenue was ALWAYS 0 and every caller
 * fell through to `sold * marketCheck.weightedAvgPrice` — i.e. it printed the
 * pre-trade quote and called it revenue. That is how a fire-sale of 8 fuel cells
 * for 400cr got logged as "29288cr revenue, 7412cr profit" (8 x the 3661cr
 * quoted average), and how 10% of a profit that never existed was donated to the
 * faction treasury.
 *
 * `trader.ts` learned the same lesson earlier (see `earnedFromSell`): never
 * reconstruct revenue from a quoted price.
 */

/** Sanitize a credit value to a safe integer. Credits are integers in-game. */
function toCredits(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value);
}

export interface SellFill {
  priceEach: number;
  quantity: number;
  subtotal: number;
  counterparty?: string;
}

export interface SellOutcome {
  /** Units the server reports as sold. */
  soldQty: number;
  /** Credits actually received. Never inferred from a quote. */
  revenue: number;
  /** Units the server could not sell (no buyer). */
  unsold: number;
  /** Realized average price per unit; 0 when nothing sold. */
  avgPrice: number;
  /** Worst price any single unit went for — this is what catches a book sweep. */
  worstFillPrice: number;
  fills: SellFill[];
  /** True when the numbers came from the response rather than being inferred. */
  verified: boolean;
}

export function readSellOutcome(sr: Record<string, unknown> | undefined): SellOutcome {
  const empty: SellOutcome = {
    soldQty: 0, revenue: 0, unsold: 0, avgPrice: 0, worstFillPrice: 0, fills: [], verified: false,
  };
  if (!sr) return empty;

  const rawFills = Array.isArray(sr.fills) ? (sr.fills as Array<Record<string, unknown>>) : [];
  const fills: SellFill[] = rawFills
    .map(f => ({
      priceEach: Number(f.price_each) || 0,
      quantity: Number(f.quantity) || 0,
      subtotal: Number(f.subtotal) || 0,
      counterparty: typeof f.counterparty === "string" ? f.counterparty : undefined,
    }))
    .filter(f => f.quantity > 0);

  const fillQty = fills.reduce((sum, f) => sum + f.quantity, 0);
  const fillRevenue = fills.reduce((sum, f) => sum + (f.subtotal || f.priceEach * f.quantity), 0);

  const reportedQty = typeof sr.quantity_sold === "number" ? sr.quantity_sold : undefined;
  const reportedEarned = typeof sr.total_earned === "number" ? sr.total_earned : undefined;

  const soldQty = reportedQty ?? fillQty;
  const revenue = toCredits(reportedEarned ?? fillRevenue);
  const verified = reportedQty !== undefined || reportedEarned !== undefined || fills.length > 0;

  return {
    soldQty,
    revenue,
    unsold: typeof sr.unsold === "number" ? sr.unsold : 0,
    avgPrice: soldQty > 0 ? revenue / soldQty : 0,
    worstFillPrice: fills.length > 0 ? Math.min(...fills.map(f => f.priceEach)) : 0,
    fills,
    verified,
  };
}
