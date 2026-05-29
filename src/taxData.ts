import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const TAXES_FILE = join(DATA_DIR, "taxes.json");

export interface TaxEstimate {
  botUsername: string;
  timestamp: number;
  taxable_income_to_date: number;
  income_tax_total: number;
  property_tax_total: number;
  assessed_property_value: number;
  last_assessed_at: number;
  data: Record<string, unknown>;
}

export interface TaxesData {
  [botUsername: string]: {
    lastTaxEstimate?: TaxEstimate;
    history: TaxEstimate[];
  };
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadTaxesData(): TaxesData {
  try {
    if (existsSync(TAXES_FILE)) {
      const content = readFileSync(TAXES_FILE, "utf-8").trim();
      if (content) {
        return JSON.parse(content) as TaxesData;
      }
    }
  } catch (err) {
    console.error("Error loading taxes.json:", err);
  }
  return {};
}

export function saveTaxesData(data: TaxesData): void {
  ensureDataDir();
  writeFileSync(TAXES_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function hasTaxEstimateChanged(
  botUsername: string,
  newEstimate: TaxEstimate
): boolean {
  const data = loadTaxesData();
  const botData = data[botUsername];
  if (!botData || !botData.lastTaxEstimate) {
    return true;
  }
  const last = botData.lastTaxEstimate;
  return (
    last.taxable_income_to_date !== newEstimate.taxable_income_to_date ||
    last.income_tax_total !== newEstimate.income_tax_total ||
    last.property_tax_total !== newEstimate.property_tax_total ||
    last.assessed_property_value !== newEstimate.assessed_property_value
  );
}

export function saveTaxEstimate(botUsername: string, estimate: TaxEstimate): void {
  const data = loadTaxesData();
  if (!data[botUsername]) {
    data[botUsername] = { history: [] };
  }
  const botData = data[botUsername];
  if (botData.lastTaxEstimate) {
    botData.history.push(botData.lastTaxEstimate);
    if (botData.history.length > 100) {
      botData.history = botData.history.slice(-100);
    }
  }
  botData.lastTaxEstimate = estimate;
  saveTaxesData(data);
}