/**
 * Lightweight tracker for fuel-transport "gift" deliveries.
 *
 * Gifted items do not appear in the destination station's faction storage, so
 * the regular station-level stock checks falsely report "0 at station" forever.
 * This module records how much of each item has already been gifted to each
 * remote station, letting the FT routine treat those units as "present" when
 * computing remaining need / co-op availability / loadout satisfaction.
 *
 * Data shape is intentionally simple: one JSON file keyed by station, then
 * itemId → quantity. No history, no per-bot attribution — just the fleet-wide
 * gifted total per station, because the destination bot/player is outside our
 * faction storage and its exact remaining quantity is not queryable.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { safeWriteFileSync } from "../diskSpaceGuard.js";

const DATA_DIR = join(process.cwd(), "data");
const GIFTED_FILE = join(DATA_DIR, "fuelTransferGifted.json");

export interface GiftedItemEntry {
  quantity: number;
  updatedAt: number;
}

export type GiftedItemsByStation = Record<string, Record<string, GiftedItemEntry>>;

let giftedMemory: GiftedItemsByStation | null = null;

function loadGiftedData(): GiftedItemsByStation {
  if (!giftedMemory) {
    try {
      if (existsSync(GIFTED_FILE)) {
        const raw = readFileSync(GIFTED_FILE, "utf-8");
        const parsed = JSON.parse(raw) as GiftedItemsByStation;
        giftedMemory = parsed;
      }
    } catch (err) {
      console.warn("Could not load fuelTransferGifted.json:", err);
    }
  }
  return giftedMemory ?? {};
}

function persistGiftedData(data: GiftedItemsByStation): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const payload = JSON.stringify(data, null, 2) + "\n";
    safeWriteFileSync(GIFTED_FILE, payload, Buffer.byteLength(payload, "utf-8"));
  } catch (err) {
    console.error("Error saving fuelTransferGifted.json:", err);
  }
}

/** Quantity of `itemId` already gifted to `stationId`. */
export function getGiftedQuantity(stationId: string, itemId: string): number {
  const data = loadGiftedData();
  return data[stationId]?.[itemId]?.quantity || 0;
}

/** All itemIds currently tracked as gifted to `stationId`. */
export function getAllGiftedItems(stationId: string): Record<string, GiftedItemEntry> {
  const data = loadGiftedData();
  return data[stationId] ?? {};
}

/** Count of stations that currently have at least one gifted item entry, plus
 *  the total number of item entries across all stations. Used by the web UI to
 *  report how much gifted tracking state exists before a reset. */
export function getGiftedSummary(): { stationCount: number; entryCount: number } {
  const data = loadGiftedData();
  let stationCount = 0;
  let entryCount = 0;
  for (const entries of Object.values(data)) {
    const keys = Object.keys(entries);
    if (keys.length > 0) {
      stationCount++;
      entryCount += keys.length;
    }
  }
  return { stationCount, entryCount };
}

/** Record `qty` more units of `itemId` as gifted to `stationId`. */
export function addGiftedQuantity(stationId: string, itemId: string, qty: number): number {
  if (qty <= 0) return getGiftedQuantity(stationId, itemId);
  const data = loadGiftedData();
  if (!data[stationId]) data[stationId] = {};
  const existing = data[stationId][itemId];
  const entry: GiftedItemEntry = existing
    ? existing
    : { quantity: 0, updatedAt: Date.now() };
  entry.quantity = Math.max(0, (entry.quantity || 0)) + qty;
  entry.updatedAt = Date.now();
  data[stationId][itemId] = entry;
  persistGiftedData(data);
  return entry.quantity;
}

/** Reset gifted tracking for one station (e.g. user reset/correction). */
export function clearGiftedForStation(stationId: string): void {
  const data = loadGiftedData();
  if (data[stationId]) {
    delete data[stationId];
    persistGiftedData(data);
  }
}

/** Reset all gifted tracking. */
export function clearAllGifted(): void {
  persistGiftedData({});
  giftedMemory = {};
}
