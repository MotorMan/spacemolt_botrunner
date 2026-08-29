import type { RoutineContext } from "../bot.js";
import type { BattleStatus } from "../types/game.js";
import { catalogStore } from "../catalogstore.js";
import { mapStore } from "../mapstore.js";
import { wildlifeStore } from "../wildlivestore.js";
import { getBattleStatus, topUpShields, useRepairKits } from "./common.js";
import { combatDebugLog } from "../debug.js";

/**
 * Returns true if the given display name belongs to a known creature (wildlife).
 * Creatures are NOT players — even with onlyNPCs=true the hunter should fight
 * (or at least not flee from) a creature that attacks it.
 *
 * Uses the store's name index (a Set lookup): this runs for every battle
 * participant on every combat tick, so it must never walk the creature data.
 */
export function isCreatureName(name: string | undefined): boolean {
  if (!name) return false;
  return wildlifeStore.hasCreatureName(name);
}

// ── Types ─────────────────────────────────────────────

export type PirateTier = "small" | "medium" | "large" | "capitol" | "boss";

/**
 * Battle commands (advance, retreat, stance, target, flee) LOCK until the server
 * processes them at the next tick (every ~10 seconds).
 *
 * IMPORTANT: bot.exec("battle", ...) may not fully block in practice, so we add
 * manual sleeps to ensure tick timing is respected.
 *
 * This function is kept for backward compatibility but simply waits 10s.
 * The real "wait" happens inside bot.exec() when it awaits the server response.
 *
 * Combat stance for hunter bots:
 *   - FIRE (default): 100% damage dealt - ALWAYS use this stance
 *   - NO BRACE: Never blocks firing to recover shields (missile ships would use this)
 *   - NO RETREAT: Stay at engaged range, never move to inner/mid/outer
 */
export async function waitForServerTick(
  ctx: RoutineContext,
  _lastTick: number | undefined,
  timeoutMs: number = 15000,
): Promise<void> {
  // Wait for server tick (~10s) as safety net.
  ctx.log("combat", `Waiting for server response (max ${timeoutMs}ms)...`);
  await ctx.sleep(Math.min(timeoutMs, 10000));
}

export const TIER_ORDER: Record<PirateTier, number> = {
  "small": 1,
  "medium": 2,
  "large": 3,
  "capitol": 4,
  "boss": 5,
};

export function getTierLevel(tier: PirateTier | undefined | null): number {
  if (!tier) return 1;
  return TIER_ORDER[tier] ?? 1;
}

export function isTierTooHigh(pirateTier: PirateTier | undefined, maxTier: PirateTier): boolean {
  if (!pirateTier) return false;
  return getTierLevel(pirateTier) > getTierLevel(maxTier);
}

export interface NearbyEntity {
  id: string;
  name: string;
  type: string;
  faction: string;
  isNPC: boolean;
  isPirate: boolean;
  isCreature?: boolean;
  creatureId?: string;
  tier?: PirateTier;
  isBoss?: boolean;
  hull?: number;
  maxHull?: number;
  inCombat?: boolean;
  shield?: number;
  maxShield?: number;
  status?: string;
}

export interface WeaponModule {
  instanceId: string;
  moduleId: string;
  name: string;
  currentAmmo: number;
  maxAmmo: number;
  ammoType?: string;
  loadedAmmoId?: string;   // specific ammo item currently loaded (e.g. "corrosive_plasma_cell_pack")
}

// ── Constants ──────────────────────────────────────────────

export const PIRATE_KEYWORDS = ["drifter", "pirate", "raider", "outlaw", "bandit", "corsair", "marauder", "hostile"];

// ── Nearby Entity Parsing ─────────────────────────────────────

export function parseNearby(result: unknown): NearbyEntity[] {
  if (!result || typeof result !== "object") return [];
  const r = result as Record<string, unknown>;
  const entities: NearbyEntity[] = [];

let rawEntities: Array<Record<string, unknown>> = [];
    if (Array.isArray(r)) {
      rawEntities = r;
    } else if (Array.isArray(r.entities)) {
      rawEntities = r.entities as Array<Record<string, unknown>>;
    } else if (Array.isArray(r.players) && r.players.length > 0) {
      rawEntities = r.players as Array<Record<string, unknown>>;
    } else if (Array.isArray(r.nearby)) {
      rawEntities = r.nearby as Array<Record<string, unknown>>;
    } else if (Array.isArray(r.pirates)) {
      rawEntities = r.pirates as Array<Record<string, unknown>>;
    } else if (Array.isArray(r.creatures)) {
      rawEntities = r.creatures as Array<Record<string, unknown>>;
    }

  for (const e of rawEntities) {
    const id = (e.id as string) || (e.player_id as string) || (e.entity_id as string) || (e.pirate_id as string) || "";
    let faction = "";
    if (typeof e.faction === "string") {
      faction = e.faction.toLowerCase();
    } else if (typeof e.faction_id === "string") {
      faction = e.faction_id.toLowerCase();
    }

    let type = "";
    if (typeof e.type === "string") {
      type = e.type.toLowerCase();
    } else if (typeof e.entity_type === "string") {
      type = e.entity_type.toLowerCase();
    }

    const isPirate = !!(e.pirate_id) || type.includes("pirate") || faction.includes("pirate");
    const isNPC = isPirate || !!(e.is_npc) || type === "npc" || type === "enemy" || (typeof e.name === "string" && e.name.toLowerCase().includes("drifter"));

    entities.push({
      id,
      name: (e.name as string) || (e.username as string) || (e.pirate_name as string) || (e.pirate_id as string) || id,
      type,
      faction,
      isNPC,
      isPirate,
    });
  }

  if (Array.isArray(r.pirates)) {
    const rawPirates = r.pirates as Array<Record<string, unknown>>;
    for (const p of rawPirates) {
      const id = (p.pirate_id as string) || "";
      if (!id) continue;

      const tier = (p.tier as string) || "small";
      const isBoss = !!(p.is_boss as boolean);

      entities.push({
        id,
        name: (p.name as string) || (p.pirate_name as string) || id,
        type: "pirate",
        faction: "pirate",
        isNPC: true,
        isPirate: true,
        tier: tier as PirateTier,
        isBoss,
        hull: p.hull as number,
        maxHull: p.max_hull as number,
        shield: p.shield as number,
        maxShield: p.max_shield as number,
        status: p.status as string,
      });
    }
  }

  if (Array.isArray(r.creatures)) {
    const rawCreatures = r.creatures as Array<Record<string, unknown>>;
    for (const c of rawCreatures) {
      const creatureId = (c.creature_id as string) || "";
      if (!creatureId) continue;

      entities.push({
        id: creatureId,
        name: (c.name as string) || "",
        type: "creature",
        faction: "",
        isNPC: true,
        isPirate: false,
        isCreature: true,
        creatureId: creatureId,
        hull: c.hull as number,
        maxHull: c.max_hull as number,
        inCombat: c.in_combat as boolean,
      });
    }
  }

  return entities.filter(e => e.id);
}

// ── Target Validation ─────────────────────────────────────────

export function isPirateTarget(entity: NearbyEntity, onlyNPCs: boolean, maxAttackTier: PirateTier = "large"): boolean {
  if (entity.isPirate) {
    return true;
  }
  if (onlyNPCs && !entity.isNPC) return false;

  const factionMatch = entity.faction ? PIRATE_KEYWORDS.some(kw => entity.faction.includes(kw)) : false;
  const typeMatch = entity.type ? PIRATE_KEYWORDS.some(kw => entity.type.includes(kw)) : false;
  const nameMatch = entity.name ? PIRATE_KEYWORDS.some(kw => entity.name.toLowerCase().includes(kw)) : false;

  return factionMatch || typeMatch || (entity.isNPC && nameMatch);
}

export function isCreatureTarget(entity: NearbyEntity, huntCreatures: boolean): boolean {
  if (!huntCreatures) return false;
  return !!(entity.isCreature || entity.type === "creature");
}

// ── Weapon & Ammo Management ─────────────────────────────────

export async function getWeaponModules(ctx: RoutineContext): Promise<WeaponModule[]> {
  const { bot } = ctx;
  const shipResp = await bot.exec("get_ship");
  if (shipResp.error || !shipResp.result) {
    ctx.log("error", `get_ship failed for weapon info: ${shipResp.error?.message}`);
    return [];
  }

  const result = shipResp.result as Record<string, unknown>;
  // V2 API: modules are at top level, not inside ship
  const modulesArray = Array.isArray(result.modules) ? result.modules : [];

  const weapons: WeaponModule[] = [];
  for (const mod of modulesArray) {
    if (!mod || typeof mod !== "object") continue;

    const modCategory = ((mod.category as string) || "").toLowerCase();
    const modType = ((mod.type as string) || (mod.module_type as string) || "").toLowerCase();
    const modId = ((mod.module_id as string) || (mod.mod_id as string) || (mod.id as string) || "").toLowerCase();
    const isWeapon =
      modCategory === "weapon" ||
      modCategory.includes("weapon") ||
      modCategory.includes("cannon") ||
      modCategory.includes("gun") ||
      modCategory.includes("laser") ||
      modType.includes("weapon") ||
      modType.includes("missile") ||
      modType.includes("launcher") ||
      modType.includes("torpedo") ||
      modId.includes("weapon") ||
      modId.includes("missile") ||
      modId.includes("launcher");
    if (!isWeapon) continue;

    // V2 API provides ammo_type directly, fall back to catalog lookup
    let ammoType = (mod.ammo_type as string) || "";
    if (!ammoType && modId) {
      const catalogModule = catalogStore.getItem(modId);
      if (catalogModule) {
        ammoType = (catalogModule as Record<string, unknown>).ammo_type as string;
      }
    }

    const instanceId = (mod.module_id as string) ||
                       (mod.instance_id as string) ||
                       (mod.weapon_instance_id as string) ||
                       (mod.module_instance_id as string) ||
                       (mod.id as string) || "";
    const moduleId = (mod.module_id as string) || (mod.mod_id as string) || (mod.id as string) || "";
    // V2 API now provides current_ammo and magazine_size directly
    const currentAmmo = (mod.current_ammo as number) ?? 0;
    const maxAmmo = (mod.magazine_size as number) ?? 0;

    if (instanceId) {
      weapons.push({
        instanceId,
        moduleId,
        name: (mod.name as string) || moduleId,
        currentAmmo,
        maxAmmo,
        ammoType,
        loadedAmmoId: (mod.loaded_ammo_id as string) || (mod.current_ammo_item as string) || undefined,
      });
    }
  }

  return weapons;
}

/**
 * Ensure the hunter has ammo loaded.
 * Uses absolute threshold for low-capacity weapons (≤50 ammo), percent threshold for high-capacity weapons (>50 ammo).
 * Uses proper reload command with weapon_instance_id and ammo_item_id from cargo.
 * Returns false if out of ammo and needs to dock for resupply.
 * 
 * Handles both traditional weapons (with reported ammo) and missile launchers
 * (which may not report ammo state but still need cargo ammo).
 */
export async function ensureAmmoLoaded(
  ctx: RoutineContext,
  _threshold: number,
  maxAttempts: number,
  absoluteThreshold: number = 1,
  percentThreshold: number = 25,
): Promise<boolean> {
  const { bot } = ctx;
  await bot.refreshShip();
  const weapons = await getWeaponModules(ctx);
  if (weapons.length === 0) {
    ctx.log("warn", "No weapon modules found — skipping reload");
    return true;
  }

  await bot.refreshCargo();
  const cargoItems = bot.inventory.map(item => ({
    itemId: item.itemId,
    quantity: item.quantity,
  }));

  let anyReloaded = false;
  for (const weapon of weapons) {
    ctx.log("debug", `Weapon "${weapon.name}": currentAmmo=${weapon.currentAmmo}, maxAmmo=${weapon.maxAmmo}, ammoType="${weapon.ammoType || 'empty'}"`);
    
    let effectiveAmmoType = weapon.ammoType;
    if (!effectiveAmmoType && weapon.loadedAmmoId) {
      const ammoIndex = catalogStore.getAmmoTypeIndex();
      for (const [ammoType, ammoIds] of Object.entries(ammoIndex)) {
        if (ammoIds.includes(weapon.loadedAmmoId)) {
          effectiveAmmoType = ammoType;
          break;
        }
      }
    }
    
    if (!effectiveAmmoType) {
      ctx.log("combat", `Weapon "${weapon.name}" does not use ammo — skipping reload check`);
      continue;
    }

    let needsReload = false;
    if (weapon.maxAmmo > 0) {
      const absThreshold = weapon.maxAmmo <= 50 ? absoluteThreshold : 0;
      const pctThreshold = weapon.maxAmmo > 50 ? percentThreshold : 0;
      const absCheck = absThreshold > 0 ? weapon.currentAmmo <= absThreshold : false;
      const pctCheck = pctThreshold > 0 ? weapon.currentAmmo <= Math.floor(weapon.maxAmmo * pctThreshold / 100) : false;
      needsReload = absCheck || pctCheck;
      if (needsReload) {
        ctx.log("combat", `Weapon "${weapon.name}" ammo low: ${weapon.currentAmmo}/${weapon.maxAmmo} (abs:${absThreshold}, pct:${pctThreshold}%)`);
      }
    } else {
      const matchingAmmo = catalogStore.findMatchingAmmoInCargo(cargoItems, effectiveAmmoType);
      if (matchingAmmo.length > 0) {
        ctx.log("combat", `Weapon "${weapon.name}" ammo state unknown - attempting reload with ${effectiveAmmoType}`);
        needsReload = true;
      } else {
        ctx.log("warn", `Weapon "${weapon.name}" needs ${effectiveAmmoType} but none in cargo`);
      }
    }

    if (!needsReload) continue;

    const matchingAmmo = catalogStore.findMatchingAmmoInCargo(cargoItems, effectiveAmmoType);
    if (matchingAmmo.length === 0) {
      ctx.log("combat", `⚠️ No ${effectiveAmmoType} ammo in cargo for "${weapon.name}" — need to resupply`);
      continue;
    }

    const ammoItem = matchingAmmo[0];
    ctx.log("combat", `Found ${ammoItem.quantity}x ${ammoItem.itemId} (${effectiveAmmoType}) — reloading "${weapon.name}"...`);

    for (let i = 0; i < maxAttempts; i++) {
      const resp = await bot.exec("reload", { weapon_instance_id: weapon.instanceId, ammo_item_id: ammoItem.itemId });

      if (resp.error) {
        const msg = resp.error.message.toLowerCase();
        if (msg.includes("full") || msg.includes("already")) {
          ctx.log("combat", `Weapon "${weapon.name}" already full or reload skipped`);
          break;
        }
        if (msg.includes("no ammo") || msg.includes("no_ammo") || msg.includes("empty")) {
          ctx.log("combat", `No ${effectiveAmmoType} ammo available — need to resupply at station`);
          return false;
        }
        if (msg.includes("must specify") || msg.includes("missing")) {
          ctx.log("error", `Reload failed: ${resp.error.message} — weapon_instance_id: ${weapon.instanceId}, ammo_item_id: ${ammoItem.itemId}`);
          break;
        }
        ctx.log("combat", `Reload attempt ${i + 1} failed for "${weapon.name}": ${resp.error.message}`);
        continue;
      }

      ctx.log("combat", `✅ Reloaded "${weapon.name}" with ${ammoItem.itemId}`);
      anyReloaded = true;
      break;
    }
  }

  await bot.refreshShip();
  const updatedWeapons = await getWeaponModules(ctx);
  let updatedTotalAmmo = 0;
  let updatedTotalMaxAmmo = 0;
  let hasAmmoWeapons = false;

  for (const weapon of updatedWeapons) {
    if (weapon.ammoType) {
      hasAmmoWeapons = true;
      updatedTotalAmmo += weapon.currentAmmo;
      updatedTotalMaxAmmo += weapon.maxAmmo;
    }
  }

  if (hasAmmoWeapons && updatedTotalMaxAmmo > 0) {
    const updatedPct = (updatedTotalAmmo / updatedTotalMaxAmmo) * 100;
    ctx.log("combat", `Post-reload ammo: ${updatedTotalAmmo}/${updatedTotalMaxAmmo} (${updatedPct.toFixed(0)}%)`);
    return updatedTotalAmmo > 0 || anyReloaded;
  }

  if (hasAmmoWeapons) {
    ctx.log("combat", `Post-reload ammo: ${updatedTotalAmmo} rounds available`);
    return updatedTotalAmmo > 0 || anyReloaded;
  }

  return true;
}

// ── Emergency Flee ────────────────────────────────────────────

export async function emergencyFleeSpam(ctx: RoutineContext, reason: string): Promise<void> {
  const { bot } = ctx;
  ctx.log("combat", `🚨 EMERGENCY FLEE — ${reason}`);

  let status = await getBattleStatus(ctx);
  if (!status) {
    ctx.log("combat", `✅ Not in battle - no need to flee`);
    return;
  }

  // Send flee stance - wait for tick completion
  ctx.log("combat", `Setting flee stance (waiting for server tick)...`);
  const fleeResp = await bot.exec("battle", { action: "stance", stance: "flee" });
  await ctx.sleep(10000);

  if (fleeResp.error) {
    const errMsg = fleeResp.error.message.toLowerCase();
    if (errMsg.includes("in_battle") || errMsg.includes("in combat")) {
      ctx.log("combat", `⚠️ Flee stance blocked - waiting for current action to complete...`);
      await ctx.sleep(2000);

      // Retry flee after tick
      status = await getBattleStatus(ctx);
      if (!status) {
        ctx.log("combat", `✅ Battle ended during flee attempt`);
        return;
      }

      ctx.log("combat", `Retrying flee stance...`);
      await bot.exec("battle", { action: "stance", stance: "flee" });
      await ctx.sleep(10000);
    } else {
      ctx.log("error", `Flee stance failed: ${fleeResp.error.message}`);
    }
  }

  // Wait for disengagement - poll using non-locking getBattleStatus
  ctx.log("combat", `Flee stance set - waiting for disengagement...`);
  const MAX_FLEE_WAIT_TICKS = 10;
  
  for (let waitTicks = 0; waitTicks < MAX_FLEE_WAIT_TICKS; waitTicks++) {
    // Use non-locking getBattleStatus to check (immediate, no wait)
    status = await getBattleStatus(ctx);
    if (!status) {
      ctx.log("combat", `✅ Successfully disengaged from battle`);
      return;
    }
    
    const ourZone = status.your_zone;
    if (ourZone && ourZone !== "engaged") {
      ctx.log("combat", `Retreating from ${ourZone} zone...`);
    }
    
    // Brief pause before re-check (bot.exec() already waited for server tick)
    await ctx.sleep(2000);
  }

  // If still in battle, try retreat commands
  status = await getBattleStatus(ctx);
  if (status) {
    ctx.log("combat", `⚠️ Still in battle after flee wait - trying retreat commands...`); //human note, retreat is not the FLEE command it only moves you from engaged/inner/mid to a maximum of outer. it will NOT leave the battle!
    for (let i = 0; i < 3; i++) {
      ctx.log("combat", `Attempting retreat (${i + 1}/3)...`);
      const retreatResp = await bot.exec("battle", { action: "retreat" }); //human side note, you may need to be in the outer zone to enable flee though.
      await ctx.sleep(10000);

      if (retreatResp.error) {
        const errMsg = retreatResp.error.message.toLowerCase();
        if (errMsg.includes("in_battle") || errMsg.includes("in combat")) {
          ctx.log("combat", `⚠️ Retreat blocked - will retry next cycle`);
        } else {
          ctx.log("error", `Retreat failed: ${retreatResp.error.message}`);
        }
      }

      // Brief pause before next check
      await ctx.sleep(2000);

      status = await getBattleStatus(ctx);
      if (!status) {
        ctx.log("combat", `✅ Successfully disengaged after retreat`);
        return;
      }
    }
    ctx.log("warn", `⚠️ Still in battle after flee attempts - will continue checking on next tick`);
  } else {
    ctx.log("combat", `✅ Successfully disengaged from battle`);
  }
}

// ── Battle Analysis ────────────────────────────────────────────

export async function analyzeExistingBattle(
  ctx: RoutineContext,
  maxAttackTier: PirateTier,
  minPiratesToFlee: number,
): Promise<{ shouldJoin: boolean; sideId?: number; reason: string }> {
  const { bot } = ctx;
  const battleStatus = await getBattleStatus(ctx);
  if (!battleStatus) {
    return { shouldJoin: false, reason: "No active battle detected" };
  }

  ctx.log("combat", `📊 Battle detected: ${battleStatus.battle_id}`);
  ctx.log("combat", `   Sides: ${battleStatus.sides.length} | Participants: ${battleStatus.participants.length}`);

  const sides = battleStatus.sides;
  const participants = battleStatus.participants;

  interface SideAnalysis {
    sideId: number;
    playerCount: number;
    pirateCount: number;
    creatureCount: number;
    pirateTiers: string[];
    playerNames: string[];
    pirateNames: string[];
    creatureNames: string[];
  }

  const sideAnalysis: SideAnalysis[] = sides.map(side => {
    const sideParticipants = participants.filter(p => p.side_id === side.side_id);

    // Classify each participant as pirate / creature / real player.
    const pirates = sideParticipants.filter(p => {
      const username = p.username || "";
      return username.toLowerCase().includes("pirate") ||
             username.toLowerCase().includes("drifter") ||
             username.toLowerCase().includes("executioner") ||
             username.toLowerCase().includes("sentinel") ||
             username.toLowerCase().includes("prowler") ||
             username.toLowerCase().includes("apex") ||
             username.toLowerCase().includes("razor") ||
             username.toLowerCase().includes("striker") ||
             username.toLowerCase().includes("rampart") ||
             username.toLowerCase().includes("stalwart") ||
             username.toLowerCase().includes("bastion") ||
             username.toLowerCase().includes("onslaught") ||
             username.toLowerCase().includes("iron") ||
             username.toLowerCase().includes("strike");
    });

    const creatures = sideParticipants.filter(p => isCreatureName(p.username || ""));

    const players = sideParticipants.filter(p => {
      const username = p.username || "";
      // Real players: not a pirate keyword and not a known creature.
      if (isCreatureName(username)) return false;
      return !pirates.some(pir => pir === p) && !p.username?.startsWith("[POLICE]");
    });

    return {
      sideId: side.side_id,
      playerCount: players.length,
      pirateCount: pirates.length,
      creatureCount: creatures.length,
      pirateTiers: pirates.map(p => "unknown"),
      playerNames: players.map(p => p.username || p.player_id),
      pirateNames: pirates.map(p => p.username || p.player_id),
      creatureNames: creatures.map(p => p.username || p.player_id),
    };
  });

  ctx.log("combat", `   Side analysis: ${sideAnalysis.map(s =>
    `Side ${s.sideId}: ${s.playerCount} player(s) [${s.playerNames.join(",")}] vs ${s.pirateCount} pirate(s) [${s.pirateNames.join(",")}] + ${s.creatureCount} creature(s) [${s.creatureNames.join(",")}]`
  ).join(" | ")}`);

  // A "player side" is any side with real players; a "hostile side" is any side
  // with pirates OR creatures. We join a player side that is fighting a hostile
  // side (they may be on the same side, or on opposite sides — e.g. one player vs
  // one creature). This lets allied hunters pull in to help a faction member who
  // got attacked by a creature.
  const playerSides = sideAnalysis.filter(s => s.playerCount > 0);
  const hostileSides = sideAnalysis.filter(s => s.pirateCount > 0 || s.creatureCount > 0);

  if (playerSides.length === 0 || hostileSides.length === 0) {
    // If our bot (or our drones/faction) is in the battle, we are already fighting — do NOT re-engage
    const ourName = bot.username;
    const weAreInBattle = participants.some(p => p.username === ourName || (ourName && p.username?.includes(ourName.split(" ")[0])));
    if (weAreInBattle || battleStatus.is_participant) {
      const ourSide = battleStatus.your_side_id ?? sides.find(s => participants.some(p => p.side_id === s.side_id && (p.username === ourName || p.username?.includes(ourName?.split(" ")[0] || ""))))?.side_id ?? sides[0]?.side_id ?? 1;
      return { shouldJoin: true, sideId: ourSide, reason: "Already in battle — fighting" };
    }

    const allPlayers = participants.filter(p => {
      const username = p.username || "";
      if (isCreatureName(username)) return false;
      return !username.startsWith("[POLICE]") &&
             !username.toLowerCase().includes("pirate") &&
             !username.toLowerCase().includes("drifter");
    });

    if (allPlayers.length >= 2 && sides.length >= 2) {
      return { shouldJoin: false, reason: "PvP battle detected — staying out" };
    }
    return { shouldJoin: false, reason: "Hostile vs hostile battle — not engaging" };
  }

  // Join the player side to help against the hostile side.
  const sideToJoin = playerSides[0];
  const hostileSide = hostileSides[0];

  // NOTE: Combat routines (like fleet hunter) NEVER flee based on pirate count or police.
  // They ONLY flee when hull <= fleeThreshold.
  // This is intentional — they are combat bots designed to fight.

  const hostileDesc = `${hostileSide.pirateCount} pirate(s)` +
    (hostileSide.creatureCount > 0 ? ` + ${hostileSide.creatureCount} creature(s)` : "");
  return {
    shouldJoin: true,
    sideId: sideToJoin.sideId,
    reason: `Joining side ${sideToJoin.sideId} (${sideToJoin.playerCount} player(s)) vs ${hostileDesc}`,
  };
}

// ── Core Engagement ────────────────────────────────────────────

export async function engageTarget(
  ctx: RoutineContext,
  target: NearbyEntity,
  fleeThreshold: number,
  fleeFromTier: PirateTier,
  minPiratesToFlee: number,
  maxAttackTier: PirateTier,
  sideId?: number, // Optional: if provided, skip analysis and directly join this side
  skipScan: boolean = false,
  repairThreshold: number = 0,   // if >0, enables in-combat emergency repair/recharge using repairThreshold as %
  onlyNPCs: boolean = false,     // if true, flee when encountering players
  cloakOnStart: boolean = false, // if true, disable cloak before attack and re-cloak after battle
  shieldRechargePct: number = 80, // shield % to top up to in combat (e.g. 80 for 80%)
): Promise<boolean> {
  const { bot } = ctx;
  if (!target.id) return false;

  // If sideId is provided (e.g., from fleet commander), directly join that side
  if (sideId !== undefined) {
    ctx.log("combat", `🎯 Direct engage on side ${sideId} (sideId provided)`);
    const engageResp = await bot.exec("battle", { action: "engage", side_id: sideId.toString() }); //human we will need to test this as i wasn't able to get this to workj with the terminal client, but it MAY work here.
    if (engageResp.error) {
      ctx.log("error", `Failed to join battle side ${sideId}: ${engageResp.error.message}`);
      return false;
    }
    return await fightJoinedBattle(ctx, target, fleeThreshold, fleeFromTier, maxAttackTier, repairThreshold, true, 80, onlyNPCs, cloakOnStart);
  }

  const battleStatus = await getBattleStatus(ctx);
  if (battleStatus) {
    ctx.log("combat", `⚔️ Existing battle detected — analyzing...`);
    const analysis = await analyzeExistingBattle(ctx, maxAttackTier, minPiratesToFlee);
    if (!analysis.shouldJoin) {
      ctx.log("combat", `⏭️ Skipping battle: ${analysis.reason}`);
      return false;
    }

    if (analysis.reason.includes("Already in battle")) {
      ctx.log("combat", `Already participating on side ${analysis.sideId} — continuing fight`);
    } else {
      ctx.log("combat", `✅ Joining battle on side ${analysis.sideId}: ${analysis.reason}`);
      const engageResp = await bot.exec("battle", { action: "engage", side_id: analysis.sideId!.toString() });
      if (engageResp.error) {
        ctx.log("error", `Failed to join battle: ${engageResp.error.message}`);
        return false;
      }
    }

    const betterTarget = pickRealBattleTarget(battleStatus, analysis.sideId) ?? target;
    return await fightJoinedBattle(ctx, betterTarget, fleeThreshold, fleeFromTier, maxAttackTier, repairThreshold, true, 80, onlyNPCs, cloakOnStart);
  }

  ctx.log("combat", `🎯 Engaging ${target.name}...`);

  // Disable cloak before attacking if cloakOnStart is enabled
  if (cloakOnStart && bot.isCloaked) {
    ctx.log("combat", `Disabling cloak before attacking ${target.name}...`);
    const cloakResp = await bot.exec("cloak", { enable: false });
    if (cloakResp.error) {
      ctx.log("warn", `Failed to disable cloak: ${cloakResp.error.message}`);
    }
  }

  if (!skipScan) {
    let scanResp = await bot.exec("scan", { target_id: target.id });
    if (scanResp.error) {
      const errMsg = scanResp.error.message.toLowerCase();
      if (errMsg.includes("in_battle") || errMsg.includes("in combat")) {
        ctx.log("combat", `Scan skipped - already in battle with ${target.name}`);
      } else if (errMsg.includes("invalid_target")) {
        ctx.log("combat", `Scan with pirate_id failed - trying name instead...`);
        scanResp = await bot.exec("scan", { target_id: target.name });
      }
    }

    if (!scanResp.error && scanResp.result) {
      const s = scanResp.result as Record<string, unknown>;
      const shipType = (s.ship_type as string) || (s.ship as string) || "unknown";
      const faction = (s.faction as string) || target.faction || "unknown";
      ctx.log("combat", `   Scan: ${target.name} — ${shipType} | Faction: ${faction}`);
    }
  }

  let attackResp = await bot.exec("attack", { target_id: target.id });
  if (attackResp.error) {
    const msg = attackResp.error.message.toLowerCase();
    if (msg.includes("not found") || msg.includes("invalid") || msg.includes("not in")) {
      ctx.log("combat", `Attack with pirate_id failed - trying name "${target.name}" instead...`);
      attackResp = await bot.exec("attack", { target_id: target.name });
    }
  }

  if (attackResp.error) {
    const msg = attackResp.error.message.toLowerCase();
    if (msg.includes("not found") || msg.includes("invalid") ||
        msg.includes("no target") || msg.includes("already") || msg.includes("not in")) {
      ctx.log("combat", `${target.name} is no longer available or already fighting`);
      return false;
    }
    ctx.log("error", `Attack failed on ${target.name}: ${attackResp.error.message}`);

    // If the attack was interrupted by combat (or we are now in a battle), jump straight into battle handling
    const battleStatus = await getBattleStatus(ctx);
    if (battleStatus) {
      ctx.log("combat", `⚔️ Attack interrupted by combat — entering battle immediately`);
      const analysis = await analyzeExistingBattle(ctx, maxAttackTier, 3);
      if (analysis.shouldJoin) {
        // Prefer a real participant from the battle we just detected.
        // This is the key fix for "boss jumped us while we were attacking something else".
        const betterTarget = pickRealBattleTarget(battleStatus, analysis.sideId) ?? target;
        return await fightJoinedBattle(ctx, betterTarget, fleeThreshold, fleeFromTier, maxAttackTier, repairThreshold, true, 80, onlyNPCs, cloakOnStart);
      }
    }
    return false;
  }

  ctx.log("combat", `⚔️ Battle started with ${target.name} — advancing to engage`);
  return await fightFreshBattle(ctx, target, fleeThreshold, fleeFromTier, maxAttackTier, repairThreshold, cloakOnStart, shieldRechargePct);
}

// ── Combat Loops ──────────────────────────────────────────────

/** Re-cloak after battle if cloakOnStart is enabled and bot has a cloak module. */
export async function recloakAfterBattle(ctx: RoutineContext, cloakOnStart: boolean): Promise<void> {
  const { bot } = ctx;
  if (!cloakOnStart) return;
  if (bot.isCloaked) return;
  
  const resp = await bot.exec("cloak", { enable: true });
  if (!resp.error) {
    ctx.log("combat", "Re-cloaked after battle victory");
  } else {
    const msg = resp.error.message.toLowerCase();
    if (!msg.includes("already cloaked") && !msg.includes("already_cloaked")) {
      ctx.log("warn", `Failed to re-cloak after battle: ${resp.error.message}`);
    }
  }
}

export async function fightFreshBattle(
  ctx: RoutineContext,
  target: NearbyEntity,
  fleeThreshold: number,
  fleeFromTier: PirateTier,
  maxAttackTier: PirateTier,
  repairThreshold: number = 0,
  cloakOnStart: boolean = false,
  shieldRechargePct: number = 80,
): Promise<boolean> {
  const { bot } = ctx;
  const MAX_BATTLE_TICKS = 60;
  let tickCount = 0;
  let lastHull = bot.hull;
  const zoneDirMap: Record<string, number> = { outer: 0, mid: 1, inner: 2, engaged: 3 };

  ctx.log("combat", `🎯 Fighting fresh battle against ${target.name}...`);

  // A battle may already be active by the time we get here: engageTarget already
  // issued the attack, or the server pulled us in (COMBAT WARNING). Re-issuing the
  // attack command is redundant AND, under the newer server combat code, can hang /
  // time out for ~60s while we sit idle in the outer ring. If we're already in a
  // battle, skip the scan and attack and go straight into the combat loop (advance/engage).
  const preAttackStatus = await getBattleStatus(ctx);
  let battleActive = !!preAttackStatus;
  let attackErrMsg: string | null = null;

  // Only scan and attack if we're not already in a battle
  if (!battleActive) {
    // Initial setup - scan and attack
    let scanResp = await bot.exec("scan", { target_id: target.id });
    if (scanResp.error) {
      const errMsg = scanResp.error.message.toLowerCase();
      if (errMsg.includes("in_battle") || errMsg.includes("in combat")) {
        ctx.log("combat", `⚔️ Scan revealed battle already active with ${target.name} — entering combat loop directly`);
        battleActive = true;
      } else if (errMsg.includes("invalid_target")) {
        ctx.log("combat", `Scan with pirate_id failed - trying name instead...`);
        scanResp = await bot.exec("scan", { target_id: target.name });
      }
    }

    if (!scanResp.error && scanResp.result) {
      const s = scanResp.result as Record<string, unknown>;
      const shipType = (s.ship_type as string) || (s.ship as string) || "unknown";
      const faction = (s.faction as string) || target.faction || "unknown";
      ctx.log("combat", `   Scan: ${target.name} — ${shipType} | Faction: ${faction}`);
    }

    if (!battleActive) {
      const atk = await bot.exec("attack", { target_id: target.id });
      if (atk.error) {
        const msg = atk.error.message.toLowerCase();
        if (msg.includes("not found") || msg.includes("invalid") || msg.includes("not in")) {
          ctx.log("combat", `${target.name} is no longer available`);
          return false;
        }
        attackErrMsg = atk.error.message;
      } else {
        battleActive = true;
      }
    }
  }

  if (!battleActive) {
    ctx.log("error", `Attack failed on ${target.name}: ${attackErrMsg ?? "unknown error"}`);
    return false;
  }

  if (attackErrMsg) {
    // The attack command errored/timed out, but a live battle exists — don't bail.
    // Enter the combat loop so we can advance and close the distance.
    ctx.log("combat", `⚠️ Attack command errored ("${attackErrMsg}") but battle ${preAttackStatus?.battle_id} is active — entering combat loop to advance/engage`);
  } else if (preAttackStatus) {
    ctx.log("combat", `⚔️ Battle already active with ${target.name} — closing to engaged`);
  } else {
    ctx.log("combat", `⚔️ Battle started with ${target.name} — closing to engaged`);
  }
  await ctx.sleep(10000);

  // Ensure we're at engaged zone before entering combat loop
  // (especially important when battle was already active and no advance was done)
  const zoneOrder: Record<string, number> = { outer: 0, mid: 1, inner: 2, engaged: 3 };
  let ourZone = "outer";
  for (let attempt = 0; attempt < 3; attempt++) {
    const initStatus = await getBattleStatus(ctx);
    if (!initStatus) {
      ctx.log("combat", `✅ Battle ended during setup — ${target.name} eliminated!`);
      await recloakAfterBattle(ctx, cloakOnStart);
      return true;
    }
    ourZone = initStatus.your_zone || "outer";
    if (ourZone === "engaged") {
      ctx.log("combat", `✅ Already at engaged zone`);
      break;
    }
    const ourZoneNum = zoneOrder[ourZone] ?? 0;
    const targetZoneNum = zoneOrder["engaged"];
    if (ourZoneNum < targetZoneNum) {
      ctx.log("combat", `↩️ Advancing from ${ourZone} to ${Object.keys(zoneOrder).find(k => zoneOrder[k] === ourZoneNum + 1) || "engaged"}...`);
      const advResp = await bot.exec("battle", { action: "advance" });
      if (advResp.error) {
        const msg = advResp.error.message.toLowerCase();
        if (msg.includes("no active battle") || msg.includes("not in battle")) {
          // Bot not registered as engaged - need to attack target first
          ctx.log("combat", `⚠️ Advance failed - not registered as engaged, attacking ${target.name}...`);
          await attackTarget(ctx, target);
          await ctx.sleep(2000);
          // Check if battle ended after attack
          const postAttackStatus = await getBattleStatus(ctx);
          if (!postAttackStatus) {
            ctx.log("combat", `✅ Battle ended after re-engaging - ${target.name} eliminated!`);
            await checkAndPraiseMorgThar(ctx, true);
            await recloakAfterBattle(ctx, cloakOnStart);
            return true;
          }
          // Continue to next advance attempt
          continue;
        }
        ctx.log("combat", `⚠️ Advance note: ${advResp.error.message}`);
      }
      await ctx.sleep(5000);
    } else {
      break;
    }
  }

  // Get initial battle status
  let status = await getBattleStatus(ctx);
  if (!status) {
    ctx.log("combat", `✅ Battle ended during setup — ${target.name} eliminated!`);
    await recloakAfterBattle(ctx, cloakOnStart);
    return true;
  }

  let ourCurrentZone = status.your_zone || "outer";
  let lastKnownEnemyZone = "outer";

  while (true) {
    if (bot.state !== "running") return false;
    tickCount++;

    if (tickCount > MAX_BATTLE_TICKS) {
      ctx.log("combat", `⚠️ Battle timeout after ${MAX_BATTLE_TICKS} ticks — assuming victory or server issue`);
      await checkAndPraiseMorgThar(ctx, true);
      await recloakAfterBattle(ctx, cloakOnStart);
      return true;
    }

    status = await getBattleStatus(ctx);
    if (!status) {
      ctx.log("combat", `✅ ${target.name} eliminated — battle complete (${tickCount} ticks, victory!)`);
      await checkAndPraiseMorgThar(ctx, true);
      await recloakAfterBattle(ctx, cloakOnStart);
      return true;
    }

    let targetParticipant = status.participants.find(
      p => p.player_id === target.id || p.username === target.name
    );

    if (targetParticipant && targetParticipant.is_destroyed) {
      ctx.log("combat", `⚠️ ${target.name} marked destroyed but battle still active — finding new target...`);
      const better = pickRealBattleTarget(status, status.your_side_id);
      if (better) {
        ctx.log("combat", `🎯 Switching to ${better.name} (previous target destroyed)`);
        target = better;
        await bot.exec("battle", { action: "target", target_id: better.id });
        await ctx.sleep(300);
      } else {
        const nearbyEnemy = await acquireEnemyFromNearby(ctx, target.name, maxAttackTier, true);
        if (nearbyEnemy) {
          ctx.log("combat", `🎯 Re-acquired ${nearbyEnemy.name} from nearby scan after target destroyed`);
          target = nearbyEnemy;
          const attackOk = await attackTarget(ctx, target);
          if (!attackOk) {
            const afterAttack = await getBattleStatus(ctx);
            if (!afterAttack) {
              ctx.log("combat", `✅ Battle ended after destroyed target — victory!`);
              await checkAndPraiseMorgThar(ctx, true);
              await recloakAfterBattle(ctx, cloakOnStart);
              return true;
            }
            ctx.log("combat", `⚠️ Re-engagement failed after destroyed target — exiting combat loop`);
            return false;
          }
          await bot.exec("battle", { action: "target", target_id: target.id });
          await ctx.sleep(300);
        } else {
          ctx.log("combat", `✅ No valid targets remaining — battle complete (${tickCount} ticks, victory!)`);
          await checkAndPraiseMorgThar(ctx, true);
          await recloakAfterBattle(ctx, cloakOnStart);
          return true;
        }
      }
      continue;
    }

    if (!targetParticipant && target) {
      const better = pickRealBattleTarget(status, status.your_side_id);
      if (better && better.name !== target.name) {
        ctx.log("combat", `🎯 Switching target to ${better.name} (previous target left the battle)`);
        target = better;
        await bot.exec("battle", { action: "target", target_id: better.id });
        await ctx.sleep(300);
      } else if (!better) {
        // Newer server combat code omits the enemy from participants, so pickRealBattleTarget
        // is almost always null. Re-acquire the attacker from the nearby scan and keep
        // fighting instead of falsely declaring victory while we're still being shot.
        const nearbyEnemy = await acquireEnemyFromNearby(ctx, target.name, maxAttackTier, true);
        if (nearbyEnemy) {
          ctx.log("combat", `🎯 Re-acquired live enemy ${nearbyEnemy.name} from nearby scan — engaging`);
          target = nearbyEnemy;
          const attackOk = await attackTarget(ctx, target);
          if (!attackOk) {
            const afterAttack = await getBattleStatus(ctx);
            if (!afterAttack) {
              ctx.log("combat", `✅ Battle ended after failed re-engagement — victory!`);
              await checkAndPraiseMorgThar(ctx, true);
              await recloakAfterBattle(ctx, cloakOnStart);
              return true;
            }
            ctx.log("combat", `⚠️ Re-engagement failed but battle still active — exiting combat loop`);
            return false;
          }
          await bot.exec("battle", { action: "target", target_id: target.id });
          await ctx.sleep(300);
          targetParticipant = undefined as any;
        } else {
          ctx.log("combat", `✅ No valid targets remaining — battle complete (${tickCount} ticks, victory!)`);
          await checkAndPraiseMorgThar(ctx, true);
          await recloakAfterBattle(ctx, cloakOnStart);
          return true;
        }
      }
    }

    await bot.refreshShip();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    const shieldPct = bot.maxShield > 0 ? Math.round((bot.shield / bot.maxShield) * 100) : 100;
    const damageThisTick = Math.max(0, lastHull - bot.hull);
    lastHull = bot.hull;

    // In-combat emergency field repair / shield top-up (hunter style)
    if (repairThreshold > 0) {
      let didAction = false;
      if (hullPct <= repairThreshold) {
        ctx.log("combat", `🛠️ Hull ${hullPct}% ≤ repairThreshold — using repair kits in combat!`);
        if (await useRepairKits(ctx)) didAction = true;
      }
      if (shieldPct <= repairThreshold) {
        ctx.log("combat", `🛡️ Shields ${shieldPct}% ≤ repairThreshold — topping up shields in combat!`);
        if (await topUpShields(ctx, shieldRechargePct / 100)) didAction = true;
      }
      if (didAction) {
        await ctx.sleep(10000);
        continue;
      }
    }

    const enemyStance = targetParticipant?.stance || "unknown";
    const enemyZone = targetParticipant?.zone || "unknown";

    // Enemy isn't in the participants roster (newer server combat code). We still know
    // who we're fighting via `target` (re-acquired from the nearby scan), so keep
    // attacking, hold fire stance, and close to engaged range.
    if (!targetParticipant && target) {
      ctx.log("combat", `Tick ${tickCount}: Enemy not in roster — keeping ${target.name} targeted/engaged | Hull=${hullPct}% | Shields=${shieldPct}% | Dmg=${damageThisTick}`);
      await attackTarget(ctx, target);
      await bot.exec("battle", { action: "target", target_id: target.id });

      // Refresh status to get current zone after targeting
      const currentStatus = await getBattleStatus(ctx);
      if (!currentStatus) {
        ctx.log("combat", `✅ Battle ended during enemy tracking - ${target.name} eliminated!`);
        await checkAndPraiseMorgThar(ctx, true);
        await recloakAfterBattle(ctx, cloakOnStart);
        return true;
      }
      
      const ourZoneNow = currentStatus.your_zone || "outer";
      if (ourZoneNow !== "engaged") {
        ctx.log("combat", `↩️ Advancing from ${ourZoneNow} to engaged (enemy not in roster)`);
        const adv = await bot.exec("battle", { action: "advance" });
        if (adv.error) {
          const errMsg = adv.error.message.toLowerCase();
          if (errMsg.includes("not in battle") || errMsg.includes("no active battle")) {
            // Bot not registered as engaged - re-acquire enemy and attack
            ctx.log("combat", `⚠️ Advance failed - not registered as engaged, re-acquiring enemy...`);
            const nearbyEnemy = await acquireEnemyFromNearby(ctx, target.name, maxAttackTier, true);
            if (nearbyEnemy) {
              ctx.log("combat", `🎯 Re-acquired live enemy ${nearbyEnemy.name} - attacking...`);
              target = nearbyEnemy;
              const attackOk = await attackTarget(ctx, target);
              if (!attackOk) {
                const afterAttack = await getBattleStatus(ctx);
                if (!afterAttack) {
                  ctx.log("combat", `✅ Battle ended after failed re-engagement — victory!`);
                  await checkAndPraiseMorgThar(ctx, true);
                  await recloakAfterBattle(ctx, cloakOnStart);
                  return true;
                }
                ctx.log("combat", `⚠️ Re-engagement failed but battle still active — exiting combat loop`);
                return false;
              }
              await bot.exec("battle", { action: "target", target_id: target.id });
              await ctx.sleep(2000);
            } else {
              ctx.log("combat", `✅ Battle ended - no enemy found for re-engagement`);
              await checkAndPraiseMorgThar(ctx, true);
              await recloakAfterBattle(ctx, cloakOnStart);
              return true;
            }
          } else {
            // Log other advance errors but continue trying
            ctx.log("combat", `⚠️ Advance note: ${adv.error.message}`);
          }
        }
        // Give server time to process advance, then check zone
        await ctx.sleep(5000);
        const postAdvStatus = await getBattleStatus(ctx);
        if (!postAdvStatus) {
          ctx.log("combat", `✅ Battle ended after advance - ${target.name} eliminated!`);
          await checkAndPraiseMorgThar(ctx, true);
          await recloakAfterBattle(ctx, cloakOnStart);
          return true;
        }
        // If still not at engaged, we need multiple advances - log and continue
        if (postAdvStatus.your_zone !== "engaged") {
          ctx.log("combat", `Still at ${postAdvStatus.your_zone} after advance - will try again next tick`);
        }
      } else {
        ctx.log("combat", `✅ Already at engaged zone - battle should be progressing`);
      }
      await ctx.sleep(5000);
      continue;
    }

    ctx.log("combat", `Tick ${tickCount}: Enemy=${enemyStance}/${enemyZone} | Hull=${hullPct}% | Shields=${shieldPct}% | Dmg=${damageThisTick}`);

    const enemyZoneNum = zoneDirMap[enemyZone] ?? 0;
    ourCurrentZone = status.your_zone || ourCurrentZone;
    const ourZoneNum = zoneDirMap[ourCurrentZone] ?? 0;

    if (targetParticipant && targetParticipant.zone) {
      if (targetParticipant.zone !== lastKnownEnemyZone) {
        const prevDir = zoneDirMap[lastKnownEnemyZone] ?? 0;
        const newDir = zoneDirMap[targetParticipant.zone] ?? 0;
        if (newDir > prevDir) {
          ctx.log("combat", `⚠️ ${target.name} advancing: ${lastKnownEnemyZone} → ${targetParticipant.zone}`);
        } else if (newDir < prevDir) {
          ctx.log("combat", `${target.name} retreating: ${lastKnownEnemyZone} → ${targetParticipant.zone}`);
        }
        lastKnownEnemyZone = targetParticipant.zone;
      }
    }

    if (hullPct <= fleeThreshold) {
      ctx.log("combat", `💀 Hull critical (${hullPct}%) — FLEEING!`);
      await emergencyFleeSpam(ctx, "hull critical during combat");
      return false;
    }

    // Stay within 1 zone of enemy to maintain firing range
    const zoneDiff = ourZoneNum - enemyZoneNum;
    
    // Always advance if we're not at engaged zone (especially when enemy zone is unknown/outer)
    if (ourCurrentZone !== "engaged") {
      if (zoneDiff > 1) {
        ctx.log("combat", `↩️ Retreating from ${ourCurrentZone} to match enemy at ${enemyZone}`);
        const retResp = await bot.exec("battle", { action: "retreat" });
        if (retResp.error) {
          const errMsg = retResp.error.message.toLowerCase();
          if (errMsg.includes("no active battle") || errMsg.includes("not in battle")) {
            ctx.log("combat", `✅ Battle ended (retreat failed: not in battle) - victory!`);
            return true;
          }
          ctx.log("error", `Retreat failed: ${retResp.error.message}`);
        }
        await ctx.sleep(10000);
      } else {
        ctx.log("combat", `⚔️ Advancing from ${ourCurrentZone} to engaged (zoneDiff=${zoneDiff}, enemyZone=${enemyZone})`);
        const advResp = await bot.exec("battle", { action: "advance" });
        if (advResp.error) {
          const errMsg = advResp.error.message.toLowerCase();
          if (errMsg.includes("no active battle") || errMsg.includes("not in battle")) {
            ctx.log("combat", `✅ Battle ended (advance failed: not in battle) - victory!`);
            return true;
          }
          ctx.log("error", `Advance failed: ${advResp.error.message}`);
        }
        await ctx.sleep(10000);
      }
    } else if (zoneDiff > 1) {
      ctx.log("combat", `↩️ Retreating from ${ourCurrentZone} to match enemy at ${enemyZone}`);
      const retResp = await bot.exec("battle", { action: "retreat" });
      if (retResp.error) {
        const errMsg = retResp.error.message.toLowerCase();
        if (errMsg.includes("no active battle") || errMsg.includes("not in battle")) {
          ctx.log("combat", `✅ Battle ended (retreat failed: not in battle) - victory!`);
          return true;
        }
        ctx.log("error", `Retreat failed: ${retResp.error.message}`);
      }
      await ctx.sleep(10000);
    } else if (zoneDiff < -1) {
      ctx.log("combat", `⚔️ Advancing from ${ourCurrentZone} to match enemy at ${enemyZone}`);
      const advResp = await bot.exec("battle", { action: "advance" });
      if (advResp.error) {
        const errMsg = advResp.error.message.toLowerCase();
        if (errMsg.includes("no active battle") || errMsg.includes("not in battle")) {
          ctx.log("combat", `✅ Battle ended (advance failed: not in battle) - victory!`);
          return true;
        }
        ctx.log("error", `Advance failed: ${advResp.error.message}`);
      }
      await ctx.sleep(10000);
    } else {
      await ctx.sleep(10000);
    }
  }
}

const PLAYER_KEYWORDS = ["pirate", "drifter", "raider", "outlaw", "bandit", "corsair", "marauder", "hostile", "executioner", "sentinel", "prowler", "apex", "razor", "striker", "rampart", "stalwart", "bastion", "onslaught", "iron", "strike"];

/**
 * Like isPlayerParticipant, but also probes the live get_nearby to disambiguate
 * a "player-looking" battle participant that is actually a creature or pirate we
 * should be fighting (e.g. a creature that attacked us from outside scan range and
 * isn't yet in the wildlife store). Returns true only for genuine human/player foes.
 */
async function isGenuinePlayer(ctx: RoutineContext, name: string | undefined): Promise<boolean> {
  if (!name) return false;
  // Fast local checks first.
  if (isCreatureName(name)) return false;
  const lower = name.toLowerCase();
  if (PLAYER_KEYWORDS.some(kw => lower.includes(kw))) return false; // pirate keyword
  // Fall back to the live nearby scan to see if this name is a creature/pirate.
  try {
    const resp = await ctx.bot.exec("get_nearby");
    if (!resp.error && resp.result) {
      const entities = parseNearby(resp.result);
      const match = entities.find(e =>
        e.name === name || e.name.toLowerCase() === lower || e.name.toLowerCase().includes(lower)
      );
      if (match) {
        if (isCreatureTarget(match, true)) return false;       // creature -> not a player
        if (isPirateTarget(match, false, "boss")) return false; // pirate -> not a player
      }
    }
  } catch {
    /* non-fatal — fall through to treating as a player */
  }
  return true;
}

/** Pick a real enemy participant from the current battle (opposite side of ourSideId).
 *  Prefers boss-like names when present. Returns null if no valid enemy is listed yet. */
function pickRealBattleTarget(
  status: BattleStatus | null | undefined,
  ourSideId?: number,
): NearbyEntity | null {
  if (!status?.participants || status.participants.length === 0) return null;
  
  // Validate ourSideId - must be a valid number from the sides present
  const validSides = status.sides?.map(s => s.side_id) || [];
  const ourSide = (ourSideId !== undefined && validSides.includes(ourSideId)) 
    ? ourSideId 
    : status.your_side_id;
  
  // If we still don't have a valid side, we can't determine enemies
  if (ourSide === undefined || ourSide === null) return null;
  
  const enemies = status.participants.filter(p =>
    p.side_id !== ourSide &&
    !p.is_destroyed &&
    (p.player_id || p.username)
  );
  if (enemies.length === 0) return null;

  // Prefer serious threats / bosses by name (covers Overlord, Grand Marshal, etc.)
  const bossish = enemies.find(p => {
    const name = (p.username || p.player_id || "").toLowerCase();
    return /overlord|grand marshal|warlord|admiral|nyx|korr|boss|alpha|omega|prime|executioner|sentinel|apex|razor|striker/.test(name);
  });
  const chosen = bossish || enemies[0];

  return {
    id: chosen.player_id || chosen.username || "",
    name: chosen.username || chosen.player_id || "enemy",
  } as NearbyEntity;
}

/**
 * Re-acquire a live enemy from get_nearby.
 *
 * NOTE: The newer server combat code OMITS the attacking enemy from
 * get_battle_status().participants — every battle reports only our own bot as a
 * participant. We therefore can't trust the battle roster to tell us who is shooting
 * us. get_nearby still lists pirate (and optionally creature) targets, so we fall back
 * to it. `preferName` biases the pick toward the known attacker (e.g. from a COMBAT
 * WARNING) when several pirates are visible.
 */
async function acquireEnemyFromNearby(
  ctx: RoutineContext,
  preferName?: string,
  maxAttackTier: PirateTier = "large",
  onlyNPCs = true,
  huntCreatures = false,
): Promise<NearbyEntity | null> {
  const { bot } = ctx;
  const resp = await bot.exec("get_nearby");
  if (resp.error || !resp.result) return null;
  const entities = parseNearby(resp.result);
  const pirates = entities.filter(e => isPirateTarget(e, onlyNPCs, maxAttackTier));
  if (pirates.length > 0) {
    if (preferName) {
      const hit = pirates.find(p =>
        p.name === preferName || p.name.toLowerCase().includes(preferName.toLowerCase())
      );
      if (hit) return hit;
    }
    return pirates[0];
  }
  // Re-acquire creatures too. This is both for huntCreatures mode AND for
  // self-defense: a creature that pulls us into battle must be fought back even
  // if huntCreatures is disabled (a creature is not a player).
  const creatures = entities.filter(e => isCreatureTarget(e, true));
  if (creatures.length > 0) {
    if (preferName && isCreatureName(preferName)) {
      const hit = creatures.find(c =>
        c.name === preferName || c.name.toLowerCase().includes(preferName.toLowerCase())
      );
      if (hit) return hit;
    }
    if (huntCreatures || (preferName && isCreatureName(preferName))) {
      return creatures[0];
    }
  }
  return null;
}

/** Issue attack on a target, falling back to the name if the id is rejected. */
async function attackTarget(ctx: RoutineContext, target: NearbyEntity): Promise<boolean> {
  const { bot } = ctx;
  let resp = await bot.exec("attack", { target_id: target.id });
  if (resp.error) {
    const msg = resp.error.message.toLowerCase();
    if (msg.includes("not found") || msg.includes("invalid") || msg.includes("not in") || msg.includes("at your location")) {
      ctx.log("combat", `Attack with id failed for ${target.name} — trying name...`);
      resp = await bot.exec("attack", { target_id: target.name });
    }
  }
  if (resp.error) {
    // "already in a battle" / "already engaged" are fine — it just means we're in.
    if (!/already/.test(resp.error.message.toLowerCase())) {
      ctx.log("combat", `Attack on ${target.name} failed: ${resp.error.message}`);
    }
    return false;
  }
  return true;
}

const MORG_THAR_NAME = "Morg'Thar";

/**
 * Check if we just battled alongside Morg'Thar and send a Klingon praise message.
 * This is called after a battle ends successfully.
 */
export async function checkAndPraiseMorgThar(
  ctx: RoutineContext,
  battleJustEnded: boolean,
): Promise<void> {
  if (!battleJustEnded) return;

  const { bot } = ctx;
  const aiChatService = (globalThis as any).aiChatService;
  if (!aiChatService || typeof aiChatService.translateToKlingon !== "function") {
    ctx.log("combat", "AI Chat service not available for Morg'Thar praise");
    return;
  }

  const battleStatus = await getBattleStatus(ctx);
  if (!battleStatus) return;

  const wasWithMorgThar = battleStatus.participants.some(p => 
    p.username?.toLowerCase() === MORG_THAR_NAME.toLowerCase() ||
    p.player_id?.toLowerCase() === MORG_THAR_NAME.toLowerCase()
  );

  if (!wasWithMorgThar) {
    ctx.log("combat", "Did not fight alongside Morg'Thar this battle");
    return;
  }

  const ourPlayerName = bot.username;
  const praiseMessage = `${ourPlayerName} and I have defeated our enemies together. A victory worthy of the Empire!`;

  ctx.log("combat", `Translating praise for Morg'Thar to Klingon...`);
  const translation = await aiChatService.translateToKlingon(
    praiseMessage,
    "battle",
    ourPlayerName
  );

  if (!translation.ok) {
    ctx.log("combat", `Klingon translation failed: ${translation.error}`);
    return;
  }

  const klingonMessage = translation.message || praiseMessage;
  ctx.log("combat", `Sending Klingon praise to system chat: ${klingonMessage}`);

  const chatResp = await bot.exec("chat", {
    channel: "system",
    content: klingonMessage,
  });

  if (chatResp.error) {
    ctx.log("error", `Failed to send Klingon praise: ${chatResp.error.message}`);
  }
}

export async function fightJoinedBattle(
  ctx: RoutineContext,
  target: NearbyEntity | null,
  fleeThreshold: number,
  fleeFromTier: PirateTier,
  maxAttackTier: PirateTier,
  repairThreshold: number = 0,
  canFlee: boolean = true,
  shieldRechargePct: number = 80,
  onlyNPCs: boolean = false,
  cloakOnStart: boolean = false,
): Promise<boolean> {
  const { bot } = ctx;
  const MAX_BATTLE_TICKS = 60;

  let currentTarget = target;

  // If the caller passed a stale or unrelated target (common after attack timeout
  // when a boss jumped us), pick a real participant from the actual battle.
  let status = await getBattleStatus(ctx);
  if (status) {
    const isValid = currentTarget && status.participants.some(
      p => p.player_id === currentTarget!.id || p.username === currentTarget!.name
    );
    if (!isValid) {
      const better = pickRealBattleTarget(status, status.your_side_id);
      if (better) {
        ctx.log("combat", `Original target ${currentTarget?.name ?? "none"} not in this battle — auto-targeting real enemy ${better.name}`);
        currentTarget = better;
      }
    }
  }

  // When joining an EXISTING battle (the only path into fightJoinedBattle — fresh
  // battles go through fightFreshBattle), the caller's target is often a synthetic
  // `fakeTarget` built from the battle roster. For creatures the roster's id is NOT
  // the id the `attack` command accepts (only get_nearby's `creature_id` is), so
  // attacking with it silently fails: the bot ends up "in" the battle but never
  // registered as engaged, the server never auto-fires, and the hunter just sits in
  // the outer ring and dies (most visible after a client restart mid-battle).
  // Always re-acquire the real enemy from get_nearby — preferName keeps the correct
  // target, and we only switch when a matching live entity is actually visible.
  const nearbyEnemy = await acquireEnemyFromNearby(ctx, currentTarget?.name, maxAttackTier, onlyNPCs);
  if (nearbyEnemy) {
    ctx.log("combat", `Re-acquired enemy from nearby scan: ${nearbyEnemy.name} (id ${nearbyEnemy.id})`);
    currentTarget = nearbyEnemy;
  }

  ctx.log("combat", `🎯 Fighting in joined battle${currentTarget ? ` — targeting ${currentTarget.name}` : ''}`);

  // Actually engage the enemy with the attack command. The server requires an active
  // attack to register us as "in" the battle for `battle` advance/stance commands —
  // otherwise advance fails with "You are not in a battle. Use attack to engage...".
  // IMPORTANT: if we are ALREADY a battle participant (e.g. a stale battle rejoined
  // after a restart), the `attack` command HANGS for ~180s and then the server still
  // rejects `advance`. In that case we must only (re)target and let the caller have
  // already fled+re-engaged. So never issue `attack` when already a participant.
  if (currentTarget) {
    if (status?.is_participant) {
      await bot.exec("battle", { action: "target", target_id: currentTarget.id });
    } else {
      await attackTarget(ctx, currentTarget);
      await bot.exec("battle", { action: "target", target_id: currentTarget.id });
    }
  }
  await ctx.sleep(10000);

  // Ensure we're at engaged zone before entering combat loop
  const postSetupStatus = await getBattleStatus(ctx);
  let ourZone = postSetupStatus?.your_zone || "outer";
  if (ourZone !== "engaged") {
    ctx.log("combat", `Current zone: ${ourZone} — advancing to engaged...`);
    const zoneOrder: Record<string, number> = { outer: 0, mid: 1, inner: 2, engaged: 3 };
    const ourZoneNum = zoneOrder[ourZone] ?? 0;
    const targetZoneNum = zoneOrder["engaged"];
    for (let z = ourZoneNum + 1; z <= targetZoneNum; z++) {
      const zoneName = Object.keys(zoneOrder).find(k => zoneOrder[k] === z) || "engaged";
      ctx.log("combat", `Advancing to ${zoneName}...`);
      const advResp = await bot.exec("battle", { action: "advance" });
      if (advResp.error) {
        const msg = advResp.error.message.toLowerCase();
        if (msg.includes("no active battle") || msg.includes("not in battle")) {
          // Bot not registered as engaged - need to ensure we're attacking the target
          if (currentTarget) {
            ctx.log("combat", `⚠️ Advance failed - not registered as engaged, ensuring attack on ${currentTarget.name}...`);
            // Never re-issue `attack` if we're already a participant — it hangs.
            if (status?.is_participant) {
              await bot.exec("battle", { action: "target", target_id: currentTarget.id });
            } else {
              await attackTarget(ctx, currentTarget);
              await bot.exec("battle", { action: "target", target_id: currentTarget.id });
            }
            await ctx.sleep(5000);
            // Check if battle is still active
            const afterAttackStatus = await getBattleStatus(ctx);
            if (!afterAttackStatus) {
              ctx.log("combat", `✅ Battle ended after re-engaging - victory!`);
              await checkAndPraiseMorgThar(ctx, true);
              return true;
            }
            // If still in battle, re-check zone and try advance again
            const recheckZone = afterAttackStatus.your_zone || "outer";
            if (recheckZone === "engaged") {
              ctx.log("combat", `✅ Now at engaged zone after re-engaging`);
              break;
            }
            // Continue to next advance attempt
            continue;
          }
          ctx.log("combat", `✅ Battle ended (advance failed: not in battle, no target) - victory!`);
          await checkAndPraiseMorgThar(ctx, true);
          return true;
        }
        ctx.log("error", `Advance to ${zoneName} failed: ${advResp.error.message}`);
      }
      await ctx.sleep(10000);
    }
  }

  let lastKnownEnemyZone = "outer";
  let tickCount = 0;

  while (true) {
    if (bot.state !== "running") return false;
    tickCount++;

    if (tickCount > MAX_BATTLE_TICKS) {
      ctx.log("combat", `⚠️ Battle timeout after ${MAX_BATTLE_TICKS} ticks — assuming victory or server issue`);
      await checkAndPraiseMorgThar(ctx, true);
      await recloakAfterBattle(ctx, cloakOnStart);
      return true;
    }

    const status = await getBattleStatus(ctx);
    if (!status) {
      ctx.log("combat", `✅ Battle complete — victory! (${tickCount} ticks)`);
      await checkAndPraiseMorgThar(ctx, true);
      await recloakAfterBattle(ctx, cloakOnStart);
      return true;
    }

    // If our current target is no longer in the battle (destroyed, fled, or was wrong to begin with),
    // pick a fresh real enemy from the actual participants. This fixes the "targeting Frazzlebite
    // while Overlord Nyx is the one hitting us" case after an attack timeout.
    let targetParticipant = status.participants.find(
      p => currentTarget && (p.player_id === currentTarget.id || p.username === currentTarget.name)
    );

    if (!targetParticipant) {
      const better = pickRealBattleTarget(status, status.your_side_id);
      if (better && (!currentTarget || better.id !== currentTarget.id)) {
        ctx.log("combat", `🎯 Switching target to ${better.name} (previous target invalid or left the battle)`);
        currentTarget = better;
        await bot.exec("battle", { action: "target", target_id: better.id });
        // Small delay so the target command registers before the next stance/tick logic
        await ctx.sleep(300);
        targetParticipant = status.participants.find(
          p => p.player_id === better.id || p.username === better.name
        );
        // Check if new target is a real player (not a creature/pirate) and we should flee
        if (onlyNPCs && targetParticipant && await isGenuinePlayer(ctx, targetParticipant.username)) {
          ctx.log("combat", `🚨 ${currentTarget?.name ?? "Enemy"} is a PLAYER — fleeing (onlyNPCs=true)!`);
          await emergencyFleeSpam(ctx, `target switched to player`);
          return false;
        }
      } else if (!better) {
        // Newer server combat code omits enemies from participants, so pickRealBattleTarget
        // is almost always null. Re-acquire the attacker from the nearby scan and actually
        // attack it instead of falsely declaring victory while we're still being shot.
        const nearbyEnemy = await acquireEnemyFromNearby(ctx, currentTarget?.name, maxAttackTier, onlyNPCs);
        if (nearbyEnemy) {
          ctx.log("combat", `🎯 Re-acquired live enemy ${nearbyEnemy.name} from nearby scan — engaging`);
          currentTarget = nearbyEnemy;
          const attackOk = await attackTarget(ctx, currentTarget);
          if (!attackOk) {
            const afterAttack = await getBattleStatus(ctx);
            if (!afterAttack) {
              ctx.log("combat", `✅ Battle ended after failed re-engagement — victory!`);
              await checkAndPraiseMorgThar(ctx, true);
              await recloakAfterBattle(ctx, cloakOnStart);
              return true;
            }
            ctx.log("combat", `⚠️ Re-engagement failed but battle still active — exiting combat loop`);
            return false;
          }
          await bot.exec("battle", { action: "target", target_id: currentTarget.id });
          await ctx.sleep(300);
          targetParticipant = undefined;
        } else {
        ctx.log("combat", `✅ No valid targets remaining — battle complete (${tickCount} ticks)!`);
        await checkAndPraiseMorgThar(ctx, true);
        await recloakAfterBattle(ctx, cloakOnStart);
        return true;
      }
    }
  }

    if (targetParticipant && targetParticipant.is_destroyed && currentTarget) {
      ctx.log("combat", `⚠️ ${currentTarget.name} marked destroyed but battle still active — finding new target...`);
      const better = pickRealBattleTarget(status, status.your_side_id);
      if (better) {
        ctx.log("combat", `🎯 Switching to ${better.name} (previous target destroyed)`);
        currentTarget = better;
        await bot.exec("battle", { action: "target", target_id: better.id });
        await ctx.sleep(300);
      } else {
        const nearbyEnemy = await acquireEnemyFromNearby(ctx, currentTarget?.name, maxAttackTier, onlyNPCs);
        if (nearbyEnemy) {
          ctx.log("combat", `🎯 Re-acquired ${nearbyEnemy.name} from nearby scan after target destroyed`);
          currentTarget = nearbyEnemy;
          const attackOk = await attackTarget(ctx, currentTarget);
          if (!attackOk) {
            const afterAttack = await getBattleStatus(ctx);
            if (!afterAttack) {
              ctx.log("combat", `✅ Battle ended after destroyed target — victory!`);
              await checkAndPraiseMorgThar(ctx, true);
              await recloakAfterBattle(ctx, cloakOnStart);
              return true;
            }
            ctx.log("combat", `⚠️ Re-engagement failed after destroyed target — exiting combat loop`);
            return false;
          }
          await bot.exec("battle", { action: "target", target_id: currentTarget.id });
          await ctx.sleep(300);
        } else {
          ctx.log("combat", `✅ No valid targets remaining — battle complete (${tickCount} ticks)!`);
          await checkAndPraiseMorgThar(ctx, true);
          await recloakAfterBattle(ctx, cloakOnStart);
          return true;
        }
      }
      continue;
    }

    if (onlyNPCs && targetParticipant && await isGenuinePlayer(ctx, targetParticipant.username)) {
      ctx.log("combat", `🚨 ${currentTarget?.name ?? "Enemy"} is a PLAYER — fleeing (onlyNPCs=true)!`);
      await emergencyFleeSpam(ctx, `target is a player`);
      return false;
    }

    await bot.refreshShip();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    const shieldPct = bot.maxShield > 0 ? Math.round((bot.shield / bot.maxShield) * 100) : 100;

    // In-combat emergency field repair / shield top-up (hunter style)
    // Only skip firing if we actually consumed items this tick (prevents infinite loop when out of stock).
    if (repairThreshold > 0) {
      let didAction = false;
      if (hullPct <= repairThreshold) {
        ctx.log("combat", `🛠️ Hull ${hullPct}% ≤ repairThreshold — using repair kits in combat!`);
        if (await useRepairKits(ctx)) didAction = true;
      }
      if (shieldPct <= repairThreshold) {
        ctx.log("combat", `🛡️ Shields ${shieldPct}% ≤ repairThreshold — topping up shields in combat!`);
        if (await topUpShields(ctx, shieldRechargePct / 100)) didAction = true;
      }
      if (didAction) {
        await ctx.sleep(10000);
        continue;
      }
    }

    // Shield recharge for escorts (even when repairThreshold is 0)
    // shieldRechargePct is passed as percentage (e.g., 80 for 80%), convert to decimal for topUpShields
    const shieldTargetPct = shieldRechargePct / 100;
    if (shieldTargetPct > 0 && shieldPct < shieldTargetPct * 100) {
      ctx.log("combat", `🛡️ Shields ${shieldPct}% < ${shieldTargetPct * 100}% — recharging...`);
      if (await topUpShields(ctx, shieldTargetPct)) {
        await ctx.sleep(10000);
        continue;
      }
    }

    const zoneDirMap: Record<string, number> = { outer: 0, mid: 1, inner: 2, engaged: 3 };

    // If the enemy isn't in the participants roster (newer server combat code omits
    // them), we have no zone info for them. We still know who we're fighting via
    // currentTarget (re-acquired from the nearby scan), so keep attacking, hold fire
    // stance, and close to engaged range — exactly what the server's
    // "advance to close the distance" directive wants.
    if (!targetParticipant && currentTarget) {
      ctx.log("combat", `Tick ${tickCount}: Enemy not in roster — keeping ${currentTarget.name} targeted/engaged | Hull=${hullPct}% | Shields=${shieldPct}%`);
      const attackOk = await attackTarget(ctx, currentTarget);
      if (!attackOk) {
        const afterAttack = await getBattleStatus(ctx);
        if (!afterAttack) {
          ctx.log("combat", `✅ Battle ended during enemy tracking - ${currentTarget.name} eliminated!`);
          await checkAndPraiseMorgThar(ctx, true);
          await recloakAfterBattle(ctx, cloakOnStart);
          return true;
        }
        ctx.log("combat", `⚠️ Attack failed but battle still active — exiting combat loop`);
        return false;
      }
      await bot.exec("battle", { action: "target", target_id: currentTarget.id });
      const ourZoneNow = status.your_zone || "outer";
      if (ourZoneNow !== "engaged") {
        const adv = await bot.exec("battle", { action: "advance" });
        if (adv.error && /not in battle/.test(adv.error.message.toLowerCase())) {
          ctx.log("combat", `✅ Battle ended (advance failed: not in battle) - victory!`);
          await checkAndPraiseMorgThar(ctx, true);
          return true;
        }
      }
      await ctx.sleep(10000);
      continue;
    }

    const enemyZone = targetParticipant?.zone || "outer";
    const enemyZoneNum = zoneDirMap[enemyZone] ?? 0;
    const ourZone = status.your_zone || "outer";
    const ourZoneNum = zoneDirMap[ourZone] ?? 0;

    if (targetParticipant && targetParticipant.zone) {
      if (targetParticipant.zone !== lastKnownEnemyZone) {
        const prevDir = zoneDirMap[lastKnownEnemyZone] ?? 0;
        const newDir = zoneDirMap[targetParticipant.zone] ?? 0;
        if (newDir > prevDir) {
          if (currentTarget) ctx.log("combat", `⚠️ ${currentTarget.name} advancing: ${lastKnownEnemyZone} → ${targetParticipant.zone}`);
        } else if (newDir < prevDir) {
          if (currentTarget) ctx.log("combat", `${currentTarget.name} retreating: ${lastKnownEnemyZone} → ${targetParticipant.zone}`);
        }
        lastKnownEnemyZone = targetParticipant.zone;
      }
    }

    if (canFlee && hullPct <= fleeThreshold) {
      ctx.log("combat", `💀 Hull critical (${hullPct}%) — FLEEING!`);
      await emergencyFleeSpam(ctx, `hull at ${hullPct}%`);
      return false;
    }

    const enemyStance = targetParticipant?.stance || "unknown";
    ctx.log("combat", `Tick ${tickCount}: Enemy=${enemyStance}/${enemyZone} | Hull=${hullPct}% | Shields=${shieldPct}%`);

    // Stay within 1 zone of enemy to maintain firing range
    // Zones: outer(0) ↔ mid(1) ↔ inner(2) ↔ engaged(3)
    // We can hit if |enemyZoneNum - ourZoneNum| <= 1
    const zoneDiff = ourZoneNum - enemyZoneNum;

    if (zoneDiff > 1) {
      // Enemy is behind us (e.g., we're at engaged(3), enemy at mid(1)) - retreat
      ctx.log("combat", `↩️ Retreating from ${ourZone} to match enemy at ${enemyZone}`);
      const retResp = await bot.exec("battle", { action: "retreat" });
      if (retResp.error) {
        const errMsg = retResp.error.message.toLowerCase();
        if (errMsg.includes("no active battle") || errMsg.includes("not in battle")) {
          ctx.log("combat", `✅ Battle ended (retreat failed: not in battle) - victory!`);
          await checkAndPraiseMorgThar(ctx, true);
          return true;
        }
        ctx.log("error", `Retreat failed: ${retResp.error.message}`);
      }
      await ctx.sleep(10000);
    } else if (zoneDiff < -1) {
      // Enemy is ahead of us (e.g., we're at outer(0), enemy at inner(2)) - advance
      ctx.log("combat", `⚔️ Advancing from ${ourZone} to match enemy at ${enemyZone}`);
      const advResp = await bot.exec("battle", { action: "advance" });
      if (advResp.error) {
        const errMsg = advResp.error.message.toLowerCase();
        if (errMsg.includes("no active battle") || errMsg.includes("not in battle")) {
          ctx.log("combat", `✅ Battle ended (advance failed: not in battle) - victory!`);
          await checkAndPraiseMorgThar(ctx, true);
          return true;
        }
        ctx.log("error", `Advance failed: ${advResp.error.message}`);
      }
      await ctx.sleep(10000);
    } else {
      // Already in range and fire stance (default) — server auto-fires each tick.
      // Re-issue the attack defensively: if the initial engage somehow didn't register
      // us as engaged (e.g. restarted mid-battle with a stale target id), this keeps
      // trying to attack instead of silently sitting in the outer ring and dying.
      // Re-attacking an already-engaged target just returns "already in a battle",
      // which attackTarget treats as success, so this is harmless when fine.
      if (currentTarget) await attackTarget(ctx, currentTarget);
      await ctx.sleep(10000);
    }
  }
}
