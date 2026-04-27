import type { RoutineContext } from "../bot.js";
import type { BattleStatus } from "../types/game.js";
import { catalogStore } from "../catalogstore.js";
import { mapStore } from "../mapstore.js";
import { getBattleStatus } from "./common.js";

// ── Types ─────────────────────────────────────────────

export type PirateTier = "small" | "medium" | "large" | "capitol" | "boss";

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
  tier?: PirateTier;
  isBoss?: boolean;
  hull?: number;
  maxHull?: number;
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

  return entities.filter(e => e.id);
}

// ── Target Validation ─────────────────────────────────────────

export function isPirateTarget(entity: NearbyEntity, onlyNPCs: boolean, maxAttackTier: PirateTier = "large"): boolean {
  if (entity.isPirate) {
    if (isTierTooHigh(entity.tier, maxAttackTier)) return false;
    return true;
  }
  if (onlyNPCs && !entity.isNPC) return false;

  const factionMatch = entity.faction ? PIRATE_KEYWORDS.some(kw => entity.faction.includes(kw)) : false;
  const typeMatch = entity.type ? PIRATE_KEYWORDS.some(kw => entity.type.includes(kw)) : false;
  const nameMatch = entity.name ? PIRATE_KEYWORDS.some(kw => entity.name.toLowerCase().includes(kw)) : false;

  return factionMatch || typeMatch || (entity.isNPC && nameMatch);
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
  const ship = (result.ship as Record<string, unknown>) || result;
  const modulesArray = (
    Array.isArray(ship.modules) ? ship.modules :
    Array.isArray(result.modules) ? result.modules :
    []
  ) as Array<Record<string, unknown>>;

  const weapons: WeaponModule[] = [];
  for (const mod of modulesArray) {
    if (!mod || typeof mod !== "object") continue;

    const modType = ((mod.type as string) || (mod.module_type as string) || "").toLowerCase();
    const modId = ((mod.module_id as string) || (mod.mod_id as string) || (mod.id as string) || "").toLowerCase();
    const isWeapon = modType.includes("weapon") || modType.includes("missile") || modType.includes("launcher") || modType.includes("torpedo") || modId.includes("weapon") || modId.includes("missile") || modId.includes("launcher");
    if (!isWeapon) continue;

    let ammoType = (mod.ammo_type as string) || (mod.ammo_item_id as string) || (mod.ammo as string);
    if (!ammoType && modId) {
      const catalogModule = catalogStore.getItem(modId);
      if (catalogModule) {
        ammoType = (catalogModule as Record<string, unknown>).ammo_type as string;
      }
    }

    const instanceId = (mod.instance_id as string) ||
                       (mod.weapon_instance_id as string) ||
                       (mod.module_instance_id as string) ||
                       (mod.id as string) || "";
    const moduleId = (mod.module_id as string) || (mod.mod_id as string) || (mod.id as string) || "";
    const currentAmmo = (mod.current_ammo as number) ?? 0;
    const maxAmmo = (mod.max_ammo as number) ?? 0;

    if (instanceId && moduleId) {
      weapons.push({
        instanceId,
        moduleId,
        name: (mod.name as string) || moduleId,
        currentAmmo,
        maxAmmo,
        ammoType,
      });
    }
  }

  return weapons;
}

export async function ensureAmmoLoaded(
  ctx: RoutineContext,
  _threshold: number,
  maxAttempts: number,
): Promise<boolean> {
  const { bot } = ctx;
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
    if (!weapon.ammoType) {
      ctx.log("warn", `Weapon "${weapon.name}" has no ammo type defined — skipping`);
      continue;
    }

    let needsReload = false;
    if (weapon.maxAmmo > 0) {
      needsReload = weapon.currentAmmo <= Math.floor(weapon.maxAmmo * 0.25);
      if (needsReload) {
        ctx.log("combat", `Weapon "${weapon.name}" ammo low: ${weapon.currentAmmo}/${weapon.maxAmmo} (<=25%, type: ${weapon.ammoType})`);
      }
    } else {
      const matchingAmmo = catalogStore.findMatchingAmmoInCargo(cargoItems, weapon.ammoType);
      if (matchingAmmo.length > 0) {
        ctx.log("combat", `Weapon "${weapon.name}" ammo state unknown - attempting reload with ${weapon.ammoType}`);
        needsReload = true;
      } else {
        ctx.log("warn", `Weapon "${weapon.name}" needs ${weapon.ammoType} but none in cargo`);
      }
    }

    if (!needsReload) continue;

    const matchingAmmo = catalogStore.findMatchingAmmoInCargo(cargoItems, weapon.ammoType);
    if (matchingAmmo.length === 0) {
      ctx.log("combat", `⚠️ No ${weapon.ammoType} ammo in cargo for "${weapon.name}" — need to resupply`);
      continue;
    }

    const ammoItem = matchingAmmo[0];
    ctx.log("combat", `Found ${ammoItem.quantity}x ${ammoItem.itemId} (${weapon.ammoType}) — reloading "${weapon.name}"...`);

    for (let i = 0; i < maxAttempts; i++) {
      const resp = await bot.exec("reload", {
        weapon_instance_id: weapon.instanceId,
        ammo_item_id: ammoItem.itemId,
      });

      if (resp.error) {
        const msg = resp.error.message.toLowerCase();
        if (msg.includes("full") || msg.includes("already")) {
          ctx.log("combat", `Weapon "${weapon.name}" already full or reload skipped`);
          break;
        }
        if (msg.includes("no ammo") || msg.includes("no_ammo") || msg.includes("empty")) {
          ctx.log("combat", `No ${weapon.ammoType} ammo available — need to resupply at station`);
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

  await bot.refreshStatus();
  const updatedWeapons = await getWeaponModules(ctx);
  let updatedTotalAmmo = 0;
  let updatedTotalMaxAmmo = 0;

  for (const weapon of updatedWeapons) {
    updatedTotalAmmo += weapon.currentAmmo;
    updatedTotalMaxAmmo += weapon.maxAmmo;
  }

  if (updatedTotalMaxAmmo > 0) {
    const updatedPct = (updatedTotalAmmo / updatedTotalMaxAmmo) * 100;
    ctx.log("combat", `Post-reload ammo: ${updatedTotalAmmo}/${updatedTotalMaxAmmo} (${updatedPct.toFixed(0)}%)`);
    return updatedTotalAmmo > 0 || anyReloaded;
  }

  return updatedTotalAmmo > 0 || anyReloaded;
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

  const fleeResp = await bot.exec("battle", { action: "stance", stance: "flee" });
  if (fleeResp.error) {
    const errMsg = fleeResp.error.message.toLowerCase();
    if (errMsg.includes("in_battle") || errMsg.includes("in combat")) {
      ctx.log("combat", `⚠️ Flee stance blocked - already in battle action. Waiting for tick to complete...`);
      await ctx.sleep(2000);
      status = await getBattleStatus(ctx);
      if (!status) {
        ctx.log("combat", `✅ Battle ended during flee attempt`);
        return;
      }
    } else {
      ctx.log("error", `Flee stance failed: ${fleeResp.error.message}`);
    }
  }

  ctx.log("combat", `Flee stance set - waiting for disengagement (3 ticks)...`);
  const MAX_FLEE_WAIT_TICKS = 10;
  let waitTicks = 0;

  for (waitTicks = 0; waitTicks < MAX_FLEE_WAIT_TICKS; waitTicks++) {
    await ctx.sleep(2000);
    status = await getBattleStatus(ctx);
    if (!status) {
      ctx.log("combat", `✅ Successfully disengaged from battle`);
      return;
    }
    const ourZone = status.your_zone;
    if (ourZone && ourZone !== "engaged") {
      ctx.log("combat", `Retreating from ${ourZone} zone...`);
    }
  }

  status = await getBattleStatus(ctx);
  if (status) {
    ctx.log("combat", `⚠️ Still in battle after flee wait - trying retreat commands...`);
    for (let i = 0; i < 3; i++) {
      const retreatResp = await bot.exec("battle", { action: "retreat" });
      if (retreatResp.error) {
        const errMsg = retreatResp.error.message.toLowerCase();
        if (errMsg.includes("in_battle") || errMsg.includes("in combat")) {
          ctx.log("combat", `⚠️ Retreat blocked - in battle action. Waiting...`);
          await ctx.sleep(2000);
        } else {
          ctx.log("error", `Retreat failed: ${retreatResp.error.message}`);
        }
      }
      await ctx.sleep(1000);
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
    pirateTiers: string[];
    playerNames: string[];
    pirateNames: string[];
  }

  const sideAnalysis: SideAnalysis[] = sides.map(side => {
    const sideParticipants = participants.filter(p => p.side_id === side.side_id);
    const players = sideParticipants.filter(p => {
      const username = p.username || "";
      const isPirate = username.toLowerCase().includes("pirate") ||
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
      return !isPirate && !p.username?.startsWith("[POLICE]");
    });

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

    return {
      sideId: side.side_id,
      playerCount: players.length,
      pirateCount: pirates.length,
      pirateTiers: pirates.map(p => "unknown"),
      playerNames: players.map(p => p.username || p.player_id),
      pirateNames: pirates.map(p => p.username || p.player_id),
    };
  });

  ctx.log("combat", `   Side analysis: ${sideAnalysis.map(s =>
    `Side ${s.sideId}: ${s.playerCount} player(s) [${s.playerNames.join(",")}] vs ${s.pirateCount} pirate(s) [${s.pirateNames.join(",")}]`
  ).join(" | ")}`);

  const playerVsPirateSides = sideAnalysis.filter(s => s.playerCount > 0 && s.pirateCount > 0);
  if (playerVsPirateSides.length === 0) {
    const allPlayers = participants.filter(p => {
      const username = p.username || "";
      return !username.startsWith("[POLICE]") &&
             !username.toLowerCase().includes("pirate") &&
             !username.toLowerCase().includes("drifter");
    });

    if (allPlayers.length >= 2 && sides.length >= 2) {
      return { shouldJoin: false, reason: "PvP battle detected — staying out" };
    }
    return { shouldJoin: false, reason: "Pirate vs pirate battle — not engaging" };
  }

  const sideToJoin = playerVsPirateSides.find(s => s.playerCount > 0);
  if (!sideToJoin) {
    return { shouldJoin: false, reason: "Could not determine which side to join" };
  }

  // NOTE: Combat routines (like fleet hunter) NEVER flee based on pirate count or police.
  // They ONLY flee when hull <= fleeThreshold.
  // This is intentional — they are combat bots designed to fight.

  return {
    shouldJoin: true,
    sideId: sideToJoin.sideId,
    reason: `Joining side ${sideToJoin.sideId} (${sideToJoin.playerCount} player(s)) vs ${sideToJoin.pirateCount} pirate(s)`,
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
): Promise<boolean> {
  const { bot } = ctx;
  if (!target.id) return false;

  // If sideId is provided (e.g., from fleet commander), directly join that side
  if (sideId !== undefined) {
    ctx.log("combat", `🎯 Direct engage on side ${sideId} (sideId provided)`);
    const engageResp = await bot.exec("battle", { action: "engage", side_id: sideId.toString() });
    if (engageResp.error) {
      ctx.log("error", `Failed to join battle side ${sideId}: ${engageResp.error.message}`);
      return false;
    }
    return await fightJoinedBattle(ctx, target, fleeThreshold, fleeFromTier, maxAttackTier);
  }

  const battleStatus = await getBattleStatus(ctx);
  if (battleStatus) {
    ctx.log("combat", `⚔️ Existing battle detected — analyzing...`);
    const analysis = await analyzeExistingBattle(ctx, maxAttackTier, minPiratesToFlee);
    if (!analysis.shouldJoin) {
      ctx.log("combat", `⏭️ Skipping battle: ${analysis.reason}`);
      return false;
    }

    ctx.log("combat", `✅ Joining battle on side ${analysis.sideId}: ${analysis.reason}`);
    const engageResp = await bot.exec("battle", { action: "engage", side_id: analysis.sideId!.toString() });
    if (engageResp.error) {
      ctx.log("error", `Failed to join battle: ${engageResp.error.message}`);
      return false;
    }
    return await fightJoinedBattle(ctx, target, fleeThreshold, fleeFromTier, maxAttackTier);
  }

  ctx.log("combat", `🎯 Engaging ${target.name}...`);
  let scanResp = await bot.exec("scan", { target_id: target.id });
  if (scanResp.error && scanResp.error.message.toLowerCase().includes("invalid_target")) {
    ctx.log("combat", `Scan with pirate_id failed - trying name instead...`);
    scanResp = await bot.exec("scan", { target_id: target.name });
  }

  if (!scanResp.error && scanResp.result) {
    const s = scanResp.result as Record<string, unknown>;
    const shipType = (s.ship_type as string) || (s.ship as string) || "unknown";
    const faction = (s.faction as string) || target.faction || "unknown";
    ctx.log("combat", `   Scan: ${target.name} — ${shipType} | Faction: ${faction}`);
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
    return false;
  }

  ctx.log("combat", `⚔️ Battle started with ${target.name} — advancing to engage`);
  return await fightFreshBattle(ctx, target, fleeThreshold, fleeFromTier, maxAttackTier);
}

// ── Combat Loops ──────────────────────────────────────────────

export async function fightFreshBattle(
  ctx: RoutineContext,
  target: NearbyEntity,
  fleeThreshold: number,
  fleeFromTier: PirateTier,
  maxAttackTier: PirateTier,
): Promise<boolean> {
  const { bot } = ctx;

  // Advance to engaged zone
  for (let zone = 0; zone < 3; zone++) {
    if (bot.state !== "running") return false;

    const status = await getBattleStatus(ctx);
    if (!status) {
      ctx.log("combat", `✅ Battle ended during advance — ${target.name} eliminated!`);
      return true;
    }

    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;

    if (hullPct <= fleeThreshold) {
      ctx.log("combat", `💀 Hull critical (${hullPct}%) while advancing — fleeing!`);
      await emergencyFleeSpam(ctx, "hull critical while advancing");
      return false;
    }

    const advResp = await bot.exec("battle", { action: "advance" });
    if (advResp.error) {
      ctx.log("error", `Advance failed: ${advResp.error.message}`);
      break;
    }

    const postAdvanceStatus = await getBattleStatus(ctx);
    if (postAdvanceStatus) {
      const zoneNames = ["mid", "inner", "engaged"];
      ctx.log("combat", `   Advanced to ${zoneNames[zone]} zone (${zone + 1}/3) | Hull: ${hullPct}%`);
    }
  }

  // Tactical combat loop
  let consecutiveBraceTicks = 0;
  let lastKnownEnemyZone = "outer";
  let tickCount = 0;
  let lastHull = bot.hull;

  await bot.exec("battle", { action: "stance", stance: "fire" });
  const initialStatus = await getBattleStatus(ctx);
  let ourCurrentZone = initialStatus?.your_zone || "outer";

  while (true) {
    if (bot.state !== "running") return false;
    tickCount++;

    const status = await getBattleStatus(ctx);
    if (!status) {
      ctx.log("combat", `✅ ${target.name} eliminated — battle complete (${tickCount} ticks, victory!)`);
      return true;
    }

    const targetParticipant = status.participants.find(
      p => p.player_id === target.id || p.username === target.name
    );

    if (targetParticipant && targetParticipant.is_destroyed) {
      ctx.log("combat", `⚠️ ${target.name} marked destroyed but battle still active — waiting...`);
      await ctx.sleep(2000);
      continue;
    }

    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    const shieldPct = bot.maxShield > 0 ? Math.round((bot.shield / bot.maxShield) * 100) : 100;
    const damageThisTick = Math.max(0, lastHull - bot.hull);
    lastHull = bot.hull;

    // Log state (NO third-party flee — combat routines fight until hull is critical)
    const enemyStance = targetParticipant?.stance || "unknown";
    const enemyZone = targetParticipant?.zone || "unknown";
    ctx.log("combat", `Tick ${tickCount}: Enemy=${enemyStance}/${enemyZone} | Hull=${hullPct}% | Shields=${shieldPct}% | Dmg=${damageThisTick}`);

    // Decide action
    const zoneDirMap = { outer: 0, mid: 1, inner: 2, engaged: 3 };
    const enemyZoneNum = zoneDirMap[enemyZone as keyof typeof zoneDirMap] ?? 0;
    const ourZoneNum = zoneDirMap[ourCurrentZone as keyof typeof zoneDirMap] ?? 0;
    const isHighDamageEnemy = damageThisTick > 50 || (target.tier && ["boss", "capitol", "large"].includes(target.tier));
    const shieldsCritical = isHighDamageEnemy
      ? (shieldPct < 40 || hullPct < 50)
      : (shieldPct < 15 && hullPct < 70);

    if (shieldsCritical && consecutiveBraceTicks < 3) {
      ctx.log("combat", `🛡️ BRACE (${isHighDamageEnemy ? 'high-damage enemy' : 'shields critical'})`);
      await bot.exec("battle", { action: "stance", stance: "brace" });
      consecutiveBraceTicks++;
    } else if (shieldsCritical && consecutiveBraceTicks >= 3) {
      ctx.log("combat", `⚔️ FIRE (braced ${consecutiveBraceTicks} ticks, switching back)`);
      await bot.exec("battle", { action: "stance", stance: "fire" });
      consecutiveBraceTicks = 0;
    } else if (consecutiveBraceTicks > 0) {
      ctx.log("combat", `⚔️ FIRE (resuming after brace)`);
      await bot.exec("battle", { action: "stance", stance: "fire" });
      consecutiveBraceTicks = 0;
    } else {
      if (enemyZoneNum > ourZoneNum) {
        ctx.log("combat", `⚔️ ADVANCING (enemy in ${enemyZone}, we're in ${ourCurrentZone})`);
        const advResp = await bot.exec("battle", { action: "advance" });
        if (!advResp.error) {
          const newZoneNum = Math.min(3, ourZoneNum + 1);
          ourCurrentZone = (["outer", "mid", "inner", "engaged"][newZoneNum]) as typeof ourCurrentZone;
        }
      } else if (enemyZoneNum <= ourZoneNum && ourZoneNum > 0) {
        ctx.log("combat", `🔄 RETREAT (maintaining position in ${ourCurrentZone})`);
        const retResp = await bot.exec("battle", { action: "retreat" });
        if (!retResp.error) {
          const newZoneNum = Math.max(0, ourZoneNum - 1);
          ourCurrentZone = (["outer", "mid", "inner", "engaged"][newZoneNum]) as typeof ourCurrentZone;
        }
      } else {
        ctx.log("combat", `⚔️ ADVANCING to engage`);
        await bot.exec("battle", { action: "advance" });
        ourCurrentZone = "mid";
      }
    }

    await ctx.sleep(2000);
  }
}

export async function fightJoinedBattle(
  ctx: RoutineContext,
  target: NearbyEntity,
  fleeThreshold: number,
  fleeFromTier: PirateTier,
  maxAttackTier: PirateTier,
): Promise<boolean> {
  const { bot } = ctx;

  ctx.log("combat", `🎯 Fighting in joined battle — targeting ${target.name}`);

  // Set target and fire stance
  await bot.exec("battle", { action: "target", target_id: target.id });
  await bot.exec("battle", { action: "stance", stance: "fire" });
  await getBattleStatus(ctx);

  // Tactical combat loop
  let consecutiveBraceTicks = 0;
  let lastKnownEnemyZone = "outer";
  let tickCount = 0;

  while (true) {
    if (bot.state !== "running") return false;
    tickCount++;

    const status = await getBattleStatus(ctx);
    if (!status) {
      ctx.log("combat", `✅ Battle complete — victory! (${tickCount} ticks)`);
      return true;
    }

    const targetParticipant = status.participants.find(
      p => p.player_id === target.id || p.username === target.name
    );

    if (targetParticipant && targetParticipant.is_destroyed) {
      ctx.log("combat", `⚠️ ${target.name} marked destroyed but battle still active — waiting...`);
      await ctx.sleep(2000);
      continue;
    }

    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    const shieldPct = bot.maxShield > 0 ? Math.round((bot.shield / bot.maxShield) * 100) : 100;

    // Track enemy zone
    if (targetParticipant && targetParticipant.zone) {
      if (targetParticipant.zone !== lastKnownEnemyZone) {
        const zoneDir = { outer: 0, mid: 1, inner: 2, engaged: 3 };
        const prevDir = zoneDir[lastKnownEnemyZone as keyof typeof zoneDir] ?? 0;
        const newDir = zoneDir[targetParticipant.zone as keyof typeof zoneDir] ?? 0;
        if (newDir > prevDir) {
          ctx.log("combat", `⚠️ ${target.name} advancing: ${lastKnownEnemyZone} → ${targetParticipant.zone}`);
        } else if (newDir < prevDir) {
          ctx.log("combat", `${target.name} retreating: ${lastKnownEnemyZone} → ${targetParticipant.zone}`);
        }
        lastKnownEnemyZone = targetParticipant.zone;
      }
    }

    // Flee check (ONLY based on hull)
    if (hullPct <= fleeThreshold) {
      ctx.log("combat", `💀 Hull critical (${hullPct}%) — FLEEING!`);
      await emergencyFleeSpam(ctx, `hull at ${hullPct}%`);
      return false;
    }

    // Log state (NO third-party flee — combat routines fight until hull is critical)
    const enemyStance = targetParticipant?.stance || "unknown";
    const enemyZone = targetParticipant?.zone || "unknown";
    ctx.log("combat", `Tick ${tickCount}: Enemy=${enemyStance}/${enemyZone} | Hull=${hullPct}% | Shields=${shieldPct}%`);

    // Decide action
    const zoneDirMap = { outer: 0, mid: 1, inner: 2, engaged: 3 };
    const enemyZoneNum = zoneDirMap[enemyZone as keyof typeof zoneDirMap] ?? 0;
    const ourZone = status.your_zone || "outer";
    const ourZoneNum = zoneDirMap[ourZone as keyof typeof zoneDirMap] ?? 0;
    const isHighDamageEnemy = target.tier && ["boss", "capitol", "large"].includes(target.tier);
    const shieldsCritical = isHighDamageEnemy
      ? (shieldPct < 40 || hullPct < 50)
      : (shieldPct < 15 && hullPct < 70);

    if (shieldsCritical && consecutiveBraceTicks < 3) {
      ctx.log("combat", `🛡️ BRACE (${isHighDamageEnemy ? 'high-damage enemy' : 'shields critical'})`);
      await bot.exec("battle", { action: "stance", stance: "brace" });
      consecutiveBraceTicks++;
    } else if (shieldsCritical && consecutiveBraceTicks >= 3) {
      ctx.log("combat", `⚔️ FIRE (braced ${consecutiveBraceTicks} ticks, switching back)`);
      await bot.exec("battle", { action: "stance", stance: "fire" });
      consecutiveBraceTicks = 0;
    } else if (consecutiveBraceTicks > 0) {
      ctx.log("combat", `⚔️ FIRE (resuming after brace)`);
      await bot.exec("battle", { action: "stance", stance: "fire" });
      consecutiveBraceTicks = 0;
    } else {
      if (enemyZoneNum > ourZoneNum) {
        ctx.log("combat", `⚔️ ADVANCING (enemy in ${enemyZone}, we're in ${ourZone})`);
        await bot.exec("battle", { action: "advance" });
      } else if (enemyZoneNum <= ourZoneNum && ourZoneNum > 0) {
        ctx.log("combat", `🔄 RETREAT (maintaining position)`);
        await bot.exec("battle", { action: "retreat" });
      } else {
        ctx.log("combat", `⚔️ ADVANCING to engage`);
        await bot.exec("battle", { action: "advance" });
      }
    }

    await ctx.sleep(2000);
  }
}
