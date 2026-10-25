import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { safeWriteFileSync } from "./diskSpaceGuard.js";

const LIVE_PASSENGERS_FILE = join(process.cwd(), "data", "livePassengers.json");

export interface LivePassenger {
  citizenId: string;
  name: string;
  accommodationClass: "economy" | "business" | "first";
  citizenship: string;
  destination: string;
  destinationName: string;
  destinationSystem?: string;
  fare: number;
  bio?: string;
  /** ISO timestamp this passenger was first seen waiting at any station. */
  firstSeen: string;
  /** ISO timestamp this passenger was last seen waiting at any station. */
  lastSeen: string;
  /** Station POI id where this passenger was last seen waiting. */
  lastStation: string;
  /** Station name where this passenger was last seen waiting. */
  lastStationName?: string;
  /** System id where this passenger was last seen waiting. */
  lastSystem: string;
  /** Total times this passenger has been seen waiting at a station. */
  timesSeen: number;
  /** "system:poi" -> times seen waiting at that station. */
  timesSeenAtStation: Record<string, number>;
}

interface StationSnapshot {
  station: string;
  stationName?: string;
  system: string;
  systemName?: string;
  count: number;
  updatedAt: string;
}

interface LivePassengersData {
  passengers: Record<string, LivePassenger>;
  stations: Record<string, StationSnapshot>;
  lastUpdated: string;
}

function stationKey(systemId: string, stationId: string): string {
  return `${systemId.toLowerCase()}:${stationId.toLowerCase()}`;
}

function parseStationKey(key: string): { system: string; station: string } {
  const sep = key.indexOf(":");
  return sep < 0 ? { system: key, station: "" } : { system: key.slice(0, sep), station: key.slice(sep + 1) };
}

function nowISO(): string {
  return new Date().toISOString();
}

export class LivePassengersStore {
  private passengers = new Map<string, LivePassenger>();
  /** stationKey -> set of citizenIds last seen waiting at that station. */
  private stationIndex = new Map<string, Set<string>>();
  private data: LivePassengersData = {
    passengers: {},
    stations: {},
    lastUpdated: nowISO(),
  };
  private _initialized = false;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(LIVE_PASSENGERS_FILE)) {
        this.save();
        return;
      }
      const text = readFileSync(LIVE_PASSENGERS_FILE, "utf-8");
      const loaded = JSON.parse(text) as LivePassengersData;
      this.data = loaded;
      for (const p of Object.values(loaded.passengers ?? {})) {
        if (p && p.citizenId) this.passengers.set(p.citizenId, p);
      }
      for (const p of this.passengers.values()) {
        const key = stationKey(p.lastSystem, p.lastStation);
        let set = this.stationIndex.get(key);
        if (!set) {
          set = new Set();
          this.stationIndex.set(key, set);
        }
        set.add(p.citizenId);
      }
      this._initialized = true;
    } catch {
      this.data = { passengers: {}, stations: {}, lastUpdated: nowISO() };
      this.save();
    }
  }

  private save(): void {
    try {
      this.data.lastUpdated = nowISO();
      this.data.passengers = Object.fromEntries(this.passengers);
      this.data.stations = Object.fromEntries(
        [...this.stationIndex.entries()].map(([key, ids]) => {
          const { system, station } = parseStationKey(key);
          const snapshot: StationSnapshot = {
            station,
            system,
            count: ids.size,
            updatedAt: nowISO(),
          };
          const existing = this.data.stations[key];
          if (existing) {
            snapshot.stationName = existing.stationName;
            snapshot.systemName = existing.systemName;
          }
          return [key, snapshot];
        }),
      );
      const payload = JSON.stringify(this.data, null, 2) + "\n";
      safeWriteFileSync(LIVE_PASSENGERS_FILE, payload, Buffer.byteLength(payload, "utf-8"));
    } catch {
      /* ignore persistence errors */
    }
  }

  private ensureLoaded(): void {
    if (!this._initialized) {
      this._initialized = true;
    }
  }

  normalizeId(id: string): string {
    return id.trim().toLowerCase();
  }

  /**
   * Record one or more passengers observed waiting at a station. Upserts by
   * citizenId and persists the roster to data/livePassengers.json.
   */
  registerSeen(
    passenger: {
      citizenId: string;
      name: string;
      accommodationClass: string;
      citizenship: string;
      destination: string;
      destinationName: string;
      destinationSystem?: string;
      fare: number;
      bio?: string;
    },
    at: {
      systemId: string;
      systemName?: string;
      stationId: string;
      stationName?: string;
    },
  ): void {
    this.ensureLoaded();
    const now = nowISO();
    const id = this.normalizeId(passenger.citizenId);
    if (!id) return;
    const key = stationKey(at.systemId, at.stationId);
    const existing = this.passengers.get(id);

    const prevStation = existing ? stationKey(existing.lastSystem, existing.lastStation) : null;
    if (prevStation && prevStation !== key) {
      const prevSet = this.stationIndex.get(prevStation);
      prevSet?.delete(id);
      if (prevSet?.size === 0) this.stationIndex.delete(prevStation);
    }

    let set = this.stationIndex.get(key);
    if (!set) {
      set = new Set();
      this.stationIndex.set(key, set);
    }
    set.add(id);

    const entry: LivePassenger = {
      citizenId: passenger.citizenId,
      name: passenger.name,
      accommodationClass: (passenger.accommodationClass as "economy" | "business" | "first") || "economy",
      citizenship: passenger.citizenship,
      destination: passenger.destination,
      destinationName: passenger.destinationName,
      destinationSystem: passenger.destinationSystem,
      fare: passenger.fare || 0,
      bio: passenger.bio,
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
      lastStation: at.stationId,
      lastStationName: at.stationName,
      lastSystem: at.systemId,
      timesSeen: (existing?.timesSeen ?? 0) + 1,
      timesSeenAtStation: {
        ...(existing?.timesSeenAtStation ?? {}),
        [key]: (existing?.timesSeenAtStation?.[key] ?? 0) + 1,
      },
    };

    this.passengers.set(id, entry);
    const snapshot: StationSnapshot = {
      station: at.stationId,
      stationName: at.stationName,
      system: at.systemId,
      systemName: at.systemName,
      count: set.size,
      updatedAt: now,
    };
    this.data.stations[key] = snapshot;
    this.save();
  }

  get(citizenId: string): LivePassenger | undefined {
    this.ensureLoaded();
    return this.passengers.get(this.normalizeId(citizenId));
  }

  getAll(): LivePassenger[] {
    this.ensureLoaded();
    return Array.from(this.passengers.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  getAtStation(systemId: string, stationId: string): LivePassenger[] {
    this.ensureLoaded();
    const ids = this.stationIndex.get(stationKey(systemId, stationId));
    if (!ids) return [];
    return Array.from(ids)
      .map(id => this.passengers.get(id))
      .filter((p): p is LivePassenger => !!p)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getStationCount(systemId: string, stationId: string): number {
    this.ensureLoaded();
    return this.stationIndex.get(stationKey(systemId, stationId))?.size ?? 0;
  }

  getStationSnapshot(systemId: string, stationId: string): StationSnapshot | undefined {
    this.ensureLoaded();
    return this.data.stations[stationKey(systemId, stationId)];
  }

  getCount(): number {
    this.ensureLoaded();
    return this.passengers.size;
  }

  getCounts(): { total: number; economy: number; business: number; first: number } {
    this.ensureLoaded();
    const values = Array.from(this.passengers.values());
    return {
      total: values.length,
      economy: values.filter(c => c.accommodationClass === "economy").length,
      business: values.filter(c => c.accommodationClass === "business").length,
      first: values.filter(c => c.accommodationClass === "first").length,
    };
  }

  search(query: string): LivePassenger[] {
    this.ensureLoaded();
    const queryLower = query.toLowerCase().trim();
    if (!queryLower) return [];
    return this.getAll().filter(p =>
      p.name.toLowerCase().includes(queryLower) ||
      p.citizenId.toLowerCase().includes(queryLower) ||
      p.destinationName.toLowerCase().includes(queryLower) ||
      p.destination.toLowerCase().includes(queryLower)
    );
  }

  getFullData(): LivePassengersData {
    this.ensureLoaded();
    return JSON.parse(JSON.stringify(this.data));
  }

  /** Blocking persist of any in-memory changes (shutdown hook). */
  flushSync(): boolean {
    try {
      this.save();
      return true;
    } catch {
      return false;
    }
  }
}

export const livePassengers = new LivePassengersStore();
