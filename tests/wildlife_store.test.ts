// tests/wildlife_store.test.ts
//
// The creature store moved from "write the whole system file on every sighting"
// to "mutate memory, prune on reconcile, flush every 2 minutes". These tests
// pin the two behaviours that can lose data if they are wrong: what reconcile
// prunes, and that a flush actually persists.

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let origCwd: string;
let dir: string;
let mod: typeof import("../src/wildlivestore.js");
let store: import("../src/wildlivestore.js").WildlifeStore;

const SYS = "sol";
const POI = "asteroid_belt";

function observed(name: string, id: string, maxHull = 100) {
  return { name, creatureId: id, species: "sp", role: "grazer", maxHull };
}

function entries() {
  return store.getSystemData(SYS).pois[POI] || [];
}

beforeAll(async () => {
  origCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "wildlife-store-"));
  mkdirSync(join(dir, "data", "creatures"), { recursive: true });
  process.chdir(dir);
  mod = await import("../src/wildlivestore.js");
  store = new mod.WildlifeStore();
});

afterAll(() => {
  store?.stopTimers();
  process.chdir(origCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe("WildlifeStore.reconcile", () => {
  test("adds creatures seen in a nearby scan", () => {
    const res = store.reconcile(SYS, POI, [
      observed("Space Cow", "c1"),
      observed("Space Cow", "c2"),
      observed("Void Whale", "w1", 5000),
    ]);
    expect(res.newTypes).toBe(2);
    const list = entries();
    expect(list.length).toBe(2);
    const cow = list.find((e) => e.n === "space cow");
    expect(cow?.ids.sort()).toEqual(["c1", "c2"]);
  });

  test("drops individuals of a present type that the scan no longer reports", () => {
    // c2 was killed; the type is still present so the scan is authoritative.
    const res = store.reconcile(SYS, POI, [
      observed("Space Cow", "c1"),
      observed("Void Whale", "w1", 5000),
    ]);
    expect(res.prunedIds).toBe(1);
    expect(res.prunedTypes).toBe(0);
    const cow = entries().find((e) => e.n === "space cow");
    expect(cow?.ids).toEqual(["c1"]);
  });

  test("keeps a type missing from one scan while inside the grace window", () => {
    const res = store.reconcile(SYS, POI, [observed("Space Cow", "c1")]);
    expect(res.prunedTypes).toBe(0);
    expect(entries().some((e) => e.n === "void whale")).toBe(true);
  });

  test("prunes a type that has been missing for longer than the grace window", () => {
    const whale = entries().find((e) => e.n === "void whale")!;
    whale.seen = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const res = store.reconcile(SYS, POI, [observed("Space Cow", "c1")]);
    expect(res.prunedTypes).toBe(1);
    expect(entries().some((e) => e.n === "void whale")).toBe(false);
  });

  test("an empty scan eventually empties the POI", () => {
    for (const e of entries()) e.seen = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    store.reconcile(SYS, POI, []);
    expect(entries().length).toBe(0);
  });

  test("ignores creature ids it cannot see (no id => no prune)", () => {
    store.reconcile(SYS, POI, [observed("Space Cow", "c1"), observed("Space Cow", "c2")]);
    // A scan whose entities carry no creature_id must not wipe the known ids.
    store.reconcile(SYS, POI, [observed("Space Cow", "")]);
    const cow = entries().find((e) => e.n === "space cow");
    expect(cow?.ids.sort()).toEqual(["c1", "c2"]);
  });
});

describe("WildlifeStore persistence", () => {
  test("sightings do not touch the disk until a flush", async () => {
    const path = join(dir, "data", "creatures", "vega.json");
    store.reconcile("vega", "ring", [observed("Star Moth", "m1")]);
    expect(existsSync(path)).toBe(false);

    await store.flush();
    expect(existsSync(path)).toBe(true);

    const raw = readFileSync(path, "utf-8");
    // Pretty-printing was dropped: no indented lines.
    expect(raw.includes("\n  ")).toBe(false);
    const parsed = JSON.parse(raw);
    expect(parsed.pois.ring[0].ids).toEqual(["m1"]);
  });

  test("a fully pruned system removes its file", async () => {
    const path = join(dir, "data", "creatures", "vega.json");
    const list = store.getSystemData("vega").pois.ring;
    for (const e of list) e.seen = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    store.reconcile("vega", "ring", []);
    await store.flush();
    expect(existsSync(path)).toBe(false);
  });

  test("cold systems are still visible to the creatures page after eviction", async () => {
    store.reconcile("rigel", "cave", [observed("Rock Grub", "g1")]);
    await store.flush();
    // Simulate the eviction timer dropping the system from the hot cache.
    const fresh = new mod.WildlifeStore();
    try {
      const data = fresh.getFullData();
      expect(Object.keys(data.systems)).toContain("rigel");
      expect(data.counts.individuals).toBeGreaterThan(0);
    } finally {
      fresh.stopTimers();
    }
  });
});

describe("WildlifeStore.hasCreatureName", () => {
  test("recognises names from disk and from live sightings", () => {
    const fresh = new mod.WildlifeStore();
    try {
      expect(fresh.hasCreatureName("Rock Grub")).toBe(true);
      expect(fresh.hasCreatureName("Definitely A Player")).toBe(false);
      fresh.reconcile("altair", "belt", [observed("Glow Shrimp", "s1")]);
      expect(fresh.hasCreatureName("glow shrimp")).toBe(true);
    } finally {
      fresh.stopTimers();
    }
  });
});
