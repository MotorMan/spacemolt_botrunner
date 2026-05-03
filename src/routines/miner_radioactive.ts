import type { RoutineContext } from "../bot.js";

// ── Radioactive mining constants ───────────────────────────────────────────

/**
 * Radioactive ores that can be extracted using radioactive harvesting modules.
 * These ores require both lead-lined cargo modules and rad harvesters to mine.
 */
export const RADIOACTIVE_ORES = new Set([
  "polonium_ore",
  "radium_ore",
  "uranium_ore",
  "thorium_ore",
]);

/**
 * Check if a resource ID is a radioactive ore.
 */
export function isRadioactiveOre(resourceId: string): boolean {
  return RADIOACTIVE_ORES.has(resourceId);
}

/**
 * Check if the ship has lead-lined cargo modules equipped.
 * These are required to safely store radioactive materials.
 */
export async function hasLeadLinedCargo(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  const shipResp = await bot.exec("get_ship");
  if (shipResp.error || !shipResp.result) return false;

  const shipData = shipResp.result as Record<string, unknown>;
  const modules = Array.isArray(shipData.modules) ? shipData.modules : [];

  for (const mod of modules) {
    const modObj = typeof mod === "object" && mod !== null ? mod as Record<string, unknown> : null;
    const modId = (modObj?.id as string) || (modObj?.type_id as string) || "";
    const modName = (modObj?.name as string) || "";
    const modType = (modObj?.type as string) || "";
    const modSpecial = (modObj?.special as string) || "";

    const checkStr = `${modId} ${modName} ${modType} ${modSpecial}`.toLowerCase();
    if (checkStr.includes("lead_lined_cargo") || checkStr.includes("lead lined cargo")) {
      return true;
    }
  }
  return false;
}

/**
 * Check if the ship has a rad harvester module equipped.
 * These are required to extract radioactive ores.
 */
export async function hasRadHarvester(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  const shipResp = await bot.exec("get_ship");
  if (shipResp.error || !shipResp.result) return false;

  const shipData = shipResp.result as Record<string, unknown>;
  const modules = Array.isArray(shipData.modules) ? shipData.modules : [];

  for (const mod of modules) {
    const modObj = typeof mod === "object" && mod !== null ? mod as Record<string, unknown> : null;
    const modId = (modObj?.id as string) || (modObj?.type_id as string) || "";
    const modName = (modObj?.name as string) || "";
    const modType = (modObj?.type as string) || "";
    const modSpecial = (modObj?.special as string) || "";

    const checkStr = `${modId} ${modName} ${modType} ${modSpecial}`.toLowerCase();
    if (checkStr.includes("rad_harvester") || checkStr.includes("rad harvester")) {
      return true;
    }
  }
  return false;
}

/**
 * Check if the ship has radioactive mining capability.
 * Returns detailed capability levels for different setups:
 * - Basic: rad harvester + lead-lined cargo (basic rad ores in public areas)
 * - Enhanced: Basic + deep core extractor (deep core rad ores in visible POIs)
 * - Full: Enhanced + deep core survey scanner (rad ores in hidden POIs)
 */
export async function getRadioactiveCapability(ctx: RoutineContext): Promise<{
  hasLeadLinedCargo: boolean;
  hasRadHarvester: boolean;
  hasDeepCoreExtractor: boolean;
  hasDeepCoreScanner: boolean;
  canMineBasicRadioactive: boolean; // Basic rad ores in public areas
  canMineDeepCoreRadioactive: boolean; // Deep core rad ores in visible POIs
  canMineHiddenRadioactive: boolean; // Rad ores in hidden POIs
}> {
  const hasLLCargo = await hasLeadLinedCargo(ctx);
  const hasRadHarv = await hasRadHarvester(ctx);

  // Check for deep core equipment
  const shipResp = await ctx.bot.exec("get_ship");
  let hasDeepCoreExtractor = false;
  let hasDeepCoreScanner = false;

  if (!shipResp.error && shipResp.result) {
    const shipData = shipResp.result as Record<string, unknown>;
    const modules = Array.isArray(shipData.modules) ? shipData.modules : [];

    for (const mod of modules) {
      const modObj = typeof mod === "object" && mod !== null ? mod as Record<string, unknown> : null;
      const modId = (modObj?.id as string) || (modObj?.type_id as string) || "";
      const modName = (modObj?.name as string) || "";
      const modSpecial = (modObj?.special as string) || "";

      const checkStr = `${modId} ${modName} ${modSpecial}`.toLowerCase();

      if (checkStr.includes("deep_core_extractor_mki") ||
          checkStr.includes("deep_core_extractor_mkii") ||
          checkStr.includes("deep_core_extractor_ii") ||
          checkStr.includes("deep_core_extractor") ||
          checkStr.includes("deep core extractor") ||
          modSpecial.includes("rare_ore_access")) {
        hasDeepCoreExtractor = true;
      }

      if (checkStr.includes("deep_core_survey_scanner") ||
          checkStr.includes("deep core survey scanner") ||
          modSpecial.includes("deep_core_detection")) {
        hasDeepCoreScanner = true;
      }
    }
  }

  const canMineBasic = hasLLCargo && hasRadHarv;
  const canMineDeepCore = canMineBasic && hasDeepCoreExtractor;
  const canMineHidden = canMineDeepCore && hasDeepCoreScanner;

  return {
    hasLeadLinedCargo: hasLLCargo,
    hasRadHarvester: hasRadHarv,
    hasDeepCoreExtractor: hasDeepCoreExtractor,
    hasDeepCoreScanner: hasDeepCoreScanner,
    canMineBasicRadioactive: canMineBasic,
    canMineDeepCoreRadioactive: canMineDeepCore,
    canMineHiddenRadioactive: canMineHidden,
  };
}

/**
 * Check radioactive mining capability levels from cached modules.
 * Returns detailed capability info.
 */
export function getRadioactiveCapabilityCached(
  modules: unknown[],
): {
  canMineBasicRadioactive: boolean;
  canMineDeepCoreRadioactive: boolean;
  canMineHiddenRadioactive: boolean;
} {
  const moduleStr = modules.map(m => {
    const obj = typeof m === "object" && m !== null ? m as Record<string, unknown> : {};
    return `${obj.id || ""} ${obj.name || ""} ${obj.type || ""} ${obj.special || ""}`.toLowerCase();
  }).join(" ");

  const hasLLCargo = moduleStr.includes("lead_lined_cargo") || moduleStr.includes("lead lined cargo");
  const hasRadHarv = moduleStr.includes("rad_harvester") || moduleStr.includes("rad harvester");
  const hasDeepCoreExtractor = moduleStr.includes("deep_core_extractor_mki") ||
                               moduleStr.includes("deep_core_extractor_mkii") ||
                               moduleStr.includes("deep_core_extractor_ii") ||
                               moduleStr.includes("deep_core_extractor") ||
                               moduleStr.includes("deep core extractor");
  const hasDeepCoreScanner = moduleStr.includes("deep_core_survey_scanner") ||
                             moduleStr.includes("deep core survey scanner") ||
                             moduleStr.includes("deep_core_detection");

  const canMineBasic = hasLLCargo && hasRadHarv;
  const canMineDeepCore = canMineBasic && hasDeepCoreExtractor;
  const canMineHidden = canMineDeepCore && hasDeepCoreScanner;

  return {
    canMineBasicRadioactive: canMineBasic,
    canMineDeepCoreRadioactive: canMineDeepCore,
    canMineHiddenRadioactive: canMineHidden,
  };
}

/**
 * Check if the ship has basic radioactive mining equipment.
 * Cached version that accepts pre-fetched modules.
 * @deprecated Use getRadioactiveCapabilityCached instead
 */
export function hasRadioactiveEquipmentCached(
  modules: unknown[],
): boolean {
  const cap = getRadioactiveCapabilityCached(modules);
  return cap.canMineBasicRadioactive;
}

/**
 * Check if the ship has a deep core extractor equipped.
 * Cached version that accepts pre-fetched modules.
 * Required to mine radioactive ores from hidden POIs.
 */
export function hasDeepCoreExtractorCached(
  modules: unknown[],
): boolean {
  const moduleStr = modules.map(m => {
    const obj = typeof m === "object" && m !== null ? m as Record<string, unknown> : {};
    return `${obj.id || ""} ${obj.name || ""} ${obj.type || ""} ${obj.special || ""}`.toLowerCase();
  }).join(" ");

  return moduleStr.includes("deep_core_extractor_mki") ||
         moduleStr.includes("deep_core_extractor_mkii") ||
         moduleStr.includes("deep_core_extractor_ii") ||
         moduleStr.includes("deep_core_extractor") ||
         moduleStr.includes("deep core extractor");
}

/**
 * Check if the ship has full radioactive mining equipment including deep core extractor and scanner.
 * This is required to mine radioactive ores from hidden POIs.
 * Cached version that accepts pre-fetched modules.
 * @deprecated Use getRadioactiveCapabilityCached instead
 */
export function hasFullRadioactiveCapabilityCached(
  modules: unknown[],
): boolean {
  const cap = getRadioactiveCapabilityCached(modules);
  return cap.canMineHiddenRadioactive;
}

/**
 * Log radioactive mining capability.
 */
export async function logRadioactiveCapability(ctx: RoutineContext): Promise<void> {
  const radCap = await getRadioactiveCapability(ctx);
  if (radCap.hasLeadLinedCargo || radCap.hasRadHarvester) {
    const parts: string[] = [];
    if (radCap.hasLeadLinedCargo) parts.push("lead-lined cargo");
    if (radCap.hasRadHarvester) parts.push("rad harvester");
    if (radCap.hasDeepCoreExtractor) parts.push("deep core extractor");
    if (radCap.hasDeepCoreScanner) parts.push("deep core scanner");
    ctx.log("mining", `Radioactive mining equipment detected: ${parts.join(" + ")}`);

    if (radCap.canMineHiddenRadioactive) {
      ctx.log("mining", "Radioactive mining capability: FULL (can mine radioactive ores in hidden POIs)");
    } else if (radCap.canMineDeepCoreRadioactive) {
      ctx.log("mining", "Radioactive mining capability: ENHANCED (can mine deep core radioactive ores in visible POIs)");
    } else if (radCap.canMineBasicRadioactive) {
      ctx.log("mining", "Radioactive mining capability: BASIC (can mine basic radioactive ores in public areas)");
    } else {
      if (!radCap.hasLeadLinedCargo) ctx.log("warn", "Radioactive mining INCOMPLETE: missing lead-lined cargo");
      if (!radCap.hasRadHarvester) ctx.log("warn", "Radioactive mining INCOMPLETE: missing rad harvester");
    }
  }
}

/**
 * Find radioactive POIs in the current system.
 * Radioactive ores may be found in regular ore belts or special locations.
 */
export function findRadioactivePoi(
  pois: Array<{ id: string; name: string; type: string }>,
  targetResource?: string,
  mapStore?: any,
): { id: string; name: string } | null {
  // If target resource specified, look for POI with that ore
  if (targetResource && mapStore) {
    for (const poi of pois) {
      const isOreBelt = poi.type.toLowerCase().includes("ore") || 
                        poi.type.toLowerCase().includes("belt") ||
                        poi.type.toLowerCase().includes("asteroid");
      
      if (isOreBelt) {
        const sysData = mapStore.getSystem(poi.id.split("-")[0] || "");
        const storedPoi = sysData?.pois.find((p: any) => p.id === poi.id);
        if (storedPoi?.ores_found?.some((o: any) => o.item_id === targetResource)) {
          return { id: poi.id, name: poi.name };
        }
      }
    }
  }

  // Fallback: any ore belt
  const oreBelt = pois.find(p => 
    p.type.toLowerCase().includes("ore") || 
    p.type.toLowerCase().includes("belt") ||
    p.type.toLowerCase().includes("asteroid")
  );
  
  return oreBelt ? { id: oreBelt.id, name: oreBelt.name } : null;
}

/**
 * Check if cargo contains radioactive ores that need to be jettisoned.
 * Returns array of items to jettison.
 */
export function getRadioactiveOresToJettison(
  cargo: Array<{ itemId: string; quantity: number; name: string }>,
  jettisonList: string[],
): Array<{ itemId: string; quantity: number; name: string }> {
  return cargo.filter(item => 
    item.quantity > 0 && 
    isRadioactiveOre(item.itemId) && 
    jettisonList.includes(item.itemId)
  );
}
