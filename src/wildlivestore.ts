import { debugLogForBot } from "./debug.js";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { onWildlifeUpdate } from "./client_sync_hooks.js";

const WILDLIFE_INFO_FILE = join(process.cwd(), "data", "wildlifeInfo.json");

export interface WildlifeDetail {
  name: string;
  species: string;
  role: string;
  danger?: number;
  hull: number;
  maxHull: number;
  inCombat: boolean;
  creatureId: string;
  lastSeen: string;
  firstSeen: string;
  system: string;
  poi: string;
  normalized: string;
}

interface WildlifeInfoData {
  wildlife: Record<string, WildlifeDetail>;
  lastUpdated: string | null;
  counts: {
    wildlife: number;
  };
}

export class WildlifeStore {
  private data: WildlifeInfoData;
  private _botName: string | null = null;

  constructor() {
    this.data = this.load();
  }

  private load(): WildlifeInfoData {
    try {
      if (!existsSync(WILDLIFE_INFO_FILE)) {
        debugLogForBot(this._botName || "unknown", "wildlife:load", `${this._botName || "unknown"}`, "No wildlife info file, starting fresh");
        return {
          wildlife: {},
          lastUpdated: new Date().toISOString(),
          counts: { wildlife: 0 },
        };
      }
      const text = readFileSync(WILDLIFE_INFO_FILE, "utf-8");
      const parsed = JSON.parse(text) as Partial<WildlifeInfoData>;
      return {
        wildlife: parsed.wildlife || {},
        lastUpdated: parsed.lastUpdated || new Date().toISOString(),
        counts: parsed.counts || { wildlife: 0 },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[WildlifeStore] Load failed: ${msg}`);
      return {
        wildlife: {},
        lastUpdated: new Date().toISOString(),
        counts: { wildlife: 0 },
      };
    }
  }

  private save(): void {
    try {
      this.data.lastUpdated = new Date().toISOString();
      const json = JSON.stringify(this.data, null, 2) + "\n";
      writeFileSync(WILDLIFE_INFO_FILE, json, "utf-8");
      void onWildlifeUpdate(this.data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[WildlifeStore] Save failed: ${msg}`);
    }
  }

  setBotName(name: string): void {
    this._botName = name;
  }

  private normalize(name: string): string {
    return name.trim().toLowerCase();
  }

  add(
    name: string,
    system: string,
    poi: string,
    creatureId: string,
    species: string,
    role: string,
    hull: number,
    maxHull: number,
    inCombat: boolean
  ): boolean {
    if (!name || typeof name !== "string") {
      return false;
    }

    const normalized = this.normalize(name);
    if (!normalized) {
      return false;
    }

    const now = new Date().toISOString();
    const existing = this.data.wildlife[normalized];

    if (existing) {
      existing.lastSeen = now;
      existing.system = system || existing.system;
      existing.poi = poi || existing.poi;
      existing.hull = hull || existing.hull;
      existing.maxHull = maxHull || existing.maxHull;
      existing.inCombat = inCombat || existing.inCombat;
      if (creatureId) existing.creatureId = creatureId;
      this.save();
      return false;
    }

    this.data.wildlife[normalized] = {
      name: name,
      species: species,
      role: role,
      hull: hull,
      maxHull: maxHull,
      inCombat: inCombat,
      creatureId: creatureId,
      lastSeen: now,
      firstSeen: now,
      system: system || "",
      poi: poi || "",
      normalized: normalized,
    };

    this.data.counts.wildlife = Object.keys(this.data.wildlife).length;
    this.save();
    debugLogForBot(this._botName || "unknown", "wildlife:add", `${this._botName || "unknown"}`, `Added wildlife: "${name}" (${species}) in ${system}/${poi}`);
    return true;
  }

  getAll(): WildlifeDetail[] {
    return Object.values(this.data.wildlife)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getWildlifeDetail(name: string): WildlifeDetail | null {
    const normalized = this.normalize(name);
    return this.data.wildlife[normalized] || null;
  }

  search(query: string): WildlifeDetail[] {
    const queryLower = query.toLowerCase().trim();
    if (!queryLower) return [];

    return Object.values(this.data.wildlife)
      .filter(e => e.name.toLowerCase().includes(queryLower) || e.normalized.includes(queryLower))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getCount(): number {
    return this.data.counts.wildlife;
  }

  getFullData(): WildlifeInfoData {
    return JSON.parse(JSON.stringify(this.data));
  }
}

export const wildlifeStore = new WildlifeStore();