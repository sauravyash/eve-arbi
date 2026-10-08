// Faction warfare hotspots for the Regional demand page: the warzone systems being fought over now
// (ESI /fw/systems/ and /universe/system_kills/), what's listed for sale around them, and which FW
// staples the warzones buy more of than is stocked. Pure: no DOM, no fetch.

export const FACTIONS = {
  500001: { name: 'Caldari State', short: 'Caldari' },
  500002: { name: 'Minmatar Republic', short: 'Minmatar' },
  500003: { name: 'Amarr Empire', short: 'Amarr' },
  500004: { name: 'Gallente Federation', short: 'Gallente' },
  500010: { name: 'Guristas Pirates', short: 'Guristas' },
  500011: { name: 'Angel Cartel', short: 'Angels' },
};
export const factionName = (id, short = false) => FACTIONS[id]?.[short ? 'short' : 'name'] || `Faction ${id}`;

// What FW pilots burn through: navy and T1 frigates and destroyers, small ammo, the usual small-gang
// modules and consumables.
export const FW_STAPLES = [
  ['Hulls', [17841, 17812, 17703, 17619, 608, 587, 602, 597, 598, 591, 16242, 16240, 16236, 16238, 32872]],
  ['Ammo', [222, 21898, 22961, 23071, 246, 12608, 12612, 12625, 12563, 27361, 24471]],
  ['Modules', [440, 438, 1183, 33076, 32774, 3831, 448, 3244, 527, 2048]],
  ['Consumables', [28668, 11283, 32006, 33474, 33475, 28670]],
].flatMap(([group, ids]) => ids.map(typeId => ({ typeId, group })));

const CONTEST_WEIGHT = 20;   // heat for a system at 100% contested, in kills/hour
const VULNERABLE_BONUS = 10; // heat added while the system can be captured

/**
 * Warzone systems with how hot they are right now.
 * @param {object[]} fwSystems  ESI /fw/systems/
 * @param {object[]} kills      ESI /universe/system_kills/ (last hour)
 * @returns {{systemId, owner, occupier, status, contest, ships, pods, npcs, heat}[]} hottest first
 */
export function hotspots(fwSystems, kills) {
  const k = new Map((kills || []).map(r => [r.system_id, r]));
  return (fwSystems || []).map(s => {
    const kr = k.get(s.solar_system_id) || {};
    const contest = s.victory_points_threshold > 0 ? Math.min(1, (s.victory_points || 0) / s.victory_points_threshold) : 0;
    const ships = kr.ship_kills || 0, pods = kr.pod_kills || 0;
    return {
      systemId: s.solar_system_id, owner: s.owner_faction_id, occupier: s.occupier_faction_id,
      status: s.contested, contest, ships, pods, npcs: kr.npc_kills || 0,
      heat: ships + pods / 2 + CONTEST_WEIGHT * contest + (s.contested === 'vulnerable' ? VULNERABLE_BONUS : 0),
    };
  }).sort((a, b) => b.heat - a.heat || b.contest - a.contest);
}

/** Per graph index, the fewest jumps to any of several distance arrays (jumpsFrom), -1 = none. */
export function nearestOf(dists, n) {
  const out = new Int16Array(n).fill(-1);
  for (const d of dists) {
    for (let i = 0; i < n; i++) if (d[i] >= 0 && (out[i] < 0 || d[i] < out[i])) out[i] = d[i];
  }
  return out;
}

/**
 * The market within `radius` jumps of a point: sell stock and the cheapest ask, the best bid.
 * @param {object[]} orders  market-merge.js normalized orders
 * @param {(systemId) => number|null} jumps  jumps from the point (null = unreachable)
 */
export function localMarket(orders, jumps, radius, { structures = true, isNpc = () => true } = {}) {
  const m = { units: 0, orders: 0, ask: null, askJumps: null, bid: null, bidJumps: null };
  for (const o of orders || []) {
    if (o.ghost || (!structures && !isNpc(o.locationId))) continue;
    const j = jumps(o.systemId);
    if (j == null || j > radius) continue;
    if (o.isBuyOrder) {
      if (m.bid == null || o.price > m.bid) { m.bid = o.price; m.bidJumps = j; }
    } else {
      m.units += o.volumeRemain;
      m.orders++;
      if (m.ask == null || o.price < m.ask) { m.ask = o.price; m.askJumps = j; }
    }
  }
  return m;
}

/**
 * One FW staple across the warzone regions: their demand (analyse() rows), stock near the
 * hotspots, and what importing from the hub would earn.
 * @param {object} o
 * @param {object[]} o.rows   analyse() rows for the item
 * @param {Set<number>} o.regions  the warzone regions to add up
 * @param {object} o.local    localMarket() around the hotspots
 * @param {number|null} o.cost  price at the buy hub
 */
export function stapleRow({ rows, regions, local, cost, taxRate = 0, brokerRate = 0 }) {
  let daily = 0, value = 0;
  for (const r of rows) {
    if (!regions.has(r.regionId)) continue;
    daily += r.daily;
    if (r.price != null) value += r.daily * r.price;
  }
  const price = daily > 0 ? value / daily : null;
  // You'd list just under the cheapest local ask; with none, at the warzones' average price.
  const sellAt = local.ask ?? price;
  const margin = sellAt != null && cost != null ? sellAt * (1 - taxRate - brokerRate) - cost : null;
  const flip = local.bid != null && cost != null ? local.bid * (1 - taxRate) - cost : null;
  return {
    daily, price, margin, flip, cost, iskDay: margin > 0 ? daily * margin : 0,
    stock: local.units, ask: local.ask, bid: local.bid,
    daysOfStock: daily > 0 ? local.units / daily : Infinity,
    markup: sellAt != null && cost ? sellAt / cost - 1 : null,
  };
}

export const STAPLE_RANKS = {
  isk: (a, b) => b.iskDay - a.iskDay || b.daily - a.daily,
  shortage: (a, b) => a.daysOfStock - b.daysOfStock || b.daily - a.daily,
  margin: (a, b) => (b.margin ?? -Infinity) - (a.margin ?? -Infinity),
};
