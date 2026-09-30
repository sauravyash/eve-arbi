// What a load of ore, gas or ice fetches at every station that buys it: the mining page's maths.
// Pure: no DOM, no fetch.
//
// Selling a load means filling buy orders, best price first, until the load runs out. From a
// station you can fill every buy order whose range reaches it (ranges.js rules: the order's own
// station, its system, N jumps on the gate graph, or its whole region, never across a region
// border). So each station's value for an item walks all the reachable orders, not just the
// ones placed there.

import { REGION, bookEntry } from './ranges.js';
import { jumpsFrom } from './galaxy.js';

/**
 * Stations worth pricing a load at: every buy order's own station, plus the station nearest
 * `fromSystem` that each ranged order reaches (ranges.js context), plus any `always` stations.
 * @returns {Map<number, number>} locationId → systemId
 */
export function candidateStations(entries, ctx, fromSystem, always = []) {
  const points = new Map();
  const add = (l, s) => { if (l != null && s != null && !points.has(l)) points.set(l, s); };
  for (const [l, s] of always) add(l, s);
  for (const entry of entries) {
    for (const G of entry.bids) {
      if (!G.lv.length) continue;
      add(G.l, G.s);
      if (G.r >= 0 && fromSystem != null) {
        const w = G.r === REGION ? ctx.regionEntry(fromSystem, G.g) : ctx.towards(fromSystem, G.s, G.r, G.g);
        if (w != null && w !== G.s) add(ctx.stationIn(w), w);
      }
    }
  }
  return points;
}

// Fill `qty` units into price levels [[price, volume]] (best first). Returns {units, gross}.
export function fill(levels, qty) {
  let units = 0, gross = 0;
  for (const [price, volume] of levels) {
    if (units >= qty) break;
    const n = Math.min(volume, qty - units);
    units += n; gross += n * price;
  }
  return { units, gross };
}

/**
 * Prices a load at every candidate station.
 * @param {{typeId: number, qty: number, volume?: number}[]} items   volume = m³ per unit
 * @param {Record<number, object[]>} books   market-merge normalised orders per type
 * @param {object} g     galaxy.js gate graph (no wormhole shortcuts: ranges follow gates)
 * @param {object} ctx   ranges.js buildRangeContext(g, stations)
 * @param {object} [o]
 * @param {number} [o.fromSystem]        where you are, to find the nearest in-range station
 * @param {number} [o.taxRate]           sales tax, 0–1
 * @param {[number, number][]} [o.always]  [locationId, systemId] stations to price even without orders (hubs)
 * @param {(locationId: number, systemId: number) => boolean} [o.allowStation]
 * @returns {{locationId, systemId, isk, gross, share, lines: {typeId, units, gross, isk, best}[]}[]}
 *   isk after tax; share = part of the load sold (by m³ when volumes are known, else units); best
 *   = highest price reachable there. Sorted by isk, highest first.
 */
export function priceLoad(items, books, g, ctx, { fromSystem = null, taxRate = 0, always = [], allowStation = () => true } = {}) {
  const want = items.filter(it => it.qty > 0);
  const entries = want.map(it => bookEntry(books[it.typeId] || []));
  const points = candidateStations(entries, ctx, fromSystem, always);
  for (const [l, s] of points) if (!allowStation(l, s)) points.delete(l);

  const idx = (s) => g.indexOf.get(s);
  const bySystem = new Map(), byRegion = new Map();
  for (const [l, s] of points) {
    (bySystem.get(s) || bySystem.set(s, []).get(s)).push(l);
    const i = idx(s);
    const r = i == null ? null : g.regionId[i];
    if (r != null) (byRegion.get(r) || byRegion.set(r, []).get(r)).push([l, s]);
  }
  // Stations each buy-order group can be filled from.
  const reached = (G) => {
    if (G.r === -1) return points.has(G.l) ? [G.l] : [];
    if (G.r === 0) return bySystem.get(G.s) || [];
    const inRegion = byRegion.get(G.g) || [];
    if (G.r === REGION) return inRegion.map(([l]) => l);
    const d = jumpsFrom(g, G.s, 'shortest');
    return inRegion.filter(([, s]) => { const i = idx(s); return i != null && d[i] >= 0 && d[i] <= G.r; }).map(([l]) => l);
  };

  // levels[locationId][item index] = [[price, volume], …]
  const levels = new Map();
  entries.forEach((entry, k) => {
    for (const G of entry.bids) {
      if (!G.lv.length) continue;
      for (const l of reached(G)) {
        let row = levels.get(l);
        if (!row) levels.set(l, row = want.map(() => []));
        row[k].push(...G.lv);
      }
    }
  });

  const totalOf = (it) => it.qty * (it.volume > 0 ? it.volume : 1);
  const total = want.reduce((s, it) => s + totalOf(it), 0);
  const keep = 1 - taxRate;
  const out = [];
  for (const [l, row] of levels) {
    let gross = 0, soldPart = 0;
    const lines = want.map((it, k) => {
      const lv = row[k].sort((a, b) => b[0] - a[0]);
      const f = fill(lv, it.qty);
      gross += f.gross;
      soldPart += totalOf(it) * (f.units / it.qty);
      return { typeId: it.typeId, units: f.units, gross: f.gross, isk: f.gross * keep, best: lv[0]?.[0] ?? null };
    });
    if (gross <= 0) continue;
    out.push({ locationId: l, systemId: points.get(l), gross, isk: gross * keep, share: total ? soldPart / total : 0, lines });
  }
  // Stations asked for by name still get a row, even when nothing there buys the load.
  for (const [l, s] of always) {
    if (points.has(l) && !levels.has(l)) {
      out.push({ locationId: l, systemId: s, gross: 0, isk: 0, share: 0,
        lines: want.map(it => ({ typeId: it.typeId, units: 0, gross: 0, isk: 0, best: null })) });
    }
  }
  return out.sort((a, b) => b.isk - a.isk);
}

/**
 * Items as pasted from EVE (inventory "Copy", plain or with <t>/<right> markup, or a list of "name qty" lines). Quantities may use
 * thousands separators. Unknown names are returned separately.
 * @param {string} text
 * @param {(name: string) => number|null} typeIdOf   exact name (any case) → type ID
 * @returns {{items: {typeId, qty}[], unknown: string[]}}  one entry per type, quantities summed (1 when missing)
 */
export function parsePaste(text, typeIdOf) {
  const sum = new Map(), unknown = [];
  for (const raw of String(text || '').split(/\r?\n|<br\s*\/?>/i)) {
    // EVE's rich-text copy marks tabs as <t> and alignment as <right>, <left>, <center>…
    const line = raw.replace(/<t>/gi, '\t').replace(/<\/?[a-z][^<>]*>/gi, '').trim();
    if (!line) continue;
    let name, qty = null, m;
    const cols = line.split('\t').map(c => c.trim());
    if (cols.length > 1) [name, qty] = [cols[0], toQty(cols[1])];
    else if ((m = line.match(/^(.+?)\s+(?:x\s*)?(\d[\d,.\s]*)$/i))) [name, qty] = [m[1], toQty(m[2])];   // Veldspar 12,345 / Veldspar x 12,345
    else if ((m = line.match(/^(\d[\d,.\s]*?)\s*x?\s+(\D.*)$/i))) [name, qty] = [m[2], toQty(m[1])]; // 12,345 x Veldspar
    else name = line;
    const id = typeIdOf(name.replace(/\*$/, '').trim());
    if (id == null) { unknown.push(name); continue; }
    sum.set(id, (sum.get(id) || 0) + (qty ?? 1));
  }
  return { items: [...sum].map(([typeId, qty]) => ({ typeId, qty })), unknown };
}

// "12,345" / "12 345" / "12.345" (European thousands) → 12345. EVE only shows whole units here.
function toQty(s) {
  const digits = String(s ?? '').replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
}
