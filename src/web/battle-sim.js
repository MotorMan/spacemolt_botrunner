const STANCES = ['fire', 'brace', 'evade', 'flee'];
const STANCE_IN_MULT = { fire: 1.0, brace: 0.25, evade: 0.5, flee: 1.0 };
const SHIELD_EFF = { energy: 0.75, kinetic: 1.0, void: 0, explosive: 1.0, em: 1.0, thermal: 1.0 };
const ARMOR_MULT = { kinetic: 1.5, void: 1.5, energy: 0.75, thermal: 0.25, explosive: 1.0, em: 1.0 };
const ARMOR_K = 150;
const ARMOR_LAW_CROSSOVER = 12;
const REGEN_HIT_DIVISOR = 3;
const FLEE_ESCAPE_PER_TICK = 0.25;
const HIT_CHANCE = 0.95;
const MAX_TICKS = 500;
const DEFAULT_RUNS = 10000;

class SeededRNG {
  constructor(seed = 1) {
    this.state = seed >>> 0;
    this.inc = 1;
  }
  next() {
    this.state = (this.state * 6364136223846793005 + this.inc) >>> 0;
    let x = this.state ^ (this.state >> 18);
    x = Math.imul(x, 0x4cd2b27d);
    x = x ^ (x >> 16);
    x = Math.imul(x, 0x1b873593);
    x = x ^ (x >> 16);
    return x >>> 0;
  }
  nextFloat() {
    return this.next() / 4294967296;
  }
  nextInt(max) {
    return Math.floor(this.nextFloat() * max);
  }
  nextBool(prob) {
    return this.nextFloat() < prob;
  }
}

let catalog = null;
let ships = [];
let modules = [];

async function loadCatalog() {
  if (catalog) return catalog;
  try {
    const resp = await fetch('/data/catalog.json');
    catalog = await resp.json();
    const items = catalog.items || {};
    const shipData = catalog.ships || {};
    ships = Object.values(shipData);
    modules = Object.values(items).filter(i => i.slot !== undefined);
    return catalog;
  } catch (e) {
    console.error('Failed to load catalog:', e);
    throw e;
  }
}

function getShips() {
  return ships;
}

function getShip(id) {
  return ships.find(s => s.id === id);
}

function getModule(id) {
  return modules.find(m => m.id === id);
}

function getModulesBySlot(slot) {
  return modules.filter(m => m.slot === slot);
}

function resolveFit(hullId, moduleIds, skills = {}) {
  const hull = getShip(hullId);
  if (!hull) throw new Error(`Unknown hull: ${hullId}`);
  if (hull.tier >= 5) throw new Error('Capital hulls (tier 5+) not supported in v1');

  const weaponModules = [];
  const defenseModules = [];
  const utilityModules = [];

  for (const modId of moduleIds) {
    if (!modId) continue;
    const mod = getModule(modId);
    if (!mod) continue;
    if (mod.slot === 'weapon') weaponModules.push(mod);
    else if (mod.slot === 'defense') defenseModules.push(mod);
    else if (mod.slot === 'utility') utilityModules.push(mod);
  }

  const weapons = weaponModules
    .filter(m => m.damage > 0)
    .map(m => ({
      name: m.name,
      damage: m.damage,
      type: m.damage_type,
      cooldown: m.cooldown || 1,
      magazine: m.magazine_size || 0
    }));

  let maxShield = hull.base_shield || 0;
  let recharge = hull.base_shield_recharge || 0;
  let armorTotal = hull.base_armor || 0;
  let flatPct = 0;

  for (const m of defenseModules) {
    maxShield += m.shield_bonus || 0;
    recharge += m.shield_recharge_bonus || 0;
    armorTotal += m.armor_bonus || 0;
    flatPct += m.damage_reduction || 0;
  }

  flatPct = Math.min(75, flatPct);
  armorTotal *= (1 + (skills.armor || 0) * 0.01);

  const weaponSkill = (skills.weapons || 0) + (skills.gunnery || 0);
  const critPct = skills.weapons || 0;

  return {
    name: hull.name,
    maxHull: hull.base_hull || 0,
    maxShield,
    recharge,
    armorTotal,
    flatPct,
    shieldsSkill: skills.shields || 0,
    weaponSkillPct: weaponSkill,
    critPct,
    weapons
  };
}

function calculateArmorReduction(armorTotal, damageType) {
  const mult = ARMOR_MULT[damageType] || 1.0;
  const counted = armorTotal * mult;
  if (counted >= ARMOR_LAW_CROSSOVER) {
    return counted / (counted + ARMOR_K);
  }
  return armorTotal * 0.75;
}

function resolveVolley(attacker, defender, stanceInMult, rng) {
  let raw = 0;
  for (const w of attacker.weapons) {
    const isCrit = rng.nextBool(attacker.critPct / 100);
    const dmg = isCrit ? Math.floor(w.damage * 1.5) : w.damage;
    raw += dmg;
  }

  let pre = Math.floor(raw * (1 + attacker.weaponSkillPct / 100));
  pre = Math.floor(pre * stanceInMult);

  if (!rng.nextBool(HIT_CHANCE)) return { hullDmg: 0, shieldDrain: 0, breakthrough: false };

  if (defender.shield > 0) {
    let x1 = Math.floor(pre * (1 - defender.shieldsSkill / 100));
    const eff = SHIELD_EFF[attacker.weapons[0]?.type || 'kinetic'] || 1.0;
    let drain = Math.floor(Math.floor(x1 * eff) * (1 - defender.flatPct / 100));

    if (defender.shield >= drain) {
      defender.shield -= drain;
      const spillFrac = (drain - defender.shield) / drain;
      if (spillFrac >= 0.5) {
        const hullDmg = Math.max(1, Math.floor(1 * (1 - defender.flatPct / 100)));
        return { hullDmg: Math.min(hullDmg, defender.hull), shieldDrain: drain, breakthrough: false };
      }
      return { hullDmg: 0, shieldDrain: drain, breakthrough: false };
    } else {
      const hullIn = pre - Math.floor(defender.shield / eff);
      defender.shield = 0;
      const f = calculateArmorReduction(defender.armorTotal, attacker.weapons[0]?.type || 'kinetic');
      const hullDmg = Math.max(1, Math.floor(hullIn * (1 - f)));
      return { hullDmg: Math.min(hullDmg, defender.hull), shieldDrain: defender.shield + drain, breakthrough: true };
    }
  } else {
    const f = calculateArmorReduction(defender.armorTotal, attacker.weapons[0]?.type || 'kinetic');
    const hullDmg = Math.max(1, Math.floor(pre * (1 - f)));
    return { hullDmg: Math.min(hullDmg, defender.hull), shieldDrain: 0, breakthrough: true };
  }
}

function runBattle(statA, statB, stanceA, stanceB, seed) {
  const rng = new SeededRNG(seed);

  const stateA = {
    hull: statA.maxHull,
    shield: statA.maxShield,
    ammo: statA.weapons.map(w => w.magazine || 999),
    cooldown: statA.weapons.map(() => 0),
    stance: stanceA,
    fled: false,
    stats: statA
  };

  const stateB = {
    hull: statB.maxHull,
    shield: statB.maxShield,
    ammo: statB.weapons.map(w => w.magazine || 999),
    cooldown: statB.weapons.map(() => 0),
    stance: stanceB,
    fled: false,
    stats: statB
  };

  const stanceInMultA = STANCE_IN_MULT[stanceA] || 1.0;
  const stanceInMultB = STANCE_IN_MULT[stanceB] || 1.0;

  for (let tick = 0; tick < MAX_TICKS; tick++) {
    const hitA = stateA.stance !== 'flee' && stateA.stance !== 'brace';
    const hitB = stateB.stance !== 'flee' && stateB.stance !== 'brace';

    let volleyA = { hullDmg: 0, shieldDrain: 0 };
    let volleyB = { hullDmg: 0, shieldDrain: 0 };

    if (hitA) {
      for (let i = 0; i < stateA.stats.weapons.length; i++) {
        if (stateA.cooldown[i] === 0 && stateA.ammo[i] > 0) {
          stateA.cooldown[i] = stateA.stats.weapons[i].cooldown;
          if (stateA.ammo[i] < 999) stateA.ammo[i]--;
          const res = resolveVolley(stateA.stats, stateB, stanceInMultB, rng);
          volleyA.hullDmg += res.hullDmg;
          volleyA.shieldDrain += res.shieldDrain;
        }
      }
    }

    if (hitB) {
      for (let i = 0; i < stateB.stats.weapons.length; i++) {
        if (stateB.cooldown[i] === 0 && stateB.ammo[i] > 0) {
          stateB.cooldown[i] = stateB.stats.weapons[i].cooldown;
          if (stateB.ammo[i] < 999) stateB.ammo[i]--;
          const res = resolveVolley(stateB.stats, stateA, stanceInMultA, rng);
          volleyB.hullDmg += res.hullDmg;
          volleyB.shieldDrain += res.shieldDrain;
        }
      }
    }

    stateA.hull -= volleyB.hullDmg;
    stateB.hull -= volleyA.hullDmg;

    if (volleyA.shieldDrain > 0) stateB.shield = Math.max(0, stateB.shield - volleyA.shieldDrain);
    if (volleyB.shieldDrain > 0) stateA.shield = Math.max(0, stateA.shield - volleyB.shieldDrain);

    const aHit = volleyB.hullDmg > 0 || volleyB.shieldDrain > 0;
    const bHit = volleyA.hullDmg > 0 || volleyA.shieldDrain > 0;

    if (!aHit) stateA.shield = Math.min(stateA.stats.maxShield, stateA.shield + stateA.stats.recharge);
    else stateA.shield = Math.min(stateA.stats.maxShield, stateA.shield + Math.floor(stateA.stats.recharge / REGEN_HIT_DIVISOR));

    if (!bHit) stateB.shield = Math.min(stateB.stats.maxShield, stateB.shield + stateB.stats.recharge);
    else stateB.shield = Math.min(stateB.stats.maxShield, stateB.shield + Math.floor(stateB.stats.recharge / REGEN_HIT_DIVISOR));

    for (let i = 0; i < stateA.cooldown.length; i++) if (stateA.cooldown[i] > 0) stateA.cooldown[i]--;
    for (let i = 0; i < stateB.cooldown.length; i++) if (stateB.cooldown[i] > 0) stateB.cooldown[i]--;

    if (stateA.stance === 'flee' && !stateA.fled) {
      if (rng.nextBool(FLEE_ESCAPE_PER_TICK)) {
        stateA.fled = true;
        return { winner: 'B', reason: 'A fled', ticks: tick + 1 };
      }
    }
    if (stateB.stance === 'flee' && !stateB.fled) {
      if (rng.nextBool(FLEE_ESCAPE_PER_TICK)) {
        stateB.fled = true;
        return { winner: 'A', reason: 'B fled', ticks: tick + 1 };
      }
    }

    if (stateA.hull <= 0 && stateB.hull <= 0) return { winner: 'draw', reason: 'mutual destruction', ticks: tick + 1 };
    if (stateA.hull <= 0) return { winner: 'B', reason: 'hull', ticks: tick + 1 };
    if (stateB.hull <= 0) return { winner: 'A', reason: 'hull', ticks: tick + 1 };
  }

  return { winner: 'stalemate', reason: 'max ticks', ticks: MAX_TICKS };
}

function runMonteCarlo(statA, statB, stanceA, stanceB, runs, baseSeed) {
  const results = { A: 0, B: 0, draw: 0, stalemate: 0, fled: 0 };
  const assumed = stanceA === 'evade' || stanceA === 'flee' || stanceB === 'evade' || stanceB === 'flee';

  for (let i = 0; i < runs; i++) {
    const seed = baseSeed + i * 4;
    const res = runBattle(statA, statB, stanceA, stanceB, seed);
    if (res.winner === 'A' || res.winner === 'B') {
      results[res.winner]++;
    } else if (res.winner === 'draw') {
      results.draw++;
    } else if (res.reason?.includes('fled')) {
      results.fled++;
    } else {
      results.stalemate++;
    }
  }

  const total = runs;
  let dominant = 'stalemate';
  let maxPct = 0;
  for (const [k, v] of Object.entries(results)) {
    const pct = (v / total) * 100;
    if (pct > maxPct) {
      maxPct = pct;
      dominant = k;
    }
  }

  const label = dominant === 'A' ? 'A wins' : dominant === 'B' ? 'B wins' : dominant === 'draw' ? 'Draw' : dominant === 'fled' ? 'Fled' : 'Stalemate';
  return { dominant, pct: Math.round(maxPct), assumed, details: results };
}

function runTable(statA, statB, runs = DEFAULT_RUNS, seed = 12345) {
  const table = [];
  for (const sa of STANCES) {
    const row = [];
    for (const sb of STANCES) {
      const res = runMonteCarlo(statA, statB, sa, sb, runs, seed);
      row.push(res);
    }
    table.push(row);
  }
  return table;
}

function formatTable(table) {
  const header = ['A\\B', ...STANCES].map(s => s.padEnd(10)).join(' | ');
  const lines = [header, '-'.repeat(header.length)];
  for (let i = 0; i < STANCES.length; i++) {
    const row = [STANCES[i].padEnd(10)];
    for (let j = 0; j < STANCES.length; j++) {
      const cell = table[i][j];
      const star = cell.assumed ? '*' : ' ';
      row.push(`${cell.dominant} ${cell.pct}%${star}`.padEnd(10));
    }
    lines.push(row.join(' | '));
  }
  lines.push('');
  lines.push('* = ASSUMED-dependent (evade/flee stance)');
  lines.push('Legend: A wins / B wins / Draw / Fled / Stalemate');
  return lines.join('\n');
}

function formatTableHTML(table) {
  let html = '<table class="battle-table"><thead><tr><th>A\\B</th>';
  for (const s of STANCES) html += `<th>${s}</th>`;
  html += '</tr></thead><tbody>';
  for (let i = 0; i < STANCES.length; i++) {
    html += `<tr><th>${STANCES[i]}</th>`;
    for (let j = 0; j < STANCES.length; j++) {
      const cell = table[i][j];
      const star = cell.assumed ? '<sup>*</sup>' : '';
      const cls = cell.dominant === 'A' ? 'win-a' : cell.dominant === 'B' ? 'win-b' : cell.dominant === 'draw' ? 'draw' : cell.dominant === 'fled' ? 'fled' : 'stalemate';
      html += `<td class="${cls}">${cell.dominant} ${cell.pct}%${star}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  html += '<p class="legend">* = ASSUMED-dependent (evade/flee stance)</p>';
  return html;
}

async function loadPresetFit(name) {
  try {
    const resp = await fetch(`/data/combat-sim/fits/${name}.json`);
    return await resp.json();
  } catch (e) {
    console.error(`Failed to load preset ${name}:`, e);
    return null;
  }
}

window.BattleSim = {
   loadCatalog,
   getShips,
   getShip,
   getModule,
   getModulesBySlot,
  resolveFit,
  runBattle,
  runMonteCarlo,
  runTable,
  formatTable,
  formatTableHTML,
  loadPresetFit,
  STANCES,
  DEFAULT_RUNS
};