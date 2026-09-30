import { HUBS, DEFAULT_TAX_PCT, formatIsk, summarizeSteps } from './arbitrage.js';
import {
  normalizeEsiOrder, normalizeTycoonOrder, mergeOrders, hubBook, bookQuote, volumeWeightedTop,
  mergeHistory, historyChange, parseFuzzwork, parseGoonXml, consensus, isNpcStation,
  MAJOR_HUB_SYSTEMS, stationQuotes, parseAdam, parseEvepraisal, parseZkill,
} from './market-merge.js';
import { buildGraph, jumpsFrom, jumpsBetween, systemInfo, isHighSec, isNullSec } from './galaxy.js';
import { SHIP_CATEGORY } from './trips.js';
import { buildRangeContext, bookEntry, pairsForType, sellPoints } from './ranges.js';
import { createMe } from './me.js';
import { createShortcuts, mountToggle } from './shortcuts.js';
import { scanClient, tabNote, showProgress } from './scan-client.js';
import { createWatchlist, itemPic, removeButton, copyButton } from './watchlist.js';
import { normalizeMyOrder, orderStanding, expiresAt } from './orders.js';
import { secColor, secLabel } from './map.js';
import { readUrl, writeUrl } from './url-state.js';
import { mountFitButton } from './fit-dialog.js';
import { mountSectionNav, openSection } from './nav.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const LS = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota or disabled */ } },
};

// The starter list watchlists used to have; one still equal to it starts empty (watchlist.js).
const OLD_DEFAULT_ITEMS = [
  { typeId: 34, name: 'Tritanium' },
  { typeId: 37, name: 'Isogen' },
  { typeId: 40520, name: 'Large Skill Injector' },
  { typeId: 587, name: 'Rifter' },
  { typeId: 16274, name: 'Helium Isotopes' },
];
const JITA = HUBS[0];
const GOON_STATION = JITA.stationId; // Goonmetrics only publishes Jita 4-4
const AUTO_MS = 5 * 60_000;
const CONCURRENCY = 4;

const stored = LS.get('market.settings', {});
// Sales tax used to default to 0%; a saved 0 from then becomes the in-game base rate, once (taxV).
if (!stored.taxV && !Number(stored.tax)) delete stored.tax;
if (stored.hub && !stored.refHub) stored.refHub = stored.hub; // settings from the first version
// Each section is its own page sharing this script and the settings bar:
// universe-scan.html (uscan), my-orders.html (orders) and watchlist.html (watch).
const PAGE = document.body.dataset.page;
const US_DEFAULTS = { minProfit: '5m', maxMargin: '100', maxJumps: '', rank: 'perJump', q: '', near: '', nearEnd: 'pickup', nearMax: '', hideShips: false };
const DEFAULTS = {
  items: [], refHub: JITA.id, home: JITA.id, flag: 'secure', tax: DEFAULT_TAX_PCT, taxV: 1, cargo: '', budget: '',
  hideHubs: true, structures: true, showGhosts: false, haulRank: 'perJump',
  selected: null, histDays: 90, auto: false, sort: { key: null, dir: -1 }, us: US_DEFAULTS,
};
const settings = Object.assign(structuredClone(DEFAULTS), stored);
// Nested so filters added later still get defaults when older settings are loaded.
settings.us = { ...US_DEFAULTS, ...stored.us };
// Settings mirrored in the query string (url-state.js); the watchlist, sort and auto-refresh stay local.
const URL_FIELDS = [
  ['selected', v => v > 0], ['refHub', HUBS.map(h => h.id)], ['home', v => v > 0], ['flag', ['secure', 'nonull', 'shortest']],
  ['tax', v => v >= 0 && v <= 100], 'cargo', 'budget', 'hideHubs', 'structures', 'showGhosts',
  ['haulRank', ['perJump', 'profit', 'margin']], ['histDays', [30, 90, 365, 0]],
  'us.minProfit', 'us.maxMargin', 'us.maxJumps', ['us.rank', ['perJump', 'near', 'profit', 'iskm3', 'margin']], 'us.q',
  'us.near', ['us.nearEnd', ['pickup', 'dropoff', 'either']], 'us.nearMax', 'us.hideShips',
];
// The watchlist is saved on its own: to your character when signed in, else this browser (watchlist.js).
const watch = createWatchlist('market', { legacy: stored.items, legacyDefaults: OLD_DEFAULT_ITEMS, onLoad: applyWatchlist });
settings.items = watch.initial();
// A link to an item you don't watch yet adds it.
let urlItem = null;
if (readUrl(settings, DEFAULTS, URL_FIELDS) && settings.selected && !settings.items.some(i => i.typeId === settings.selected)) {
  urlItem = settings.selected;
  settings.items.push({ typeId: settings.selected, name: `Type ${settings.selected}` }); // named once types.json loads
}
const save = () => { LS.set('market.settings', { ...settings, items: undefined }); writeUrl(settings, DEFAULTS, URL_FIELDS); };
const saveItems = () => watch.save(settings.items);

// data[typeId] = { esi: {regionId: {orders, at}}, tycoon: {orders, at}, esiHist, tyHist, tyStats, praisal, zkill, errors }
const data = {};
const agg = { fuzz: {}, goon: null, adam: {}, mokaam: {}, ccp: null };
const names = new Map();                      // locationId → station/structure name (from Tycoon payloads)
let stationNames = null;                      // NPC stationId → [name, systemId] (SDE, loaded on demand)
const sourceState = {
  esi: { label: 'ESI', desc: 'CCP live orders, history, global average prices' },
  tycoon: { label: 'EVE Tycoon', desc: 'orders in every region incl. structures, history since 2019, 5% stats' },
  fuzzwork: { label: 'Fuzzwork', desc: 'station aggregates + percentiles' },
  goon: { label: 'Goonmetrics', desc: 'Jita 4-4 quotes, weekly movement', jitaOnly: true },
  evepraisal: { label: 'Evepraisal', desc: 'hub + universe-wide summaries per item' },
  adam4eve: { label: 'Adam4EVE', desc: 'region best prices + 5% percentiles (1 req / 5 s)' },
  mokaam: { label: 'Mokaam', desc: 'region trend stats: VWAP, 52-week range (major regions)' },
  zkill: { label: 'zKillboard', desc: 'daily item valuation back to 2007' },
};
for (const s of Object.values(sourceState)) Object.assign(s, { ok: 0, err: 0, at: null, lastErr: null });
const ui = { loading: false, bookAll: false, lastError: null, timer: null, ver: 0 };
let graph = null, types = null;               // graph: stargates only (names, order ranges)
// Wormhole shortcuts (shortcuts.js): jumps use the gate graph plus the ones in use.
let drawToggle = () => {};
const sc = createShortcuts({ onChange: () => { drawToggle(); bump(); renderAll(); } });
const travel = () => sc.travelGraph() || graph;

const $ = (id) => document.getElementById(id);
const refHub = () => HUBS.find(h => h.id === settings.refHub) || JITA;
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slot = (typeId) => (data[typeId] ||= { esi: {}, tycoon: null, esiHist: {}, tyHist: {}, tyStats: {}, praisal: null, zkill: null, errors: {} });
const bump = () => { ui.ver++; };

function parseAmount(v) {
  const m = String(v ?? '').trim().toLowerCase().replace(/[, _]/g, '').match(/^(\d*\.?\d+)([kmb]?)$/);
  if (!m) return null;
  return Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1);
}

// ---------------------------------------------------------------------------
// Fetching — everything goes through the local caching proxy
// ---------------------------------------------------------------------------
async function get(source, url, as = 'json') {
  const s = sourceState[source];
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = as === 'text' ? await res.text() : await res.json();
    const at = Date.parse(res.headers.get('x-fetched-at')) || Date.now();
    s.ok++; s.at = Math.max(s.at || 0, at); s.lastErr = null;
    bump();
    return { body, at, headers: res.headers };
  } catch (e) {
    s.err++; s.lastErr = e.message;
    throw e;
  }
}

async function fetchEsiOrders(typeId, regionId) {
  const base = `/api/esi/markets/${regionId}/orders/?order_type=all&type_id=${typeId}`;
  const first = await get('esi', base);
  const pages = Number(first.headers.get('x-pages')) || 1;
  const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => get('esi', `${base}&page=${i + 2}`)));
  const orders = [first, ...rest].flatMap(r => r.body).map(o => normalizeEsiOrder(o, regionId));
  slot(typeId).esi[regionId] = { orders, at: first.at };
}

async function fetchTycoonOrders(typeId) {
  const { body, at } = await get('tycoon', `/api/tycoon/v1/market/orders/${typeId}`);
  for (const [id, n] of Object.entries(body.stationNames || {})) names.set(Number(id), n);
  for (const [id, n] of Object.entries(body.structureNames || {})) names.set(Number(id), n);
  slot(typeId).tycoon = { orders: (body.orders || []).map(normalizeTycoonOrder), at };
}

const fetchEsiHistory = async (typeId, regionId) => {
  slot(typeId).esiHist[regionId] = (await get('esi', `/api/esi/markets/${regionId}/history/?type_id=${typeId}`)).body;
};
const fetchTycoonHistory = async (typeId, regionId) => {
  slot(typeId).tyHist[regionId] = (await get('tycoon', `/api/tycoon/v1/market/history/${regionId}/${typeId}`)).body;
};
const fetchTycoonStats = async (typeId, regionId) => {
  const r = await get('tycoon', `/api/tycoon/v1/market/stats/${regionId}/${typeId}`);
  slot(typeId).tyStats[regionId] = { ...r.body, at: r.at };
};
const fetchPraisal = async (typeId) => {
  const r = await get('evepraisal', `/api/evepraisal/item/${typeId}.json`);
  slot(typeId).praisal = parseEvepraisal(r.body);
};
const fetchZkill = async (typeId) => {
  slot(typeId).zkill = parseZkill((await get('zkill', `/api/zkill/prices/${typeId}/`)).body);
};

async function fetchFuzzwork(stationId, typeIds) {
  const byType = { ...(agg.fuzz[stationId]?.byType || {}) };
  let at = null;
  for (let i = 0; i < typeIds.length; i += 100) {
    const r = await get('fuzzwork', `/api/fuzzwork/aggregates/?station=${stationId}&types=${typeIds.slice(i, i + 100).join(',')}`);
    Object.assign(byType, parseFuzzwork(r.body));
    at = r.at;
  }
  agg.fuzz[stationId] = { byType, at };
}

async function fetchGoon(typeIds) {
  const r = await get('goon', `/api/goon/price_data/?station_id=${GOON_STATION}&type_id=${typeIds.join(',')}`, 'text');
  agg.goon = { byType: parseGoonXml(r.body), at: r.at };
}

// Adam4EVE allows one request every 5 s (the proxy spaces them), so the whole watchlist goes in one call each.
async function fetchAdam(regionId, typeIds) {
  const q = `typeID=${typeIds.join(',')}&locationID=${regionId}`;
  const prices = await get('adam4eve', `/api/adam4eve/market_prices?${q}`);
  const pct = await get('adam4eve', `/api/adam4eve/market_percentiles?${q}`).catch(() => ({ body: {} }));
  agg.adam[regionId] = { byType: { ...(agg.adam[regionId]?.byType || {}), ...parseAdam(prices.body, pct.body) }, at: prices.at };
}

async function fetchMokaam(regionId, typeIds) {
  const r = await get('mokaam', `/api/mokaam/items?regionid=${regionId}&typeid=${typeIds.join(',')}`);
  agg.mokaam[regionId] = { byType: { ...(agg.mokaam[regionId]?.byType || {}), ...r.body }, at: r.at };
}

async function fetchCcpPrices() {
  if (agg.ccp && agg.ccp.at > Date.now() - 3600_000) return;
  const r = await get('esi', '/api/esi/markets/prices/');
  agg.ccp = { byType: new Map(r.body.map(p => [p.type_id, p])), at: r.at };
}

async function pool(tasks, n = CONCURRENCY) {
  let i = 0;
  const errors = [];
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (i < tasks.length) {
      const t = tasks[i++];
      try { await t(); } catch (e) { errors.push(e); }
    }
  }));
  return errors;
}

const tracked = (typeId, key, fn) => async () => {
  try { await fn(); delete slot(typeId).errors[key]; }
  catch (e) { slot(typeId).errors[key] = e.message; throw e; }
};

function itemTasks(id, h) {
  return [
    tracked(id, 'tycoon', () => fetchTycoonOrders(id)),
    tracked(id, 'esi', () => fetchEsiOrders(id, h.regionId)),
    tracked(id, 'esiHist', () => fetchEsiHistory(id, h.regionId)),
    tracked(id, 'evepraisal', () => fetchPraisal(id)),
  ];
}
const batchTasks = (h, ids) => [
  () => fetchFuzzwork(h.stationId, ids),
  async () => { if (h.id === JITA.id) await fetchGoon(ids); },
  () => fetchAdam(h.regionId, ids),
  () => fetchMokaam(h.regionId, ids),
  () => fetchCcpPrices(),
];

async function refresh() {
  if (ui.loading) return;
  ui.loading = true;
  const btn = $('refreshBtn');
  btn.disabled = true; btn.classList.add('loading');
  const h = refHub();
  const ids = settings.items.map(i => i.typeId);
  renderStatus('Loading…');
  let done = 0;
  const wrap = (t) => async () => { try { await t(); } finally { if (++done % 4 === 0) renderAll(); } };
  const errs = await pool([
    ...ids.flatMap(id => itemTasks(id, h)).map(wrap),
    ...(ids.length ? batchTasks(h, ids).map(wrap) : []),
  ]);
  renderAll();
  errs.push(...await loadDetail());
  loadMyOrders();
  ui.loading = false;
  btn.disabled = false; btn.classList.remove('loading');
  ui.lastError = errs.length ? `${errs.length} request${errs.length > 1 ? 's' : ''} failed (${errs[0].message})` : null;
  renderAll();
}

// Detail adds long history, region stats, zKill valuations and every hub's live ESI book.
async function loadDetail() {
  const id = settings.selected;
  if (!id) return [];
  const h = refHub();
  const s = slot(id);
  const tasks = [
    tracked(id, 'tyHist', () => fetchTycoonHistory(id, h.regionId)),
    tracked(id, 'tyStats', () => fetchTycoonStats(id, h.regionId)),
    tracked(id, 'zkill', () => fetchZkill(id)),
  ];
  if (!s.esiHist[h.regionId]) tasks.push(tracked(id, 'esiHist', () => fetchEsiHistory(id, h.regionId)));
  if (!s.tycoon) tasks.push(tracked(id, 'tycoon', () => fetchTycoonOrders(id)));
  if (!s.praisal) tasks.push(tracked(id, 'evepraisal', () => fetchPraisal(id)));
  for (const other of HUBS) if (other.id !== h.id || !s.esi[h.regionId]) {
    tasks.push(tracked(id, `esi${other.regionId}`, () => fetchEsiOrders(id, other.regionId)));
  }
  const errs = await pool(tasks);
  renderAll();
  return errs;
}

// ---------------------------------------------------------------------------
// Collation (memoised per data version + settings)
// ---------------------------------------------------------------------------
const memo = new Map();
const settingsKey = () => [settings.refHub, settings.home, settings.flag, settings.tax, settings.cargo, settings.budget,
  settings.hideHubs, settings.structures, settings.showGhosts, !!graph, !!stationNames, sc.key()].join('|');

function collate(typeId) {
  const key = `${ui.ver}|${settingsKey()}`;
  const hit = memo.get(typeId);
  if (hit?.key === key) return hit.value;
  const value = computeCollation(typeId);
  memo.set(typeId, { key, value });
  return value;
}

function computeCollation(typeId) {
  const s = data[typeId];
  if (!s) return null;
  const esiRegions = Object.keys(s.esi).map(Number);
  const esiOrders = Object.values(s.esi).flatMap(r => r.orders);
  const tyOrders = s.tycoon?.orders || [];
  if (!esiOrders.length && !tyOrders.length && !esiRegions.length) return null;
  const merged = mergeOrders([
    { id: 'esi', live: true, regions: esiRegions, orders: esiOrders },
    { id: 'tycoon', orders: tyOrders },
  ]);
  const h = refHub();
  const book = hubBook(merged.orders, h, { includeGhosts: settings.showGhosts });
  const hist = mergeHistory(s.esiHist[h.regionId] || [], s.tyHist[h.regionId] || []);
  const quote = bookQuote(book);

  // Everywhere else
  const quotes = stationQuotes(merged.orders, { includeGhosts: settings.showGhosts });
  const allow = (q) => (settings.structures || isNpcStation(q.locationId)) && !(settings.hideHubs && MAJOR_HUB_SYSTEMS.has(q.systemId));
  // With high-sec routing, a station you can't reach safely isn't a deal.
  const reachable = (q) => !graph || settings.flag === 'shortest' || homeJumps(q.systemId) != null;
  const allowed = [...quotes.values()].filter(q => allow(q) && reachable(q));
  const cheapest = allowed.filter(q => q.bestAsk != null).sort((a, b) => a.bestAsk - b.bestAsk);
  // Where to sell: until the star map and station list load, each buy order at its own station;
  // then counting ranges (the station nearest your home that each order's range reaches).
  let dearest = allowed.filter(q => q.bestBid != null).sort((a, b) => b.bestBid - a.bestBid);
  // Hauls, counting buy-order ranges: sell at the nearest station each order's range reaches
  // (see ranges.js). Sources are filtered up front; sell points after matching.
  let hauls = [];
  const ctx = rangeContext();
  if (ctx) {
    const taxRate = (Number(settings.tax) || 0) / 100;
    const limits = { taxRate, unitVolume: types?.[typeId]?.[1] || 0,
      maxVolume: parseAmount(settings.cargo) ?? Infinity, maxCost: parseAmount(settings.budget) ?? Infinity };
    const entry = bookEntry(merged.orders, { includeGhosts: settings.showGhosts, allowSource: (q) => allow(q) && reachable(q) });
    dearest = sellPoints(entry, ctx, settings.home).filter(q => allow(q) && reachable(q));
    for (const c of pairsForType(typeId, entry, ctx, { minProfit: 0, keep: false, maxSources: 40, maxSteps: 200 })) {
      const to = { locationId: c.d, systemId: c.ds };
      if (!allow(to) || !reachable(to)) continue;
      const j = c.fs === c.ds ? 0 : jumpsBetween(travel(), c.fs, c.ds, settings.flag);
      if (j == null) continue;
      const s = summarizeSteps(c.s, limits);
      if (s.units <= 0 || s.profit <= 0) continue;
      const toStart = homeJumps(c.fs);
      hauls.push({ from: { locationId: c.f, systemId: c.fs }, to, x: !!c.x, jumps: j, homeJumps: toStart, ...s,
        margin: s.cost ? s.profit / s.cost * 100 : null, perJump: s.profit / Math.max(1, j + (toStart ?? 0)) });
    }
    const rank = { perJump: 'perJump', profit: 'profit', margin: 'margin' }[settings.haulRank] || 'perJump';
    hauls.sort((a, b) => (b[rank] ?? -Infinity) - (a[rank] ?? -Infinity));
  }
  const universe = { sell: cheapest[0]?.bestAsk ?? null, buy: dearest[0]?.bestBid ?? null };
  // Region-wide best prices at the reference hub's region, for the region-scope sources.
  const inRegion = [...quotes.values()].filter(q => q.regionId === h.regionId);
  const region = {
    sell: Math.min(...inRegion.map(q => q.bestAsk ?? Infinity)),
    buy: Math.max(...inRegion.map(q => q.bestBid ?? -Infinity)),
  };
  for (const k of ['sell', 'buy']) if (!Number.isFinite(region[k])) region[k] = null;
  return { merged, book, quote, hist, s, quotes, cheapest, dearest, hauls, universe, region };
}

function homeDist() { return jumpsFrom(travel(), settings.home, settings.flag); }

// Range matching needs the gate graph and where NPC stations are; built once both have loaded.
let rangeCtx = null;
function rangeContext() {
  if (!graph || !stationNames) return null;
  if (rangeCtx?.graph !== graph || rangeCtx.stations !== stationNames) {
    rangeCtx = { graph, stations: stationNames, ctx: buildRangeContext(graph, stationNames) };
  }
  return rangeCtx.ctx;
}
const loadStations = () => (stationNames ? Promise.resolve(stationNames)
  : fetch('data/stations.json').then(r => (r.ok ? r.json() : {})).catch(() => ({})).then(t => { stationNames ||= t; bump(); return stationNames; }));
// High-sec-only routes leave a low-/null-sec home by the nearest high-sec (galaxy.js), but a home with
// no gate route into high-sec (Pochven) reaches nothing else, so every station is filtered out; say why.
function homeBlocked() {
  if (!graph || settings.flag === 'shortest') return null;
  const secure = settings.flag === 'secure', sec = systemInfo(graph, settings.home)?.sec ?? 1;
  if (secure ? isHighSec(sec) : !isNullSec(sec)) return null;
  if (homeDist().some(d => d > 0)) return null;
  const sys = systemInfo(graph, settings.home), space = secure ? 'high-sec' : 'high- or low-sec';
  return `${esc(sys.name)} (${secLabel(sys.sec)}) has no gate route into ${space}, so ${space} routes reach no station. Set Route to Shortest, or choose another home system.`;
}
function homeJumps(systemId) {
  if (!graph) return null;
  const i = graph.indexOf.get(systemId);
  const d = i == null ? -1 : homeDist()[i];
  return d < 0 ? null : d;
}

// Independent quotes for the reference hub, one per source, grouped by scope.
function sourceQuotes(typeId, c) {
  const h = refHub();
  const s = c.s;
  const station = [], region = [];
  const esiR = s.esi[h.regionId];
  if (esiR) station.push({ id: 'esi', ...bookQuote(hubBook(esiR.orders, h)), at: esiR.at });
  if (s.tycoon) station.push({ id: 'tycoon', ...bookQuote(hubBook(s.tycoon.orders, h, { includeGhosts: true })), at: s.tycoon.at });
  const fz = agg.fuzz[h.stationId]?.byType[typeId];
  if (fz) station.push({ id: 'fuzzwork', ...fz, at: agg.fuzz[h.stationId].at });
  const gn = h.id === JITA.id ? agg.goon?.byType[typeId] : null;
  if (gn) station.push({ id: 'goon', ...gn, at: gn.updated || agg.goon.at });
  const ep = s.praisal?.[h.name.toLowerCase()];
  if (ep) station.push({ id: 'evepraisal', ...ep });
  const ad = agg.adam[h.regionId]?.byType[typeId];
  if (ad) region.push({ id: 'adam4eve', ...ad });
  return { station, region };
}

function agreement(typeId, c) {
  const q = sourceQuotes(typeId, c);
  const regionQuotes = [{ id: 'merged', value: c.region.sell }, ...q.region.map(r => ({ id: r.id, value: r.sell }))];
  return {
    ...q,
    sell: consensus(q.station.map(r => ({ id: r.id, value: r.sell }))),
    buy: consensus(q.station.map(r => ({ id: r.id, value: r.buy }))),
    regionSell: consensus(regionQuotes),
  };
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------
const isk = (v) => formatIsk(v);
const num = (v) => {
  if (v == null || !Number.isFinite(v)) return '—';
  if (Math.abs(v) < 1000) return String(Math.round(v));
  return formatIsk(v, 1);
};
const pct = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%`);
const signCls = (v) => (v == null ? 'muted' : v > 0 ? 'up' : v < 0 ? 'down' : 'muted');
function ago(ms) {
  if (!ms) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const icon = (id, size = 32) => `https://images.evetech.net/types/${id}/icon?size=${size}`;
const SRC_LABEL = Object.fromEntries(Object.entries(sourceState).map(([k, v]) => [k, v.label]));
const SRC_LETTER = { esi: 'E', tycoon: 'T', fuzzwork: 'F', goon: 'G', evepraisal: 'P', adam4eve: 'A', merged: 'M' };

function secSpan(sec) {
  if (sec == null) return '';
  return `<span class="sec" style="--sec:${secColor(sec)}">${secLabel(sec)}</span>`;
}
// "Station name" with system, security and region, for any location in the merged book.
function placeHtml(q, { compact = false } = {}) {
  const sys = graph ? systemInfo(graph, q.systemId) : null;
  const full = names.get(q.locationId) || stationNames?.[q.locationId]?.[0];
  const npc = isNpcStation(q.locationId);
  const label = full ? (compact ? full.split(' - ')[0] : full) : npc ? `Station ${q.locationId}` : 'Structure';
  const hub = MAJOR_HUB_SYSTEMS.has(q.systemId) ? '<span class="badge ov">hub</span>' : '';
  const struct = npc ? '' : '<span class="badge stale" title="Player structure — docking or market access may be restricted">structure</span>';
  return `<span class="place" title="${esc(full || '')}"><b>${esc(label)}</b>${hub}${struct}`
    + `<small>${sys ? `${secSpan(sys.sec)} ${esc(sys.name)} · ${esc(sys.region)}` : 'Unknown system'}</small></span>`;
}
// Links to the raw data behind a haul end: ESI's region book on that side (what the scan and merge read)
// and EVE Tycoon's item page (the second order source, incl. structures).
function srcLinks(typeId, systemId, side) {
  const region = graph ? systemInfo(graph, systemId)?.regionId : null;
  const esi = region ? `<a href="https://esi.evetech.net/latest/markets/${region}/orders/?order_type=${side}&type_id=${typeId}" target="_blank" rel="noopener"
    title="Raw ESI ${side} orders for this item in ${esc(systemInfo(graph, systemId).region)}">ESI ↗</a>` : '';
  return `<span class="src-links">${esi}<a href="https://evetycoon.com/market/${typeId}" target="_blank" rel="noopener" title="This item on EVE Tycoon">Tycoon ↗</a></span>`;
}
const jumpsCell = (sys) => { const j = homeJumps(sys); return j == null ? '<span class="muted" title="Unreachable with this route setting">—</span>' : String(j); };

function sparkline(days, w = 90, h = 22) {
  const pts = days.slice(-30);
  if (pts.length < 2) return '<span class="muted">—</span>';
  const vals = pts.map(d => d.average);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const xy = vals.map((v, i) => `${(i / (vals.length - 1) * w).toFixed(1)},${(h - 2 - (v - lo) / span * (h - 4)).toFixed(1)}`).join(' ');
  const up = vals[vals.length - 1] >= vals[0];
  return `<svg class="spark ${up ? 'up' : 'down'}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${xy}"/></svg>`;
}

function renderStatus(msg) {
  const el = $('status');
  if (msg) { el.textContent = msg; el.classList.remove('err'); return; }
  const times = Object.values(sourceState).map(s => s.at).filter(Boolean);
  const newest = times.length ? Math.max(...times) : null;
  el.textContent = ui.lastError || (newest ? `Updated ${new Date(newest).toLocaleTimeString()}` : 'Not loaded');
  el.classList.toggle('err', !!ui.lastError);
}

function renderSources() {
  $('sources').innerHTML = Object.entries(sourceState).map(([, s]) => {
    const na = s.jitaOnly && refHub().id !== JITA.id;
    const state = na ? 'na' : s.lastErr && !s.at ? 'error' : s.at ? (s.lastErr ? 'warn' : 'ok') : 'idle';
    const detail = na ? 'Jita only' : s.lastErr && !s.at ? s.lastErr : s.at ? `data ${ago(s.at)}${s.lastErr ? ' · some failed' : ''}` : 'waiting';
    const dot = { ok: 'ok', error: 'error', warn: 'stale' }[state] || '';
    return `<li class="src-chip ${state}" title="${esc(s.desc)}${s.lastErr ? `\nLast error: ${esc(s.lastErr)}` : ''}"><i class="dot ${dot}"></i>
      <b>${esc(s.label)}</b><span>${esc(detail)}</span></li>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Watchlist board
// ---------------------------------------------------------------------------
const COLUMNS = [
  { key: 'name', label: 'Item', l: true },
  { key: 'ref', label: 'Hub sell', ref: true },
  { key: 'cheapPct', label: 'Cheapest elsewhere', l: true },
  { key: 'bidPct', label: 'Best buy order elsewhere', l: true },
  { key: 'haulProfit', label: 'Best haul', l: true },
  { key: 'haulPJ', label: 'ISK/jump' },
  { key: 'd7', label: 'Δ 7d' },
  { key: 'trend', label: '30d', nosort: true },
  { key: 'agree', label: 'Sources', l: true },
];

function boardRows() {
  return settings.items.map(it => {
    const c = collate(it.typeId);
    const s = data[it.typeId];
    const row = { it, c, name: it.name, errors: s ? Object.values(s.errors) : [] };
    if (!c) return row;
    row.ref = c.quote.sell;
    row.cheap = c.cheapest[0];
    row.cheapPct = row.cheap && row.ref ? (row.cheap.bestAsk - row.ref) / row.ref * 100 : null;
    row.bid = c.dearest[0];
    row.bidPct = row.bid && c.quote.buy ? (row.bid.bestBid - c.quote.buy) / c.quote.buy * 100 : null;
    row.haul = c.hauls[0];
    row.haulProfit = row.haul?.profit ?? null;
    row.haulPJ = row.haul?.perJump ?? null;
    row.d7 = historyChange(c.hist.days, 7);
    row.days = c.hist.days;
    row.agreeInfo = agreement(it.typeId, c);
    row.agree = row.agreeInfo.sell.n ? row.agreeInfo.sell.n - row.agreeInfo.sell.outliers.length : null;
    return row;
  });
}

function sortRows(rows) {
  const { key, dir } = settings.sort;
  if (!key) return rows;
  // For "cheapest" lower is better; the sort direction toggle still applies.
  return rows.slice().sort((a, b) => {
    const x = a[key], y = b[key];
    if (x == null) return 1; if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
  });
}

function renderBoard() {
  const { key, dir } = settings.sort;
  const h = refHub();
  $('boardHead').innerHTML = COLUMNS.map(c => `<th class="${c.l ? 'l' : ''}" data-key="${c.nosort ? '' : c.key}"${key === c.key ? ` aria-sort="${dir > 0 ? 'ascending' : 'descending'}"` : ''}>${c.ref ? `${h.name} sell` : c.label}</th>`).join('') + '<th aria-label="Remove"></th>';
  const rows = sortRows(boardRows());
  $('boardCount').textContent = `· ${settings.items.length} item${settings.items.length === 1 ? '' : 's'}`;
  const home = graph ? systemInfo(graph, settings.home) : null;
  $('boardHint').textContent = `${settings.hideHubs ? 'Trade hubs skipped' : 'Hubs included'} · ${settings.flag === 'secure' ? 'high-sec routes' : settings.flag === 'nonull' ? 'high- and low-sec routes' : 'any-sec routes'}${home ? ` · jumps from ${home.name}` : ''}${homeBlocked() ? ' (no route into high-sec: set Route to Shortest)' : ''} · click a row for detail`;
  if (!rows.length) {
    $('boardBody').innerHTML = `<tr class="empty"><td colspan="10">Your watchlist is empty. Add items with the <b>Add item</b> search above${watch.mode === 'account' ? ' — it’s saved to your character' : ''}.</td></tr>`;
    return;
  }
  $('boardBody').innerHTML = rows.map(r => {
    const sel = settings.selected === r.it.typeId;
    const loading = !r.c && ui.loading;
    const err = r.errors.length && !r.c;
    let agree = '<span class="muted">—</span>';
    if (r.agreeInfo?.sell.n) {
      const { station, sell } = r.agreeInfo;
      agree = `<span class="agree" title="${esc(station.map(q => `${SRC_LABEL[q.id]}: ${isk(q.sell)}${sell.outliers.includes(q.id) ? ' (off consensus)' : ''}`).join('\n'))}">`
        + station.map(q => `<i class="sd ${q.sell == null ? 'none' : sell.outliers.includes(q.id) ? 'off' : 'on'}">${SRC_LETTER[q.id]}</i>`).join('')
        + '</span>';
    }
    const cheap = r.cheap ? `<span class="deal"><b>${isk(r.cheap.bestAsk)}</b> <span class="${r.cheapPct < 0 ? 'up' : 'muted'}">${pct(r.cheapPct)}</span>${placeHtml(r.cheap, { compact: true })}</span>` : '<span class="muted">—</span>';
    const bid = r.bid ? `<span class="deal"><b>${isk(r.bid.bestBid)}</b> <span class="${r.bidPct > 0 ? 'up' : 'muted'}">${pct(r.bidPct)}</span>${placeHtml(r.bid, { compact: true })}</span>` : '<span class="muted">—</span>';
    const haul = r.haul ? `<span class="deal"><b class="up">${isk(r.haul.profit)}</b> <span class="muted">${r.haul.jumps}j</span>
        <small>${esc(sysName(r.haul.from.systemId))} → ${esc(sysName(r.haul.to.systemId))}</small></span>`
      : `<span class="muted">${graph ? 'none found' : 'loading map…'}</span>`;
    return `<tr data-id="${r.it.typeId}" class="${sel ? 'picked' : ''}">
      <td class="l item">${itemPic(r.it.typeId, r.it.name, 28)}<span>${esc(r.it.name)}</span>${copyButton(r.it.name)}
        ${loading ? '<i class="dot loading"></i>' : ''}${err ? `<span class="badge stale" title="${esc(r.errors.join('; '))}">ERR</span>` : ''}</td>
      <td>${isk(r.ref)}</td>
      <td class="l">${cheap}</td>
      <td class="l">${bid}</td>
      <td class="l">${haul}</td>
      <td class="${r.haulPJ ? 'metric' : ''}">${isk(r.haulPJ)}</td>
      <td class="${signCls(r.d7)}">${pct(r.d7)}</td>
      <td>${r.days ? sparkline(r.days) : ''}</td>
      <td class="l">${agree}</td>
      <td>${removeButton(r.it.typeId, r.it.name)}</td>
    </tr>`;
  }).join('');
}
const sysName = (id) => (graph ? systemInfo(graph, id)?.name : null) || `System ${id}`;

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------
function renderDetail() {
  const id = settings.selected;
  const it = settings.items.find(i => i.typeId === id);
  $('detail').hidden = !it;
  if (!it) return;
  const h = refHub();
  const c = collate(id);
  $('dIcon').src = icon(id, 64);
  $('dName').textContent = it.name;
  const vol = types?.[id]?.[1];
  $('dSub').textContent = `Type ${id}${vol ? ` · ${vol.toLocaleString()} m³ packaged` : ''}`;
  $('dLinks').innerHTML = [
    ['EVE Tycoon', `https://evetycoon.com/market/${id}`],
    ['Fuzzwork', `https://market.fuzzwork.co.uk/type/${id}/`],
    ['Adam4EVE', `https://www.adam4eve.eu/commodity.php?typeID=${id}`],
    ['Evepraisal', `https://evepraisal.itworks.cc/item/${id}`],
    ['zKillboard', `https://zkillboard.com/item/${id}/`],
    ['EVE Ref', `https://everef.net/types/${id}`],
  ].map(([n, u]) => `<a href="${u}" target="_blank" rel="noopener">${n} ↗</a>`).join('');
  document.querySelectorAll('.refName').forEach(e => { e.textContent = h.name; });
  if (!c) {
    $('dKpis').innerHTML = `<span class="muted">${ui.loading ? 'Loading…' : 'No data yet — press Refresh.'}</span>`;
    ['srcBody', 'hubsBody', 'askBody', 'bidBody', 'haulBody', 'buyWhere', 'sellWhere'].forEach(k => { $(k).innerHTML = ''; });
    $('collate').innerHTML = '';
    $('chart').innerHTML = '';
    return;
  }
  const best = c.hauls[0];
  const cheap = c.cheapest[0], bid = c.dearest[0];
  $('dKpis').innerHTML = [
    ['Best haul', best ? isk(best.profit) : '—', best ? `${isk(best.perJump)}/jump · ${best.jumps + (best.homeJumps ?? 0)} jumps total` : 'none found'],
    ['Cheapest elsewhere', isk(cheap?.bestAsk), cheap ? `${pct((cheap.bestAsk - c.quote.sell) / c.quote.sell * 100)} vs ${h.name} · ${sysName(cheap.systemId)}` : ''],
    ['Best bid elsewhere', isk(bid?.bestBid), bid ? `${pct((bid.bestBid - c.quote.buy) / c.quote.buy * 100)} vs ${h.name} · ${sysName(bid.systemId)}` : ''],
    [`${h.name} sell / buy`, `${isk(c.quote.sell)} / ${isk(c.quote.buy)}`, `Δ 7d ${pct(historyChange(c.hist.days, 7))} · Δ 30d ${pct(historyChange(c.hist.days, 30))}`],
  ].map(([k, v, s]) => `<div class="kpi"><span>${k}</span><b>${v}</b><small>${esc(s)}</small></div>`).join('');

  renderHauls(c, id);
  renderWhere(c);
  renderSourceTable(id, c);
  renderCollation(id, c);
  renderHubs(c);
  renderChart(c);
  renderBook(c);
}

function renderHauls(c, typeId) {
  const rows = c.hauls.slice(0, 20);
  $('haulMeta').textContent = `· ${c.hauls.length} profitable station pair${c.hauls.length === 1 ? '' : 's'}${settings.hideHubs ? ', hubs skipped' : ''}`;
  if (!graph) { $('haulBody').innerHTML = '<tr class="empty"><td colspan="10">Loading star map for jump counts…</td></tr>'; return; }
  $('haulBody').innerHTML = rows.map((r, i) => `<tr class="${i === 0 ? 'top' : ''}">
    <td class="l">${placeHtml(r.from, { compact: true })}<small class="muted">${r.homeJumps ?? '?'}j from home</small>${srcLinks(typeId, r.from.systemId, 'sell')}</td>
    <td class="l">${placeHtml(r.to, { compact: true })}${r.x
      ? '<small class="range-note" title="Some of the buy orders filled here were placed at other stations; their range reaches this one.">sells into ranged buy orders</small>' : ''}${srcLinks(typeId, r.to.systemId, 'buy')}</td>
    <td>${r.jumps}</td><td>${num(r.units)}</td><td>${num(r.volume)}</td><td>${isk(r.cost)}</td>
    <td>${isk(r.buy)} → ${isk(r.sell)}</td><td>${pct(r.margin)}</td>
    <td class="metric">${isk(r.profit)}</td><td>${isk(r.perJump)}</td></tr>`).join('')
    || (homeBlocked() ? `<tr class="empty"><td colspan="10">${homeBlocked()}</td></tr>` : '')
    || `<tr class="empty"><td colspan="10">No profitable station-to-station hauls with these settings${settings.flag === 'secure' ? ' (try High + low-sec or Shortest route)' : settings.flag === 'nonull' ? ' (try Shortest route to include null-sec)' : ''}.</td></tr>`;
}

function renderWhere(c) {
  const ref = c.quote;
  // `good` flips the colour: cheaper is good when buying, dearer is good when selling.
  const row = (q, price, vs, vol, good) => `<tr><td>${isk(price)}</td><td class="${signCls(vs == null ? null : vs * good)}">${pct(vs)}</td><td>${num(vol)}</td>
    <td class="l">${placeHtml(q)}${q.via ? `<small class="range-note" title="The best buy order that can be filled here was placed at another station; its range reaches this one.">ranged order placed in ${esc(sysName(q.via.systemId))}</small>` : ''}</td>
    <td>${jumpsCell(q.systemId)}</td></tr>`;
  const vsRef = (p, r) => (r ? (p - r) / r * 100 : null);
  $('buyWhere').innerHTML = c.cheapest.slice(0, 12).map(q => row(q, q.bestAsk, vsRef(q.bestAsk, ref.sell), q.askVolume, -1)).join('')
    || `<tr class="empty"><td colspan="5">${homeBlocked() || 'No sell orders outside the filters'}</td></tr>`;
  $('sellWhere').innerHTML = c.dearest.slice(0, 12).map(q => row(q, q.bestBid, vsRef(q.bestBid, ref.buy), q.bidVolume, 1)).join('')
    || `<tr class="empty"><td colspan="5">${homeBlocked() || 'No buy orders outside the filters'}</td></tr>`;
}

function renderSourceTable(id, c) {
  const h = refHub();
  const a = agreement(id, c);
  const cell = (v, cons) => {
    if (v == null) return '<td class="muted">—</td>';
    const off = cons?.median && Math.abs(v - cons.median) / cons.median > 0.02;
    return `<td class="${off ? 'warn-m' : ''}"${off ? ` title="${pct((v - cons.median) / cons.median * 100, 2)} vs consensus"` : ''}>${isk(v)}</td>`;
  };
  const line = (r, sell, buy, cls = '') => `<tr class="${cls}"><td class="l">${r.label}</td>${cell(r.sell, sell)}${cell(r.buy, buy)}
    <td>${num(r.sellVolume)}</td><td>${num(r.buyVolume)}</td>
    <td>${r.sellOrders != null ? `${r.sellOrders} / ${r.buyOrders}` : '—'}</td><td>${ago(r.at)}</td></tr>`;
  const group = (t) => `<tr class="group"><td colspan="7">${t}</td></tr>`;
  const mergedAt = Math.max(0, ...Object.values(c.s.esi).map(r => r.at), c.s.tycoon?.at || 0) || null;
  let html = group(`${esc(h.station)}`);
  html += line({ label: 'Merged (deduped)', ...c.quote, at: mergedAt }, a.sell, a.buy, 'top');
  for (const r of a.station) html += line({ ...r, label: SRC_LABEL[r.id] }, a.sell, a.buy);

  const regionCons = a.regionSell;
  html += group(`${esc(h.region)} (whole region)`);
  html += line({ label: 'Merged (deduped)', sell: c.region.sell, buy: c.region.buy, at: mergedAt }, regionCons, null, 'top');
  for (const r of a.region) html += line({ ...r, label: SRC_LABEL[r.id] }, regionCons, null);
  const ad = agg.adam[h.regionId]?.byType[id];
  if (ad?.sellPct) html += `<tr class="sub-row"><td class="l">Adam4EVE 5% percentile</td><td>${isk(ad.sellPct)}</td><td>${isk(ad.buyPct)}</td><td colspan="4"></td></tr>`;
  const st = c.s.tyStats[h.regionId];
  if (st) html += `<tr class="sub-row"><td class="l">EVE Tycoon 5% average</td><td>${isk(st.sellAvgFivePercent)}</td><td>${isk(st.buyAvgFivePercent)}</td>
      <td>${num(st.sellVolume)}</td><td>${num(st.buyVolume)}</td><td>${st.sellOrders} / ${st.buyOrders}</td><td>${ago(st.at)}</td></tr>`;
  const fz = agg.fuzz[h.stationId]?.byType[id];
  if (fz) html += `<tr class="sub-row"><td class="l">Fuzzwork 5th percentile <small>station</small></td><td>${isk(fz.sellPercentile)}</td><td>${isk(fz.buyPercentile)}</td><td colspan="4"></td></tr>`;

  html += group('All of New Eden');
  html += line({ label: 'Merged — every station', sell: c.universe.sell, buy: c.universe.buy, at: mergedAt }, null, null, 'top');
  const epU = c.s.praisal?.universe;
  if (epU) html += line({ ...epU, label: 'Evepraisal (universe)' }, null, null);

  html += group('Reference valuations');
  const ccp = agg.ccp?.byType.get(id);
  if (ccp) html += `<tr class="sub-row"><td class="l">CCP average / adjusted <small>ESI</small></td><td colspan="2">${isk(ccp.average_price)} / ${isk(ccp.adjusted_price)}</td><td colspan="3"></td><td>${ago(agg.ccp.at)}</td></tr>`;
  const zk = c.s.zkill;
  if (zk?.current) html += `<tr class="sub-row"><td class="l">zKillboard valuation</td><td colspan="2">${isk(zk.current)}</td><td colspan="4"></td></tr>`;
  const gn = h.id === JITA.id ? agg.goon?.byType[id] : null;
  if (gn?.weeklyMovement != null) html += `<tr class="sub-row"><td class="l">Goonmetrics weekly movement</td><td colspan="2">${num(gn.weeklyMovement)} units</td><td colspan="4"></td></tr>`;
  $('srcBody').innerHTML = html;
}

function renderCollation(id, c) {
  const m = c.merged.stats, hs = c.hist.stats;
  const structOnly = c.merged.orders.filter(o => !isNpcStation(o.locationId) && o.sources.length === 1 && o.sources[0] === 'tycoon').length;
  const regions = Object.keys(c.s.esi).length;
  const stations = c.quotes.size;
  const regionsSeen = new Set(c.merged.orders.map(o => o.regionId)).size;
  const items = [
    ['Coverage', `${num(stations)} stations/structures in ${regionsSeen} regions have orders`],
    ['Raw orders', `${num(m.bySource.esi)} ESI (${regions} region${regions === 1 ? '' : 's'}) + ${num(m.bySource.tycoon ?? 0)} EVE Tycoon (all regions)`],
    ['Unique after merge', `${num(m.unique)} — ${num(m.duplicates)} duplicates collapsed by order ID, ${num(m.conflicts)} conflicting copies resolved`],
    ['Ghosts', `${num(m.ghosts)} NPC-station orders only in Tycoon ${settings.showGhosts ? '(shown)' : '(hidden)'}`],
    ['Structure orders', `${num(structOnly)} only visible via EVE Tycoon`],
    ['History days', `${num(hs.esi)} ESI + ${num(hs.tycoon)} Tycoon → ${num(hs.total)} unique (${num(hs.shared)} overlap, ${num(hs.conflicts)} disagree >0.5%)`],
  ];
  const mk = agg.mokaam[refHub().regionId]?.byType[id];
  if (mk) {
    items.push(['Trend (Mokaam)', `avg week ${isk(mk.avg_price_week)} · month ${isk(mk.avg_price_month)} · year ${isk(mk.avg_price_year)}`]);
    items.push(['VWAP / range', `VWAP month ${isk(mk.vwap_month)} · 52-week ${isk(mk._52w_low)} – ${isk(mk._52w_high)}`]);
  }
  $('collate').innerHTML = items.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

function renderHubs(c) {
  const rows = HUBS.map(h => {
    const hasEsi = !!c.s.esi[h.regionId];
    const q = bookQuote(hubBook(c.merged.orders, h, { includeGhosts: settings.showGhosts }));
    return { h, q, partial: !hasEsi };
  });
  const cheapest = Math.min(...rows.map(r => r.q.sell).filter(v => v != null));
  const bestBid = Math.max(...rows.map(r => r.q.buy).filter(v => v != null));
  $('hubsBody').innerHTML = rows.map(({ h, q, partial }) => `<tr class="${h.id === settings.refHub ? 'picked' : ''}" data-hub="${h.id}">
    <td class="l"><b>${h.name}</b>${partial ? ' <span class="badge ov" title="Only EVE Tycoon data for this region so far">T only</span>' : ''}</td>
    <td class="${q.sell === cheapest ? 'up' : ''}">${isk(q.sell)}</td>
    <td class="${q.buy === bestBid ? 'up' : ''}">${isk(q.buy)}</td>
    <td>${num(q.sellVolume)}</td><td>${num(q.buyVolume)}</td>
    <td>${q.sell != null && Number.isFinite(cheapest) ? (q.sell === cheapest ? '<span class="up">cheapest</span>' : pct((q.sell - cheapest) / cheapest * 100)) : '—'}</td>
  </tr>`).join('');
}

function renderBook(c) {
  const lim = ui.bookAll ? Infinity : 15;
  const badges = (o) => `${o.sources.includes('esi') ? '<b class="src e">E</b>' : ''}${o.sources.includes('tycoon') ? '<b class="src t">T</b>' : ''}${o.ghost ? '<span class="badge stale">ghost</span>' : ''}`;
  const place = (o) => {
    const n = names.get(o.locationId);
    if (o.locationId === refHub().stationId) return 'Hub station';
    return n ? n.split(' - ')[0] : isNpcStation(o.locationId) ? `Station ${o.locationId}` : 'Structure';
  };
  const rng = (r) => (r === 'REGION' ? 'Region' : r === 'SOLARSYSTEM' ? 'System' : r === 'STATION' ? 'Station' : `${r.slice(1)} jumps`);
  let cum = 0;
  $('askBody').innerHTML = c.book.askOrders.slice(0, lim).map(o => {
    cum += o.price * o.volumeRemain;
    return `<tr class="${o.ghost ? 'ghost' : ''}"><td>${isk(o.price)}</td><td>${num(o.volumeRemain)}</td><td class="muted-num">${isk(cum)}</td>
      <td class="l">${ago(o.issued)}</td><td class="l">${badges(o)}</td></tr>`;
  }).join('') || '<tr class="empty"><td colspan="5">No sell orders in the hub station</td></tr>';
  $('bidBody').innerHTML = c.book.bidOrders.slice(0, lim).map(o => `<tr class="${o.ghost ? 'ghost' : ''}">
      <td>${isk(o.price)}</td><td>${num(o.volumeRemain)}</td><td class="l where" title="${esc(names.get(o.locationId) || '')}">${esc(place(o))}</td>
      <td class="l">${rng(o.range)}</td><td class="l">${badges(o)}</td></tr>`).join('')
    || '<tr class="empty"><td colspan="5">No buy orders reachable from the hub station</td></tr>';
  const total = c.book.askOrders.length + c.book.bidOrders.length;
  $('bookMeta').textContent = `· ${refHub().name} · ${c.book.askOrders.length} sell / ${c.book.bidOrders.length} buy`;
  $('bookMore').hidden = total <= 30;
  $('bookMore').textContent = ui.bookAll ? 'Show top 15' : 'Show all orders';
}

// ---------------------------------------------------------------------------
// History chart (SVG)
// ---------------------------------------------------------------------------
let chartModel = null;

function renderChart(c) {
  const hist = c.hist;
  const svg = $('chart');
  document.querySelectorAll('#histRange button').forEach(b => b.setAttribute('aria-selected', String(Number(b.dataset.days) === settings.histDays)));
  const days = settings.histDays ? hist.days.slice(-settings.histDays) : hist.days;
  const hs = hist.stats;
  $('histMeta').textContent = hist.days.length ? `· ${refHub().region} · ${days.length} days` : '';
  const W = svg.clientWidth || 800, H = 260, pad = { l: 64, r: 12, t: 10, b: 24 }, volH = 50;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  if (days.length < 2) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" class="c-empty">${hs.total ? 'Not enough history in this range' : ui.loading ? 'Loading history…' : 'No history'}</text>`;
    chartModel = null;
    return;
  }
  const zkBy = new Map((c.s.zkill?.days || []).map(d => [d.date, d.price]));
  const zk = days.map(d => zkBy.get(d.date) ?? null);
  const lo = Math.min(...days.map(d => d.lowest)), hi = Math.max(...days.map(d => d.highest));
  // Outlier wicks dwarf the average line on thin markets; clamp the axis to the averages ± a margin.
  const aLo = Math.min(...days.map(d => d.average)), aHi = Math.max(...days.map(d => d.average));
  const yLo = Math.max(lo, aLo - (aHi - aLo) * 0.6 - aHi * 0.01), yHi = Math.min(hi, aHi + (aHi - aLo) * 0.6 + aHi * 0.01);
  const vMax = Math.max(...days.map(d => d.volume)) || 1;
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b - volH - 6;
  const x = (i) => pad.l + i / (days.length - 1) * pw;
  const y = (v) => pad.t + (1 - (Math.min(yHi, Math.max(yLo, v)) - yLo) / (yHi - yLo || 1)) * ph;
  const vy = (v) => H - pad.b - v / vMax * volH;
  const bw = Math.max(1, pw / days.length - 1);

  let grid = '';
  for (let k = 0; k <= 4; k++) {
    const v = yLo + (yHi - yLo) * k / 4, yy = y(v);
    grid += `<line class="c-grid" x1="${pad.l}" x2="${W - pad.r}" y1="${yy}" y2="${yy}"/><text class="c-axis" x="${pad.l - 6}" y="${yy + 4}" text-anchor="end">${isk(v)}</text>`;
  }
  const labelEvery = Math.ceil(days.length / 6);
  const xl = days.map((d, i) => (i % labelEvery === 0 ? `<text class="c-axis" x="${x(i)}" y="${H - 6}" text-anchor="middle">${d.date.slice(days.length > 400 ? 0 : 5, days.length > 400 ? 7 : 10)}</text>` : '')).join('');
  const band = `M${days.map((d, i) => `${x(i)},${y(d.highest)}`).join('L')}L${days.map((d, i) => [x(i), y(d.lowest)]).reverse().map(p => p.join(',')).join('L')}Z`;
  const line = days.map((d, i) => `${i ? 'L' : 'M'}${x(i)},${y(d.average)}`).join('');
  let zline = '', pen = false;
  zk.forEach((v, i) => { if (v == null) { pen = false; return; } zline += `${pen ? 'L' : 'M'}${x(i)},${y(v)}`; pen = true; });
  const vols = days.map((d, i) => `<rect class="c-vol ${d.src === 'tycoon' ? 'tyc' : ''}" x="${x(i) - bw / 2}" y="${vy(d.volume)}" width="${bw}" height="${H - pad.b - vy(d.volume)}"/>`).join('');
  svg.innerHTML = `${grid}<path class="c-band" d="${band}"/>${vols}<path class="c-line" d="${line}"/>${zline ? `<path class="c-zk" d="${zline}"/>` : ''}${xl}
    <line id="cCross" class="c-cross" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/><circle id="cDot" class="c-dot" r="4" visibility="hidden"/>`;
  chartModel = { days, zk, x, y, W, pad, pw };
}

function onChartMove(e) {
  if (!chartModel) return;
  const r = $('chart').getBoundingClientRect();
  const sx = (e.clientX - r.left) * (chartModel.W / r.width);
  const { days, zk, x, y, pad, pw } = chartModel;
  const i = Math.max(0, Math.min(days.length - 1, Math.round((sx - pad.l) / pw * (days.length - 1))));
  const d = days[i];
  const cross = $('cCross'), dot = $('cDot'), tip = $('chartTip');
  cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
  dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(d.average)); dot.setAttribute('visibility', 'visible');
  const src = { esi: 'ESI', tycoon: 'EVE Tycoon only', both: 'ESI + Tycoon' }[d.src];
  tip.innerHTML = `<b>${d.date}</b><br>Avg ${isk(d.average)} · H ${isk(d.highest)} · L ${isk(d.lowest)}<br>Vol ${num(d.volume)} · ${num(d.orderCount)} trades`
    + `${zk[i] != null ? `<br>zKill valuation ${isk(zk[i])}` : ''}<div class="hint">${src}</div>`;
  tip.hidden = false;
  const px = x(i) / chartModel.W * r.width;
  tip.style.left = `${Math.min(r.width - 200, Math.max(0, px + 12))}px`;
  tip.style.top = '8px';
}
function onChartLeave() {
  $('chartTip').hidden = true;
  $('cCross')?.setAttribute('visibility', 'hidden');
  $('cDot')?.setAttribute('visibility', 'hidden');
}

// ---------------------------------------------------------------------------
// Item search (local type list)
// ---------------------------------------------------------------------------
let typeList = null;
async function loadTypes() {
  typeList ||= fetch('data/types.json').then(r => r.json())
    .then(t => {
      types = t; bump();
      let named = false;
      for (const it of settings.items) if (t[it.typeId] && it.name === `Type ${it.typeId}`) { it.name = t[it.typeId][0]; named = true; }
      if (named) saveItems();
      return Object.entries(t).map(([id, [name]]) => ({ id: Number(id), name, lc: name.toLowerCase() }));
    })
    .catch(() => []);
  return typeList;
}

async function onSearch() {
  const q = $('itemSearch').value.trim().toLowerCase();
  const box = $('pickerResults');
  if (q.length < 2) { box.hidden = true; return; }
  const list = await loadTypes();
  if ($('itemSearch').value.trim().toLowerCase() !== q) return;
  const hits = list.filter(t => t.lc.includes(q))
    .sort((a, b) => (b.lc.startsWith(q) - a.lc.startsWith(q)) || a.name.length - b.name.length)
    .slice(0, 25);
  const have = new Set(settings.items.map(i => i.typeId));
  box.innerHTML = hits.length
    ? hits.map(t => `<button type="button" data-add="${t.id}" data-name="${esc(t.name)}" class="${have.has(t.id) ? 'added' : ''}">
        <img src="${icon(t.id)}" alt="" width="20" height="20" loading="lazy"> ${esc(t.name)}${have.has(t.id) ? ' · watching' : ''}</button>`).join('')
    : `<div class="msg">${list.length ? 'No matching items' : 'Item list not built yet — run npm run build:map'}</div>`;
  box.hidden = false;
}

function addItem(typeId, name) {
  // The item's detail lives on the Watchlist page; a link to an item you don't watch adds it there.
  if (PAGE !== 'watch') { openSection('watchlist.html', { selected: typeId }); return; }
  if (!settings.items.some(i => i.typeId === typeId)) { settings.items.push({ typeId, name }); saveItems(); }
  settings.selected = typeId;
  save();
  $('itemSearch').value = '';
  $('pickerResults').hidden = true;
  renderAll();
  refreshOne(typeId);
}

async function refreshOne(typeId) {
  const h = refHub();
  const ids = settings.items.map(i => i.typeId);
  const errs = await pool([...itemTasks(typeId, h), ...batchTasks(h, ids)]);
  renderAll();
  if (settings.selected === typeId) errs.push(...await loadDetail());
  if (errs.length) { ui.lastError = `${errs.length} request(s) failed (${errs[0].message})`; renderStatus(); }
}

function removeItem(typeId) {
  settings.items = settings.items.filter(i => i.typeId !== typeId);
  if (settings.selected === typeId) settings.selected = settings.items[0]?.typeId ?? null;
  save(); saveItems();
  renderAll();
}

// The watchlist arrived (from your character or this browser): show it, and load items that are new.
function applyWatchlist(items) {
  const before = new Set(settings.items.map(i => i.typeId));
  settings.items = items;
  if (urlItem && !items.some(i => i.typeId === urlItem)) {
    items.push({ typeId: urlItem, name: types?.[urlItem]?.[0] || `Type ${urlItem}` });
    saveItems();
  }
  urlItem = null;
  if (settings.selected && !items.some(i => i.typeId === settings.selected)) settings.selected = null;
  if (!settings.selected && items.length) settings.selected = items[0].typeId;
  save();
  renderAll();
  if (PAGE === 'watch' && items.some(i => !before.has(i.typeId))) refresh();
}

// ---------------------------------------------------------------------------
// Universe scan (server-side, see universe-scanner.js)
// ---------------------------------------------------------------------------
const us = { status: null, result: null, poll: null, loading: false, limit: 50, memo: null };
const uniScan = scanClient('uscan');

async function usLoadResult() {
  us.loading = true;
  renderUscanStatus();
  try {
    const r = await uniScan.result();
    if (r) { us.result = r; us.memo = null; }
  } catch { /* keep the previous result */ }
  await loadStations();
  us.loading = false;
  renderUscan();
}

async function usPoll() {
  clearTimeout(us.poll);
  try { us.status = await uniScan.status(); } catch { /* server restarting */ }
  const st = us.status?.state;
  if (st === 'running' || st === 'computing') us.poll = setTimeout(usPoll, 1500);
  else if (us.status?.result && us.status.result.finishedAt !== us.result?.finishedAt) await usLoadResult();
  renderUscanStatus();
}

async function usStart() {
  $('usBtn').disabled = true;
  try { us.status = await uniScan.start(); } catch { /* shown by poll */ }
  usPoll();
}

// Apply the page settings to the raw candidates: tax, cargo, budget, jumps from home, filters.
function usRows() {
  const r = us.result;
  if (!r || !graph) return [];
  const f = settings.us;
  const key = [r.finishedAt, settingsKey(), JSON.stringify(f), !!types].join('|');
  if (us.memo?.key === key) return us.memo.rows;
  const taxRate = (Number(settings.tax) || 0) / 100;
  const maxVolume = parseAmount(settings.cargo) ?? Infinity, maxCost = parseAmount(settings.budget) ?? Infinity;
  const minProfit = parseAmount(f.minProfit) ?? 0;
  const maxMargin = f.maxMargin === '' ? Infinity : Number(f.maxMargin);
  const maxJumps = f.maxJumps === '' ? Infinity : Number(f.maxJumps);
  const q = f.q.trim().toLowerCase();
  // "Near": jumps from a chosen system to the pickup, the drop-off, or whichever end is closer.
  const nearId = nearSystem();
  const nearDist = nearId ? jumpsFrom(travel(), nearId, settings.flag) : null;
  const nearMax = f.nearMax === '' ? Infinity : Number(f.nearMax);
  const distTo = (sys) => { const i = graph.indexOf.get(sys); const d = i == null ? -1 : nearDist[i]; return d < 0 ? null : d; };
  const rows = [];
  for (const c of r.candidates) {
    if (settings.hideHubs && c.hub) continue;
    if (!settings.structures && (!isNpcStation(c.f) || !isNpcStation(c.d))) continue;
    const [name, unitVolume] = r.types[c.t] || [`Type ${c.t}`, 0];
    if (q && !name.toLowerCase().includes(q)) continue;
    if (f.hideShips && types?.[c.t]?.[2] === SHIP_CATEGORY) continue;
    const home = homeJumps(c.fs);
    if (home == null && settings.flag !== 'shortest') continue;
    const j = c.fs === c.ds ? 0 : jumpsBetween(travel(), c.fs, c.ds, settings.flag);
    if (j == null || j + (home ?? 0) > maxJumps) continue;
    const s = summarizeSteps(c.s, { taxRate, unitVolume, maxVolume, maxCost });
    if (s.units <= 0 || s.profit <= 0 || s.profit < minProfit) continue;
    const margin = s.cost ? s.profit / s.cost * 100 : 0;
    if (margin > maxMargin) continue;
    let near = null, nearPick = null, nearDrop = null;
    if (nearDist) {
      nearPick = distTo(c.fs); nearDrop = distTo(c.ds);
      const ends = f.nearEnd === 'pickup' ? [nearPick] : f.nearEnd === 'dropoff' ? [nearDrop] : [nearPick, nearDrop];
      const known = ends.filter(d => d != null);
      if (!known.length) continue;
      near = Math.min(...known);
      if (near > nearMax) continue;
    }
    rows.push({ c, name, ...s, margin, jumps: j, homeJumps: home, near, nearPick, nearDrop,
      perJump: s.profit / Math.max(1, j + (home ?? 0)), iskm3: s.volume ? s.profit / s.volume : null });
  }
  const k = f.rank;
  if (k === 'near' && nearDist) rows.sort((a, b) => a.near - b.near || b.perJump - a.perJump);
  else rows.sort((a, b) => (b[k] ?? -Infinity) - (a[k] ?? -Infinity));
  us.memo = { key, rows };
  return rows;
}

function renderUscanStatus() {
  const st = us.status, el = $('usStatus'), bar = $('usProgress');
  if (!el) return;
  const running = st?.state === 'running' || st?.state === 'computing';
  $('usBtn').disabled = running;
  showProgress(bar, st, us.loading);
  const r = us.result;
  let msg = '';
  if (st?.state === 'running') msg = `Scanning ${st.regionsDone}/${st.regions} regions · ${st.done}/${st.total} pages…${tabNote(st)}`;
  else if (st?.state === 'computing') msg = 'Matching every station pair…';
  else if (st?.state === 'error') msg = `Scan failed: ${st.error}`;
  else if (us.loading) msg = 'Loading scan results…';
  else if (r) {
    const fresh = r.expiresAt > Date.now();
    msg = `${num(r.items)} items at ${num(r.locations)} item-stations in ${r.regions} regions · scanned ${ago(r.finishedAt)}${fresh ? '' : ' · ESI has newer data'}`;
    $('usBtn').textContent = fresh ? 'Rescan' : 'Scan universe';
  } else msg = 'No scan yet — takes a few minutes.';
  const warnings = (running ? st?.warnings : r?.warnings) || [];
  el.textContent = msg + (warnings.length ? ` · ${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : '');
  el.title = warnings.join('\n');
  el.classList.toggle('warn', warnings.length > 0 || st?.state === 'error');
}

// "4j from Dodixie" under the end the Near filter measures (both ends for "either").
function nearNote(d, end) {
  const f = settings.us, id = nearSystem();
  if (!id || (f.nearEnd !== 'either' && f.nearEnd !== end)) return '';
  return `<small class="near-note">${d == null ? 'unreachable' : `${d}j`} from ${esc(systemInfo(graph, id)?.name || '')}</small>`;
}

function renderUscan() {
  renderUscanStatus();
  const body = $('usBody');
  if (!body) return;
  if (!us.result) {
    body.innerHTML = '<tr class="empty"><td colspan="12">Press <b>Scan universe</b> to search every station in New Eden.</td></tr>';
    $('usMore').hidden = true;
    return;
  }
  if (!graph) { body.innerHTML = '<tr class="empty"><td colspan="12">Loading star map…</td></tr>'; return; }
  const rows = usRows();
  const nearIn = $('usNear'), typed = settings.us.near.trim();
  nearIn.classList.toggle('bad', !!typed && !nearSystem());
  nearIn.title = typed && !nearSystem() ? 'Unknown system — pick one from the list' : '';
  $('usRank').classList.toggle('bad', settings.us.rank === 'near' && !nearSystem());
  $('usRank').title = settings.us.rank === 'near' && !nearSystem() ? 'Choose a Near system first' : '';
  const watching = new Set(settings.items.map(i => i.typeId));
  body.innerHTML = rows.slice(0, us.limit).map((r, i) => `<tr data-t="${r.c.t}" class="${i === 0 ? 'top' : ''}">
    <td class="l rank">${i + 1}</td>
    <td class="l item"><img src="${icon(r.c.t)}" alt="" width="24" height="24" loading="lazy"><span>${esc(r.name)}</span>${copyButton(r.name)}${watching.has(r.c.t) ? '<span class="badge ov">watching</span>' : ''}</td>
    <td class="l">${placeHtml({ locationId: r.c.f, systemId: r.c.fs }, { compact: true })}<small class="muted">${r.homeJumps ?? '?'}j from home</small>${nearNote(r.nearPick, 'pickup')}${srcLinks(r.c.t, r.c.fs, 'sell')}</td>
    <td class="l">${placeHtml({ locationId: r.c.d, systemId: r.c.ds }, { compact: true })}${r.c.x
      ? '<small class="range-note" title="Some of the buy orders filled here were placed at other stations; their range reaches this one.">sells into ranged buy orders</small>' : ''}${nearNote(r.nearDrop, 'dropoff')}${srcLinks(r.c.t, r.c.ds, 'buy')}</td>
    <td>${r.jumps === 0 ? '<span class="up" title="Buy and sell without undocking">0</span>' : r.jumps}</td><td>${num(r.units)}</td><td>${num(r.volume)}</td><td>${isk(r.cost)}</td>
    <td>${isk(r.buy)} → ${isk(r.sell)}</td><td class="${r.margin > 50 ? 'warn-m' : ''}">${pct(r.margin)}</td>
    <td class="metric">${isk(r.profit)}</td><td>${isk(r.perJump)}</td></tr>`).join('')
    || '<tr class="empty"><td colspan="12">No hauls match these filters.</td></tr>';
  $('usMore').hidden = rows.length <= us.limit;
  $('usMore').textContent = `Show more (${num(rows.length - us.limit)} left)`;
}

// ---------------------------------------------------------------------------
// My orders (signed in): your orders vs the live competition (see orders.js)
// ---------------------------------------------------------------------------
const my = { orders: null, corpError: null, market: new Map(), structSys: new Map(), loading: false, error: null, at: 0 };
const ORDERS_SCOPE = 'esi-markets.read_character_orders.v1';

async function loadMyOrders() {
  if (PAGE !== 'orders') return;
  const st = meCtl?.status;
  if (!st?.loggedIn) { my.orders = null; my.error = null; renderMyOrders(); return; }
  if (my.loading) return;
  if (!st.scopes?.includes(ORDERS_SCOPE)) { my.error = 'Sign out and sign in again to allow reading your market orders.'; renderMyOrders(); return; }
  my.loading = true; my.error = null;
  renderMyOrders();
  try {
    const r = await (await fetch('/api/me/orders')).json();
    if (r.error) throw new Error(r.error);
    await loadStations();
    my.corpError = r.corpError;
    const raw = r.orders;
    // Rival orders: the region book for NPC-station orders, the structure's own market for structure orders.
    const byRegionType = new Map(), byStructure = new Map();
    for (const o of raw) {
      if (isNpcStation(o.location_id)) byRegionType.set(`${o.region_id}:${o.type_id}`, [o.region_id, o.type_id]);
      else (byStructure.get(o.location_id) || byStructure.set(o.location_id, { region: o.region_id, types: new Set() }).get(o.location_id)).types.add(o.type_id);
    }
    const market = new Map();
    const addMarket = (typeId, list) => { const cur = market.get(typeId) || []; market.set(typeId, cur.concat(list)); };
    const errs = await pool([
      ...[...byRegionType.values()].map(([region, type]) => async () => {
        const base = `/api/esi/markets/${region}/orders/?order_type=all&type_id=${type}`;
        const first = await fetch(base);
        if (!first.ok) throw new Error(`ESI orders: HTTP ${first.status}`);
        const pages = Number(first.headers.get('x-pages')) || 1;
        const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => fetch(`${base}&page=${i + 2}`).then(x => x.json())));
        const list = [await first.json(), ...rest].flat();
        for (const o of list) if (!isNpcStation(o.location_id)) my.structSys.set(o.location_id, o.system_id);
        addMarket(type, list.map(o => normalizeEsiOrder(o, region)));
      }),
      ...[...byStructure].map(([loc, { region, types }]) => async () => {
        const res = await fetch(`/api/me/structure/${loc}?types=${[...types].join(',')}`);
        const body = await res.json();
        if (!res.ok) throw new Error(`${names.get(loc) || `Structure ${loc}`}: ${body.error || res.status}`);
        for (const o of body) addMarket(o.type_id, [normalizeEsiOrder({ ...o, system_id: my.structSys.get(loc) ?? null }, region)]);
      }),
    ]);
    const systemOf = (loc) => stationNames?.[loc]?.[1] ?? my.structSys.get(loc) ?? null;
    my.orders = raw.map(o => normalizeMyOrder(o, systemOf));
    my.market = market;
    my.at = Date.now();
    my.error = errs.length ? `Couldn't check ${errs.length} market${errs.length > 1 ? 's' : ''}: ${errs[0].message}` : null;
  } catch (e) { my.error = e.message; }
  my.loading = false;
  renderMyOrders();
}

function renderMyOrders() {
  const body = $('ordersBody'), status = $('ordersStatus');
  const tabN = $('ordersTabN');
  if (!body) return;
  tabN.classList.remove('warn');
  if (!meCtl?.status?.loggedIn) {
    status.textContent = ''; $('ordersCount').textContent = ''; tabN.textContent = '';
    body.innerHTML = '<tr class="empty"><td colspan="8">Sign in with EVE (top right) to check your market orders against the live market.</td></tr>';
    return;
  }
  status.classList.toggle('warn', !!(my.error || my.corpError));
  status.title = [my.error, my.corpError].filter(Boolean).join('\n');
  if (my.loading && !my.orders) { status.textContent = 'Loading your orders…'; body.innerHTML = ''; return; }
  if (!my.orders) { status.textContent = my.error || ''; body.innerHTML = '<tr class="empty"><td colspan="8">No orders loaded.</td></tr>'; return; }
  const ownIds = new Set(my.orders.map(o => o.orderId));
  const ctx = rangeContext();
  const rows = my.orders.map(o => ({ o, s: orderStanding(o, my.market.get(o.typeId) || [], { ownIds, ctx }) }));
  const bad = (r) => r.s.status === 'undercut' || r.s.status === 'outbid';
  rows.sort((a, b) => bad(b) - bad(a) || (b.o.price * b.o.volumeRemain) - (a.o.price * a.o.volumeRemain));
  const sells = my.orders.filter(o => !o.isBuyOrder), buys = my.orders.filter(o => o.isBuyOrder);
  const listed = sells.reduce((s, o) => s + o.price * o.volumeRemain, 0), escrow = buys.reduce((s, o) => s + o.escrow, 0);
  const nBad = rows.filter(bad).length;
  $('ordersCount').textContent = `· ${my.orders.length} active`;
  tabN.textContent = nBad ? `${nBad} to update` : String(my.orders.length);
  tabN.classList.toggle('warn', nBad > 0);
  status.textContent = `${sells.length} sell (${isk(listed)} listed) · ${buys.length} buy (${isk(escrow)} escrow) · `
    + `${nBad ? `${nBad} need updating` : 'all at the best price'}${my.loading ? ' · checking…' : ` · checked ${ago(my.at)}`}`
    + (my.corpError ? ' · corp orders unavailable' : '') + (my.error ? ' · some markets unchecked' : '');
  const onlyBad = $('ordersProblems').checked;
  const shown = rows.filter(r => !onlyBad || bad(r));
  const itemName = (id) => types?.[id]?.[0] || `Type ${id}`;
  body.innerHTML = shown.map(({ o, s }) => {
    const standing = s.status === 'best' ? `<span class="standing best">✓ Best price<small>${s.rivals} rival${s.rivals === 1 ? '' : 's'}</small></span>`
      : s.status === 'alone' ? '<span class="standing best">✓ No competition</span>'
      : `<span class="standing bad">${s.status === 'undercut' ? 'Undercut' : 'Outbid'} by ${isk(s.diff)} (${s.pct < 0.01 ? '<0.01' : s.pct.toFixed(2)}%)`
        + `<small>set ${o.isBuyOrder ? '≥' : '≤'} ${s.best} to lead${s.rival.locationId !== o.locationId ? ` · rival in ${esc(sysName(s.rival.systemId))}` : ''}</small></span>`;
    const left = expiresAt(o) - Date.now();
    return `<tr data-t="${o.typeId}" class="${bad({ s }) ? 'bad' : ''}">
      <td class="l"><span class="side ${o.isBuyOrder ? 'buy' : 'sell'}">${o.isBuyOrder ? 'BUY' : 'SELL'}</span>${o.owner === 'corporation' ? ' <span class="badge ov">corp</span>' : ''}</td>
      <td class="l item"><img src="${icon(o.typeId)}" alt="" width="24" height="24" loading="lazy"><span>${esc(itemName(o.typeId))}</span>${copyButton(itemName(o.typeId))}</td>
      <td class="l">${placeHtml({ locationId: o.locationId, systemId: o.systemId }, { compact: true })}</td>
      <td>${isk(o.price)}</td><td>${num(o.volumeRemain)} / ${num(o.volumeTotal)}</td>
      <td>${isk(s.best)}</td><td class="l">${standing}</td>
      <td>${left > 0 ? (left > 86_400_000 ? `${Math.floor(left / 86_400_000)}d` : `${Math.ceil(left / 3_600_000)}h`) : 'expired'}</td></tr>`;
  }).join('') || `<tr class="empty"><td colspan="8">${onlyBad ? 'Every order is at the best price.' : 'You have no active orders.'}</td></tr>`;
}

// Character options from the header menu: ship cargo → Cargo m³, wallet → Max investment.
function useShipCargo(m3) {
  const input = $('cargo');
  if (m3 != null) { settings.cargo = String(Math.floor(m3)); input.value = settings.cargo; save(); }
  input.disabled = m3 != null;
  input.classList.toggle('from-me', m3 != null);
  input.title = m3 != null ? 'From your current ship (base hold) — turn off in the character menu to edit' : '';
  renderAll();
}
function useWallet(balance) {
  for (const id of ['budget', 'usBudget']) {
    const input = $(id);
    if (!input) continue;
    if (balance != null) input.value = String(Math.floor(balance));
    input.disabled = balance != null;
    input.classList.toggle('from-me', balance != null);
    input.title = balance != null ? 'Your wallet balance — turn off in the character menu to edit' : '';
  }
  if (balance != null) { settings.budget = String(Math.floor(balance)); save(); }
  renderAll();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function renderAll() {
  $('watchTabN').textContent = settings.items.length ? String(settings.items.length) : '';
  if (PAGE === 'watch') {
    renderStatus(ui.loading ? 'Loading…' : null);
    renderSources();
    renderBoard();
    renderDetail();
  }
  if (PAGE === 'uscan') renderUscan();
  if (PAGE === 'orders') renderMyOrders();
}

function setAuto(on) {
  settings.auto = on; save();
  clearInterval(ui.timer);
  if (on) ui.timer = setInterval(refresh, AUTO_MS);
}

function bindSetting(id, key, { prop = 'value', parse = v => v, event = 'change', reload = false } = {}) {
  const el = $(id);
  if (!el) return;
  el[prop] = settings[key];
  el.addEventListener(event, () => {
    settings[key] = parse(el[prop]); save();
    renderAll();
    if (reload) refresh();
  });
}

const byName = new Map(); // lower-case system name → system ID

// The scan's "Near system", resolved to an ID (null when blank or not a known system).
function nearSystem() {
  const name = settings.us.near.trim().toLowerCase();
  return name ? byName.get(name) ?? null : null;
}

// Signed in with Follow on: your character's system is the home system (see me.js).
function followLocation(loc) {
  const input = $('home');
  if (loc && graph?.indexOf.has(loc.systemId) && loc.systemId !== settings.home) {
    settings.home = loc.systemId; save();
  }
  if (graph) input.value = sysName(settings.home);
  input.disabled = !!loc;
  input.title = loc ? 'Following your character — untick Follow to choose a system by hand' : '';
  renderAll();
}
let meCtl = null;

function initHome() {
  const input = $('home');
  for (let i = 0; i < graph.n; i++) byName.set(graph.name[i].toLowerCase(), graph.id[i]);
  $('systemList').innerHTML = [...graph.name].sort().map(n => `<option value="${esc(n)}">`).join('');
  if (!systemInfo(graph, settings.home)) { settings.home = JITA.id; save(); } // unknown ID from a link
  input.value = systemInfo(graph, settings.home)?.name || 'Jita';
  meCtl?.reapply(); // system names are available now
  input.addEventListener('change', () => {
    const id = byName.get(input.value.trim().toLowerCase());
    if (!id) { input.classList.add('bad'); return; }
    input.classList.remove('bad');
    settings.home = id; save(); renderAll();
  });
}

function init() {
  meCtl = createMe({
    el: $('me'), returnTo: location.pathname, systemName: sysName, isk,
    shipInfo: (id) => (types?.[id] ? { name: types[id][0], cargo: types[id][2] === 6 ? types[id][3] ?? null : null } : null),
    onFollow: followLocation, onCargo: useShipCargo, onBudget: useWallet,
    onStatus: () => { loadMyOrders(); watch.load(); },
  });
  mountSectionNav();
  drawToggle = mountToggle($('whToggle'), sc);
  bindSetting('flag', 'flag');
  bindSetting('tax', 'tax', { parse: Number, event: 'input' });
  bindSetting('cargo', 'cargo', { event: 'input' });
  mountFitButton($('cargo'), { types: () => types });
  bindSetting('budget', 'budget', { event: 'input' });
  bindSetting('hideHubs', 'hideHubs', { prop: 'checked' });
  bindSetting('structures', 'structures', { prop: 'checked' });
  bindSetting('showGhosts', 'showGhosts', { prop: 'checked' });
  if (PAGE === 'uscan') bindUscan();
  if (PAGE === 'orders') bindOrders();
  if (PAGE === 'watch') bindWatch();

  if (!settings.selected && settings.items.length) settings.selected = settings.items[0].typeId;
  writeUrl(settings, DEFAULTS, URL_FIELDS);
  fetch('data/universe.json').then(r => r.json()).then(u => { graph = buildGraph(u); sc.setBase(graph); initHome(); bump(); renderAll(); })
    .catch(() => { $('home').placeholder = 'Star map unavailable'; });
  loadTypes().then(() => { renderAll(); meCtl?.reapply(); }); // ship names and cargo need types.json
  loadStations().then(() => renderAll());
  renderAll();
  if (PAGE === 'uscan') {
    usPoll();
    uniScan.onChange(() => usPoll());   // a scan started or finished in another tab
  }
  if (PAGE === 'watch') {
    setAuto(settings.auto);
    refresh();
  }
}

function bindOrders() {
  $('ordersRefresh').addEventListener('click', loadMyOrders);
  $('ordersProblems').addEventListener('change', renderMyOrders);
  $('ordersBody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-t]');
    if (tr) addItem(Number(tr.dataset.t));
  });
}

function bindUscan() {
  // The scan's Max investment field is the same setting as the one in the top controls.
  $('usBudget').value = settings.budget;
  $('usBudget').addEventListener('input', () => { settings.budget = $('usBudget').value; $('budget').value = settings.budget; save(); renderAll(); });
  $('budget').addEventListener('input', () => { $('usBudget').value = settings.budget; });
  for (const [id, k, ev] of [['usMinProfit', 'minProfit', 'input'], ['usMaxMargin', 'maxMargin', 'input'],
    ['usMaxJumps', 'maxJumps', 'input'], ['usRank', 'rank', 'change'], ['usQuery', 'q', 'input'],
    ['usNear', 'near', 'input'], ['usNearEnd', 'nearEnd', 'change'], ['usNearMax', 'nearMax', 'input']]) {
    $(id).value = settings.us[k];
    $(id).addEventListener(ev, () => { settings.us[k] = $(id).value; us.limit = 50; save(); renderUscan(); });
  }
  $('usHideShips').checked = !!settings.us.hideShips;
  $('usHideShips').addEventListener('change', () => { settings.us.hideShips = $('usHideShips').checked; us.limit = 50; save(); renderUscan(); });
  $('usBtn').addEventListener('click', usStart);
  $('usMore').addEventListener('click', () => { us.limit += 50; renderUscan(); });
  $('usBody').addEventListener('click', (e) => {
    if (e.target.closest('a')) return; // source links open on their own
    const tr = e.target.closest('tr[data-t]');
    if (tr) addItem(Number(tr.dataset.t));
  });
}

function bindWatch() {
  $('refHub').innerHTML = HUBS.map(h => `<option value="${h.id}">${h.name} — ${h.region}</option>`).join('');
  bindSetting('refHub', 'refHub', { parse: Number, reload: true });
  bindSetting('haulRank', 'haulRank');
  $('autoRefresh').checked = settings.auto;
  $('autoRefresh').addEventListener('change', () => setAuto($('autoRefresh').checked));
  $('refreshBtn').addEventListener('click', refresh);

  $('itemSearch').addEventListener('input', onSearch);
  $('itemSearch').addEventListener('focus', onSearch);
  $('itemSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('pickerResults').hidden = true;
    if (e.key === 'Enter') $('pickerResults').querySelector('button[data-add]')?.click();
  });
  $('pickerResults').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-add]');
    if (b) addItem(Number(b.dataset.add), b.dataset.name);
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.picker')) $('pickerResults').hidden = true; });

  $('boardHead').addEventListener('click', (e) => {
    const k = e.target.closest('th')?.dataset.key;
    if (!k) return;
    const s = settings.sort;
    // Cheaper-than-hub and hub-sell read best ascending; everything else descending first.
    const firstDir = ['name', 'cheapPct', 'ref'].includes(k) ? 1 : -1;
    if (s.key === k) { if (s.dir === firstDir) s.dir = -firstDir; else { s.key = null; s.dir = -1; } }
    else { s.key = k; s.dir = firstDir; }
    save(); renderBoard();
  });
  $('boardBody').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) { removeItem(Number(rm.dataset.remove)); return; }
    if (e.target.closest('a')) return; // the item picture opens the wiki
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    settings.selected = Number(tr.dataset.id); save();
    ui.bookAll = false;
    renderAll();
    loadDetail().then(errs => { if (errs.length) { ui.lastError = `${errs.length} request(s) failed`; renderStatus(); } });
    $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('hubsBody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-hub]');
    if (!tr || Number(tr.dataset.hub) === settings.refHub) return;
    settings.refHub = Number(tr.dataset.hub); $('refHub').value = String(settings.refHub); save();
    renderAll(); refresh();
  });
  $('histRange').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-days]');
    if (!b) return;
    settings.histDays = Number(b.dataset.days); save();
    const c = collate(settings.selected);
    if (c) renderChart(c);
  });
  $('bookMore').addEventListener('click', () => { ui.bookAll = !ui.bookAll; const c = collate(settings.selected); if (c) renderBook(c); });
  $('chart').addEventListener('mousemove', onChartMove);
  $('chart').addEventListener('mouseleave', onChartLeave);
  let rz;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { const c = collate(settings.selected); if (c) renderChart(c); }, 150); });
}

init();
