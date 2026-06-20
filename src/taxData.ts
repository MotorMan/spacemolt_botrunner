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
}

export interface FactionTaxEstimate {
  action: string;
  faction_id: string;
  faction_name: string;
  domicile: string;
  taxable_income_to_date: number;
  deductible_expenses_to_date: number;
  net_taxable_profit: number;
  income_tax: Array<{
    empire: string;
    basis: string;
    rate_bps: number;
    taxed_profit: number;
    gross: number;
    credit: number;
    owed: number;
  }>;
  income_tax_total: number;
  carried_debt: Array<{ empire: string; amount: number }>;
  carried_debt_total: number;
  tax_prepaid: number;
  next_assessment_approx_seconds: number;
  tax_collection_active: boolean;
  last_assessed_at?: number;
  note?: string;
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
    last.last_assessed_at !== newEstimate.last_assessed_at ||
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

export interface FactionTaxData {
  lastFactionTaxEstimate?: FactionTaxEstimate;
  lastUpdated: number;
}

export function loadFactionTaxData(): FactionTaxData {
  try {
    const factionTaxesFile = join(DATA_DIR, "faction_taxes.json");
    if (existsSync(factionTaxesFile)) {
      const content = readFileSync(factionTaxesFile, "utf-8").trim();
      if (content) {
        return JSON.parse(content) as FactionTaxData;
      }
    }
  } catch (err) {
    console.error("Error loading faction_taxes.json:", err);
  }
  return { lastUpdated: 0 };
}

export function saveFactionTaxEstimate(estimate: FactionTaxEstimate): void {
  ensureDataDir();
  const data: FactionTaxData = {
    lastFactionTaxEstimate: estimate,
    lastUpdated: Date.now(),
  };
  const factionTaxesFile = join(DATA_DIR, "faction_taxes.json");
  writeFileSync(factionTaxesFile, JSON.stringify(data, null, 2) + "\n", "utf-8");
}