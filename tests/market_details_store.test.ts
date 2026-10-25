// tests/market_details_store.test.ts
//
// marketDetails.json used to be fully re-read and re-written on every market
// push (~17 times a minute for a 10MB file). It is now an in-memory object with
// a 2-minute persist cadence, shared by the market and explorer routines.

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let origCwd: string;
let dir: string;
let file: string;
let store: typeof import("../src/marketdetailsstore.js").marketDetailsStore;

function obs(itemId: string, price: number) {
  return {
    itemId,
    itemName: itemId,
    buyOrders: [{ price, quantity: 10 }],
    sellOrders: [{ price: price + 5, quantity: 10 }],
  };
}

beforeAll(async () => {
  origCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "market-details-"));
  mkdirSync(join(dir, "data"), { recursive: true });
  file = join(dir, "data", "marketDetails.json");
  // Seed an existing file so we also cover the "load what is already there" path.
  writeFileSync(
    file,
    JSON.stringify({
      lastSaved: new Date().toISOString(),
      items: [{
        systemId: "sol", stationPoiId: "sol_station", stationName: "Sol Station",
        itemId: "iron", itemName: "Iron", buyOrders: [], sellOrders: [],
        lastUpdated: new Date().toISOString(),
      }],
    }),
    "utf-8",
  );
  process.chdir(dir);
  ({ marketDetailsStore: store } = await import("../src/marketdetailsstore.js"));
});

afterAll(() => {
  store?.stopAutoPersist();
  process.chdir(origCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe("marketDetailsStore", () => {
  test("updates existing entries in place instead of appending duplicates", () => {
    store.upsertItems("sol", "sol_station", "Sol Station", [obs("iron", 100)]);
    store.upsertItems("sol", "sol_station", "Sol Station", [obs("iron", 120)]);
    const items = store.getData().items.filter((i) => i.itemId === "iron");
    expect(items.length).toBe(1);
    expect(items[0].buyOrders[0].price).toBe(120);
  });

  test("keeps entries for different stations apart", () => {
    store.upsertItems("vega", "vega_station", "Vega Station", [obs("iron", 90)]);
    expect(store.getData().items.filter((i) => i.itemId === "iron").length).toBe(2);
  });

  test("does not write to disk on update", () => {
    const before = readFileSync(file, "utf-8");
    store.upsertItems("sol", "sol_station", "Sol Station", [obs("copper", 42)]);
    expect(readFileSync(file, "utf-8")).toBe(before);
    expect(store.hasPendingWrites()).toBe(true);
  });

  test("flushSync persists everything, unformatted", () => {
    expect(store.flushSync()).toBe(true);
    expect(store.hasPendingWrites()).toBe(false);
    const raw = readFileSync(file, "utf-8");
    expect(raw.includes("\n  ")).toBe(false);
    const parsed = JSON.parse(raw);
    expect(parsed.items.find((i: { itemId: string }) => i.itemId === "copper")).toBeTruthy();
    expect(parsed.items.filter((i: { itemId: string }) => i.itemId === "iron").length).toBe(2);
  });

  test("a flush with nothing pending is a no-op", () => {
    expect(store.flushSync()).toBe(false);
  });

  test("leaves no temp file behind", () => {
    expect(existsSync(join(dir, "data", "marketDetails.json.tmp"))).toBe(false);
  });
});
