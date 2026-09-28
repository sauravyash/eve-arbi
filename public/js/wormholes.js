// Wormhole shortcuts for jump counts. Pure: no DOM, no fetch.
//
// ESI has no travel history, so the app keeps its own: while you're signed in, me.js records every
// system change it sees when it polls your location (recordLocation). Two readings in a row in
// systems that no stargate joins mean you took a wormhole (or a jump bridge or cyno), so that pair
// becomes a shortcut (trailLinks). EVE Scout's public Thera and Turnur connections
// (parseEveScout) and links you enter by hand work the same way. withLinks adds them to the gate
// graph from galaxy.js, so jumpsFrom/pathBetween route through them.
//
// Wormholes change travel only. Buy-order ranges are measured on the gate graph, as in game, so
// ranges.js keeps using the graph without shortcuts.

export const isJSpace = (id) => id >= 31_000_000 && id < 32_000_000;   // wormhole systems, incl. Thera
const isAbyssal = (id) => id >= 32_000_000;                              // filament pockets: you return to where you left

const HOUR = 3_600_000;
export const TRAIL_MAX_AGE = 48 * HOUR;
const TRAIL_MAX = 300;
// Longest gap between two location readings that still counts as one jump. me.js polls every 20 s;
// background tabs can be slowed to once a minute.
export const MAX_GAP = 90_000;

/**
 * Adds a location reading to a character's trail: {last: {s, d, at}, hops: [{a, b, at, gap, da, db}]}.
 * A hop is a system change: from a to b, `gap` ms after the previous reading, docked (da/db) at either end.
 * Returns the trail (updated in place), with hops older than TRAIL_MAX_AGE dropped.
 */
export function recordLocation(trail, loc, now = Date.now()) {
  const t = trail && typeof trail === 'object' ? trail : {};
  t.hops = Array.isArray(t.hops) ? t.hops : [];
  if (!loc?.systemId) return t;
  const docked = !!(loc.stationId || loc.structureId);
  const last = t.last;
  if (last?.s && last.s !== loc.systemId && now >= last.at) {
    t.hops.push({ a: last.s, b: loc.systemId, at: now, gap: now - last.at, da: !!last.d, db: docked });
  }
  t.last = { s: loc.systemId, d: docked, at: now };
  t.hops = t.hops.filter(h => now - h.at < TRAIL_MAX_AGE).slice(-TRAIL_MAX);
  return t;
}

function adjacent(g, a, b) {
  const i = g.indexOf.get(a), j = g.indexOf.get(b);
  if (i == null || j == null) return false;
  for (let k = g.start[i]; k < g.start[i + 1]; k++) if (g.adj[k] === j) return true;
  return false;
}

const pairKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

/**
 * Shortcuts from a trail's hops, checked against the gate graph (without shortcuts).
 * kind 'wormhole': one end is in wormhole space. kind 'jump': two known-space systems with no gate
 * between them (a K-space wormhole, jump bridge or cyno; you decide whether to keep it).
 * Skipped: gate jumps, hops after a long gap (the path in between is unknown), docked-to-docked
 * changes (jump clones) and abyssal filaments.
 * @returns {{a, b, at, kind, src: 'trail'}[]} newest first, one per pair
 */
export function trailLinks(hops, g, { since = 0, maxGap = MAX_GAP } = {}) {
  const out = new Map();
  for (const h of hops || []) {
    const { a, b } = h;
    if (!(h.at >= since) || !a || !b || a === b || isAbyssal(a) || isAbyssal(b) || !(h.gap <= maxGap)) continue;
    const known = g.indexOf.has(a) && g.indexOf.has(b);
    let kind;
    if (known) {
      if (adjacent(g, a, b) || (h.da && h.db)) continue;
      kind = 'jump';
    } else kind = 'wormhole';
    const k = pairKey(a, b);
    if (!out.has(k) || out.get(k).at < h.at) out.set(k, { a, b, at: h.at, kind, src: 'trail' });
  }
  return [...out.values()].sort((x, y) => y.at - x.at);
}

/**
 * EVE Scout's public signatures (https://api.eve-scout.com/v2/public/signatures): wormholes from
 * Thera and Turnur. Returns live links {a, b, at, expiresAt, kind: 'wormhole', src: 'evescout', note}
 * and the system names it mentions.
 */
export function parseEveScout(rows, now = Date.now()) {
  const links = [], names = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r?.signature_type !== 'wormhole' || !r.out_system_id || !r.in_system_id) continue;
    const expiresAt = Date.parse(r.expires_at);
    if (Number.isFinite(expiresAt) && expiresAt <= now) continue;
    if (r.out_system_name) names.set(r.out_system_id, r.out_system_name);
    if (r.in_system_name) names.set(r.in_system_id, r.in_system_name);
    links.push({
      a: r.out_system_id, b: r.in_system_id, at: Date.parse(r.updated_at || r.created_at) || now,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : null, kind: 'wormhole', src: 'evescout',
      note: [r.wh_type, r.max_ship_size && `${r.max_ship_size} ships`].filter(Boolean).join(' · '),
    });
  }
  return { links, names };
}

/**
 * The gate graph plus shortcuts. Systems missing from it (wormhole space) become new nodes with
 * security -1 and no region, so routes can pass through them and they can be a starting point.
 * @param {object} g         galaxy.js graph
 * @param {{a, b}[]} links
 * @param {Map<number,string>} [names]  names for systems not in the graph
 */
export function withLinks(g, links, names = new Map()) {
  const pairs = (links || []).filter(l => l.a && l.b && l.a !== l.b);
  if (!pairs.length) return g;
  const id = Array.from(g.id), name = Array.from(g.name), sec = Array.from(g.sec), regionId = Array.from(g.regionId);
  const indexOf = new Map(g.indexOf);
  const node = (sys) => {
    let i = indexOf.get(sys);
    if (i == null) {
      i = id.length;
      id.push(sys); name.push(names.get(sys) || `System ${sys}`); sec.push(-1); regionId.push(null);
      indexOf.set(sys, i);
    }
    return i;
  };
  const extra = [], shortcuts = new Set();
  for (const l of pairs) {
    const k = pairKey(l.a, l.b);
    if (shortcuts.has(k) || adjacent(g, l.a, l.b)) continue;
    shortcuts.add(k);
    extra.push(node(l.a), node(l.b));
  }
  const n = id.length;
  const deg = new Uint32Array(n);
  for (let i = 0; i < g.n; i++) deg[i] = g.start[i + 1] - g.start[i];
  for (const i of extra) deg[i]++;
  const start = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + deg[i];
  const adj = new Uint32Array(start[n]), fill = start.slice(0, n);
  for (let i = 0; i < g.n; i++) for (let k = g.start[i]; k < g.start[i + 1]; k++) adj[fill[i]++] = g.adj[k];
  for (let k = 0; k < extra.length; k += 2) {
    const a = extra[k], b = extra[k + 1];
    adj[fill[a]++] = b; adj[fill[b]++] = a;
  }
  return { ...g, n, start, adj, id, name, sec, regionId, indexOf, cache: new Map(), shortcuts, base: g.base || g };
}

/** How many steps of a system path (pathBetween) are shortcuts rather than stargates. */
export function shortcutsOn(g, path) {
  if (!g.shortcuts || !path) return 0;
  let n = 0;
  for (let i = 1; i < path.length; i++) if (g.shortcuts.has(pairKey(path[i - 1], path[i]))) n++;
  return n;
}
