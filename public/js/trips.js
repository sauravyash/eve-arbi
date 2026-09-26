// Pure multi-stop trip planning over universe-scan hauls — no DOM, no fetch.
//
// A trip chains hauls: fly from your start to A1, buy item 1, fly to B1 and sell it; buy item 2
// at B1 (or after a short empty hop), sell it at B2; and so on. Each leg sells everything before
// the next buy, so cargo and investment limits apply per leg, not across the trip.

import { summarizeSteps } from './arbitrage.js';

export const SHIP_CATEGORY = 6;

/**
 * Turn raw universe-scan candidates into priced hauls ("legs") under the player's limits.
 * @param {object} result   /api/uscan/result payload
 * @param {object} o
 * @param {object} [o.catalog]  types.json ({typeId: [name, m³, categoryId]}), for categories
 */
export function evaluateLegs(result, { catalog = {}, taxRate = 0, maxVolume = Infinity, maxCost = Infinity, minProfit = 0,
  hideShips = false, hideHubs = false, structures = true, isNpcStation = () => true } = {}) {
  const legs = [];
  for (const c of result?.candidates || []) {
    if (hideHubs && c.hub) continue;
    if (!structures && (!isNpcStation(c.f) || !isNpcStation(c.d))) continue;
    const info = catalog[c.t] || result.types?.[c.t] || [`Type ${c.t}`, 0];
    if (hideShips && info[2] === SHIP_CATEGORY) continue;
    const s = summarizeSteps(c.s, { taxRate, unitVolume: info[1] || 0, maxVolume, maxCost });
    if (s.units <= 0 || s.profit <= 0 || s.profit < minProfit) continue;
    legs.push({ t: c.t, name: info[0], f: c.f, fs: c.fs, d: c.d, ds: c.ds, x: !!c.x, hub: !!c.hub, ...s });
  }
  return legs;
}

/**
 * Best multi-stop trips, found with a beam search.
 * @param {object[]} legs            from evaluateLegs
 * @param {object} o
 * @param {number} o.start           system you start in
 * @param {(sys: number) => (sys: number) => number|null} o.distFrom   jump-distance lookup factory
 * @param {number} [o.maxLegs=3]     hauls per trip
 * @param {number} [o.maxLink=3]     empty jumps allowed between a sale and the next purchase
 * @param {'perJump'|'profit'} [o.rank='perJump']
 * @param {number} [o.maxReuse=2]   listed trips a single haul may appear in
 * @returns {{legs, links, startJumps, jumps, profit, peakCost, perJump}[]} trips with ≥ 2 legs, best first
 */
export function planTrips(legs, { start, distFrom, maxLegs = 3, maxLink = 3, rank = 'perJump', beam = 300, perPickup = 6, limit = 60, maxReuse = 2 } = {}) {
  const fromStart = distFrom(start);
  const byPickup = new Map();
  for (const L of legs) {
    let list = byPickup.get(L.fs);
    if (!list) byPickup.set(L.fs, list = []);
    list.push(L);
  }
  for (const list of byPickup.values()) list.sort((a, b) => b.profit - a.profit);
  const pickups = [...byPickup.keys()];
  const legJumps = (L) => (L.fs === L.ds ? 0 : distFrom(L.fs)(L.ds));
  const score = rank === 'profit' ? (s) => s.profit : (s) => s.profit / Math.max(1, s.jumps);

  // Depth 1: every leg you can reach from the start.
  let frontier = [];
  for (const L of legs) {
    const j0 = fromStart(L.fs), jl = legJumps(L);
    if (j0 == null || jl == null) continue;
    frontier.push({ legs: [L], links: [], startJumps: j0, jumps: j0 + jl, profit: L.profit, peakCost: L.cost, types: new Set([L.t]) });
  }
  frontier = frontier.sort((a, b) => score(b) - score(a)).slice(0, beam);

  const found = new Map();
  for (let depth = 2; depth <= maxLegs && frontier.length; depth++) {
    const next = [];
    for (const s of frontier) {
      const here = s.legs[s.legs.length - 1].ds;
      const fromHere = distFrom(here);
      for (const p of pickups) {
        const link = p === here ? 0 : fromHere(p);
        if (link == null || link > maxLink) continue;
        for (const L of byPickup.get(p).slice(0, perPickup)) {
          if (s.types.has(L.t)) continue; // the same item twice would compete for the same orders
          const jl = legJumps(L);
          if (jl == null) continue;
          const t = {
            legs: [...s.legs, L], links: [...s.links, link], startJumps: s.startJumps,
            jumps: s.jumps + link + jl, profit: s.profit + L.profit, peakCost: Math.max(s.peakCost, L.cost),
            types: new Set([...s.types, L.t]),
          };
          next.push(t);
          const key = t.legs.map(l => `${l.t}:${l.f}:${l.d}`).join('>');
          if (!found.has(key)) found.set(key, t);
        }
      }
    }
    frontier = next.sort((a, b) => score(b) - score(a)).slice(0, beam);
  }
  // Variety: one lucrative haul would otherwise headline dozens of trips that only differ by a
  // trivial extra stop, so each haul may appear in at most `maxReuse` listed trips.
  const uses = new Map(), out = [];
  const legKey = (l) => `${l.t}:${l.f}:${l.d}`;
  for (const t of [...found.values()].sort((a, b) => score(b) - score(a))) {
    if (t.legs.some(l => (uses.get(legKey(l)) || 0) >= maxReuse)) continue;
    t.legs.forEach(l => uses.set(legKey(l), (uses.get(legKey(l)) || 0) + 1));
    const { types, ...rest } = t;
    out.push({ ...rest, perJump: t.profit / Math.max(1, t.jumps) });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Waypoints for a trip, in flying order: [{systemId, locationId, action, leg}] where action is
 * 'buy', 'sell' or 'sell+buy' (sell the last cargo and buy the next one at the same station).
 */
export function tripStops(trip) {
  const stops = [];
  trip.legs.forEach((L, i) => {
    const prev = stops[stops.length - 1];
    if (prev && prev.locationId === L.f && prev.action === 'sell') { prev.action = 'sell+buy'; prev.buy = L; }
    else stops.push({ systemId: L.fs, locationId: L.f, action: 'buy', buy: L });
    stops.push({ systemId: L.ds, locationId: L.d, action: 'sell', sell: L, leg: i });
  });
  return stops;
}
