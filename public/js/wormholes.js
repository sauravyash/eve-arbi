// Wormhole shortcuts for jump counts. Pure: no DOM, no fetch.
//
// ESI has no travel history, so the app keeps its own: while you're signed in, me.js records every
// system change it sees when it polls your location (recordLocation). Two readings in a row in
// systems that no stargate joins mean you took a wormhole (or a jump bridge or cyno), so that pair
// becomes a shortcut (trailLinks). EVE Scout's public Thera and Turnur connections
// (parseEveScout), a Wanderer mapper's connections (parseWanderer) and links you enter by hand
// work the same way; links from a feed carry the hole's type code (Q063, …), which whInfo looks
// up in the wormhole type table (public/wormhole-types.json, from ellatha.com). withLinks adds them to the gate graph from galaxy.js, so
// jumpsFrom/pathBetween route through them. shortcuts.js gathers them for the pages.
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
 * Thera and Turnur. Returns live links {a, b, at, expiresAt, kind: 'wormhole', src: 'evescout', type, note}
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
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : null, kind: 'wormhole', src: 'evescout', type: whCode(r.wh_type),
      note: [r.wh_type, r.max_ship_size && `${r.max_ship_size} ships`].filter(Boolean).join(' · '),
    });
  }
  return { links, names };
}

/** A wormhole type code as typed or sent by a feed ("q063", "Wormhole Q063") → "Q063", else null. */
export function whCode(s) {
  const m = /^\s*(?:wormhole\s+)?([a-z]\d{3})\s*$/i.exec(String(s ?? ''));
  return m ? m[1].toUpperCase() : null;
}

// EVE Scout's ship size names, by the heaviest ship a hole lets through in one jump.
const SHIP_SIZES = [[5e6, 'small'], [62e6, 'medium'], [375e6, 'large'], [2e9, 'xlarge'], [Infinity, 'capital']];

/**
 * A wormhole type from the type table (public/wormhole-types.json: code → [leads to, max stable
 * hours, max stable mass kg, max jump mass kg]). K162 isn't in it: an exit takes after the hole
 * it's the other side of.
 * @returns {{code, leads, hours, mass, jump, ships}|null}
 */
export function whInfo(types, code) {
  const c = whCode(code), row = c && types?.[c];
  if (!Array.isArray(row)) return null;
  const [leads = null, hours = null, mass = null, jump = null] = row;
  return { code: c, leads, hours, mass, jump, ships: jump ? SHIP_SIZES.find(([kg]) => jump <= kg)[1] : null };
}

/** "Q063: to high-sec, lives up to 16 h, 500,000 t in all, 62,000 t per jump (medium ships)" */
export function whSummary(info) {
  if (!info) return '';
  const t = (kg) => `${Math.round(kg / 1000).toLocaleString('en-US')} t`;
  return `${info.code}: ` + [info.leads && `to ${info.leads}`, info.hours && `lives up to ${info.hours} h`,
    info.mass && `${t(info.mass)} in all`, info.jump && `${t(info.jump)} per jump (${info.ships} ships)`].filter(Boolean).join(', ');
}

// Wanderer's time_status and mass_status codes (its map shows the same labels).
const WANDERER_TIME = { 1: 'end of life' };
const WANDERER_MASS = { 1: 'reduced', 2: 'critical' };

/**
 * A Wanderer map's connections (GET {instance}/api/maps/{slug}/connections, {data: [...]}).
 * Wanderer drops a connection when its wormhole collapses, so none of them carries an expiry.
 * @returns {{a, b, at, expiresAt: null, kind: 'wormhole', src: 'wanderer', type, note}[]}
 */
export function parseWanderer(json, now = Date.now()) {
  const rows = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
  const out = [];
  for (const r of rows) {
    const a = Number(r?.solar_system_source), b = Number(r?.solar_system_target);
    if (!(a > 0) || !(b > 0) || a === b) continue;
    out.push({
      a, b, at: Date.parse(r.updated_at || r.inserted_at) || now, expiresAt: null, kind: 'wormhole', src: 'wanderer', type: whCode(r.wormhole_type),
      note: [r.wormhole_type, WANDERER_TIME[r.time_status], WANDERER_MASS[r.mass_status] && `mass ${WANDERER_MASS[r.mass_status]}`]
        .filter(Boolean).join(' · '),
    });
  }
  return out;
}

// Words in a bookmark label that describe the hole, not where it goes.
const BM_FLAGS = { small: 'small', medium: 'medium', med: 'medium', large: 'large', xl: 'xlarge', xlarge: 'xlarge', eol: 'EOL', crit: 'crit', reduced: 'reduced' };
const EVE_TIME = /^(\d{4})\.(\d\d)\.(\d\d) (\d\d):(\d\d)$/;
const eveTime = (s) => { const m = EVE_TIME.exec(String(s || '').trim()); return m ? Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5]) : null; };

/**
 * Rows copied from the game's Locations window (People & Places → Locations: select rows, Ctrl+C):
 * label, type, jumps, system, constellation, region, created, expires, creator, tab-separated, all
 * times EVE time (UTC). Folder names come along as lines without tabs and are skipped.
 * A wormhole bookmark's label names where the hole goes: "MKE-480 > Gelhan", "HOB-904 Keikaken LARGE EOL",
 * "UNKNOWN SIG > J152825 (Toward Misaba)". `dest` lists the names it could be, best first (what follows
 * the signature or ">", minus notes in brackets and size/EOL words); [] when the label has no
 * destination (a safe spot, "WH C5").
 * @returns {{label, sig, dest: string[], flags: string[], system, created, expires, by}[]}
 */
export function parseBookmarks(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const cols = line.split('\t');
    if (cols.length < 8) continue;
    const label = cols[0].replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').trim();
    const system = cols[3].trim();
    if (!label || !system) continue;
    const m = /^([A-Z]{3}-\d{3})\b\s*(.*)$/i.exec(label);
    const sig = m ? m[1].toUpperCase() : null;
    let rest = m ? m[2] : label;
    const arrow = /^(?:.*?)>\s*(.*)$/.exec(rest);
    if (arrow) rest = arrow[1];
    else if (!sig) rest = '';                              // no signature, no ">": not a hole
    const flags = [], words = [];
    for (const w of rest.replace(/\([^)]*\)/g, ' ').split(/\s+/).filter(Boolean)) {
      const f = BM_FLAGS[w.toLowerCase()];
      if (f) { if (!flags.includes(f)) flags.push(f); } else if (!flags.length) words.push(w);
    }
    const dest = [];
    const glued = /^(J\d{6})/i.exec(words[0] || '');      // "J222104Toward Misaba"
    if (glued) dest.push(glued[1].toUpperCase());
    else for (let n = Math.min(3, words.length); n >= 1; n--) dest.push(words.slice(0, n).join(' '));
    // "AY-24l": a lower-case L typed for the capital I in a null-sec name.
    for (const d of [...dest]) if (/l/.test(d) && /\d/.test(d)) dest.push(d.replace(/l/g, 'I'));
    out.push({ label, sig, dest, flags, system, created: eveTime(cols[6]), expires: eveTime(cols[7]), by: (cols[8] || '').trim() || null });
  }
  return out;
}

/**
 * Bookmark rows (parseBookmarks) → shortcuts, one per pair, newest first. `idOf(name)` gives a
 * system ID or null. A bookmark expires when it says it does, else `hours` after it was made; ones
 * already expired are left out.
 * @returns {{links: {a, b, at, expiresAt, kind: 'wormhole', src: 'bookmark', note, by}[], noDest: number, unknown: string[], expired: number}}
 */
export function bookmarkLinks(rows, idOf, { now = Date.now(), hours = 16 } = {}) {
  const byPair = new Map(), unknown = new Set();
  let noDest = 0, expired = 0;
  for (const r of rows || []) {
    if (!r.dest.length) { noDest++; continue; }
    const a = idOf(r.system), b = r.dest.map(idOf).find(Boolean);
    if (!a) unknown.add(r.system);
    if (!b) { noDest++; continue; }
    if (!a || a === b) continue;
    const at = r.created ?? now, expiresAt = r.expires ?? at + hours * 3_600_000;
    if (expiresAt <= now) { expired++; continue; }
    const k = pairKey(a, b), cur = byPair.get(k);
    if (cur && cur.at >= at) continue;
    byPair.set(k, { a, b, at, expiresAt, kind: 'wormhole', src: 'bookmark', note: [r.sig, ...r.flags].filter(Boolean).join(' · '), by: r.by });
  }
  return { links: [...byPair.values()].sort((x, y) => y.at - x.at), noDest, unknown: [...unknown], expired };
}

/**
 * Where to ask a Wanderer instance for a map's connections (the proxy in server.js/worker only
 * calls these): the current API path, then the older one. Only public https hosts are allowed, so
 * the proxy can't be pointed at this machine or its network.
 * @returns {string[]|null}  null when `instance` or `map` isn't acceptable
 */
export function wandererUrls(instance, map) {
  let u;
  try { u = new URL(String(instance || '')); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.port || u.username || u.password || !host.includes('.')
    || /^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[') || /(^|\.)(localhost|local|internal)$/.test(host)) return null;
  if (!/^[\w-]{1,100}$/.test(String(map || ''))) return null;
  const root = `https://${host}${u.pathname.replace(/\/+$/, '')}`;
  return [`${root}/api/maps/${map}/connections`, `${root}/api/map/connections?slug=${map}`];
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
