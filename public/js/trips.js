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
    Object.defineProperties(leg, {
      refit: {
        value: (vol, cost) => {
          const r = summarizeSteps(c.s, { taxRate, unitVolume, maxVolume: Math.min(vol, maxVolume), maxCost: Math.min(cost, maxCost) });
          return r.units > 0 && r.profit > 0 && r.profit >= minProfit ? r : null;
        },
      },
      // refit's units, profit and cost only, for the planner's inner loop: the same walk as
      // summarizeSteps without its extra fields and allocations.
      fit: {
        value: (vol, cost) => {
          const V = Math.min(vol, maxVolume), C = Math.min(cost, maxCost);
          let units = 0, profit = 0, spent = 0;
          for (const [n, buy, sell] of c.s) {
            const margin = sell * (1 - taxRate) - buy;
            if (margin <= 0) break;
            let take = n;
            if (unitVolume > 0) take = Math.min(take, Math.floor((V - units * unitVolume) / unitVolume + 1e-9));
            take = Math.min(take, Math.floor((C - spent) / buy + 1e-9));
            if (take <= 0) break;
            units += take; profit += take * margin; spent += take * buy;
            if (take < n) break;
          }
          return units > 0 && profit > 0 && profit >= minProfit ? { units, profit, cost: spent, volume: units * unitVolume, room: [vol, cost] } : null;
        },
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
 * @param {(sys: number) => (sys: number) => number|null} [o.distFrom]  jump-distance lookup factory
 * @param {{indexOf: Map<number, number>, from: (sys: number) => Int16Array}} [o.jumps]  faster: jumps from a
 *   system as a row indexed like the graph (galaxy.js jumpsFrom, -1 unreachable); used instead of distFrom
 * @param {number} [o.maxLegs=3]     hauls per trip
 * @param {number} [o.maxLink=3]     extra jumps allowed to pick up a haul (empty jumps, with an empty hold)
 * @param {number} [o.maxVolume]     cargo m³ aboard at once
 * @param {number} [o.maxCost]       ISK tied up in cargo at once
 * @param {number} [o.maxJumps]      longest trip, counting the flight from `start`
 * @param {'perJump'|'profit'} [o.rank='perJump']
 * @param {number} [o.maxReuse=2]   listed trips a single haul may appear in
 * @returns {{legs, events, startJumps, jumps, profit, peakCost, peakVolume, perJump}[]} trips with ≥ 2 legs, best first;
 *   events are the stops in flying order: {kind: 'buy'|'sell', leg (index into legs), hop (jumps from the previous event)}
 */
export function planTrips(legs, { start, distFrom, jumps, maxLegs = 3, maxLink = 3, rank = 'perJump', maxVolume = Infinity, maxCost = Infinity,
  maxJumps = Infinity, beam = 400, perPickup = 80, limit = 60, maxReuse = 2, spread = 4, keep = 16 } = {}) {
  // Every system a trip can visit gets a small local id; jumps between them are read from one
  // Int16Array row per system (-1: unreachable), built the first time a trip is there.
  const loc = new Map(), sysOf = [];
  const local = (sys) => {
    let k = loc.get(sys);
    if (k === undefined) { k = sysOf.length; loc.set(sys, k); sysOf.push(sys); }
    return k;
  };
  const startK = local(start);

  // Pickup systems, each with its hauls, most profitable first.
  const byPick = new Map(), seen = new Set();
  legs.forEach((L, i) => {
    const key = `${L.t}:${L.f}:${L.d}`;
    if (seen.has(key)) return;
    seen.add(key);
    const fk = local(L.fs), dk = local(L.ds);
    let list = byPick.get(fk);
    if (!list) byPick.set(fk, list = []);
    list.push({
      L, i, t: L.t, fs: L.fs, ds: L.ds, f: L.f, d: L.d, fk, dk, profit: L.profit, cost: L.cost, volume: L.volume || 0,
      uv: L.units ? (L.volume || 0) / L.units : 0, buy: L.buy || L.cost / L.units, margin: L.sell - L.buy || Infinity,
    });
  });
  const pickK = Int32Array.from(byPick.keys());
  const P = pickK.length, K = sysOf.length;
  const legsAt = [...byPick.values()].map(list => list.sort((a, b) => b.profit - a.profit));

  // With `jumps` ({indexOf, from(sys) → Int16Array by graph index}) a row is K array reads;
  // otherwise K distFrom lookups.
  const graphIdx = jumps && Int32Array.from(sysOf, sys => jumps.indexOf.get(sys) ?? -1);
  const rows = new Array(K);
  const row = (k) => {
    let r = rows[k];
    if (r) return r;
    r = rows[k] = new Int16Array(K);
    if (jumps) {
      const d = graphIdx[k] < 0 ? null : jumps.from(sysOf[k]);
      for (let m = 0; m < K; m++) r[m] = d && graphIdx[m] >= 0 ? d[graphIdx[m]] : -1;
    } else {
      const f = distFrom(sysOf[k]);
      for (let m = 0; m < K; m++) r[m] = f(sysOf[m]) ?? -1;
    }
    r[k] = 0;
    return r;
  };
  // Pickups ordered by jumps from a system (counting sort; unreachable ones left out).
  const orders = new Array(K);
  const pickupsBy = (k) => {
    let o = orders[k];
    if (o) return o;
    const r = row(k);
    let max = 0;
    for (let p = 0; p < P; p++) if (r[pickK[p]] > max) max = r[pickK[p]];
    const count = new Uint32Array(max + 2);
    for (let p = 0; p < P; p++) { const j = r[pickK[p]]; if (j >= 0) count[j + 1]++; }
    for (let j = 1; j < count.length; j++) count[j] += count[j - 1];
    o = orders[k] = new Uint32Array(count[max + 1]);
    for (let p = 0; p < P; p++) { const j = r[pickK[p]]; if (j >= 0) o[count[j]++] = p; }
    return o;
  };

  const perJump = rank !== 'profit';
  const scoreOf = (gain, jumps) => (perJump ? gain / Math.max(1, jumps) : gain);

  // Trip states link back to their parent; `evs` are the buys and sales on arriving at `at`.
  const root = { at: startK, jumps: 0, bank: 0, pend: 0, vol: 0, cost: 0, peakCost: 0, peakVol: 0, n: 0, open: [], used: [], prev: null, evs: [], hop: 0 };
  const found = [];

  // Arrive at `to` (hop jumps on), sell what is bound there, then buy H (if any) and sell it
  // too if it is bound for this very system.
  const build = (s, to, hop, H0, fit) => {
    const H = fit ? { ...H0, profit: fit.profit, cost: fit.cost, volume: fit.volume, fit } : H0;
    const evs = [], open = [];
    let bank = s.bank, pend = s.pend, vol = s.vol, cost = s.cost;
    for (const o of s.open) {
      if (o.dk !== to) { open.push(o); continue; }
      evs.push({ kind: 'sell', H: o });
      bank += o.profit; pend -= o.profit; vol -= o.volume; cost -= o.cost;
    }
    let peakCost = s.peakCost, peakVol = s.peakVol, used = s.used, n = s.n;
    if (H) {
      evs.push({ kind: 'buy', H });
      used = [...used, H]; n++;
      peakCost = Math.max(peakCost, cost + H.cost); peakVol = Math.max(peakVol, vol + H.volume);
      if (H.dk === to) { evs.push({ kind: 'sell', H }); bank += H.profit; }
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
    const d = row(from);
    if (k === 1) return d[drops[0]] < 0 ? null : { jumps: d[drops[0]], order: drops };
    if (k <= 3) {
      const [x, y, z] = drops, rx = row(x), dxy = rx[y];
      if (dxy < 0) return null;
      const vx = d[x], vy = d[y];
      if (k === 2) {
        if (vx < 0 && vy < 0) return null;
        return vy < 0 || (vx >= 0 && vx <= vy) ? { jumps: vx + dxy, order: [x, y] } : { jumps: vy + dxy, order: [y, x] };
      }
      const dxz = rx[z], dyz = row(y)[z], vz = d[z];
      if (dxz < 0 || dyz < 0) return null;
      let best = Infinity, order = null;
      // Visit one end of the path first; the middle one is the drop-off not at either end.
      const tryPath = (v, a, b, c, inner) => { if (v >= 0 && v + inner < best) { best = v + inner; order = [a, b, c]; } };
      tryPath(vx, x, y, z, dxy + dyz); tryPath(vx, x, z, y, dxz + dyz);
      tryPath(vy, y, x, z, dxy + dxz); tryPath(vy, y, z, x, dyz + dxz);
      tryPath(vz, z, x, y, dxz + dxy); tryPath(vz, z, y, x, dyz + dxy);
      return order && { jumps: best, order };
    }
    const left = [...drops], order = [];
    let at = from, total = 0;
    while (left.length) {
      const da = row(at);
      let best = -1, bj = Infinity;
      left.forEach((x, m) => { const j = da[x]; if (j >= 0 && j < bj) { bj = j; best = m; } });
      if (best < 0) return null;
      total += bj; at = left[best]; order.push(at); left.splice(best, 1);
    }
    return { jumps: total, order };
  };
  // Distinct drop-off systems of the hauls aboard, but `skip`.
  const dropsOf = (open, skip) => {
    const out = [];
    for (const o of open) if (o.dk !== skip && !out.includes(o.dk)) out.push(o.dk);
    return out;
  };

  // Every move scores as the trip it would be if it sold what's aboard and stopped buying, and is
  // kept as a finished trip too once it has 2 hauls: most of the listed trips come from these.
  let frontier = [root];
  for (let level = 0; level < 2 * maxLegs && frontier.length; level++) {
    const heap = topK(beam * 4);
    for (const s of frontier) {
      const here = s.at, fromHere = row(here);
      const toDrop = s.open.map(o => fromHere[o.dk]);
      const gain0 = s.bank + s.pend;

      // Sell: fly to the drop-off of something aboard.
      for (const D of dropsOf(s.open)) {
        const hop = fromHere[D];
        if (hop < 0) continue;
        const rest = tour(D, dropsOf(s.open, D));
        if (!rest) continue; // something aboard could never be sold from there
        if (s.jumps + hop + rest.jumps > maxJumps) continue;
        heap.push({ s, to: D, hop, H: null, rest, score: scoreOf(gain0, s.jumps + hop + rest.jumps) });
      }

      // Buy: a haul whose pickup is (nearly) on the way.
      if (s.n >= maxLegs) continue;
      // Finished trips from here: all of them share this state's hauls, and each haul is listed in
      // at most `maxReuse` trips, so only the best few can ever be shown (the rest of `keep` is
      // slack for trips whose new haul is already listed often enough).
      const mine = topK(keep);
      const order = pickupsBy(here), usedTypes = s.used.map(u => u.t);
      // A pickup a jumps away costs at least 2·(a − jumps to a drop-off) extra, so nothing past
      // the farthest drop-off + maxLink/2 can be on the way.
      const dropRows = s.open.map(o => row(o.dk));
      const bound = s.open.length ? Math.max(...toDrop) + (maxLink >> 1) : s.n === 0 ? Infinity : maxLink;
      for (let q = 0; q < order.length; q++) {
        const p = order[q], sys = pickK[p], a = fromHere[sys];
        if (a > bound || s.jumps + a > maxJumps) break;
        if (s.open.length) {
          let detour = Infinity;
          for (let m = 0; m < s.open.length; m++) {
            const back = dropRows[m][sys];
            if (back >= 0) detour = Math.min(detour, a + back - toDrop[m]);
          }
          if (detour > maxLink) continue;
        }
        // Arriving here sells what's bound here first.
        let fV = 0, fC = 0;
        for (const o of s.open) if (o.dk === sys) { fV += o.volume; fC += o.cost; }
        const roomV = maxVolume - (s.vol - fV), roomC = maxCost - (s.cost - fC);
        const aboard = dropsOf(s.open, sys), fromSys = row(sys);
        let far0 = 0;
        for (const D of aboard) far0 = Math.max(far0, fromSys[D] < 0 ? Infinity : fromSys[D]);
        if (far0 === Infinity) continue;
        const tours = new Map(); // by the new haul's drop-off
        // The first purchase can be any haul; after that, the `perPickup` most profitable that
        // fit, looking no further than 3 × perPickup down the list. Casting this wide matters
        // more than a wider beam: with a shared hold the best add-on is often a small, dense
        // load far down a hub's list, and the bound below skips most of them cheaply.
        let took = 0, looked = 0;
        const cap = s.n === 0 ? Infinity : perPickup;
        for (const H0 of legsAt[p]) {
          if (took >= cap || looked++ >= 3 * cap) break;
          if (usedTypes.includes(H0.t)) continue; // the same item twice would compete for the same orders
          const jl = fromSys[H0.dk];
          if (jl < 0) continue;
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
          let rest = tours.get(H0.dk);
          if (rest === undefined) {
            tours.set(H0.dk, rest = tour(sys, aboard.includes(H0.dk) || H0.dk === sys ? aboard : [...aboard, H0.dk]));
          }
          if (!rest) continue;
          const total = s.jumps + a + rest.jumps;
          if (total > maxJumps) continue;
          if (scoreOf(gain0 + most, total) <= floor) { took++; continue; }
          let fit = null;
          if (!fits) {
            fit = H0.L.fit ? H0.L.fit(roomV, roomC) : H0.L.refit?.(roomV, roomC);
            if (!fit) continue;
          }
          took++;
          const rec = { s, to: sys, hop: a, H: H0, fit, rest, score: scoreOf(gain0 + (fit || H0).profit, total) };
          if (s.n >= 1) mine.push(rec);
          heap.push(rec);
        }
      }
      found.push(...mine.sorted());
    }
    // Next frontier: the best distinct states (same place, same hauls done and aboard), with no
    // haul in more than `spread` of them, or a few lucrative ones crowd out every other idea.
    const seenState = new Set(), inBeam = new Map();
    frontier = [];
    for (const r of heap.sorted()) {
      if (r.H && (inBeam.get(r.H.i) || 0) >= spread) continue;
      if (r.s.used.some(u => (inBeam.get(u.i) || 0) >= spread)) continue;
      const st = build(r.s, r.to, r.hop, r.H, r.fit);
      const key = `${st.at}|${st.used.map(u => u.i).sort((x, y) => x - y).join(',')}|${st.open.map(u => u.i).sort((x, y) => x - y).join(',')}`;
      if (seenState.has(key)) continue;
      seenState.add(key);
      for (const u of st.used) inBeam.set(u.i, (inBeam.get(u.i) || 0) + 1);
      frontier.push(st);
      if (frontier.length >= beam) break;
    }
  }

  // Materialise a finished trip: the move, then the sales in tour order.
  const finish = (r) => {
    let st = build(r.s, r.to, r.hop, r.H, r.fit);
    for (const D of r.rest.order) st = build(st, D, row(st.at)[D], null);
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
  // A part load gets its full price summary (first and last prices) now.
  const legs = st.used.map(H => (H.fit ? { ...H.L, ...(H.fit.room ? H.L.refit(...H.fit.room) : H.fit) } : { ...H.L }));
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
