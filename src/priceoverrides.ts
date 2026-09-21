import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { rename, writeFile } from "fs/promises";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const PRICE_OVERRIDES_FILE = join(DATA_DIR, "priceOverrides.json");
const PRICE_OVERRIDES_TMP = join(DATA_DIR, "priceOverrides.json.tmp");
const PERSIST_INTERVAL_MS = 30_000;

export interface PriceOverride {
  price: number;
  timestamp: string;
}

export class PriceOverridesStore {
  private data: Record<string, PriceOverride> = {};
  private dirty = false;
  private writing = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  private ensureLoaded(): Record<string, PriceOverride> {
    if (Object.keys(this.data).length > 0 || existsSync(PRICE_OVERRIDES_FILE)) {
      try {
        const raw = readFileSync(PRICE_OVERRIDES_FILE, "utf-8");
        const parsed = JSON.parse(raw) as Record<string, PriceOverride>;
        if (parsed && typeof parsed === "object") {
          this.data = parsed;
        }
      } catch {
        // Corrupt file — start fresh
      }
    }
    this.startAutoPersist();
    return this.data;
  }

  private startAutoPersist(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, PERSIST_INTERVAL_MS);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stopAutoPersist(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getAll(): Record<string, PriceOverride> {
    return this.ensureLoaded();
  }

  get(itemId: string): PriceOverride | undefined {
    const data = this.ensureLoaded();
    return data[(itemId || "").toLowerCase()];
  }

  set(itemId: string, price: number): void {
    const data = this.ensureLoaded();
    const key = (itemId || "").toLowerCase();
    data[key] = { price, timestamp: new Date().toISOString() };
    this.dirty = true;
  }

  remove(itemId: string): boolean {
    const data = this.ensureLoaded();
    const key = (itemId || "").toLowerCase();
    if (data[key]) {
      delete data[key];
      this.dirty = true;
      return true;
    }
    return false;
  }

  clearAll(): void {
    const data = this.ensureLoaded();
    if (Object.keys(data).length > 0) {
      this.data = {};
      this.dirty = true;
    }
  }

  hasPendingWrites(): boolean {
    return this.dirty;
  }

  private serialize(): string {
    const data = this.ensureLoaded();
    return JSON.stringify(data) + "\n";
  }

  async flush(): Promise<boolean> {
    if (!this.dirty || this.writing) return false;
    this.writing = true;
    this.dirty = false;
    try {
      const text = this.serialize();
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      try {
        await writeFile(PRICE_OVERRIDES_TMP, text, "utf-8");
        await rename(PRICE_OVERRIDES_TMP, PRICE_OVERRIDES_FILE);
      } catch {
        await writeFile(PRICE_OVERRIDES_FILE, text, "utf-8");
      }
      return true;
    } catch (err) {
      this.dirty = true;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[PriceOverrides] Save failed: ${msg}`);
      return false;
    } finally {
      this.writing = false;
    }
  }

  flushSync(): boolean {
    if (!this.dirty) return false;
    try {
      const text = this.serialize();
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      try {
        writeFileSync(PRICE_OVERRIDES_TMP, text, "utf-8");
        renameSync(PRICE_OVERRIDES_TMP, PRICE_OVERRIDES_FILE);
      } catch {
        writeFileSync(PRICE_OVERRIDES_FILE, text, "utf-8");
      }
      this.dirty = false;
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[PriceOverrides] Save failed: ${msg}`);
      return false;
    }
  }
}

export const priceOverridesStore = new PriceOverridesStore();
