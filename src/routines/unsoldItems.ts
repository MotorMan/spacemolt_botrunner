import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const UNSOLD_ITEMS_FILE = join(DATA_DIR, "traderUnsoldItems.json");

export interface UnsoldItem {
  itemId: string;
  itemName: string;
  boughtPrice: number;
  quantity: number;
  storageSystem: string;
  storagePoi: string;
  depositedAt: string;
  botUsername?: string;
}

export interface UnsoldItemsData {
  items: UnsoldItem[];
}

export function loadUnsoldItems(): UnsoldItemsData {
  try {
    if (existsSync(UNSOLD_ITEMS_FILE)) {
      const content = readFileSync(UNSOLD_ITEMS_FILE, "utf-8").trim();
      if (content) {
        const parsed = JSON.parse(content);
        if (typeof parsed === "object" && Array.isArray(parsed.items)) {
          return parsed;
        }
      }
    }
  } catch (err) {
    console.warn("Could not load traderUnsoldItems.json:", err);
  }
  return { items: [] };
}

export function saveUnsoldItems(data: UnsoldItemsData): void {
  try {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    writeFileSync(UNSOLD_ITEMS_FILE, JSON.stringify(data, null, 2) + "\n");
  } catch (err) {
    console.error("Error saving traderUnsoldItems.json:", err);
  }
}

export function addUnsoldItem(item: UnsoldItem): void {
  const data = loadUnsoldItems();
  const existingIndex = data.items.findIndex(i => 
    i.itemId === item.itemId && 
    i.storageSystem === item.storageSystem && 
    i.storagePoi === item.storagePoi &&
    (!item.botUsername || i.botUsername === item.botUsername)
  );
  
  if (existingIndex >= 0) {
    data.items[existingIndex].quantity += item.quantity;
    data.items[existingIndex].depositedAt = item.depositedAt;
  } else {
    data.items.push(item);
  }
  saveUnsoldItems(data);
}

export function removeUnsoldItem(itemId: string, storageSystem: string, storagePoi: string): void {
  const data = loadUnsoldItems();
  data.items = data.items.filter(i => 
    !(i.itemId === itemId && i.storageSystem === storageSystem && i.storagePoi === storagePoi)
  );
  saveUnsoldItems(data);
}

export function updateUnsoldItemQuantity(itemId: string, storageSystem: string, storagePoi: string, newQuantity: number): void {
  const data = loadUnsoldItems();
  const index = data.items.findIndex(i => 
    i.itemId === itemId && i.storageSystem === storageSystem && i.storagePoi === storagePoi
  );
  
  if (index >= 0) {
    data.items[index].quantity = newQuantity;
    if (newQuantity <= 0) {
      data.items.splice(index, 1);
    }
    saveUnsoldItems(data);
  }
}

export function getUnsoldItemsByItem(itemId: string): UnsoldItem[] {
  const data = loadUnsoldItems();
  return data.items.filter(i => i.itemId === itemId);
}

export function getAllUnsoldItems(): UnsoldItem[] {
  return loadUnsoldItems().items;
}

export function clearAllUnsoldItems(): void {
  saveUnsoldItems({ items: [] });
}