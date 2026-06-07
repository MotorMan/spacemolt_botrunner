import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const FULL_CIVILIANS_INFO_FILE = join(process.cwd(), "data", "fullCiviliansInfo.json");

export interface CivilianPassenger {
  citizenId: string;
  name: string;
  accommodationClass: "economy" | "business" | "first";
  citizenship: string;
  destination: string;
  destinationName: string;
  fare: number;
  bio: string;
  loadedAt: string;
  status: "boarded" | "delivered" | "stranded";
  ticksRemaining?: number;
}

export interface CivilianRecord {
  citizenId: string;
  name: string;
  accommodationClass: "economy" | "business" | "first";
  citizenship: string;
  destination: string;
  destinationName: string;
  fare: number;
  bio: string;
  firstSeen: string;
  lastSeen: string;
  timesTransported: number;
  totalFare: number;
  timesSeenAtStation: Record<string, number>;
  lastSeenAtStation: string;
  transportHistory: Array<{
    destination: string;
    destinationName: string;
    fare: number;
    transportedAt: string;
    status: "delivered" | "stranded";
  }>;
}

interface FullCiviliansInfoData {
  civilians: Record<string, CivilianRecord>;
  lastUpdated: string;
  counts: {
    total: number;
    economy: number;
    business: number;
    first: number;
  };
}

export class CivilianStore {
  private civilians = new Map<string, CivilianRecord>();
  private _initialized = false;
  private data: FullCiviliansInfoData = {
    civilians: {},
    lastUpdated: new Date().toISOString(),
    counts: { total: 0, economy: 0, business: 0, first: 0 },
  };

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(FULL_CIVILIANS_INFO_FILE)) {
        this.save();
        return;
      }
      const text = readFileSync(FULL_CIVILIANS_INFO_FILE, "utf-8");
      const loaded = JSON.parse(text) as FullCiviliansInfoData;
      this.data = loaded;
      for (const [id, record] of Object.entries(loaded.civilians)) {
        this.civilians.set(id, record);
      }
      this._initialized = true;
    } catch (err) {
      console.error("[CivilianStore] Load failed:", err);
      this.save();
    }
  }

  private save(): void {
    try {
      this.data.lastUpdated = new Date().toISOString();
      this.data.civilians = Object.fromEntries(this.civilians);
      this.data.counts = {
        total: this.civilians.size,
        economy: Array.from(this.civilians.values()).filter(c => c.accommodationClass === "economy").length,
        business: Array.from(this.civilians.values()).filter(c => c.accommodationClass === "business").length,
        first: Array.from(this.civilians.values()).filter(c => c.accommodationClass === "first").length,
      };
      writeFileSync(FULL_CIVILIANS_INFO_FILE, JSON.stringify(this.data, null, 2), "utf-8");
    } catch (err) {
      console.error("[CivilianStore] Save failed:", err);
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

  registerSeen(passenger: {
    citizenId: string;
    name: string;
    accommodationClass: "economy" | "business" | "first";
    destination: string;
    destinationName: string;
    fare: number;
    bio?: string;
  }): void {
    this.ensureLoaded();
    const now = new Date().toISOString();
    const normalizedId = this.normalizeId(passenger.citizenId);
    const existing = this.civilians.get(normalizedId);

    if (existing) {
      existing.lastSeen = now;
      if (passenger.bio) {
        existing.bio = passenger.bio;
      }
      const stationId = passenger.destination;
      existing.timesSeenAtStation[stationId] = (existing.timesSeenAtStation[stationId] || 0) + 1;
      existing.lastSeenAtStation = stationId;
      return;
    }

    const record: CivilianRecord = {
      citizenId: passenger.citizenId,
      name: passenger.name,
      accommodationClass: passenger.accommodationClass,
      citizenship: "",
      destination: passenger.destination,
      destinationName: passenger.destinationName,
      fare: passenger.fare,
      bio: passenger.bio || "",
      firstSeen: now,
      lastSeen: now,
      timesTransported: 0,
      totalFare: 0,
      timesSeenAtStation: { [passenger.destination]: 1 },
      lastSeenAtStation: passenger.destination,
      transportHistory: [],
    };
    this.civilians.set(normalizedId, record);
  }

  addOrUpdate(passenger: CivilianPassenger): void {
    this.ensureLoaded();
    const now = new Date().toISOString();
    const normalizedId = this.normalizeId(passenger.citizenId);
    const existing = this.civilians.get(normalizedId);

    if (existing) {
      existing.lastSeen = now;
      existing.timesTransported += 1;
      existing.totalFare += passenger.fare;
      if (passenger.status === "delivered") {
        existing.transportHistory.push({
          destination: passenger.destination,
          destinationName: passenger.destinationName,
          fare: passenger.fare,
          transportedAt: now,
          status: "delivered",
        });
      }
      if (passenger.bio) {
        existing.bio = passenger.bio;
      }
      const stationId = passenger.destination;
      existing.timesSeenAtStation[stationId] = (existing.timesSeenAtStation[stationId] || 0) + 1;
      existing.lastSeenAtStation = stationId;
    } else {
      const record: CivilianRecord = {
        citizenId: passenger.citizenId,
        name: passenger.name,
        accommodationClass: passenger.accommodationClass,
        citizenship: passenger.citizenship,
        destination: passenger.destination,
        destinationName: passenger.destinationName,
        fare: passenger.fare,
        bio: passenger.bio,
        firstSeen: now,
        lastSeen: now,
        timesTransported: 1,
        totalFare: passenger.fare,
        timesSeenAtStation: { [passenger.destination]: 1 },
        lastSeenAtStation: passenger.destination,
        transportHistory: passenger.status === "delivered"
          ? [{
              destination: passenger.destination,
              destinationName: passenger.destinationName,
              fare: passenger.fare,
              transportedAt: now,
              status: "delivered",
            }]
          : [],
      };
      this.civilians.set(normalizedId, record);
    }

    this.save();
  }

  get(citizenId: string): CivilianRecord | undefined {
    this.ensureLoaded();
    return this.civilians.get(this.normalizeId(citizenId));
  }

  getAll(): CivilianRecord[] {
    this.ensureLoaded();
    return Array.from(this.civilians.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  search(query: string): CivilianRecord[] {
    this.ensureLoaded();
    const queryLower = query.toLowerCase().trim();
    if (!queryLower) return [];
    return this.getAll().filter(c =>
      c.name.toLowerCase().includes(queryLower) ||
      c.citizenId.toLowerCase().includes(queryLower) ||
      c.destinationName.toLowerCase().includes(queryLower)
    );
  }

  getCount(): number {
    this.ensureLoaded();
    return this.civilians.size;
  }

  getCounts(): { total: number; economy: number; business: number; first: number } {
    this.ensureLoaded();
    return this.data.counts;
  }

  getFullData(): FullCiviliansInfoData {
    this.ensureLoaded();
    return JSON.parse(JSON.stringify(this.data));
  }
}

export const civilianStore = new CivilianStore();