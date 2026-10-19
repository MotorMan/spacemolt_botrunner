import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { safeWriteFileSync } from "./diskSpaceGuard.js";

const LOUNGE_FILE = fileURLToPath(new URL("../data/passengersLounge.json", import.meta.url));

export interface LoungePassenger {
  citizenId: string;
  name: string;
  accommodationClass: "economy" | "business" | "first";
  citizenship: string;
  destination: string;
  destinationName: string;
  destinationSystem?: string;
  fare: number;
  bio: string;
  loadedAt: string;
  checkedInAt: string;
  expiresAt: string;
  status: "waiting" | "ready_for_delivery" | "delivered" | "expired";
}

interface LoungeData {
  passengers: LoungePassenger[];
  lastUpdated: string;
  capacity: number;
}

const LOUNGE_CAPACITY = 150;
const LOUNGE_TICK_EXTENSION = 360;

function nowISO(): string {
  return new Date().toISOString();
}

export class PassengersLoungeStore {
  private passengers = new Map<string, LoungePassenger>();
  private data: LoungeData = {
    passengers: [],
    lastUpdated: nowISO(),
    capacity: LOUNGE_CAPACITY,
  };

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(LOUNGE_FILE)) {
        this.save();
        return;
      }
      const text = readFileSync(LOUNGE_FILE, "utf-8");
      const loaded = JSON.parse(text) as LoungeData;
      this.data = loaded;
      for (const p of loaded.passengers) {
        this.passengers.set(p.citizenId, p);
      }
    } catch {
      this.data = {
        passengers: [],
        lastUpdated: nowISO(),
        capacity: LOUNGE_CAPACITY,
      };
    }
  }

  private save(): void {
    this.data.passengers = Array.from(this.passengers.values());
    this.data.lastUpdated = nowISO();
    this.data.capacity = LOUNGE_CAPACITY;
    const payload = JSON.stringify(this.data, null, 2) + "\n";
    safeWriteFileSync(LOUNGE_FILE, payload, Buffer.byteLength(payload, "utf-8"));
  }

  getPassenger(citizenId: string): LoungePassenger | undefined {
    return this.passengers.get(citizenId);
  }

  getAllPassengers(): LoungePassenger[] {
    return Array.from(this.passengers.values());
  }

  getWaitingPassengers(): LoungePassenger[] {
    return Array.from(this.passengers.values()).filter(p => p.status === "waiting");
  }

  getReadyForDeliveryPassengers(): LoungePassenger[] {
    return Array.from(this.passengers.values()).filter(p => p.status === "ready_for_delivery");
  }

  getCount(): number {
    return this.passengers.size;
  }

  getAvailableSlots(): number {
    return Math.max(0, LOUNGE_CAPACITY - this.passengers.size);
  }

  addPassenger(passenger: LoungePassenger): boolean {
    if (this.passengers.size >= LOUNGE_CAPACITY) return false;
    this.passengers.set(passenger.citizenId, passenger);
    this.save();
    return true;
  }

  removePassenger(citizenId: string): LoungePassenger | undefined {
    const p = this.passengers.get(citizenId);
    if (p) {
      this.passengers.delete(citizenId);
      this.save();
    }
    return p;
  }

  markDelivered(citizenId: string): boolean {
    const p = this.passengers.get(citizenId);
    if (p) {
      p.status = "delivered";
      this.save();
      return true;
    }
    return false;
  }

  checkExpiredPassengers(): LoungePassenger[] {
    const now = new Date();
    const expired: LoungePassenger[] = [];
    for (const p of this.passengers.values()) {
      if (p.status === "waiting") {
        const expiresAt = new Date(p.expiresAt);
        if (now >= expiresAt) {
          p.status = "ready_for_delivery";
          expired.push(p);
        }
      }
    }
    if (expired.length > 0) this.save();
    return expired;
  }

  addOrUpdatePassenger(passenger: LoungePassenger): void {
    this.passengers.set(passenger.citizenId, passenger);
    this.save();
  }

  static createLoungePassenger(from: {
    citizenId: string;
    name: string;
    accommodationClass: "economy" | "business" | "first";
    citizenship: string;
    destination: string;
    destinationName: string;
    destinationSystem?: string;
    fare: number;
    bio: string;
    loadedAt: string;
  }): LoungePassenger {
    const checkedInAt = nowISO();
    const expiresAt = new Date(Date.now() + LOUNGE_TICK_EXTENSION * 1000).toISOString();
    return {
      citizenId: from.citizenId,
      name: from.name,
      accommodationClass: from.accommodationClass,
      citizenship: from.citizenship,
      destination: from.destination,
      destinationName: from.destinationName,
      destinationSystem: from.destinationSystem,
      fare: from.fare,
      bio: from.bio,
      loadedAt: from.loadedAt,
      checkedInAt,
      expiresAt,
      status: "waiting",
    };
  }
}

export const passengersLounge = new PassengersLoungeStore();
