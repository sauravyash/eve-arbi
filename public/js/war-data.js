// Alliance and corporation warfare for the Warfare page: who holds null-sec (ESI /sovereignty/map/),
// whose space is under attack (/sovereignty/campaigns/, /sovereignty/structures/), and who is
// shooting whom and so who dominates each system in practice (zKillboard killmails, which carry the
// attackers and victim inline; faction warfare occupancy from /fw/systems/). Pure: no DOM, no fetch.

export const EVENT_LABEL = {
  tcu_defense: 'TCU', ihub_defense: 'IHub', station_defense: 'Station', station_freeport: 'Freeport',
};
// Sovereignty structure types (/sovereignty/structures/ structure_type_id).
export const STRUCTURE_LABEL = { 32226: 'TCU', 32458: 'IHub' };

// A side in a fight: the alliance if there is one, else the corporation, else the NPC faction.
// Keys are 'a:<id>', 'c:<id>' or 'f:<id>' so the three id spaces can't collide.
export function sideOf(p) {
  if (!p) return null;
  if (p.alliance_id) return `a:${p.alliance_id}`;
  if (p.corporation_id) return `c:${p.corporation_id}`;
  if (p.faction_id) return `f:${p.faction_id}`;
  return null;
}
export const sideId = (key) => Number(key.slice(2));
export const sideKind = (key) => ({ a: 'alliance', c: 'corporation', f: 'faction' }[key[0]]);

/**
 * A stable colour for an alliance (or any side): hues spread by the golden angle so neighbours
 * with close ids still differ. Light theme gets darker, less saturated tones.
 */
export function allianceColor(id, light = false) {
  const h = Math.round(((id * 0.6180339887) % 1) * 360);
  const s = 55 + (id % 3) * 12;   // 55, 67, 79
  const l = light ? 38 + (id % 4) * 3 : 56 + (id % 4) * 4;
  return `hsl(${h} ${s}% ${l}%)`;
}

/** systemId → {alliance, corporation, faction} from /sovereignty/map/. */
export function sovIndex(map) {
  const out = new Map();
  for (const s of map || []) {
    out.set(s.system_id, { alliance: s.alliance_id || null, corporation: s.corporation_id || null, faction: s.faction_id || null });
  }
  return out;
}

/**
 * Per alliance holding sov: how many systems, the last hour's kills in them, the campaigns
 * against them and their structures' average ADM.
 * @param {Map} sov  sovIndex()
 * @param {object[]} kills  ESI /universe/system_kills/
 * @param {object[]} campaigns  ESI /sovereignty/campaigns/
 * @param {object[]} structures  ESI /sovereignty/structures/
 * @returns {object[]} most systems first
 */
export function territories(sov, kills = [], campaigns = [], structures = []) {
  const k = new Map((kills || []).map(r => [r.system_id, r]));
  const by = new Map();
  const get = (id) => {
    let t = by.get(id);
    if (!t) by.set(id, t = { allianceId: id, systems: 0, ships: 0, pods: 0, npcs: 0, campaigns: 0, admSum: 0, admN: 0, systemIds: [] });
    return t;
  };
  for (const [systemId, s] of sov) {
    if (!s.alliance) continue;
    const t = get(s.alliance);
    t.systems++;
    t.systemIds.push(systemId);
    const kr = k.get(systemId);
    if (kr) { t.ships += kr.ship_kills || 0; t.pods += kr.pod_kills || 0; t.npcs += kr.npc_kills || 0; }
  }
  for (const c of campaigns || []) if (c.defender_id && by.has(c.defender_id)) get(c.defender_id).campaigns++;
  for (const s of structures || []) {
    if (!s.alliance_id || !(s.vulnerability_occupancy_level > 0)) continue;
    const t = get(s.alliance_id);
    t.admSum += s.vulnerability_occupancy_level; t.admN++;
  }
  return [...by.values()]
    .filter(t => t.systems > 0)
    .map(({ admSum, admN, ...t }) => ({ ...t, adm: admN ? admSum / admN : null }))
    .sort((a, b) => b.systems - a.systems || b.ships - a.ships);
}

/**
 * Active sov campaigns, soonest / most lost first. Scores are 0–1; the attacker wins at 1.
 * Before start_time the timer hasn't come out yet (`upcoming`).
 */
export function campaignRows(campaigns, now = Date.now()) {
  return (campaigns || []).map(c => {
    const start = Date.parse(c.start_time);
    return {
      id: c.campaign_id, systemId: c.solar_system_id, constellationId: c.constellation_id, defender: c.defender_id,
      type: c.event_type, label: EVENT_LABEL[c.event_type] || c.event_type,
      attackers: c.attackers_score ?? 0, defenders: c.defender_score ?? 0,
      start, upcoming: start > now,
    };
  }).sort((a, b) => (a.upcoming - b.upcoming) || (a.upcoming ? a.start - b.start : b.attackers - a.attackers));
}

/** systemId → sov structures there with their ADM and vulnerability window. */
export function structuresBySystem(structures) {
  const out = new Map();
  for (const s of structures || []) {
    const list = out.get(s.solar_system_id) || [];
    list.push({
      type: STRUCTURE_LABEL[s.structure_type_id] || 'Structure', alliance: s.alliance_id, adm: s.vulnerability_occupancy_level ?? null,
      vulnStart: s.vulnerable_start_time ? Date.parse(s.vulnerable_start_time) : null,
      vulnEnd: s.vulnerable_end_time ? Date.parse(s.vulnerable_end_time) : null,
    });
    out.set(s.solar_system_id, list);
  }
  return out;
}

// Only players count as sides in a fight: an attacker with no character is an NPC or a structure's guns.
const playerSides = (attackers) => {
  const out = new Set();
  for (const a of attackers || []) if (a.character_id) { const s = sideOf(a); if (s) out.add(s); }
  return out;
};

/**
 * Who is fighting whom, from zKillboard killmails. Every pair of sides that met is a conflict;
 * a kill counts once per pair (a third party on the kill doesn't double it).
 * @param {object[]} killmails  zKillboard /api/kills/… rows (deduplicated by killmail_id here)
 * @returns {{conflicts: object[], sides: Map, systems: Map, kills: number, isk: number}}
 *   conflicts: {a, b, kills: {[side]: n}, isk: {[side]: ISK destroyed}, total, totalIsk, systems: Map(systemId → n), last}
 *   sides: side → {kills, losses, iskKilled, iskLost, systems: Map}
 *   systems: systemId → {kills, isk, sides: Map(side → kills+losses), attack: Map(side → kills scored there), last}
 */
export function fights(killmails) {
  const seen = new Set();
  const pairs = new Map(), sides = new Map(), systems = new Map();
  let kills = 0, isk = 0;
  const side = (k) => {
    let s = sides.get(k);
    if (!s) sides.set(k, s = { kills: 0, losses: 0, iskKilled: 0, iskLost: 0, systems: new Map() });
    return s;
  };
  for (const km of killmails || []) {
    if (!km?.killmail_id || seen.has(km.killmail_id)) continue;
    seen.add(km.killmail_id);
    if (km.zkb?.npc) continue;
    const victim = sideOf(km.victim);
    const attackers = playerSides(km.attackers);
    if (victim) attackers.delete(victim);   // awoxing and fleet-on-fleet within one alliance isn't war
    if (!victim || !attackers.size) continue;
    const value = km.zkb?.totalValue || 0;
    const t = Date.parse(km.killmail_time) || 0;
    const sys = km.solar_system_id;
    kills++; isk += value;

    let sy = systems.get(sys);
    if (!sy) systems.set(sys, sy = { kills: 0, isk: 0, sides: new Map(), attack: new Map(), last: 0 });
    sy.kills++; sy.isk += value; sy.last = Math.max(sy.last, t);
    sy.sides.set(victim, (sy.sides.get(victim) || 0) + 1);

    const v = side(victim);
    v.losses++; v.iskLost += value; v.systems.set(sys, (v.systems.get(sys) || 0) + 1);
    for (const a of attackers) {
      const s = side(a);
      s.kills++; s.iskKilled += value; s.systems.set(sys, (s.systems.get(sys) || 0) + 1);
      sy.sides.set(a, (sy.sides.get(a) || 0) + 1);
      sy.attack.set(a, (sy.attack.get(a) || 0) + 1);
      const [x, y] = a < victim ? [a, victim] : [victim, a];
      const key = `${x}|${y}`;
      let p = pairs.get(key);
      if (!p) pairs.set(key, p = { a: x, b: y, kills: { [x]: 0, [y]: 0 }, isk: { [x]: 0, [y]: 0 }, total: 0, totalIsk: 0, systems: new Map(), last: 0 });
      p.kills[a]++; p.isk[a] += value; p.total++; p.totalIsk += value;
      p.systems.set(sys, (p.systems.get(sys) || 0) + 1);
      p.last = Math.max(p.last, t);
    }
  }
  const conflicts = [...pairs.values()].sort((x, y) => y.totalIsk - x.totalIsk || y.total - x.total);
  return { conflicts, sides, systems, kills, isk };
}

/**
 * Who dominates each system: the side scoring the most kills there. A side owns a system once it
 * has at least `minKills` kills in it and `minShare` of all the kills scored there (contested
 * otherwise, still reported with its leader).
 * @param {Map} systems  fights().systems
 * @returns {Map} systemId → {side, kills, share, total, contested, contenders: [[side, kills]] most first}
 */
export function dominance(systems, { minKills = 2, minShare = 0.5 } = {}) {
  const out = new Map();
  for (const [sys, s] of systems || []) {
    const contenders = [...(s.attack || [])].sort((a, b) => b[1] - a[1]);
    if (!contenders.length) continue;
    const total = contenders.reduce((t, [, n]) => t + n, 0);
    const [side, kills] = contenders[0];
    const share = kills / total;
    out.set(sys, { side, kills, share, total, contested: kills < minKills || share < minShare, contenders });
  }
  return out;
}

/**
 * Per side, the systems it dominates (not contested) and the ones where it leads a contested fight.
 * @param {Map} dom  dominance()
 * @returns {{side, held: number[], leading: number[], kills}[]} most systems held first
 */
export function dominanceBySide(dom) {
  const by = new Map();
  for (const [sys, d] of dom || []) {
    let r = by.get(d.side);
    if (!r) by.set(d.side, r = { side: d.side, held: [], leading: [], kills: 0 });
    (d.contested ? r.leading : r.held).push(sys);
    r.kills += d.kills;
  }
  return [...by.values()].sort((a, b) => b.held.length - a.held.length || b.leading.length - a.leading.length || b.kills - a.kills);
}

/** systemId → {occupier, owner, status, contest} for the faction warfare zones (ESI /fw/systems/). */
export function fwIndex(fwSystems) {
  const out = new Map();
  for (const s of fwSystems || []) {
    out.set(s.solar_system_id, {
      occupier: s.occupier_faction_id, owner: s.owner_faction_id, status: s.contested,
      contest: s.victory_points_threshold > 0 ? Math.min(1, (s.victory_points || 0) / s.victory_points_threshold) : 0,
    });
  }
  return out;
}

/** ISK efficiency as a fraction: destroyed / (destroyed + lost); null when nothing either way. */
export const efficiency = (killed, lost) => (killed + lost > 0 ? killed / (killed + lost) : null);

/**
 * The regions worth asking zKillboard about: most player ship kills in the last hour first.
 * @param {object[]} kills  ESI /universe/system_kills/
 * @param {(systemId) => number|null} regionOf  region id of a system
 */
export function hotRegions(kills, regionOf, limit = 6) {
  const by = new Map();
  for (const r of kills || []) {
    const reg = regionOf(r.system_id);
    if (reg == null) continue;
    by.set(reg, (by.get(reg) || 0) + (r.ship_kills || 0) + (r.pod_kills || 0) / 2);
  }
  return [...by].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id, v]) => ({ regionId: id, heat: v }));
}

/** Every id that needs a name: sov holders, campaign defenders and the sides in the fights. */
export function idsToName({ sov, campaigns, fightSides } = {}) {
  const ids = new Set();
  for (const s of sov?.values() || []) { if (s.alliance) ids.add(s.alliance); if (s.faction) ids.add(s.faction); }
  for (const c of campaigns || []) if (c.defender_id) ids.add(c.defender_id);
  for (const k of fightSides?.keys() || []) ids.add(sideId(k));
  return [...ids];
}
