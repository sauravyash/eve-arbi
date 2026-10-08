// FW supply runs for the Regional demand page: what to bring to the chosen faction warfare hotspots
// (enough that local stock covers some days of demand), which stations to buy it at, and the order
// to fly them in. Pure: no DOM, no fetch.

import { localMarket, sellPrice } from './fw.js';
import { optimizeOrder, UNREACHABLE } from './route-plan.js';

/**
 * Units each hotspot needs: `days` of its region's daily volume, less what's listed within `radius`.
 * Hotspots that share a region split its demand.
 * @param {{typeId, rows, orders}[]} items  per staple: analyse() rows and its orders
 * @param {{regionId, jumps: (systemId) => number|null}[]} spots  the hotspots to supply
 * @returns {{spot, typeId, units, daily, stock, sellAt}[]}  spot = index into `spots`
 */
export function hotspotNeeds(items, spots, { radius, days, market = {} }) {
  const share = new Map();
  for (const s of spots) share.set(s.regionId, (share.get(s.regionId) || 0) + 1);
  const needs = [];
  for (const it of items) {
    spots.forEach((s, spot) => {
      const row = it.rows.find(r => r.regionId === s.regionId);
      if (!(row?.daily > 0)) return;
      const daily = row.daily / share.get(s.regionId);
      const local = localMarket(it.orders, s.jumps, radius, market);
      const sellAt = sellPrice(local.ask, row.price);
      const units = Math.ceil(daily * days - local.units);
      if (units > 0 && sellAt != null) needs.push({ spot, typeId: it.typeId, units, daily, stock: local.units, sellAt });
    });
  }
  return needs;
}

/**
 * Where to buy what the needs call for. Greedy by station: each round takes the station whose
 * profitable purchases (filling the remaining needs, within the cargo and budget left) earn most
 * once its detour is paid for, up to `maxStops` stations. The detour is the jumps to it from the
 * nearest place already on the way (`start` or a stop taken), at `iskPerJump` each; a station that
 * doesn't earn more than its detour costs is skipped. Within a station the units that earn most per
 * m³ or ISK of room go first.
 * @param {object[]} needs  hotspotNeeds()
 * @param {Map<number, {locationId, systemId, price, volume}[]>} asks  per typeId, the sell orders you may buy from
 * @param {object} o
 * @param {(typeId) => number} o.unitVolume  packaged m³
 * @param {number} o.feeRate  sales tax + broker fee on what you list at the hotspot, 0–1
 * @param {number} [o.start]  system you set out from
 * @param {(a: number, b: number) => number|null} [o.jumps]  between two systems (null = unreachable); without it detours are free
 * @param {number} [o.iskPerJump=0]  what a jump of detour costs you
 * @returns {{stops: {locationId, systemId, lines: {typeId, spot, units, price, sellAt, profit}[], cost, volume, profit}[],
 *   cost, volume, profit, short: {typeId, spot, units}[]}}  short = need left unfilled
 */
export function planPurchases(needs, asks, { unitVolume, feeRate = 0, maxVolume = Infinity, maxCost = Infinity, maxStops = 3, minMargin = 0,
  start = null, jumps = null, iskPerJump = 0 }) {
  const left = needs.map(n => n.units);
  const byType = new Map();
  needs.forEach((n, k) => { if (!byType.has(n.typeId)) byType.set(n.typeId, []); byType.get(n.typeId).push(k); });
  // Orders by station, only for the types something needs.
  const stations = new Map();
  for (const [typeId, list] of asks) {
    if (!byType.has(typeId)) continue;
    for (const o of list) {
      let s = stations.get(o.locationId);
      if (!s) stations.set(o.locationId, s = { locationId: o.locationId, systemId: o.systemId, orders: [] });
      s.orders.push({ ...o, typeId, left: o.volume });
    }
  }
  const room = (vol, price, v, c) => Math.max(maxVolume < Infinity ? vol / Math.max(v, 1e-9) : 0, maxCost < Infinity ? price / Math.max(c, 1e-9) : 0);

  // What buying at one station would take, without committing it.
  function shop(st, vol, cash, commit) {
    const pairs = [];
    for (const o of st.orders) {
      if (o.left <= 0) continue;
      for (const k of byType.get(o.typeId)) {
        const margin = needs[k].sellAt * (1 - feeRate) - o.price;
        if (left[k] > 0 && margin > minMargin) pairs.push({ o, k, margin, eff: margin / (room(unitVolume(o.typeId), o.price, maxVolume, maxCost) || 1) });
      }
    }
    pairs.sort((a, b) => b.eff - a.eff || b.margin - a.margin);
    const used = new Map(), want = new Map();   // order → units taken, need → units taken (this pass)
    const lines = [];
    let cost = 0, volume = 0, profit = 0;
    for (const { o, k, margin } of pairs) {
      const m3 = unitVolume(o.typeId);
      let take = Math.min(o.left - (used.get(o) || 0), left[k] - (want.get(k) || 0));
      if (m3 > 0) take = Math.min(take, Math.floor((vol - volume) / m3 + 1e-9));
      take = Math.min(take, Math.floor((cash - cost) / o.price + 1e-9));
      if (take <= 0) continue;
      used.set(o, (used.get(o) || 0) + take);
      want.set(k, (want.get(k) || 0) + take);
      cost += take * o.price; volume += take * m3; profit += take * margin;
      lines.push({ typeId: o.typeId, spot: needs[k].spot, need: k, units: take, price: o.price, sellAt: needs[k].sellAt, profit: take * margin });
    }
    if (commit) {
      for (const [o, n] of used) o.left -= n;
      for (const [k, n] of want) left[k] -= n;
    }
    return { lines, cost, volume, profit };
  }

  const stops = [];
  const visited = start != null ? [start] : [];
  const detour = (sys) => {
    if (!jumps || !visited.length) return 0;
    let d = Infinity;
    for (const v of visited) { const j = v === sys ? 0 : jumps(v, sys); if (j != null && j < d) d = j; }
    return d;
  };
  let vol = maxVolume, cash = maxCost;
  while (stops.length < maxStops && vol > 0 && cash > 0) {
    let best = null, bestValue = 0;
    for (const st of stations.values()) {
      const d = detour(st.systemId);
      if (d === Infinity) continue;
      const value = shop(st, vol, cash, false).profit - d * iskPerJump;
      if (value > bestValue) { best = st; bestValue = value; }
    }
    if (!best) break;
    visited.push(best.systemId);
    const got = shop(best, vol, cash, true);
    stations.delete(best.locationId);
    vol -= got.volume; cash -= got.cost;
    // One line per item and hotspot, at the average price paid.
    const merged = new Map();
    for (const l of got.lines) {
      const key = `${l.typeId}|${l.spot}`, m = merged.get(key);
      if (m) { m.price = (m.price * m.units + l.price * l.units) / (m.units + l.units); m.units += l.units; m.profit += l.profit; }
      else merged.set(key, { typeId: l.typeId, spot: l.spot, units: l.units, price: l.price, sellAt: l.sellAt, profit: l.profit });
    }
    stops.push({ locationId: best.locationId, systemId: best.systemId, lines: [...merged.values()].sort((a, b) => b.profit - a.profit),
      cost: got.cost, volume: got.volume, profit: got.profit });
  }
  const sum = (f) => stops.reduce((s, x) => s + x[f], 0);
  return {
    stops, cost: sum('cost'), volume: sum('volume'), profit: sum('profit'),
    short: needs.map((n, k) => ({ typeId: n.typeId, spot: n.spot, units: left[k] })).filter(x => x.units > 0),
  };
}

/**
 * The order to fly: from `start`, every buy stop (fewest jumps), then every drop-off (fewest jumps
 * from the last buy).
 * @param {(a: number, b: number) => number|null} jumps  between two systems, null = unreachable
 * @returns {{order: {kind: 'buy'|'sell', index, systemId, hop}[], jumps, unreachable: boolean}}
 *   index into buys or drops; hop = jumps from the previous stop
 */
export function supplyRoute(start, buys, drops, jumps) {
  const j = (a, b) => (a === b ? 0 : jumps(a, b) ?? UNREACHABLE);
  const matrix = (ids) => ids.map(a => ids.map(b => j(a, b)));
  const out = [];
  let at = start, total = 0;
  for (const [kind, list] of [['buy', buys], ['sell', drops]]) {
    if (!list.length) continue;
    const ids = [at, ...list];
    for (const k of optimizeOrder(matrix(ids)).slice(1)) {
      const hop = j(at, ids[k]);
      out.push({ kind, index: k - 1, systemId: ids[k], hop });
      total += hop; at = ids[k];
    }
  }
  return { order: out, jumps: total, unreachable: total >= UNREACHABLE };
}

/**
 * Where to sell near a hotspot: the station within `radius` jumps with the most sell orders
 * across `orders` (the local market), the nearest on a tie. Null when none has any.
 * @param {Iterable<object>} orders  normalized orders (any items)
 */
export function marketStation(orders, jumps, radius, { structures = true, isNpc = () => true } = {}) {
  const count = new Map();
  for (const o of orders) {
    if (o.isBuyOrder || o.ghost || (!structures && !isNpc(o.locationId))) continue;
    const d = jumps(o.systemId);
    if (d == null || d > radius) continue;
    const c = count.get(o.locationId);
    if (c) c.n++; else count.set(o.locationId, { locationId: o.locationId, systemId: o.systemId, jumps: d, n: 1 });
  }
  let best = null;
  for (const c of count.values()) if (!best || c.n > best.n || (c.n === best.n && c.jumps < best.jumps)) best = c;
  return best;
}
