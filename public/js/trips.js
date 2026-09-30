// Pure multi-stop trip planning over universe-scan hauls — no DOM, no fetch.
//
// A trip strings hauls together in one hold: buy item 1, buy item 2 on the way while item 1 is
// still aboard, sell each at its own station, buy the next where you sold, and so on. *Cargo m³*
// and *Budget* cap what is aboard at any moment: a sale frees room for the next purchase, and a
// haul that no longer fits whole is bought in part (its cheapest units).

import { summarizeSteps } from './arbitrage.js';

export const SHIP_CATEGORY = 6;

/**
 * Turn raw universe-scan candidates into priced hauls ("legs") under the player's limits.
 * Each leg can be re-priced for less room with its (non-enumerable) refit(maxVolume, maxCost),
 * which returns the smaller load, or null when that is no longer worth `minProfit`.
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
    const unitVolume = info[1] || 0;
    const s = summarizeSteps(c.s, { taxRate, unitVolume, maxVolume, maxCost });
    if (s.units <= 0 || s.profit <= 0 || s.profit < minProfit) continue;
    const leg = { t: c.t, name: info[0], f: c.f, fs: c.fs, d: c.d, ds: c.ds, x: !!c.x, hub: !!c.hub, ...s };
    Object.defineProperty(leg, 'refit', {
      value: (vol, cost) => {
        const r = summarizeSteps(c.s, { taxRate, unitVolume, maxVolume: Math.min(vol, maxVolume), maxCost: Math.min(cost, maxCost) });
        return r.units > 0 && r.profit > 0 && r.profit >= minProfit ? r : null;
      },
    });
    legs.push(leg);
  }
  return legs;
}

// Bounded min-heap on .score: keeps the `cap` best records pushed into it.
function topK(cap) {
  const h = [];
  const up = (i) => {
    const x = h[i];
    while (i > 0) { const p = (i - 1) >> 1; if (h[p].score <= x.score) break; h[i] = h[p]; i = p; }
    h[i] = x;
  };
  const down = (i) => {
    const x = h[i], n = h.length;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && h[c + 1].score < h[c].score) c++;
      if (h[c].score >= x.score) break;
      h[i] = h[c]; i = c;
    }
    h[i] = x;
  };
  return {
    /** Lowest score that would still get in. */
    floor: () => (h.length < cap ? -Infinity : h[0].score),
    push(r) {
      if (h.length < cap) { h.push(r); up(h.length - 1); }
      else if (r.score > h[0].score) { h[0] = r; down(0); }
    },
    sorted: () => h.sort((a, b) => b.score - a.score),
  };
}

/**
 * Best multi-stop trips, found with a beam search over stops. From each partial trip it tries
 * flying to sell any haul aboard, and buying any haul whose pickup is at most `maxLink` jumps
 * out of the way (with an empty hold: at most `maxLink` jumps away). Arriving somewhere sells
 * everything bound there before buying.
 * @param {object[]} legs            from evaluateLegs
 * @param {object} o
 * @param {number} o.start           system you start in
 * @param {(sys: number) => (sys: number) => number|null} o.distFrom   jump-distance lookup factory
 * @param {number} [o.maxLegs=3]     hauls per trip
 * @param {number} [o.maxLink=3]     extra jumps allowed to pick up a haul (empty jumps, with an empty hold)
 * @param {number} [o.maxVolume]     cargo m³ aboard at once
 * @param {number} [o.maxCost]       ISK tied up in cargo at once
 * @param {'perJump'|'profit'} [o.rank='perJump']
 * @param {number} [o.maxReuse=2]   listed trips a single haul may appear in
 * @returns {{legs, events, startJumps, jumps, profit, peakCost, peakVolume, perJump}[]} trips with ≥ 2 legs, best first;
 *   events are the stops in flying order: {kind: 'buy'|'sell', leg (index into legs), hop (jumps from the previous event)}
 */
export function planTrips(legs, { start, distFrom, maxLegs = 3, maxLink = 3, rank = 'perJump', maxVolume = Infinity, maxCost = Infinity,
  beam = 400, perPickup = 8, limit = 60, maxReuse = 2, spread = 4, keep = 16 } = {}) {
  // One lookup per system; distFrom itself runs a BFS per system.
  const lookups = new Map();
  const dist = (s) => { let f = lookups.get(s); if (!f) lookups.set(s, f = distFrom(s)); return f; };

  // Pickup systems, each with its best hauls. A haul is dropped once we know it can't be flown.
  const bySys = new Map(), seen = new Set();
  legs.forEach((L, i) => {
    const key = `${L.t}:${L.f}:${L.d}`;
    if (seen.has(key)) return;
    seen.add(key);
    let list = bySys.get(L.fs);
    if (!list) bySys.set(L.fs, list = []);
    list.push({
      L, i, t: L.t, fs: L.fs, ds: L.ds, f: L.f, d: L.d, profit: L.profit, cost: L.cost, volume: L.volume || 0, jl: undefined,
      uv: L.units ? (L.volume || 0) / L.units : 0, buy: L.buy || L.cost / L.units, margin: L.sell - L.buy || Infinity,
    });
  });
  const pickSys = [...bySys.keys()];
  const P = pickSys.length;
  const legsAt = pickSys.map(s => bySys.get(s).sort((a, b) => b.profit - a.profit));
  const legJumps = (H) => {
    if (H.jl === undefined) H.jl = H.fs === H.ds ? 0 : dist(H.fs)(H.ds);
    return H.jl;
  };

  // Per system: jumps to every pickup (-1: unreachable), and the pickups ordered by it.
  const rows = new Map();
  const rowOf = (s) => {
    let r = rows.get(s);
    if (r) return r;
    const d = new Int16Array(P), from = dist(s);
    let max = 0;
    for (let k = 0; k < P; k++) { const j = from(pickSys[k]); d[k] = j == null ? -1 : j; if (j > max) max = j; }
    const count = new Uint32Array(max + 2);
    for (let k = 0; k < P; k++) if (d[k] >= 0) count[d[k] + 1]++;
    for (let j = 1; j < count.length; j++) count[j] += count[j - 1];
    const order = new Uint32Array(count[max + 1]);
    for (let k = 0; k < P; k++) if (d[k] >= 0) order[count[d[k]]++] = k;
    rows.set(s, r = { d, order });
    return r;
  };

  const perJump = rank !== 'profit';
  const scoreOf = (gain, jumps) => (perJump ? gain / Math.max(1, jumps) : gain);

  // Trip states link back to their parent; `evs` are the buys and sales on arriving at `at`.
  const root = { at: start, jumps: 0, bank: 0, pend: 0, vol: 0, cost: 0, peakCost: 0, peakVol: 0, n: 0, open: [], used: [], prev: null, evs: [], hop: 0 };
  const found = [];

  // Arrive at `to` (hop jumps on), sell what is bound there, then buy H (if any) and sell it
  // too if it is bound for this very system.
  const build = (s, to, hop, H0, fit) => {
    const H = fit ? { ...H0, profit: fit.profit, cost: fit.cost, volume: fit.volume, fit } : H0;
    const evs = [], open = [];
    let bank = s.bank, pend = s.pend, vol = s.vol, cost = s.cost;
    for (const o of s.open) {
      if (o.ds !== to) { open.push(o); continue; }
      evs.push({ kind: 'sell', H: o });
      bank += o.profit; pend -= o.profit; vol -= o.volume; cost -= o.cost;
    }
    let peakCost = s.peakCost, peakVol = s.peakVol, used = s.used, n = s.n;
    if (H) {
      evs.push({ kind: 'buy', H });
      used = [...used, H]; n++;
      peakCost = Math.max(peakCost, cost + H.cost); peakVol = Math.max(peakVol, vol + H.volume);
      if (H.ds === to) { evs.push({ kind: 'sell', H }); bank += H.profit; }
      else { open.push(H); pend += H.profit; vol += H.volume; cost += H.cost; }
    }
    return { at: to, jumps: s.jumps + hop, bank, pend, vol, cost, peakCost, peakVol, n, open, used, prev: s, evs, hop };
  };

  // Fewest jumps to sell everything bound for `drops` (distinct systems) starting at `from`,
  // with the drop-offs in that order: exact for up to 3 (jumps are symmetric), nearest first
  // beyond. null: something can't be reached.
  const tour = (from, drops) => {
    const k = drops.length;
    if (!k) return { jumps: 0, order: drops };
    const d = dist(from);
    if (k === 1) {
      const j = d(drops[0]);
      return j == null ? null : { jumps: j, order: drops };
    }
    if (k <= 3) {
      const [x, y, z] = drops, dxy = dist(x)(y);
      if (dxy == null) return null;
      if (k === 2) {
        const vx = d(x), vy = d(y);
        if (vx == null && vy == null) return null;
        return vy == null || (vx != null && vx <= vy) ? { jumps: vx + dxy, order: [x, y] } : { jumps: vy + dxy, order: [y, x] };
      }
      const dxz = dist(x)(z), dyz = dist(y)(z), vx = d(x), vy = d(y), vz = d(z);
      if (dxz == null || dyz == null) return null;
      let jumps = Infinity, order = null;
      // Visit one end of the path first; the middle one is the drop-off not at either end.
      const tryPath = (v, a, b, c, inner) => { if (v != null && v + inner < jumps) { jumps = v + inner; order = [a, b, c]; } };
      tryPath(vx, x, y, z, dxy + dyz); tryPath(vx, x, z, y, dxz + dyz);
      tryPath(vy, y, x, z, dxy + dxz); tryPath(vy, y, z, x, dyz + dxz);
      tryPath(vz, z, x, y, dxz + dxy); tryPath(vz, z, y, x, dyz + dxy);
      return order && { jumps, order };
    }
    const left = [...drops], order = [];
    let at = from, jumps = 0;
    while (left.length) {
      const da = dist(at);
      let best = -1, bj = Infinity;
      left.forEach((x, m) => { const j = da(x); if (j != null && j < bj) { bj = j; best = m; } });
      if (best < 0) return null;
      jumps += bj; at = left[best]; order.push(at); left.splice(best, 1);
    }
    return { jumps, order };
  };
  // Distinct drop-off systems of the hauls aboard, but `skip`.
  const dropsOf = (open, skip) => {
    const out = [];
    for (const o of open) if (o.ds !== skip && !out.includes(o.ds)) out.push(o.ds);
    return out;
  };

  // Every move scores as the trip it would be if it sold what's aboard and stopped buying, and is
  // kept as a finished trip too once it has 2 hauls: most of the listed trips come from these.
  let frontier = [root];
  for (let level = 0; level < 2 * maxLegs && frontier.length; level++) {
    const heap = topK(beam * 4);
    for (const s of frontier) {
      const here = s.at, fromHere = dist(here);
      const toDrop = s.open.map(o => fromHere(o.ds));
      const gain0 = s.bank + s.pend;

      // Sell: fly to the drop-off of something aboard.
      for (const D of dropsOf(s.open)) {
        const hop = fromHere(D);
        if (hop == null) continue;
        const rest = tour(D, dropsOf(s.open, D));
        if (!rest) continue; // something aboard could never be sold from there
        heap.push({ s, to: D, hop, H: null, rest, score: scoreOf(gain0, s.jumps + hop + rest.jumps) });
      }

      // Buy: a haul whose pickup is (nearly) on the way.
      if (s.n >= maxLegs) continue;
      // Finished trips from here: all of them share this state's hauls, and each haul is listed in
      // at most `maxReuse` trips, so only the best few can ever be shown (the rest of `keep` is
      // slack for trips whose new haul is already listed often enough).
      const mine = topK(keep);
      const row = rowOf(here), usedTypes = s.used.map(u => u.t);
      // A pickup a jumps away costs at least 2·(a − jumps to a drop-off) extra, so nothing past
      // the farthest drop-off + maxLink/2 can be on the way.
      const dropRows = s.open.map(o => rowOf(o.ds).d);
      const bound = s.open.length ? Math.max(...toDrop.map(j => j ?? -Infinity)) + (maxLink >> 1)
        : s.n === 0 ? Infinity : maxLink;
      for (let k = 0; k < row.order.length; k++) {
        const p = row.order[k], a = row.d[p];
        if (a > bound) break;
        if (s.open.length) {
          let detour = Infinity;
          for (let m = 0; m < s.open.length; m++) {
            const back = dropRows[m][p];
            if (back >= 0 && toDrop[m] != null) detour = Math.min(detour, a + back - toDrop[m]);
          }
          if (detour > maxLink) continue;
        }
        const sys = pickSys[p];
        // Arriving here sells what's bound here first.
        let fV = 0, fC = 0;
        for (const o of s.open) if (o.ds === sys) { fV += o.volume; fC += o.cost; }
        const roomV = maxVolume - (s.vol - fV), roomC = maxCost - (s.cost - fC);
        const aboard = dropsOf(s.open, sys), fromSys = dist(sys);
        let far0 = 0;
        for (const D of aboard) far0 = Math.max(far0, fromSys(D) ?? Infinity);
        if (far0 === Infinity) continue;
        const tours = new Map(); // by the new haul's drop-off
        // The first purchase can be any haul; after that, the `perPickup` most profitable that
        // fit, looking no further than 3 × perPickup down the list.
        let took = 0, looked = 0;
        const cap = s.n === 0 ? Infinity : perPickup;
        for (const H0 of legsAt[p]) {
          if (took >= cap || looked++ >= 3 * cap) break;
          if (usedTypes.includes(H0.t)) continue; // the same item twice would compete for the same orders
          const jl = legJumps(H0);
          if (jl == null) continue;
          // Whether it fits, or else the most a smaller load could earn: its first units have the
          // best margin, so no more than that margin (before tax) times the units that fit.
          const fits = H0.volume <= roomV + 1e-9 && H0.cost <= roomC + 1e-9;
          let most = H0.profit;
          if (!fits) {
            const units = Math.min(H0.uv > 0 ? Math.floor(roomV / H0.uv + 1e-9) : Infinity, Math.floor(roomC / H0.buy + 1e-9));
            if (units <= 0) continue;
            most = Math.min(most, units * H0.margin);
          }
          // Skip the selling tour and re-pricing when even that, over the fewest jumps the sales
          // could take, can't make the beam or this state's finished trips.
          const floor = Math.min(heap.floor(), s.n >= 1 ? mine.floor() : -Infinity);
          if (scoreOf(gain0 + most, s.jumps + a + Math.max(far0, jl)) <= floor) { took++; continue; }
          let rest = tours.get(H0.ds);
          if (rest === undefined) {
            tours.set(H0.ds, rest = tour(sys, aboard.includes(H0.ds) || H0.ds === sys ? aboard : [...aboard, H0.ds]));
          }
          if (!rest) continue;
          const jumps = s.jumps + a + rest.jumps;
          if (scoreOf(gain0 + most, jumps) <= floor) { took++; continue; }
          let fit = null;
          if (!fits) {
            fit = H0.L.refit?.(roomV, roomC);
            if (!fit) continue;
          }
          took++;
          const rec = { s, to: sys, hop: a, H: H0, fit, rest, score: scoreOf(gain0 + (fit || H0).profit, jumps) };
          if (s.n >= 1) mine.push(rec);
          heap.push(rec);
        }
      }
      found.push(...mine.sorted());
    }
    // Next frontier: the best distinct states (same place, same hauls done and aboard), with no
    // haul in more than `spread` of them, or a few lucrative ones crowd out every other idea.
    const seen = new Set(), inBeam = new Map();
    frontier = [];
    for (const r of heap.sorted()) {
      if (r.H && (inBeam.get(r.H.i) || 0) >= spread) continue;
      if (r.s.used.some(u => (inBeam.get(u.i) || 0) >= spread)) continue;
      const st = build(r.s, r.to, r.hop, r.H, r.fit);
      const key = `${st.at}|${st.used.map(u => u.i).sort((x, y) => x - y).join(',')}|${st.open.map(u => u.i).sort((x, y) => x - y).join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const u of st.used) inBeam.set(u.i, (inBeam.get(u.i) || 0) + 1);
      frontier.push(st);
      if (frontier.length >= beam) break;
    }
  }

  // Materialise a finished trip: the move, then the sales in tour order.
  const finish = (r) => {
    let st = build(r.s, r.to, r.hop, r.H, r.fit);
    for (const D of r.rest.order) st = build(st, D, dist(st.at)(D), null);
    return st;
  };

  // Finished trips, best first; each haul headlines at most `maxReuse` of them so one lucrative
  // trade doesn't fill the list with trips that only differ by a trivial extra stop.
  const uses = new Map(), keys = new Set(), out = [];
  const legKey = (H) => `${H.t}:${H.f}:${H.d}`;
  for (const r of found.sort((a, b) => b.score - a.score)) {
    const used = [...r.s.used, r.H];
    const key = used.map(legKey).join('>');
    if (keys.has(key)) continue;
    if (used.some(H => (uses.get(legKey(H)) || 0) >= maxReuse)) continue;
    keys.add(key);
    used.forEach(H => uses.set(legKey(H), (uses.get(legKey(H)) || 0) + 1));
    out.push(toTrip(finish(r)));
    if (out.length >= limit) break;
  }
  return out;
}

// A finished search state as a plain trip (it goes to sessionStorage, so nothing but data).
function toTrip(st) {
  const chain = [];
  for (let s = st; s.prev; s = s.prev) chain.push(s);
  chain.reverse();
  const index = new Map(st.used.map((H, k) => [H.i, k]));
  const events = [];
  let startJumps = null;
  // Everything done in one system without flying on: sales first (they only free room), then
  // purchases grouped by station, so no station is docked at twice.
  let run = [], sys = null;
  const flush = () => {
    const order = [...new Set(run.map(e => e.loc))];
    run.sort((x, y) => (x.kind === y.kind ? order.indexOf(x.loc) - order.indexOf(y.loc) : x.kind === 'sell' ? -1 : 1));
    run.forEach((e, k) => events.push({ kind: e.kind, leg: e.leg, hop: k ? 0 : e.hop }));
    run = [];
  };
  for (const s of chain) {
    startJumps ??= s.hop;
    s.evs.forEach((e, k) => {
      const hop = k ? 0 : s.hop, at = e.kind === 'buy' ? e.H.fs : e.H.ds;
      if (hop || at !== sys) flush();
      sys = at;
      run.push({ kind: e.kind, leg: index.get(e.H.i), hop, loc: e.kind === 'buy' ? e.H.f : e.H.d });
    });
  }
  flush();
  const legs = st.used.map(H => (H.fit ? { ...H.L, ...H.fit } : { ...H.L }));
  return {
    legs, events, startJumps, jumps: st.jumps, profit: st.bank, peakCost: st.peakCost, peakVolume: st.peakVol,
    perJump: st.bank / Math.max(1, st.jumps),
  };
}

/**
 * Waypoints for a trip, in flying order: [{systemId, locationId, sells: [leg], buys: [leg]}].
 * One stop per station visit: what to sell there, then what to buy.
 */
export function tripStops(trip) {
  // Trips planned before hauls could share the hold: each leg sold before the next is bought.
  const events = trip.events || trip.legs.flatMap((_, i) => [{ kind: 'buy', leg: i }, { kind: 'sell', leg: i }]);
  const stops = [];
  for (const e of events) {
    const L = trip.legs[e.leg];
    const systemId = e.kind === 'buy' ? L.fs : L.ds, locationId = e.kind === 'buy' ? L.f : L.d;
    let st = stops[stops.length - 1];
    // A sale after a purchase at the same station is a second visit only if it can't be merged.
    if (!st || st.locationId !== locationId || (e.kind === 'sell' && st.buys.length)) {
      stops.push(st = { systemId, locationId, sells: [], buys: [] });
    }
    (e.kind === 'buy' ? st.buys : st.sells).push(L);
  }
  return stops;
}
