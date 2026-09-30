// Buy-order ranges, shared by the universe scan (server) and the watchlist hauls (browser).
// Pure: no DOM, no fetch, no Node APIs.
//
// A buy order can be filled from any station within its range: the same station, the same
// system, N jumps (measured on the shortest path, as the game does), or the whole region, and
// never across a region border. So for each place you could buy (A), we look for the nearest
// stations where in-range buy orders can be filled (X), and walk A's asks against every buy order
// reachable from X. That finds shorter trips than delivering to each order's own station, and
// "sell where you buy" flips (X = A, 0 jumps).

import { matchSteps } from './arbitrage.js';
import { MAJOR_HUB_SYSTEMS } from './market-merge.js';
import { jumpsFrom } from './galaxy.js';

const MAX_SOURCES = 25;                 // cheapest selling stations tried per item
const MAX_GROUPS = 60;                  // best buy-order groups (station × range) considered per item
const MAX_SELL_POINTS = 40;             // delivery stations tried per source
const MAX_STEPS = 30;                   // fill steps kept per pair
export const MIN_PROFIT = 250_000;      // ISK before tax/caps (scan default)
const KEEP_OFFHUB = 8, KEEP_OFFHUB_NEAR = 8, KEEP_HUB = 4;

// Buy-order range codes: -1 station, 0 solar system, N jumps, REGION whole region.
export const REGION = 10_000;
// ESI spelling ('station', 'solarsystem', 'region', '5').
export const rangeCode = (r) => (r === 'station' ? -1 : r === 'solarsystem' ? 0 : r === 'region' ? REGION : Number(r));
// Normalised spelling used by market-merge ('STATION', 'SOLARSYSTEM', 'REGION', '_5').
export const rangeCodeOf = (r) => (r === 'STATION' ? -1 : r === 'SOLARSYSTEM' ? 0 : r === 'REGION' ? REGION : Number(String(r).replace(/^_/, '')));

/**
 * Geometry for range matching, built from universe.json and stations.json.
 * Distances are shortest-path jump counts (what order ranges use); -1 = unreachable/unknown.
 */
export function buildRangeContext(g, stations) {
  const stationIn = new Map();            // systemId → an NPC station there (lowest ID, stable)
  for (const [id, [, sys]] of Object.entries(stations || {})) {
    const cur = stationIn.get(sys);
    if (cur == null || Number(id) < cur) stationIn.set(sys, Number(id));
  }
  const idx = (sys) => g.indexOf.get(sys);
  const dist = (fromSys) => (idx(fromSys) == null ? null : jumpsFrom(g, fromSys, 'shortest'));
  const regionOf = (sys) => { const i = idx(sys); return i == null ? null : g.regionId[i]; };
  const hasStation = (i) => stationIn.has(g.id[i]);
  // Step one jump along a shortest path downhill in `d` (d[next] = d[cur] - 1).
  const downhill = (i, d) => {
    for (let k = g.start[i]; k < g.start[i + 1]; k++) if (d[g.adj[k]] === d[i] - 1) return g.adj[k];
    return -1;
  };

  // Nearest system with an NPC station within `radius` jumps of `target` and inside `regionId`
  // (market orders never reach across a region border), walking from `from` along a shortest
  // path. null when unreachable or when only `target` itself qualifies but has no NPC station
  // (then the order's own location is the sell point).
  function towards(from, target, radius, regionId) {
    const d = dist(target), i0 = idx(from);
    if (!d || i0 == null || d[i0] < 0) return null;
    const ok = (i) => hasStation(i) && g.regionId[i] === regionId;
    let i = i0;
    while (i >= 0 && d[i] > radius) i = downhill(i, d);
    while (i >= 0 && !ok(i) && d[i] > 0) i = downhill(i, d);
    return i >= 0 && ok(i) ? g.id[i] : null;
  }

  // Nearest system with an NPC station inside `regionId`, walking from `from`.
  const regionDist = new Map();
  function regionEntry(from, regionId) {
    let d = regionDist.get(regionId);
    if (!d) {
      d = new Int16Array(g.n).fill(-1);
      const q = new Uint32Array(g.n);
      let head = 0, tail = 0;
      for (let i = 0; i < g.n; i++) if (g.regionId[i] === regionId && hasStation(i)) { d[i] = 0; q[tail++] = i; }
      while (head < tail) {
        const v = q[head++];
        for (let k = g.start[v]; k < g.start[v + 1]; k++) {
          const w = g.adj[k];
          if (d[w] === -1) { d[w] = d[v] + 1; q[tail++] = w; }
        }
      }
      regionDist.set(regionId, d);
    }
    let i = idx(from);
    if (i == null || d[i] < 0) return null;
    while (i >= 0 && d[i] > 0) i = downhill(i, d);
    return i >= 0 ? g.id[i] : null;
  }

  // Can a seller docked at station `x` (in system `xs`) fill buy-order group G?
  // Orders are regional: ranges never extend into a neighbouring region.
  function reaches(G, x, xs) {
    if (G.r === -1) return G.l === x;
    if (G.r === 0) return G.s === xs;
    if (regionOf(xs) !== G.g) return false;
    if (G.r === REGION) return true;
    const d = dist(G.s), i = idx(xs);
    return !!d && i != null && d[i] >= 0 && d[i] <= G.r;
  }

  const jumps = (a, b) => { const d = dist(a), i = idx(b); return d && i != null && d[i] >= 0 ? d[i] : null; };
  return { towards, regionEntry, reaches, jumps, stationIn: (s) => stationIn.get(s) ?? null };
}

const isHubSys = (s) => MAJOR_HUB_SYSTEMS.has(s);

/**
 * Profitable hauls for one item. Returns candidates {t, f, fs, d, ds, s, hub, x}:
 * buy at f (system fs), sell at d (system ds) into every buy order reachable from there;
 * s = fill steps [units, buy, sell]; x = true when the fill uses orders placed elsewhere (range).
 */
export function pairsForType(typeId, entry, ctx, { minProfit = MIN_PROFIT, keep = true, maxSources = MAX_SOURCES, maxSteps = MAX_STEPS } = {}) {
  const sources = entry.asks.filter(x => x.a.length).sort((x, y) => x.a[0][0] - y.a[0][0]).slice(0, maxSources);
  if (!sources.length) return [];
  const minAsk = sources[0].a[0][0];
  const groups = entry.bids.filter(G => G.lv.length && G.lv[0][0] > minAsk)
    .sort((x, y) => y.lv[0][0] - x.lv[0][0]).slice(0, MAX_GROUPS);
  if (!groups.length) return [];
  // Every bid level, best first, tagged with its group.
  const flat = groups.flatMap((G, gi) => G.lv.filter(([p]) => p > minAsk).map(([price, volume]) => ({ price, volume, gi })))
    .sort((x, y) => y.price - x.price);

  const found = [];
  for (const A of sources) {
    const bestAsk = A.a[0][0];
    // Where could we sell? Each order's own station, plus the nearest in-range station toward A.
    const points = new Map();
    const add = (l, s) => { if (l != null && s != null && !points.has(l) && points.size < MAX_SELL_POINTS) points.set(l, s); };
    for (const G of groups) {
      if (G.lv[0][0] <= bestAsk) continue;
      if (G.r >= 0) {
        const w = G.r === REGION ? ctx.regionEntry(A.s, G.g) : ctx.towards(A.s, G.s, G.r, G.g);
        // In the order's own system its own station is as close, and listing another would repeat the haul.
        if (w != null) add(w === A.s ? A.l : w === G.s ? G.l : ctx.stationIn(w), w);
      }
      add(G.l, G.s);
    }
    let asks = null;
    for (const [x, xs] of points) {
      const mask = groups.map(G => ctx.reaches(G, x, xs));
      const bids = flat.filter(b => mask[b.gi] && b.price > bestAsk);
      if (!bids.length) continue;
      asks ||= A.a.map(([price, volume]) => ({ price, volume }));
      const steps = matchSteps(asks, bids, 0, maxSteps);
      const profit = steps.reduce((s, [n, buy, sell]) => s + n * (sell - buy), 0);
      if (profit < minProfit) continue;
      const lastSell = steps[steps.length - 1][2];
      const x2 = bids.some(b => b.price >= lastSell && groups[b.gi].l !== x);
      const hj = A.s === xs ? 0 : ctx.jumps(A.s, xs);
      found.push({ t: typeId, f: A.l, fs: A.s, d: x, ds: xs, s: steps, p: profit, hj,
        hub: isHubSys(A.s) || isHubSys(xs), x: x2 || undefined });
    }
  }
  if (!keep) return found.map(({ p, hj, ...c }) => c);
  // Keep the most profitable, plus the best per jump (short hops lose on raw profit), per hub quota.
  const off = found.filter(c => !c.hub);
  const pick = new Set(off.sort((a, b) => b.p - a.p).slice(0, KEEP_OFFHUB));
  off.filter(c => c.hj != null).sort((a, b) => b.p / (b.hj + 1) - a.p / (a.hj + 1))
    .filter(c => !pick.has(c)).slice(0, KEEP_OFFHUB_NEAR).forEach(c => pick.add(c));
  found.filter(c => c.hub).sort((a, b) => b.p - a.p).slice(0, KEEP_HUB).forEach(c => pick.add(c));
  return [...pick].map(({ p, hj, ...c }) => c);
}

/**
 * One item's merged order book (market-merge's normalised orders) in pairsForType's shape:
 * asks grouped by station, buy orders grouped by station × range.
 * @param {(q: {locationId, systemId}) => boolean} [allowSource]  stations you'd consider buying at
 */
export function bookEntry(orders, { includeGhosts = false, allowSource = () => true } = {}) {
  const asks = new Map(), bids = new Map();
  for (const o of orders) {
    if (o.ghost && !includeGhosts) continue;
    let slot;
    if (o.isBuyOrder) {
      if (o.minVolume > 1) continue; // bait
      const r = rangeCodeOf(o.range), key = `${o.locationId}|${r}`;
      slot = bids.get(key);
      if (!slot) bids.set(key, slot = { l: o.locationId, s: o.systemId, r, g: o.regionId, m: new Map() });
    } else {
      if (!allowSource({ locationId: o.locationId, systemId: o.systemId })) continue;
      slot = asks.get(o.locationId);
      if (!slot) asks.set(o.locationId, slot = { l: o.locationId, s: o.systemId, m: new Map() });
    }
    slot.m.set(o.price, (slot.m.get(o.price) || 0) + o.volumeRemain);
  }
  return {
    asks: [...asks.values()].map(({ m, ...x }) => ({ ...x, a: [...m].sort((p, q) => p[0] - q[0]) })),
    bids: [...bids.values()].map(({ m, ...x }) => ({ ...x, lv: [...m].sort((p, q) => q[0] - p[0]) })),
  };
}

/**
 * Where to sell, counting ranges: each buy order's own station, plus the station nearest to
 * `fromSystem` that its range reaches. For every such point, the best price among all buy orders
 * that can be filled there.
 * @returns {{locationId, systemId, bestBid, bidVolume, via: {locationId, systemId}|null}[]} best price first;
 *   bidVolume = units wanted at that best price; via = where the best order was placed, when elsewhere
 */
export function sellPoints(entry, ctx, fromSystem) {
  const points = new Map();
  const add = (l, s) => { if (l != null && s != null && !points.has(l)) points.set(l, s); };
  for (const G of entry.bids) {
    if (!G.lv.length) continue;
    add(G.l, G.s);
    if (G.r >= 0 && fromSystem != null) {
      const w = G.r === REGION ? ctx.regionEntry(fromSystem, G.g) : ctx.towards(fromSystem, G.s, G.r, G.g);
      if (w != null && w !== G.s) add(ctx.stationIn(w), w);
    }
  }
  const out = [];
  for (const [l, s] of points) {
    let best = -Infinity, vol = 0, via = null;
    for (const G of entry.bids) {
      if (!G.lv.length || !ctx.reaches(G, l, s)) continue;
      const [p, v] = G.lv[0];
      if (p > best) { best = p; vol = v; via = G.l === l ? null : { locationId: G.l, systemId: G.s }; }
      else if (p === best) { vol += v; if (G.l === l) via = null; }
    }
    if (best > -Infinity) out.push({ locationId: l, systemId: s, bestBid: best, bidVolume: vol, via });
  }
  return out.sort((a, b) => b.bestBid - a.bestBid);
}
