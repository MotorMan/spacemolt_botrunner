import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const COORD_FILE = join(DATA_DIR, "factionTradeCoordination.json");
const ACTIVITY_FILE = join(DATA_DIR, "traderActivity.json");

let coordBackup: string | null = null;
let activityBackup: string | null = null;

/**
 * Regression cover for the Node Alpha fuel-cell fire-sale.
 *
 * Two of our own faction traders carried fuel cells to the same station. The
 * first swept the whole book (2@3721, 2@3646, 3@3645, 1@3619); the second
 * arrived a tick later and its market order fell through to a 50cr junk bid —
 * 8 units for 400cr. The runner then logged "29288cr revenue, 7412cr profit"
 * because it reconstructed revenue from the pre-trade quote.
 */
describe("faction trader fire-sale regressions", () => {
  beforeEach(() => {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    coordBackup = existsSync(COORD_FILE) ? readFileSync(COORD_FILE, "utf-8") : null;
    activityBackup = existsSync(ACTIVITY_FILE) ? readFileSync(ACTIVITY_FILE, "utf-8") : null;
    rmSync(COORD_FILE, { force: true });
  });

  afterEach(() => {
    if (coordBackup !== null) writeFileSync(COORD_FILE, coordBackup);
    else rmSync(COORD_FILE, { force: true });
    if (activityBackup !== null) writeFileSync(ACTIVITY_FILE, activityBackup);
  });

  describe("buy-order claims", () => {
    const claim = (bot: string, price: number, qty: number) => ({
      botUsername: bot,
      itemId: "fuel_cell",
      itemName: "Fuel Cell",
      destSystem: "node_alpha",
      destPoi: "node_alpha_processing_station",
      destPoiName: "Node Alpha Processing Station",
      pricePerUnit: price,
      quantityCommitted: qty,
    });

    it("blocks a second bot even when it planned against a different price level", async () => {
      const { acquireBuyOrderLock, getBuyOrderLock } = await import(
        "../src/routines/factionTraderCoordination.js"
      );

      // Cara plans against the 3721 top-of-book.
      expect(acquireBuyOrderLock(claim("Cara Stein", 3721, 8))).toBe(true);

      // Zara's snapshot has already rolled to the next level. Under the old
      // price-keyed lock this produced a different key and both bots committed.
      expect(acquireBuyOrderLock(claim("Zara Burns", 3645, 8))).toBe(false);

      const held = getBuyOrderLock("fuel_cell", "node_alpha_processing_station", "Zara Burns");
      expect(held?.lockedBy).toBe("Cara Stein");
    });

    it("reserves book depth so a second bot only plans against what is left", async () => {
      const { acquireBuyOrderLock, getReservedQuantity } = await import(
        "../src/routines/factionTraderCoordination.js"
      );

      acquireBuyOrderLock(claim("Cara Stein", 3721, 8));

      expect(getReservedQuantity("fuel_cell", "node_alpha_processing_station", "Zara Burns")).toBe(8);
      // The owner does not reserve against itself.
      expect(getReservedQuantity("fuel_cell", "node_alpha_processing_station", "Cara Stein")).toBe(0);
    });

    it("releases without needing the price the claim was made at", async () => {
      const { acquireBuyOrderLock, releaseBuyOrderLock, getBuyOrderLock } = await import(
        "../src/routines/factionTraderCoordination.js"
      );

      acquireBuyOrderLock(claim("Cara Stein", 3721, 8));
      // The book has moved since the claim; release must still find it.
      expect(releaseBuyOrderLock("Cara Stein", "fuel_cell", "node_alpha_processing_station", "completed")).toBe(true);
      expect(getBuyOrderLock("fuel_cell", "node_alpha_processing_station")).toBeNull();
    });

    it("keeps a sessionless claim alive through the grace window", async () => {
      const { acquireBuyOrderLock, cleanupStaleFactionLocks, getBuyOrderLock } = await import(
        "../src/routines/factionTraderCoordination.js"
      );

      writeFileSync(ACTIVITY_FILE, JSON.stringify({}));

      // Claimed at route selection; the session does not exist yet.
      acquireBuyOrderLock(claim("Cara Stein", 3721, 8));

      // The old cleanup reaped this immediately, freeing the book mid-run.
      expect(cleanupStaleFactionLocks()).toBe(0);
      expect(getBuyOrderLock("fuel_cell", "node_alpha_processing_station")?.lockedBy).toBe("Cara Stein");
    });

    it("reaps a sessionless claim once the grace window expires", async () => {
      const { cleanupStaleFactionLocks, getBuyOrderLock } = await import(
        "../src/routines/factionTraderCoordination.js"
      );

      writeFileSync(ACTIVITY_FILE, JSON.stringify({}));
      const old = new Date(Date.now() - 10 * 60_000).toISOString();
      writeFileSync(COORD_FILE, JSON.stringify({
        activeLocks: {
          "faction_buy:fuel_cell:node_alpha_processing_station": {
            lockedBy: "Cara Stein",
            buyOrderKey: "faction_buy:fuel_cell:node_alpha_processing_station",
            itemId: "fuel_cell",
            itemName: "Fuel Cell",
            destSystem: "node_alpha",
            destPoi: "node_alpha_processing_station",
            destPoiName: "Node Alpha Processing Station",
            pricePerUnit: 3721,
            quantityCommitted: 8,
            lockedAt: old,
            lastActivity: old,
            sessionId: "",
          },
        },
        lockHistory: [],
      }));

      expect(cleanupStaleFactionLocks()).toBe(1);
      expect(getBuyOrderLock("fuel_cell", "node_alpha_processing_station")).toBeNull();
    });

    it("migrates legacy price-keyed locks onto the price-free key", async () => {
      const { getBuyOrderLock, acquireBuyOrderLock } = await import(
        "../src/routines/factionTraderCoordination.js"
      );

      const now = new Date().toISOString();
      writeFileSync(COORD_FILE, JSON.stringify({
        activeLocks: {
          "faction_buy:fuel_cell:node_alpha_processing_station:3721": {
            lockedBy: "Cara Stein",
            buyOrderKey: "faction_buy:fuel_cell:node_alpha_processing_station:3721",
            itemId: "fuel_cell",
            itemName: "Fuel Cell",
            destSystem: "node_alpha",
            destPoi: "node_alpha_processing_station",
            destPoiName: "Node Alpha Processing Station",
            pricePerUnit: 3721,
            quantityCommitted: 8,
            lockedAt: now,
            lastActivity: now,
            sessionId: "sess-1",
          },
        },
        lockHistory: [],
      }));

      expect(getBuyOrderLock("fuel_cell", "node_alpha_processing_station")?.lockedBy).toBe("Cara Stein");
      // And it must actually block, not just be readable.
      expect(acquireBuyOrderLock({
        botUsername: "Zara Burns",
        itemId: "fuel_cell",
        itemName: "Fuel Cell",
        destSystem: "node_alpha",
        destPoi: "node_alpha_processing_station",
        destPoiName: "Node Alpha Processing Station",
        pricePerUnit: 3645,
        quantityCommitted: 8,
      })).toBe(false);
    });
  });

  describe("readSellOutcome", () => {
    it("reads the real SellResponse fields instead of inventing revenue", async () => {
      const { readSellOutcome } = await import("../src/routines/sellOutcome.js");

      // Exactly what the server returned for the 50cr sweep.
      const outcome = readSellOutcome({
        action: "sell",
        item: "Fuel Cell",
        item_id: "fuel_cell",
        quantity_sold: 8,
        total_earned: 400,
        unsold: 0,
        fills: [{ price_each: 50, quantity: 8, subtotal: 400, counterparty: "Skaldic" }],
        level_up: false,
      });

      expect(outcome.soldQty).toBe(8);
      expect(outcome.revenue).toBe(400);
      expect(outcome.avgPrice).toBe(50);
      expect(outcome.worstFillPrice).toBe(50);
      expect(outcome.verified).toBe(true);
      expect(outcome.fills[0].counterparty).toBe("Skaldic");
    });

    it("finds the worst fill when an order sweeps several price levels", async () => {
      const { readSellOutcome } = await import("../src/routines/sellOutcome.js");

      const outcome = readSellOutcome({
        quantity_sold: 8,
        total_earned: 22288,
        fills: [
          { price_each: 3721, quantity: 2, subtotal: 7442 },
          { price_each: 3646, quantity: 2, subtotal: 7292 },
          { price_each: 50, quantity: 4, subtotal: 200 },
        ],
      });

      expect(outcome.soldQty).toBe(8);
      expect(outcome.worstFillPrice).toBe(50);
    });

    it("never fabricates revenue from a response it cannot read", async () => {
      const { readSellOutcome } = await import("../src/routines/sellOutcome.js");

      // The old field names the code used to look for. They do not exist.
      const outcome = readSellOutcome({ credits_earned: 29288, total: 29288, revenue: 29288 });

      expect(outcome.revenue).toBe(0);
      expect(outcome.soldQty).toBe(0);
      expect(outcome.verified).toBe(false);
    });
  });
});
