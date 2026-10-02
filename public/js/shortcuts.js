// Wormhole shortcuts for every page: gathers them from each source, remembers your choices, and
// hands out the travel graph (the gate graph plus the shortcuts in use; see wormholes.js).
//
// Sources:
//   trail     — jumps with no stargate recorded by me.js for any character signed in on this browser
//   evescout  — EVE Scout's public Thera and Turnur connections (api.eve-scout.com, CORS allowed)
//   wanderer  — a Wanderer mapper's connections, with its map API token (through /api/wanderer, since
//               Wanderer sends no CORS headers)
//   manual    — pairs you add on the Routes page, optionally with the hole's type
//
// Wormhole types (what a Q063 leads to, how long it lives, what fits through) come from
// public/wormhole-types.json, a snapshot of ellatha.com's wormhole database (scripts/build-wormholes.js).
//
// Everything is kept in localStorage (wh.*), so every page and tab shares it; a change in one tab
// reaches the others through the storage event. Pages build order-range geometry (ranges.js)
// from the gate graph, and jumps from travelGraph().

import { trailLinks, parseEveScout, parseWanderer, withLinks, isJSpace, whInfo, whCode } from './wormholes.js';
import { readAllTrails, TRAIL_PREFIX } from './me.js';

const HOUR = 3_600_000;
const EVE_SCOUT = 'https://api.eve-scout.com/v2/public/signatures';
const SCOUT_TTL = 5 * 60_000, WANDERER_TTL = 2 * 60_000;
const KEYS = { settings: 'wh.settings', links: 'wh.links', off: 'wh.off', names: 'wh.sysNames' };

export const WH_DEFAULTS = { on: true, trail: true, scout: false, hours: 16, wanderer: { on: false, url: 'https://wanderer.ltd', map: '', token: '' } };
export const SOURCE_LABEL = { trail: 'Your jump', evescout: 'EVE Scout', wanderer: 'Wanderer', manual: 'Added by you' };
export const pairKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

const LS = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota or disabled */ } },
};

// The Mining page kept these under mining.* before they were shared.
function migrate() {
  try {
    if (localStorage.getItem(KEYS.settings) != null) return;
    const old = LS.get('mining.settings', {}).wh;
    if (old) LS.set(KEYS.settings, old);
    for (const [from, to] of [['mining.links', KEYS.links], ['mining.linksOff', KEYS.off], ['mining.sysNames', KEYS.names]]) {
      const v = localStorage.getItem(from);
      if (v != null) localStorage.setItem(to, v);
    }
  } catch { /* storage disabled */ }
}

function readSettings() {
  const s = LS.get(KEYS.settings, {});
  return { ...WH_DEFAULTS, ...s, wanderer: { ...WH_DEFAULTS.wanderer, ...s.wanderer } };
}

/**
 * @param {object} [o]
 * @param {() => void} [o.onChange]  shortcuts or names changed (another source loaded, another tab, …)
 */
export function createShortcuts({ onChange = () => {} } = {}) {
  migrate();
  let settings = readSettings();
  let manual = LS.get(KEYS.links, []);
  let off = LS.get(KEYS.off, {});
  const names = new Map(LS.get(KEYS.names, []));
  const feeds = {
    evescout: { links: [], at: 0, error: null, loading: null },
    wanderer: { links: [], at: 0, error: null, loading: null, for: '' },
  };
  let base = null, memo = null, whTypes = null;
  const changed = () => { memo = null; onChange(); };
  fetch('wormhole-types.json').then(r => (r.ok ? r.json() : null)).then(t => { whTypes = t; if (t) changed(); }).catch(() => {});

  // --- sources -------------------------------------------------------------
  async function loadFeed(name, force, fetcher, ttl, ident = '') {
    const f = feeds[name];
    if (!force && f.for === ident && Date.now() - f.at < ttl) return;
    f.loading ||= (async () => {
      try {
        const { links, names: found } = await fetcher();
        for (const [id, n] of found || []) if (!base?.indexOf.has(id)) names.set(id, n);
        Object.assign(f, { links, at: Date.now(), error: null, for: ident });
      } catch (e) {
        Object.assign(f, { error: e.message, at: Date.now(), for: ident });
      }
      f.loading = null;
      changed();
    })();
    return f.loading;
  }
  const loadScout = (force) => settings.scout && loadFeed('evescout', force, async () => {
    const res = await fetch(EVE_SCOUT, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseEveScout(await res.json());
  }, SCOUT_TTL);
  const loadWanderer = (force) => {
    const w = settings.wanderer;
    if (!w.on || !w.url || !w.map || !w.token) return;
    return loadFeed('wanderer', force, async () => {
      const res = await fetch(`/api/wanderer/connections?${new URLSearchParams({ url: w.url, map: w.map })}`, { headers: { 'X-Wanderer-Token': w.token } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      return { links: parseWanderer(body) };
    }, WANDERER_TTL, `${w.url}|${w.map}|${w.token}`);
  };

  // Every shortcut on offer, newest first; `use` is false for ones you switched off.
  function links() {
    if (!base) return [];
    const now = Date.now(), since = now - settings.hours * HOUR;
    const out = new Map();
    const add = (l) => {
      const key = pairKey(l.a, l.b), cur = out.get(key);
      if (!cur || cur.at < l.at) out.set(key, { ...l, key });
    };
    if (settings.trail) for (const t of readAllTrails()) trailLinks(t.hops, base, { since }).forEach(add);
    manual.filter(l => !(l.expiresAt <= now)).forEach(add);
    if (settings.scout) feeds.evescout.links.filter(l => !(l.expiresAt <= now)).forEach(add);
    if (settings.wanderer.on) feeds.wanderer.links.forEach(add);
    const list = [...out.values()].sort((x, y) => y.at - x.at);
    for (const l of list) l.use = !(off[l.key] >= l.at);
    return list;
  }

  // --- names of wormhole systems (not in universe.json), via ESI ---------------
  const naming = new Set(), unnamed = new Set();
  async function resolveNames(ids) {
    if (!base) return;
    const want = [...new Set(ids)].filter(id => id && !base.indexOf.has(id) && !names.has(id) && !naming.has(id) && !unnamed.has(id));
    if (!want.length) return;
    want.forEach(id => naming.add(id));
    try {
      const res = await fetch('/api/esi/universe/names/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(want) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const r of await res.json()) if (r.category === 'solar_system') names.set(r.id, r.name);
      LS.set(KEYS.names, [...names].slice(-500));
      changed();
    } catch { want.forEach(id => unnamed.add(id)); } finally { want.forEach(id => naming.delete(id)); }
  }

  function sysName(id) {
    if (id == null) return '';
    const i = base?.indexOf.get(id);
    if (i != null) return base.name[i];
    return names.get(id) || (isJSpace(id) ? `J-space ${id}` : `System ${id}`);
  }

  // A system typed by name: known space locally, anything else (J-codes, Thera) via ESI.
  async function systemByName(text) {
    const q = String(text || '').trim().toLowerCase();
    if (!q || !base) return null;
    for (let i = 0; i < base.n; i++) if (base.name[i].toLowerCase() === q) return base.id[i];
    for (const [id, n] of names) if (n.toLowerCase() === q) return id;
    const res = await fetch('/api/esi/universe/ids/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([text.trim()]) });
    const hit = res.ok ? (await res.json()).systems?.[0] : null;
    if (!hit) return null;
    if (!base.indexOf.has(hit.id)) { names.set(hit.id, hit.name); LS.set(KEYS.names, [...names].slice(-500)); }
    return hit.id;
  }

  // Another tab recorded a jump or changed a setting.
  window.addEventListener('storage', (e) => {
    if (!e.key) return;
    if (e.key === KEYS.settings) { settings = readSettings(); refresh(); changed(); }
    else if (e.key === KEYS.links) { manual = LS.get(KEYS.links, []); changed(); }
    else if (e.key === KEYS.off) { off = LS.get(KEYS.off, {}); changed(); }
    else if (e.key.startsWith(TRAIL_PREFIX)) changed();
  });

  function refresh(force = false) {
    return Promise.all([loadScout(force), loadWanderer(force)]);
  }

  const api = {
    get settings() { return settings; },
    feeds,
    names,
    sysName,
    /** A wormhole type by code (whInfo), once the type table has loaded. */
    whInfo: (code) => whInfo(whTypes, code),
    resolveNames,
    systemByName,
    links,
    refresh,
    /** The gate graph (galaxy.js buildGraph) the shortcuts are added to. */
    setBase(g) { base = g; changed(); refresh(); },
    /** The gate graph plus the shortcuts in use (the gate graph itself when there are none or they're off). */
    travelGraph() {
      if (!base) return null;
      const used = settings.on ? links().filter(l => l.use) : [];
      const key = used.map(l => l.key).sort().join(',');
      if (memo?.key !== `${key}|${names.size}` || memo.base !== base) {
        memo = { key: `${key}|${names.size}`, base, g: withLinks(base, used, names), count: used.length };
      }
      return memo.g;
    },
    /** Changes whenever travelGraph() would give different jumps; for page memo keys. */
    key() { api.travelGraph(); return memo?.key ?? ''; },
    /** How many shortcuts travelGraph() uses. */
    inUse() { api.travelGraph(); return memo?.count ?? 0; },
    update(patch) {
      settings = { ...settings, ...patch, wanderer: { ...settings.wanderer, ...patch.wanderer } };
      LS.set(KEYS.settings, settings);
      changed();
      refresh();
    },
    setUse(key, use, at) {
      if (use) delete off[key]; else off[key] = at;
      LS.set(KEYS.off, off);
      changed();
    },
    /** A pair you found yourself; with its type code, it expires when that type's lifetime runs out. */
    addManual(a, b, type = null) {
      const now = Date.now(), code = whCode(type), hours = whInfo(whTypes, code)?.hours || settings.hours;
      manual = manual.filter(l => pairKey(l.a, l.b) !== pairKey(a, b) && !(l.expiresAt <= now));
      manual.push({ a, b, at: now, expiresAt: now + hours * HOUR, kind: 'wormhole', src: 'manual', type: code, note: code || undefined });
      delete off[pairKey(a, b)];
      LS.set(KEYS.links, manual); LS.set(KEYS.off, off);
      changed();
    },
    removeManual(key) {
      manual = manual.filter(l => pairKey(l.a, l.b) !== key);
      LS.set(KEYS.links, manual);
      changed();
    },
  };
  // Keep the live feeds fresh while a page is open.
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, WANDERER_TTL);
  return api;
}

/**
 * A "Wormholes" switch for a page's settings bar: turns shortcuts on or off everywhere and links to
 * the Routes page, where they're managed (wormhole-panel.js).
 */
export function mountToggle(el, sc) {
  const draw = () => {
    const n = sc.links().filter(l => l.use).length;
    el.innerHTML = `<input type="checkbox"${sc.settings.on ? ' checked' : ''}> Wormholes
      <a href="route-planner.html#wormholes" title="Wormhole shortcuts count in every jump total. Manage them on the Routes page.">${n ? `(${n})` : 'set up'}</a>`;
  };
  el.addEventListener('change', (e) => { if (e.target.type === 'checkbox') sc.update({ on: e.target.checked }); });
  draw();
  return draw;
}
