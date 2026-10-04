// Route planner maths for route-planner.html. Pure: no DOM, no fetch.
//
// Routes are breadth-first over a travel graph (galaxy.js buildGraph, plus wormhole shortcuts from
// wormholes.js withLinks), with the in-game autopilot's two extras: a security preference and a list
// of systems to avoid. A stack of waypoints is flown leg by leg, each leg with its own preference if
// you set one, and the waypoints between the first and (optionally) the last can be put in the order
// that flies fewest jumps (optimizeOrder).

import { isHighSec, isNullSec } from './galaxy.js';
import { isJSpace } from './wormholes.js';

export const FLAGS = ['secure', 'nonull', 'shortest'];
export const FLAG_LABEL = { secure: 'High-sec only', nonull: 'No null-sec', shortest: 'Shortest' };

// Wormhole space joined to the graph by withLinks has no region; known space always has one.
const inJSpace = (g, i) => g.regionId[i] == null || isJSpace(g.id[i]);

function allowedFn(g, { flag = 'shortest', avoid, passJSpace = true }) {
  const ok = flag === 'secure' ? isHighSec : flag === 'nonull' ? (s) => !isNullSec(s) : null;
  return (i) => {
    if (avoid?.has(g.id[i])) return false;
    if (!ok) return true;
    return passJSpace && inJSpace(g, i) ? true : ok(g.sec[i]);
  };
}

/**
 * Breadth-first from `a`: jumps to every system (-1 = unreachable) and the system each was reached
 * from, both indexed like g.id. The start is always allowed; so is `b` when given, so a route can
 * end in a system the preference or avoid list would otherwise skip.
 */
export function searchFrom(g, a, opts = {}, b = null) {
  const dist = new Int32Array(g.n).fill(-1), prev = new Int32Array(g.n).fill(-1);
  const from = g.indexOf.get(a);
  if (from == null) return { dist, prev };
  const end = b == null ? -1 : g.indexOf.get(b) ?? -1;
  const ok = allowedFn(g, opts);
  const q = new Uint32Array(g.n);
  let head = 0, tail = 0;
  q[tail++] = from; dist[from] = 0;
  while (head < tail) {
    const v = q[head++];
    if (v === end) break;
    for (let k = g.start[v]; k < g.start[v + 1]; k++) {
      const w = g.adj[k];
      if (dist[w] !== -1 || (w !== end && !ok(w))) continue;
      dist[w] = dist[v] + 1; prev[w] = v;
      q[tail++] = w;
    }
  }
  return { dist, prev };
}

function walkBack(g, prev, from, to) {
  const path = [to];
  for (let i = to; i !== from;) { i = prev[i]; if (i < 0) return null; path.push(i); }
  return path.reverse().map(i => g.id[i]);
}

/**
 * The fewest-jump path from a to b (system IDs, both ends included).
 * When the preference or avoid list leaves no way through, it relaxes them in turn and says so:
 * fallback 'flag' (flew outside the preferred security), 'avoid' (through an avoided system).
 * @returns {{path: number[], jumps: number, fallback: null|'flag'|'avoid'}|null}  null when unreachable
 */
export function findPath(g, a, b, opts = {}) {
  const ia = g.indexOf.get(a), ib = g.indexOf.get(b);
  if (ia == null || ib == null) return null;
  if (a === b) return { path: [a], jumps: 0, fallback: null };
  const tries = [[opts, null]];
  if ((opts.flag || 'shortest') !== 'shortest') tries.push([{ ...opts, flag: 'shortest' }, 'flag']);
  if (opts.avoid?.size) tries.push([{ ...opts, flag: 'shortest', avoid: null }, 'avoid']);
  for (const [o, fallback] of tries) {
    const { dist, prev } = searchFrom(g, a, o, b);
    if (dist[ib] < 0) continue;
    return { path: walkBack(g, prev, ia, ib), jumps: dist[ib], fallback };
  }
  return null;
}

/**
 * A stack of waypoints flown in order.
 * @param {{id: number, flag?: string|null}[]} stops  the first is where you start; `flag` overrides
 *   the route preference for the leg that ends at that stop
 * @returns {{legs: {from, to, flag, path, jumps, fallback}[], path: number[], jumps: number, broken: number}}
 *   broken counts legs with no route at all (their path is null and they add no jumps)
 */
export function planRoute(g, stops, opts = {}) {
  const legs = [], path = [];
  let jumps = 0, broken = 0;
  for (let k = 1; k < stops.length; k++) {
    const from = stops[k - 1].id, to = stops[k].id, flag = stops[k].flag || opts.flag || 'shortest';
    const r = findPath(g, from, to, { ...opts, flag });
    legs.push({ from, to, flag, path: r?.path ?? null, jumps: r?.jumps ?? null, fallback: r?.fallback ?? null });
    if (!r) { broken++; continue; }
    jumps += r.jumps;
    path.push(...(path.length && path[path.length - 1] === r.path[0] ? r.path.slice(1) : r.path));
  }
  return { legs, path, jumps, broken };
}

// Cost of a leg with no route: big enough that the optimiser never prefers one.
export const UNREACHABLE = 1e6;

/** Jumps between every pair of `ids` (UNREACHABLE when there's no way), one search per system. */
export function jumpMatrix(g, ids, opts = {}) {
  return ids.map((a) => {
    const { dist } = searchFrom(g, a, opts);
    return ids.map((b) => {
      if (a === b) return 0;
      const i = g.indexOf.get(b);
      if (i != null && dist[i] >= 0) return dist[i];
      return findPath(g, a, b, opts)?.jumps ?? UNREACHABLE;   // b itself avoided or outside the preference
    });
  });
}

const tourCost = (d, order) => order.reduce((s, v, k) => (k ? s + d[order[k - 1]][v] : 0), 0);

/**
 * The order of waypoints that flies the fewest jumps.
 * Index 0 (where you start) stays first. `keepEnd` keeps the last index last (your destination);
 * `roundTrip` counts the way back to the start. Exact (Held–Karp) for up to 10 free waypoints,
 * otherwise nearest neighbour improved by 2-opt.
 * @param {number[][]} d  jumpMatrix
 * @returns {number[]} indices into d
 */
export function optimizeOrder(d, { keepEnd = false, roundTrip = false } = {}) {
  const n = d.length;
  if (n <= 2) return [...Array(n).keys()];
  const end = keepEnd && !roundTrip ? n - 1 : null;
  const free = [...Array(n).keys()].filter(i => i !== 0 && i !== end);
  const close = (last) => (end != null ? d[last][end] : roundTrip ? d[last][0] : 0);
  const finish = (mid) => [0, ...mid, ...(end != null ? [end] : [])];

  if (free.length <= 10) {
    const m = free.length, full = (1 << m) - 1;
    const cost = new Float64Array((1 << m) * m).fill(Infinity), from = new Int8Array((1 << m) * m).fill(-1);
    for (let j = 0; j < m; j++) cost[(1 << j) * m + j] = d[0][free[j]];
    for (let mask = 1; mask <= full; mask++) {
      for (let j = 0; j < m; j++) {
        const c = cost[mask * m + j];
        if (!(mask & (1 << j)) || c === Infinity) continue;
        for (let k = 0; k < m; k++) {
          if (mask & (1 << k)) continue;
          const next = mask | (1 << k), v = c + d[free[j]][free[k]];
          if (v < cost[next * m + k]) { cost[next * m + k] = v; from[next * m + k] = j; }
        }
      }
    }
    let best = Infinity, last = 0;
    for (let j = 0; j < m; j++) {
      const v = cost[full * m + j] + close(free[j]);
      if (v < best) { best = v; last = j; }
    }
    const mid = [];
    for (let mask = full, j = last; j >= 0;) { mid.push(free[j]); const p = from[mask * m + j]; mask &= ~(1 << j); j = p; }
    return finish(mid.reverse());
  }

  // Nearest neighbour, then 2-opt on the free part.
  const left = new Set(free), mid = [];
  for (let at = 0; left.size;) {
    let pick = -1;
    for (const v of left) if (pick < 0 || d[at][v] < d[at][pick]) pick = v;
    mid.push(pick); left.delete(pick); at = pick;
  }
  const total = (m) => tourCost(d, finish(m)) + (end == null && roundTrip ? d[m[m.length - 1]][0] : 0);
  let best = total(mid), improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < mid.length - 1; i++) {
      for (let j = i + 1; j < mid.length; j++) {
        const cand = [...mid.slice(0, i), ...mid.slice(i, j + 1).reverse(), ...mid.slice(j + 1)];
        const c = total(cand);
        if (c < best) { best = c; mid.splice(0, mid.length, ...cand); improved = true; }
      }
    }
  }
  return finish(mid);
}

/** Total jumps of visiting d's indices in `order` (plus the way back when roundTrip). */
export function orderCost(d, order, roundTrip = false) {
  return tourCost(d, order) + (roundTrip && order.length > 1 ? d[order[order.length - 1]][order[0]] : 0);
}

// --- wormholes --------------------------------------------------------------

// EVE Scout's ship size names, smallest first; a hole lets through every size up to its own.
export const SHIP_SIZES = ['small', 'medium', 'large', 'xlarge', 'capital'];
const HOUR = 3_600_000;
// Jump bridges (Ansiblex) take every subcapital, freighters and jump freighters included, but no capital.
export const BRIDGE_SHIPS = 'xlarge';
// The farthest an Ansiblex can reach.
export const BRIDGE_RANGE_LY = 5;
const EOL_HOURS = 4;   // a hole at end of life has under 4 h left

/**
 * The biggest ship a shortcut lets through ('small' … 'capital'), or null when unknown:
 * from its type code (whInfo), else EVE Scout's "… medium ships" note.
 */
export function linkShipSize(l, whInfo = () => null) {
  if (l?.kind === 'bridge') return BRIDGE_SHIPS;
  const t = l?.type ? whInfo(l.type)?.ships : null;
  if (t) return t;
  const m = /\b(small|medium|large|xlarge|capital) ships\b/i.exec(l?.note || '');
  return m ? m[1].toLowerCase() : null;
}

/** When a shortcut is expected to close: its expiry, or 4 h after it was last seen at end of life. */
export function linkExpiry(l) {
  const eol = /end of life/i.test(l?.note || '') ? (l.at || 0) + EOL_HOURS * HOUR : null;
  if (l?.expiresAt && eol) return Math.min(l.expiresAt, eol);
  return l?.expiresAt || eol || null;
}

/**
 * Shortcuts a route may use: the ones switched on, that let `ship` through and stay open at least
 * `minLeftMs` longer. Holes of unknown size count as open to every ship (the table flags them).
 */
export function usableLinks(links, { ship = '', minLeftMs = 0, now = Date.now(), whInfo } = {}) {
  const need = SHIP_SIZES.indexOf(ship);
  return (links || []).filter((l) => {
    if (l.use === false) return false;
    if (need > 0) {
      const size = linkShipSize(l, whInfo);
      if (size && SHIP_SIZES.indexOf(size) < need) return false;
    }
    const exp = linkExpiry(l);
    return !(minLeftMs > 0 && exp && exp - now < minLeftMs);
  });
}

// --- summary ----------------------------------------------------------------

/**
 * What a path flies through.
 * @returns {{jumps, high, low, null, jspace, wormholes, regions: string[], minSec: number|null, lowEntries: number}}
 *   counts are systems after the start; lowEntries counts steps from high-sec into low-, null- or J-space
 */
export function routeSummary(g, path, isShortcut = () => false) {
  const out = { jumps: Math.max(0, (path?.length || 0) - 1), high: 0, low: 0, null: 0, jspace: 0, wormholes: 0, regions: [], minSec: null, lowEntries: 0 };
  if (!path?.length) return out;
  let wasHigh = null;
  path.forEach((id, k) => {
    const i = g.indexOf.get(id);
    if (i == null) return;
    const js = inJSpace(g, i), sec = g.sec[i], high = !js && isHighSec(sec);
    if (!js) {
      const r = g.regionName?.get(g.regionId[i]);
      if (r && out.regions[out.regions.length - 1] !== r) out.regions.push(r);
      if (out.minSec == null || sec < out.minSec) out.minSec = sec;
    }
    if (k > 0) {
      if (js) out.jspace++; else if (high) out.high++; else if (isNullSec(sec)) out.null++; else out.low++;
      if (wasHigh && !high) out.lowEntries++;
      if (isShortcut(path[k - 1], id)) out.wormholes++;
    }
    wasHigh = high;
  });
  return out;
}

// --- text in and out --------------------------------------------------------

const SHOWINFO = /<url=showinfo:5\/\/(\d+)>([^<]*)<\/url>|<a href="?showinfo:5\/\/(\d+)"?>([^<]*)<\/a>/gi;

/**
 * Systems in pasted text, in order: one per line, or separated by commas, arrows or ">" (the
 * in-game route copy), in-game chat links (showinfo:5//id) and "1. Jita (0.9)" style lines.
 * @returns {({id: number, name: string}|{name: string})[]}
 */
export function parseWaypointText(text) {
  const out = [];
  const src = String(text || '').replace(SHOWINFO, (_, id1, n1, id2, n2) => `\n#${id1 || id2}#${(n1 ?? n2 ?? '').trim()}\n`);
  for (let part of src.split(/[\n\r,;>→»]+|\s-+>\s|\s+-\s+/)) {
    part = part.trim();
    if (!part) continue;
    const link = /^#(\d+)#(.*)$/.exec(part);
    if (link) { out.push({ id: Number(link[1]), name: link[2] }); continue; }
    const name = part.replace(/^\d+[.)]\s*/, '').replace(/\s*\(-?\d\.\d\)\s*$/, '').replace(/\s+-?\d\.\d$/, '').trim();
    if (name) out.push({ name });
  }
  return out;
}

// "1DQ1-A » 8QT-H4", "1DQ1-A <-> 8QT-H4", "1DQ1-A → 8QT-H4", tab or comma separated, …
const BRIDGE_SEP = /\s*(?:»|«|<->|<=>|<-->|↔|⇄|-->|->|→|=>|\t|,)\s*/;

/**
 * Jump bridges in pasted text, one per line: two systems joined by », an arrow, a tab or a comma.
 * Structure names work too ("1DQ1-A » 8QT-H4 - Imperium Bridge", "1DQ1-A @ 1-1 » 8QT-H4 @ 3-2"):
 * anything after " - " or " @ " on either side is dropped, and a name after " - " becomes the note.
 * @returns {{a: string, b: string, note?: string}[]}  system names, as typed
 */
export function parseBridgeText(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const parts = raw.trim().split(BRIDGE_SEP).filter(Boolean);
    if (parts.length < 2) continue;
    const clean = (p) => p.replace(/\s+@\s.*$/, '').replace(/\s+-\s.*$/, '').trim();
    const a = clean(parts[0]), b = clean(parts[1]);
    if (!a || !b || a.toLowerCase() === b.toLowerCase()) continue;
    const note = / - (.+)$/.exec(parts[1])?.[1]?.trim();
    out.push(note ? { a, b, note } : { a, b });
  }
  return out;
}

/** Bridges as text for sharing, one "A » B" per line (what parseBridgeText reads). */
export function bridgeText(bridges, name) {
  return bridges.map(b => `${name(b.a)} » ${name(b.b)}${b.note ? ` - ${b.note}` : ''}`).join('\n');
}

/** Light years between two systems of universe.json (by index), or null without coordinates. */
export function lyBetween(systems, i, j) {
  const { x, y, z3 } = systems || {};
  if (!x || i == null || j == null) return null;
  return Math.hypot(x[i] - x[j], y[i] - y[j], (z3?.[i] ?? 0) - (z3?.[j] ?? 0));
}

/** In-game chat links for systems ("<url=showinfo:5//30000142>Jita</url>"), for chat, mails and notepads. */
export function chatLinks(stops, sep = ' → ') {
  return stops.map(s => `<url=showinfo:5//${s.id}>${s.name}</url>`).join(sep);
}

/** Waypoints for the query string: "30000142,30002187:secure" (an id, then its leg's preference if set). */
export function encodeStops(stops) {
  return stops.map(s => (s.flag ? `${s.id}:${s.flag}` : String(s.id))).join(',');
}

export function decodeStops(text) {
  const out = [];
  for (const part of String(text || '').split(',')) {
    const [id, flag] = part.split(':');
    const n = Number(id);
    if (!(Number.isInteger(n) && n > 0)) continue;
    out.push(FLAGS.includes(flag) ? { id: n, flag } : { id: n });
  }
  return out;
}

/** "1 h 12 min" for a number of seconds. */
export function formatDuration(s) {
  if (!(s >= 0)) return '—';
  const m = Math.round(s / 60);
  if (m < 1) return '< 1 min';
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}
