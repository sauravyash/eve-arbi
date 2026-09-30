import { HUBS, DEFAULT_TAX_PCT, pairKey, extractHubBooks, computeRoutes, summarizeSteps, formatIsk } from './arbitrage.js';
import { scanClient, tabNote, showProgress } from './scan-client.js';
import { GalaxyMap, secColor, secLabel } from './map.js';
import { createMapSwitch, loadThree, migrateMapLayout } from './map-switch.js';
import { buildGraph, jumpsFrom, pathBetween, systemInfo } from './galaxy.js';
import { createShortcuts, mountToggle } from './shortcuts.js';
import { shortcutsOn, isJSpace } from './wormholes.js';
import { isNpcStation } from './market-merge.js';
import { evaluateLegs, planTrips, tripStops, SHIP_CATEGORY } from './trips.js';
import { createMe } from './me.js';
import { createWatchlist, itemPic, removeButton, copyButton } from './watchlist.js';
import { readUrl, writeUrl } from './url-state.js';
import { shipHolds, capacityFor } from './holds.js';
import { packRoute, multibuyText } from './manifest.js';
import { mountFitButton } from './fit-dialog.js';
import { mountSectionNav } from './nav.js';

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
const LS = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota or disabled */ } },
};

// The starter list watchlists used to have; one still equal to it starts empty (watchlist.js).
const OLD_DEFAULT_ITEMS = [
  { typeId: 40520, name: 'Large Skill Injector' },
  { typeId: 37, name: 'Isogen' },
  { typeId: 587, name: 'Rifter' },
];
const JUMP_TTL = 24 * 3600_000;

const DEFAULTS = {
  items: [], flag: 'secure', sellMode: 'instant', metric: 'unit', taxPct: DEFAULT_TAX_PCT, taxV: 1, graphItem: 'all', showAll: false,
  view: 'map', mapLayout: 'space', mapV: 1, secColors: true,
  scan: { scope: 'hubs', cargo: '', ship: '', budget: '', minProfit: '5m', from: '', to: '', near: '0', maxMargin: '100', rank: 'ppj', q: '', hideShips: false, structures: false },
  trips: { start: 30000142, legs: '3', link: '3', minProfit: '1m', rank: 'perJump', hideShips: false, hideHubs: false, structures: false },
};
const storedSettings = migrateMapLayout(LS.get('arbi.settings', {}));
// Sales tax used to default to 0%; a saved 0 from then becomes the in-game base rate, once (taxV).
if (!storedSettings.taxV && !Number(storedSettings.taxPct)) delete storedSettings.taxPct;
const settings = Object.assign(structuredClone(DEFAULTS), storedSettings);
settings.scan = { ...DEFAULTS.scan, ...settings.scan };
settings.trips = { ...DEFAULTS.trips, ...settings.trips };
// Settings mirrored in the query string (url-state.js); the item list and overrides stay local.
const hubIds = ['', ...HUBS.map(h => String(h.id))];
const scanEnds = [...hubIds, 'hubs', 'offhub', 'me'];
const URL_FIELDS = [
  ['flag', ['secure', 'shortest', 'insecure']], ['sellMode', ['instant', 'relist']], ['metric', ['unit', 'depth']],
  ['taxPct', v => v >= 0 && v <= 100], 'graphItem', 'showAll', ['view', ['map', 'schematic']], ['mapLayout', ['space', '3d', '2d']], 'secColors',
  ['scan.scope', ['hubs', 'all']], 'scan.cargo', ['scan.ship', v => v === '' || Number(v) > 0], 'scan.budget', 'scan.minProfit',
  ['scan.from', scanEnds], ['scan.to', scanEnds], ['scan.near', v => v === '' || Number(v) >= 0], 'scan.maxMargin',
  ['scan.rank', ['ppj', 'profit', 'iskm3', 'margin']], 'scan.q', 'scan.hideShips', 'scan.structures',
  ['trips.start', v => v > 0], ['trips.legs', ['2', '3', '4', '5']], 'trips.link', 'trips.minProfit',
  ['trips.rank', ['perJump', 'profit']], 'trips.hideShips', 'trips.hideHubs', 'trips.structures',
];
readUrl(settings, DEFAULTS, URL_FIELDS);
writeUrl(settings, DEFAULTS, URL_FIELDS);
const overrides = Object.assign({ prices: {}, jumps: {} }, LS.get('arbi.overrides', {}));
// market[typeId] = {books, fetchedAt, expiresAt, status: ok|stale|error|loading|cached, error}
const market = LS.get('arbi.market', {});
for (const m of Object.values(market)) m.status = 'cached';
// jumpCache[flag] = {pairs: {pairKey: [systemId, …] ordered from lower hub id to higher}, expiresAt}
const jumpCache = LS.get('arbi.routes', {});
try { localStorage.removeItem('arbi.jumps'); } catch { /* old jump-count-only cache */ }

const ui = { tripPick: null, scanTrip: false, selectedHub: null, sort: { key: null, dir: -1 }, refreshing: false, lastError: null, scanPick: null, scanLimit: 50, loadPick: null, loadLimit: 30 };

const saveSettings = () => { LS.set('arbi.settings', { ...settings, items: undefined }); writeUrl(settings, DEFAULTS, URL_FIELDS); };
// The watchlist is saved on its own: to your character when signed in, else this browser (watchlist.js).
const watch = createWatchlist('hub', { legacy: LS.get('arbi.settings', {}).items, legacyDefaults: OLD_DEFAULT_ITEMS, onLoad: applyWatchlist });
settings.items = watch.initial();
const saveItems = () => watch.save(settings.items);
const saveOverrides = () => LS.set('arbi.overrides', overrides);
const saveMarket = () => LS.set('arbi.market', Object.fromEntries(
  Object.entries(market).filter(([, m]) => m.books).map(([k, m]) => [k, { books: m.books, fetchedAt: m.fetchedAt, expiresAt: m.expiresAt }])));
const saveJumps = () => LS.set('arbi.routes', jumpCache);

const $ = (id) => document.getElementById(id);
const hubById = Object.fromEntries(HUBS.map(h => [h.id, h]));
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------------
// Data fetching (all through the local caching proxy)
// ---------------------------------------------------------------------------
async function getJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch { /* non-json */ }
    throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
  }
  return { data: await res.json(), headers: res.headers };
}

async function fetchItem(item) {
  const id = item.typeId;
  const prev = market[id];
  market[id] = { ...(prev || {}), status: 'loading' };
  render();
  try {
    const { data, headers } = await getJson(`/api/tycoon/v1/market/orders/${id}`);
    if (data.itemType?.typeName) item.name = data.itemType.typeName;
    market[id] = {
      books: extractHubBooks(data),
      fetchedAt: Date.parse(headers.get('X-Fetched-At')) || Date.now(),
      expiresAt: Date.parse(headers.get('X-Expires-At')) || null,
      status: headers.get('X-Cache') === 'STALE' ? 'stale' : 'ok',
      error: headers.get('X-Cache') === 'STALE' ? 'Upstream failed; proxy served last good copy' : null,
    };
  } catch (e) {
    // Keep the last good books so one failure doesn't blank the graph.
    market[id] = { ...(prev || {}), status: prev?.books ? 'stale' : 'error', error: e.message };
  }
}

function jumpsFresh(flag) {
  const c = jumpCache[flag];
  return c && c.expiresAt > Date.now() && Object.keys(c.pairs).length === HUBS.length * (HUBS.length - 1) / 2;
}

async function fetchJumps(flag) {
  if (jumpsFresh(flag)) return;
  const c = jumpCache[flag] ||= { pairs: {}, expiresAt: 0 };
  const failures = [];
  let expiresAt = Date.now() + JUMP_TTL;
  const tasks = [];
  for (let i = 0; i < HUBS.length; i++) for (let j = i + 1; j < HUBS.length; j++) {
    const a = HUBS[i], b = HUBS[j];
    tasks.push(getJson(`/api/esi/route/${a.id}/${b.id}/?flag=${flag}`)
      .then(({ data, headers }) => {
        c.pairs[pairKey(a.id, b.id)] = a.id < b.id ? data : [...data].reverse();
        const exp = Date.parse(headers.get('X-Expires-At'));
        if (exp) expiresAt = Math.max(expiresAt, exp);
      })
      .catch(e => failures.push(`${a.name}–${b.name}: ${e.message}`)));
  }
  await Promise.all(tasks);
  // Only mark fresh if every pair resolved; otherwise retry missing pairs next refresh.
  c.expiresAt = failures.length ? 0 : expiresAt;
  saveJumps();
  if (failures.length) throw new Error(`Route lookup failed (${failures.length}/10)`);
}

async function refresh() {
  if (ui.refreshing) return;
  ui.refreshing = true;
  ui.lastError = null;
  render();
  const errors = [];
  await Promise.all([
    fetchJumps(settings.flag).catch(e => errors.push(e.message)).finally(render),
    ...settings.items.map(it => fetchItem(it).finally(render)),
  ]);
  const failedItems = settings.items.filter(it => ['stale', 'error'].includes(market[it.typeId]?.status));
  if (failedItems.length) errors.push(`${failedItems.length} item fetch${failedItems.length > 1 ? 'es' : ''} failed`);
  ui.lastError = errors.join(' · ') || null;
  ui.refreshing = false;
  saveMarket();
  saveSettings(); // item names may have been corrected from the API
  render();
}

// ---------------------------------------------------------------------------
// Route computation
// ---------------------------------------------------------------------------
// Wormhole shortcuts (shortcuts.js). ESI's routes only know stargates, so while shortcuts are in
// use each hub pair also gets a local path through them, and the shorter one wins.
let drawToggle = () => {};
const sc = createShortcuts({ onChange: () => { drawToggle(); trip.memo = null; scan.memo = null; render(); renderTrips(); } });
const travel = () => sc.travelGraph() || trip.graph;

// System path between two hubs (lower hub ID first), or null until ESI answers.
function hubPath(k) {
  const esi = jumpCache[settings.flag]?.pairs[k] || null;
  if (!trip.graph || !sc.inUse()) return esi;
  const [a, b] = k.split('-').map(Number);
  const local = pathBetween(travel(), a, b, tripFlag());
  return local && (!esi || local.length < esi.length) ? local : esi;
}

const jumpOverride = (k) => (overrides.jumps[k] !== '' && overrides.jumps[k] != null && Number(overrides.jumps[k]) > 0 ? Number(overrides.jumps[k]) : null);
const jumpsOverridden = (r) => jumpOverride(pairKey(r.from.id, r.to.id)) != null;

function jumpsFor(a, b) {
  const k = pairKey(a, b);
  const o = jumpOverride(k);
  if (o != null) return o;
  const path = hubPath(k);
  return path ? path.length - 1 : null;
}

// Gate-by-gate system path for a route, in travel direction (wormhole systems are skipped on the map).
function pathFor(r) {
  const path = hubPath(pairKey(r.from.id, r.to.id));
  if (!path) return null;
  return r.from.id < r.to.id ? path : [...path].reverse();
}

// System path for any pickup → drop-off pair: the hub route for two hubs, else the travel graph.
function pathBetweenEnds(from, to) {
  if (from.hub && to.hub) return pathFor({ from: from.hub, to: to.hub });
  return trip.graph ? pathBetween(travel(), from.systemId, to.systemId, tripFlag()) : null;
}

// ⤳ after a jump count when its route takes wormhole shortcuts (paths from pathFor/pathBetween).
function whMark(...paths) {
  if (!sc.inUse()) return '';
  const g = travel(), n = paths.reduce((sum, p) => sum + shortcutsOn(g, p), 0);
  return n ? `<span class="wh-mark" title="Route uses ${n} wormhole shortcut${n > 1 ? 's' : ''}">⤳</span>` : '';
}

function metricOf(r) {
  return settings.metric === 'depth' && settings.sellMode === 'instant' ? r.depthPerJump : r.iskPerJump;
}

function allRoutes() {
  const taxRate = (Number(settings.taxPct) || 0) / 100;
  return settings.items.flatMap(item => {
    const m = market[item.typeId];
    const routes = computeRoutes({
      item, books: m?.books || null, overrides: overrides.prices[item.typeId] || {},
      jumps: jumpsFor, sellMode: settings.sellMode, taxRate,
    });
    const stale = m?.status === 'stale' || m?.status === 'cached';
    for (const r of routes) {
      r.stale = stale && !r.overridden;
      r.metric = metricOf(r);
    }
    return routes;
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  renderScan();
  renderTrips();
  const routes = allRoutes();
  const graphRoutes = settings.graphItem === 'scan' ? scanGraphRoutes()
    : settings.graphItem === 'all' ? routes : routes.filter(r => String(r.item.typeId) === settings.graphItem);
  renderStatus();
  const model = graphModel(graphRoutes);
  $('mapView').hidden = settings.view !== 'map';
  $('graph').hidden = settings.view !== 'schematic';
  if (settings.view === 'map') galaxy.update(model); else renderGraph(model);
  renderFocus(graphRoutes);
  renderItems();
  renderTable(routes);
  renderOverrides();
}

function renderStatus() {
  const el = $('status'), btn = $('refreshBtn');
  btn.disabled = ui.refreshing;
  btn.classList.toggle('loading', ui.refreshing);
  el.classList.toggle('err', !!ui.lastError);
  if (ui.refreshing) { el.textContent = 'Fetching market data…'; return; }
  const times = settings.items.map(i => market[i.typeId]).filter(m => m?.fetchedAt);
  if (!times.length) { el.textContent = ui.lastError || 'No data yet'; return; }
  const oldest = Math.min(...times.map(m => m.fetchedAt));
  const nextFresh = Math.min(...times.map(m => m.expiresAt || Infinity));
  const t = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  let s = `Data as of ${t(oldest)}`;
  if (Number.isFinite(nextFresh) && nextFresh > Date.now()) s += ` · upstream refreshes ~${t(nextFresh)}`;
  if (ui.lastError) s = `${ui.lastError} — ${s}`;
  el.textContent = s;
}

// --- graph ---
const SVGNS = 'http://www.w3.org/2000/svg';
const G = { cx: 320, cy: 282, R: 212, nodeR: 38 };
const nodePos = HUBS.map((h, i) => {
  const a = (-90 + i * 72) * Math.PI / 180;
  return { hub: h, x: G.cx + G.R * Math.cos(a), y: G.cy + G.R * Math.sin(a) };
});
const posOf = Object.fromEntries(nodePos.map(p => [p.hub.id, p]));

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

// A route the user picked from the market ranking always wins its pair.
const better = (a, b) => {
  if (b == null) return a;
  if (!!a?.pinned !== !!b.pinned) return a?.pinned ? a : b;
  return (a?.metric ?? -Infinity) > (b.metric ?? -Infinity) ? a : b;
};

function bestPerPair(routes) {
  const pairs = {};
  for (let i = 0; i < HUBS.length; i++) for (let j = i + 1; j < HUBS.length; j++) {
    const k = pairKey(HUBS[i].id, HUBS[j].id);
    const cands = routes.filter(r => pairKey(r.from.id, r.to.id) === k);
    const scored = cands.filter(r => r.metric != null);
    pairs[k] = {
      a: HUBS[i], b: HUBS[j],
      best: scored.reduce((acc, r) => better(r, acc), null),
      anyUnknown: cands.some(r => r.status === 'unknown'),
    };
  }
  return pairs;
}

// What the graph/map shows per hub pair: the overall-best direction, or (when a hub is
// selected) that hub's best outgoing route.
function graphModel(routes) {
  const pairs = bestPerPair(routes);
  const sel = ui.selectedHub;
  const shown = Object.values(pairs).map(p => {
    if (!sel) return { ...p, route: p.best };
    if (p.a.id !== sel && p.b.id !== sel) return { ...p, route: null, faded: true };
    const out = routes.filter(r => r.from.id === sel && (r.to.id === p.a.id || r.to.id === p.b.id) && r.metric != null)
      .reduce((acc, r) => better(r, acc), null);
    return { ...p, route: out, anyUnknown: !out && routes.some(r => r.from.id === sel && pairKey(r.from.id, r.to.id) === pairKey(p.a.id, p.b.id) && r.status === 'unknown') };
  });
  const positive = shown.filter(s => s.route?.metric > 0);
  const maxV = Math.max(0, ...positive.map(s => s.route.metric));
  const top = positive.reduce((acc, s) => (!acc || better(s.route, acc.route) === s.route ? s : acc), null);
  return { shown, top, maxV, sel, hubs: HUBS, pathFor };
}

function renderGraph({ shown, top, maxV, sel }) {
  const svg = $('graph');
  svg.replaceChildren();
  const defs = el('defs', {}, svg);
  const glow = el('filter', { id: 'glow', x: '-50%', y: '-50%', width: '200%', height: '200%' }, defs);
  el('feGaussianBlur', { stdDeviation: '3.5', result: 'b' }, glow);
  const merge = el('feMerge', {}, glow);
  el('feMergeNode', { in: 'b' }, merge); el('feMergeNode', { in: 'SourceGraphic' }, merge);
  for (const [id, color] of [['ah-best', 'var(--teal)'], ['ah-pos', 'var(--edge)']]) {
    const mk = el('marker', { id, viewBox: '0 0 10 10', refX: '5', refY: '5', markerWidth: '3.2', markerHeight: '3.2', orient: 'auto', markerUnits: 'strokeWidth' }, defs);
    el('path', { d: 'M1,1 L9,5 L1,9 z', style: `fill: ${color}` }, mk);
  }
  el('rect', { class: 'bg', x: 0, y: 0, width: 640, height: 560 }, svg).addEventListener('click', () => selectHub(null));

  const edgesLayer = el('g', {}, svg), labelsLayer = el('g', {}, svg), nodesLayer = el('g', {}, svg);

  for (const s of shown) {
    const r = s.route;
    const from = posOf[(r?.from ?? s.a).id], to = posOf[(r?.to ?? s.b).id];
    const dx = to.x - from.x, dy = to.y - from.y, len = Math.hypot(dx, dy);
    const ux = dx / len, uy = dy / len;
    const x1 = from.x + ux * (G.nodeR + 6), y1 = from.y + uy * (G.nodeR + 6);
    const x2 = to.x - ux * (G.nodeR + 6), y2 = to.y - uy * (G.nodeR + 6);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;

    let cls, width = 1.5, marker = '';
    const isTop = s === top;
    if (s.faded) cls = 'neg faded';
    else if (!r) cls = s.anyUnknown ? 'stale' : 'neg';
    else if (r.metric > 0) {
      const ratio = maxV > 0 ? Math.sqrt(r.metric / maxV) : 0;
      width = 2 + ratio * 9;
      cls = isTop ? 'best' : 'pos';
      marker = isTop ? 'url(#ah-best)' : 'url(#ah-pos)';
    } else cls = 'neg';

    const g = el('g', {}, edgesLayer);
    const path = el('path', { class: `edge ${cls}`, d: `M${x1},${y1} L${mx},${my} L${x2},${y2}`, 'stroke-width': width }, g);
    if (marker) path.setAttribute('marker-mid', marker);
    if (cls.startsWith('pos')) path.style.opacity = sel ? 0.35 : (0.35 + 0.65 * Math.sqrt(r.metric / maxV)).toFixed(2);
    if (r?.stale && r.metric > 0) path.style.strokeDasharray = '10 6';

    const hit = el('path', { class: 'edge-hit', d: `M${x1},${y1} L${x2},${y2}` }, g);
    el('title', {}, hit).textContent = edgeTitle(s, r);

    // Label: offset perpendicular to the edge so it doesn't sit on the arrow.
    if (s.faded) continue;
    let text = null, lcls = '';
    if (!r) { if (s.anyUnknown) { text = '?'; lcls = 'stale'; } }
    else if (r.metric > 0) { text = `${formatIsk(r.metric, r.metric >= 1e6 ? 2 : 1)}/j`; lcls = isTop ? 'best' : ''; }
    if (r?.stale && r.metric > 0) lcls += ' stale';
    if (!text) continue;
    const nx = -uy, ny = ux, off = 16;
    const lg = el('g', { class: `elabel ${lcls}`, transform: `translate(${mx + nx * off},${my + ny * off})` }, labelsLayer);
    const w = text.length * 7 + 12;
    el('rect', { x: -w / 2, y: -10, width: w, height: 20, rx: 10 }, lg);
    el('text', {}, lg).textContent = text;
    el('title', {}, lg).textContent = edgeTitle(s, r);
  }

  const topRoute = top?.route;
  for (const p of nodePos) {
    const isSrc = sel ? p.hub.id === sel : topRoute?.from.id === p.hub.id;
    const isDst = sel ? topRoute?.from.id === sel && topRoute?.to.id === p.hub.id : topRoute?.to.id === p.hub.id;
    const cls = ['node', isSrc && 'src', isDst && 'dst', sel && !isSrc && !isDst && 'dim'].filter(Boolean).join(' ');
    const g = el('g', { class: cls, transform: `translate(${p.x},${p.y})`, tabindex: '0', role: 'button',
      'aria-pressed': String(sel === p.hub.id), 'aria-label': `${p.hub.name} — show best outgoing route` }, nodesLayer);
    el('circle', { r: G.nodeR }, g);
    el('text', { class: 'name', y: -1 }, g).textContent = p.hub.name;
    el('text', { class: 'region', y: 14 }, g).textContent = p.hub.region;
    const toggle = () => selectHub(sel === p.hub.id ? null : p.hub.id);
    g.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  }
}

function edgeTitle(s, r) {
  if (!r) return `${s.a.name} ↔ ${s.b.name}: no usable data${s.anyUnknown ? ' (missing prices or jumps)' : ''}`;
  const lines = [
    `${r.from.name} → ${r.to.name} · ${r.item.name}`,
    `Buy ${formatIsk(r.buy)} → Sell ${formatIsk(r.sell)} · ${r.jumps} jumps`,
    `Spread ${formatIsk(r.spread)} · ${formatIsk(r.iskPerJump)} ISK/jump per unit`,
  ];
  if (r.units != null) lines.push(`Depth: ${r.units.toLocaleString()} units → ${formatIsk(r.depthProfit)} (${formatIsk(r.depthPerJump)}/jump)`);
  if (r.stale) lines.push('⚠ stale data');
  if (r.overridden) lines.push('✎ manual override');
  return lines.join('\n');
}

// In-game style route strip: one square per system, coloured by security. Each strip carries its
// systems (data-path) and stop labels (data-mark), so the hover tip (bindRouteTip) works anywhere.
// marks: [[index into path, label]]; defaults to pickup and drop-off.
function routeStrip(path, marks) {
  if (!path?.length || !trip.graph) return null;
  const last = path.length - 1;
  const at = new Map();
  for (const [i, label] of marks || [[0, 'Pickup · buy here'], [last, 'Drop-off · sell here']]) at.set(i, at.has(i) ? `${at.get(i)} · ${label}` : label);
  const g = travel();
  sc.resolveNames(path.filter(id => !trip.graph.indexOf.has(id)));
  const squares = path.map((id, i) => {
    const s = systemInfo(g, id);
    const mark = at.get(i);
    // Round: reached through a wormhole shortcut rather than a stargate.
    const cls = [mark && 'end', i && g.shortcuts?.has(pairKey(path[i - 1], id)) && 'wh'].filter(Boolean).join(' ');
    return `<i data-n="${i}"${cls ? ` class="${cls}"` : ''}${mark ? ` data-mark="${esc(mark)}"` : ''} style="--sec:${s ? secColor(s.sec) : 'var(--faint)'}"></i>`;
  }).join('');
  return `<span class="route-strip" data-path="${path.join(',')}" role="img"
    aria-label="${last} jump${last === 1 ? '' : 's'}: ${esc(path.map(sysName).join(', '))}">${squares}</span>`;
}

function bindRouteTip() {
  const tip = document.createElement('div');
  tip.className = 'route-tip';
  tip.hidden = true;
  document.body.append(tip);
  document.addEventListener('mouseover', (e) => {
    const sq = e.target.closest?.('.route-strip i');
    if (!sq || !trip.graph) { tip.hidden = true; return; }
    const path = sq.parentElement.dataset.path.split(',').map(Number);
    const n = Number(sq.dataset.n), last = path.length - 1;
    const s = systemInfo(trip.graph, path[n]);
    const jumps = (k) => `${k} jump${k === 1 ? '' : 's'}`;
    const where = [sq.dataset.mark, sq.classList.contains('wh') && 'via wormhole', n === 0 ? '' : n === last ? jumps(last) : `${jumps(n)} in · ${last - n} to go`].filter(Boolean).join(' · ');
    tip.innerHTML = s
      ? `<b>${esc(s.name)}</b> <span class="sec" style="--sec:${secColor(s.sec)}">${secLabel(s.sec)}</span> <span class="reg">&lt; ${esc(s.region || '')}</span><div>${esc(where)}</div>`
      : `<b>${esc(sysName(path[n]))}</b>${isJSpace(path[n]) ? ' <span class="reg">Wormhole space</span>' : ''}<div>${esc(where)}</div>`;
    tip.hidden = false;
    const r = sq.getBoundingClientRect();
    tip.style.left = `${Math.max(4, Math.min(r.left - 8, innerWidth - tip.offsetWidth - 4))}px`;
    tip.style.top = `${r.top - tip.offsetHeight - 6 < 4 ? r.bottom + 6 : r.top - tip.offsetHeight - 6}px`;
  });
}

// The row picked in Best items / Single route, while the map is showing it.
function focusPick() {
  if (settings.graphItem !== 'scan') return null;
  const pick = ui.scanPick ? scan.rows.find(r => r.key === ui.scanPick)
    : ui.loadPick ? routeRows().find(r => r.key === ui.loadPick) : null;
  return pick && (pick.from.hub?.id ?? null) === ui.selectedHub ? pick : null;
}

function renderFocus(routes) {
  const box = $('focus');
  const tr = ui.tripPick && trip.result && trip.graph ? tripList().find(t => t.key === ui.tripPick) : null;
  if (tr) {
    const geo = tripGeometry(tr);
    const last = geo.stops.at(-1);
    box.innerHTML = `Multi-stop: <strong>${esc(sysName(settings.trips.start))}</strong> ${routeStrip(geo.path, tripMarks(geo.path, geo.marks)) || '→'}
      <strong>${esc(sysName(last.systemId))}</strong> · ${geo.stops.length} stops · <span class="big">${formatIsk(tr.perJump)}</span> profit/jump
      · ${formatIsk(tr.profit)} profit · ${tr.jumps} jumps${whMark(geo.path)}`;
    return;
  }
  const pick = focusPick();
  if (pick) {
    const path = pathBetweenEnds(pick.from, pick.to);
    const what = pick.items ? `${pick.items.length} item${pick.items.length === 1 ? '' : 's'}` : esc(pick.name);
    const jumps = pick.jumps == null ? '' : ` · ${pick.approach != null ? `${pick.approach} + ` : ''}${pick.jumps} jumps${whMark(path)}`;
    box.innerHTML = `Picked: <strong>${esc(pick.from.name)}</strong> ${routeStrip(path) || '→'} <strong>${esc(pick.to.name)}</strong> · ${what}
      ${pick.ppj != null ? `· <span class="big">${formatIsk(pick.ppj)}</span> profit/jump` : ''} · ${formatIsk(pick.profit)} profit${jumps}
      ${pick.stale ? '<span class="badge stale">OLD</span>' : ''}`;
    return;
  }
  const scored = routes.filter(r => r.metric != null && (!ui.selectedHub || r.from.id === ui.selectedHub));
  const best = scored.reduce((acc, r) => better(r, acc), null);
  const where = ui.selectedHub ? `from <strong>${esc(hubById[ui.selectedHub].name)}</strong>` : 'overall';
  if (!best) {
    box.innerHTML = settings.items.length
      ? `No scored routes ${where} yet — refresh, or fill in manual overrides.`
      : 'Add an item to start scanning.';
    return;
  }
  if (best.metric <= 0) {
    box.innerHTML = `No profitable route ${where} right now. Best is ${esc(best.from.name)} ${routeStrip(pathFor(best)) || '→'} ${esc(best.to.name)} (${esc(best.item.name)}) at ${formatIsk(best.metric)}/jump.`;
    return;
  }
  const unitLabel = settings.graphItem === 'scan' ? 'profit/jump (whole haul)'
    : settings.metric === 'depth' && settings.sellMode === 'instant' ? 'ISK/jump (depth)' : 'ISK/jump per unit';
  box.innerHTML = `Best ${where}: <strong>${esc(best.from.name)}</strong> ${routeStrip(pathFor(best)) || '→'} <strong>${esc(best.to.name)}</strong> · ${esc(best.item.name)}
    · <span class="big">${formatIsk(best.metric)}</span> ${unitLabel}
    · ${best.jumps} jumps${best.overridden ? '' : whMark(pathFor(best))} · buy ${formatIsk(best.buy)} / sell ${formatIsk(best.sell)}
    ${best.units != null ? ` · ${best.units.toLocaleString()} units deep (${formatIsk(best.depthProfit)})` : ''}
    ${best.stale ? '<span class="badge stale">STALE</span>' : ''}${best.overridden ? '<span class="badge ov">OVERRIDE</span>' : ''}`;
}

function selectHub(id) {
  ui.selectedHub = id;
  ui.scanPick = null;
  if (ui.scanTrip) { ui.scanTrip = false; galaxy.setTrip(null); }
  render();
}

// --- items ---
function renderItems() {
  $('itemCount').textContent = settings.items.length ? `(${settings.items.length})` : '';
  const list = $('itemList');
  list.replaceChildren(...settings.items.map(item => {
    const m = market[item.typeId];
    const status = m?.status || 'none';
    const li = document.createElement('li');
    const tip = { ok: 'Fresh', loading: 'Loading…', stale: `Stale: ${m?.error || ''}`, error: `Failed: ${m?.error || ''}`, cached: 'Saved from last session — refresh for live data', none: 'Not loaded' }[status];
    li.innerHTML = `${itemPic(item.typeId, item.name, 24)}<span class="dot ${status === 'cached' ? 'stale' : status}" title="${esc(tip)}"></span>
      <span class="nm" title="${esc(item.name)}">${esc(item.name)}</span>${copyButton(item.name)}<span class="id">${item.typeId}</span>
      ${removeButton(item.typeId, item.name)}`;
    li.querySelector('[data-remove]').addEventListener('click', () => removeItem(item.typeId));
    return li;
  }));
  if (!settings.items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = `Your watchlist is empty — add items below${watch.mode === 'account' ? ' (saved to your character)' : ''}.`;
    list.replaceChildren(li);
  }

  const gi = $('graphItem');
  const opts = [['all', 'Watchlist: all items'], ['scan', 'Whole market (scan)'], ...settings.items.map(i => [String(i.typeId), i.name])];
  if (!opts.some(([v]) => v === settings.graphItem)) settings.graphItem = 'all';
  gi.replaceChildren(...opts.map(([v, t]) => new Option(t, v, false, v === settings.graphItem)));
}

function addItem(typeId, name) {
  typeId = Number(typeId);
  if (settings.items.some(i => i.typeId === typeId)) return;
  const item = { typeId, name };
  settings.items.push(item);
  saveSettings(); saveItems();
  fetchItem(item).finally(() => { saveMarket(); saveSettings(); render(); });
}

function removeItem(typeId) {
  settings.items = settings.items.filter(i => i.typeId !== typeId);
  saveSettings(); saveItems();
  render();
}

// The watchlist arrived (from your character or this browser): show it and load items that are new.
function applyWatchlist(items) {
  const before = new Set(settings.items.map(i => i.typeId));
  settings.items = items;
  saveSettings();
  render();
  for (const item of items) if (!before.has(item.typeId) || !market[item.typeId]) fetchItem(item).finally(() => { saveMarket(); render(); });
}

// --- item picker: market groups tree + exact-name lookup via ESI ---
const picker = { groups: null, loading: null, types: {} };

async function loadGroups() {
  if (picker.groups) return picker.groups;
  picker.loading ||= getJson('/api/tycoon/v1/market/groups').then(({ data }) => {
    const byId = Object.fromEntries(data.map(g => [g.marketGroupID, g]));
    const pathOf = (g) => {
      const parts = []; let cur = byId[g.parentGroupID], guard = 0;
      while (cur && guard++ < 12) { parts.unshift(cur.marketGroupName); cur = byId[cur.parentGroupID]; }
      return parts.join(' › ');
    };
    picker.groups = data.filter(g => g.hasTypes).map(g => ({ id: g.marketGroupID, name: g.marketGroupName, path: pathOf(g) }));
    return picker.groups;
  }).catch(e => { picker.loading = null; throw e; });
  return picker.loading;
}

function pickerShow(nodes) {
  const box = $('pickerResults');
  box.replaceChildren(...nodes);
  box.hidden = nodes.length === 0;
}
const msg = (t) => Object.assign(document.createElement('div'), { className: 'msg', textContent: t });

function typeButton(t) {
  const b = document.createElement('button');
  b.type = 'button';
  const added = settings.items.some(i => i.typeId === t.typeID);
  b.innerHTML = `${esc(t.typeName)}${added ? ' <span class="added">· added</span>' : ''}`;
  b.addEventListener('click', () => { addItem(t.typeID, t.typeName); b.innerHTML = `${esc(t.typeName)} <span class="added">· added</span>`; });
  return b;
}

async function openGroup(g) {
  pickerShow([msg(`Loading ${g.name}…`)]);
  try {
    picker.types[g.id] ||= (await getJson(`/api/tycoon/v1/market/groups/${g.id}/types`)).data
      .filter(t => t.typeName).sort((a, b) => a.typeName.localeCompare(b.typeName));
    const back = document.createElement('button');
    back.type = 'button';
    back.innerHTML = `<span class="grp">← ${esc(g.name)}</span><span class="path">${esc(g.path)}</span>`;
    back.addEventListener('click', () => onSearch());
    pickerShow([back, ...picker.types[g.id].map(typeButton)]);
  } catch (e) { pickerShow([msg(`Couldn't load group: ${e.message}`)]); }
}

let searchSeq = 0;
async function onSearch() {
  const q = $('itemSearch').value.trim().toLowerCase();
  const seq = ++searchSeq;
  if (q.length < 2) return pickerShow([]);
  let groups;
  try { groups = await loadGroups(); } catch (e) { return pickerShow([msg(`Market groups unavailable: ${e.message}. Press Enter to look up an exact item name.`)]); }
  if (seq !== searchSeq) return;

  // Types from groups already opened this session match by name, too.
  const typeHits = Object.values(picker.types).flat().filter(t => t.typeName.toLowerCase().includes(q)).slice(0, 8);
  const groupHits = groups
    .filter(g => g.name.toLowerCase().includes(q) || g.path.toLowerCase().includes(q))
    .sort((a, b) => (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
    .slice(0, 40);
  const nodes = [...typeHits.map(typeButton), ...groupHits.map(g => {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<span class="grp">${esc(g.name)}</span><span class="path">${esc(g.path)}</span>`;
    b.addEventListener('click', () => openGroup(g));
    return b;
  })];
  pickerShow(nodes.length ? nodes : [msg('No matching groups. Press Enter to look up an exact item name.')]);
}

async function lookupExact() {
  const name = $('itemSearch').value.trim();
  if (!name) return;
  pickerShow([msg(`Looking up “${name}”…`)]);
  try {
    const { data } = await getJson('/api/esi/universe/ids/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([name]),
    });
    const t = data.inventory_types?.[0];
    if (!t) return pickerShow([msg(`No item named exactly “${name}”.`)]);
    addItem(t.id, t.name);
    $('itemSearch').value = '';
    pickerShow([]);
  } catch (e) { pickerShow([msg(`Lookup failed: ${e.message}`)]); }
}

// --- table ---
const COLUMNS = [
  { key: 'route', label: 'Route', l: true, val: r => `${r.from.name}→${r.to.name}` },
  { key: 'item', label: 'Item', l: true, val: r => r.item.name },
  { key: 'jumps', label: 'Jumps', val: r => r.jumps },
  { key: 'buy', label: 'Buy', val: r => r.buy },
  { key: 'sell', label: 'Sell', val: r => r.sell },
  { key: 'spread', label: 'Spread', val: r => r.spread },
  { key: 'iskPerJump', label: 'ISK/jump', val: r => r.iskPerJump },
  { key: 'units', label: 'Depth units', val: r => r.units },
  { key: 'depthProfit', label: 'Depth profit', val: r => r.depthProfit },
  { key: 'depthPerJump', label: 'Profit/jump', val: r => r.depthPerJump },
];

function renderTable(routes) {
  if (!$('routeBody')) return;
  const defaultKey = settings.metric === 'depth' && settings.sellMode === 'instant' ? 'depthPerJump' : 'iskPerJump';
  const sortKey = ui.sort.key || defaultKey;
  const metricKey = defaultKey;

  $('routeHead').replaceChildren(...COLUMNS.map(c => {
    const th = document.createElement('th');
    th.textContent = c.label;
    if (c.l) th.className = 'l';
    if (c.key === sortKey) th.setAttribute('aria-sort', ui.sort.dir < 0 ? 'descending' : 'ascending');
    th.addEventListener('click', () => {
      ui.sort = { key: c.key, dir: sortKey === c.key ? -ui.sort.dir : (c.l ? 1 : -1) };
      render();
    });
    return th;
  }));

  const chip = $('originChip');
  chip.hidden = !ui.selectedHub;
  if (ui.selectedHub) {
    chip.innerHTML = `From ${esc(hubById[ui.selectedHub].name)} <button type="button" aria-label="Clear origin filter">×</button>`;
    chip.querySelector('button').onclick = () => selectHub(null);
  }

  let rows = routes.filter(r => r.status !== 'nomarket');
  if (ui.selectedHub) rows = rows.filter(r => r.from.id === ui.selectedHub);
  if (!settings.showAll) rows = rows.filter(r => r.metric > 0);
  const col = COLUMNS.find(c => c.key === sortKey);
  rows.sort((a, b) => {
    const va = col.val(a), vb = col.val(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * ui.sort.dir;
  });
  const topRow = rows.filter(r => r.metric != null).reduce((acc, r) => better(r, acc), null);

  const body = $('routeBody');
  if (!rows.length) {
    body.innerHTML = `<tr class="empty"><td colspan="${COLUMNS.length}">${
      settings.items.length ? 'No profitable routes with current data. Tick “Show unprofitable” to see everything.' : 'No items selected.'}</td></tr>`;
    return;
  }
  const n = (v, neg = true) => v == null ? '<span class="muted">—</span>' : `<span class="${neg && v < 0 ? 'neg' : ''}">${formatIsk(v)}</span>`;
  body.innerHTML = rows.map((r, i) => `
    <tr data-i="${i}" class="${r === topRow && r.metric > 0 ? 'top' : ''}">
      <td class="l">${esc(r.from.name)}<span class="arrow">→</span>${esc(r.to.name)}${r.stale ? '<span class="badge stale">STALE</span>' : ''}${r.overridden ? '<span class="badge ov">OVR</span>' : ''}</td>
      <td class="l">${esc(r.item.name)}${copyButton(r.item.name)}</td>
      <td>${r.jumps == null ? '<span class="muted">?</span>' : `${r.jumps}${jumpsOverridden(r) ? '' : whMark(pathFor(r))}`}</td>
      <td>${n(r.buy)}</td>
      <td>${n(r.sell)}</td>
      <td>${n(r.spread)}</td>
      <td class="${metricKey === 'iskPerJump' ? 'metric' : ''}">${n(r.iskPerJump)}</td>
      <td>${r.units == null ? '<span class="muted">—</span>' : r.units.toLocaleString()}</td>
      <td>${n(r.depthProfit)}</td>
      <td class="${metricKey === 'depthPerJump' ? 'metric' : ''}">${n(r.depthPerJump)}</td>
    </tr>`).join('');
  body.querySelectorAll('tr').forEach(tr => tr.addEventListener('click', () => {
    const r = rows[Number(tr.dataset.i)];
    settings.graphItem = String(r.item.typeId);
    saveSettings();
    selectHub(r.from.id);
    if (settings.view === 'map') galaxy.fitPath(pathFor(r));
  }));
}

// --- overrides ---
let ovItem = null;
function renderOverrides() {
  const panel = $('overridesPanel');
  const sel = $('ovItem');
  if (!settings.items.some(i => i.typeId === ovItem)) ovItem = settings.items[0]?.typeId ?? null;
  // Don't rebuild inputs while the user is typing in them.
  if (panel.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;

  sel.replaceChildren(...settings.items.map(i => new Option(i.name, i.typeId, false, i.typeId === ovItem)));
  $('ovSellHead').textContent = settings.sellMode === 'instant' ? 'Sell at (best buy)' : 'Sell at (lowest sell)';

  const books = market[ovItem]?.books;
  const ov = overrides.prices[ovItem] || {};
  $('ovPrices').replaceChildren(...HUBS.map(h => {
    const tr = document.createElement('tr');
    const liveBuy = books?.[h.id]?.asks[0]?.price;
    const liveSell = settings.sellMode === 'instant' ? books?.[h.id]?.bids[0]?.price : books?.[h.id]?.asks[0]?.price;
    tr.innerHTML = `<td>${esc(h.name)}</td>
      <td><input type="number" min="0" step="any" data-hub="${h.id}" data-side="buy" placeholder="${liveBuy ?? '—'}" value="${ov[h.id]?.buy ?? ''}" aria-label="${esc(h.name)} buy price"></td>
      <td><input type="number" min="0" step="any" data-hub="${h.id}" data-side="sell" placeholder="${liveSell ?? '—'}" value="${ov[h.id]?.sell ?? ''}" aria-label="${esc(h.name)} sell price"></td>`;
    return tr;
  }));

  const jumpsBox = $('ovJumps');
  const labels = [];
  for (let i = 0; i < HUBS.length; i++) for (let j = i + 1; j < HUBS.length; j++) {
    const k = pairKey(HUBS[i].id, HUBS[j].id);
    const live = hubPath(k) ? hubPath(k).length - 1 : null;
    const lab = document.createElement('label');
    lab.innerHTML = `${esc(HUBS[i].name)}–${esc(HUBS[j].name)} <input type="number" min="1" step="1" data-pair="${k}" placeholder="${live ?? '?'}" value="${overrides.jumps[k] ?? ''}">`;
    labels.push(lab);
  }
  jumpsBox.replaceChildren(...labels);
}

function onOverrideInput(e) {
  const t = e.target;
  if (t.dataset.pair) {
    if (t.value === '') delete overrides.jumps[t.dataset.pair];
    else overrides.jumps[t.dataset.pair] = t.value;
  } else if (t.dataset.hub && ovItem != null) {
    const item = overrides.prices[ovItem] ||= {};
    const hub = item[t.dataset.hub] ||= {};
    if (t.value === '') delete hub[t.dataset.side]; else hub[t.dataset.side] = t.value;
    if (!Object.keys(hub).length) delete item[t.dataset.hub];
    if (!Object.keys(item).length) delete overrides.prices[ovItem];
  } else return;
  saveOverrides();
  render();
}

// ---------------------------------------------------------------------------
// Best arbitrage items. Markets → Trade hubs uses the hub scan (every order in the five hub
// regions); All stations uses the universe scan (every station, shared with multi-stop routes).
// Either way the scan finds the hauls and we rank and filter them here.
// ---------------------------------------------------------------------------
const scan = { result: null, status: null, polling: null, loading: false, rows: [], memo: null, optKey: null };
const hubByStation = new Map(HUBS.map(h => [h.stationId, h]));
const hubSystems = new Set(HUBS.map(h => h.id));
const allStations = () => settings.scan.scope === 'all';

// "500m", "2.5b", "12,000" → number; blank or invalid → null
function parseAmount(v) {
  const m = String(v ?? '').trim().toLowerCase().replace(/[,\s_]/g, '').match(/^(\d*\.?\d+)([kmbt]?)$/);
  if (!m) return null;
  return Number(m[1]) * { '': 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[m[2]];
}

// The special holds (ore, mineral, PI, fleet hangar, …) of the ship in the Ship field: your
// current ship while "Use my ship's cargo" is on, else one picked by hand. From ESI's dogma
// attributes, cached per ship type in localStorage (they only change with game patches).
const ship = { typeId: null, holds: [], loading: false, error: null, fromMe: false };
const HOLDS_KEY = 'arbi.shipHolds';
async function loadShipHolds(typeId) {
  typeId = Number(typeId) || null;
  if (typeId === ship.typeId && !ship.error) return;
  Object.assign(ship, { typeId, holds: [], loading: false, error: null });
  scan.memo = null;
  const cached = typeId && LS.get(HOLDS_KEY, {})[typeId];
  if (typeId && !cached) {
    ship.loading = true;
    renderScan();
    try {
      const { data } = await getJson(`/api/esi/universe/types/${typeId}/`);
      if (ship.typeId !== typeId) return;
      ship.holds = shipHolds(data.dogma_attributes);
      LS.set(HOLDS_KEY, { ...LS.get(HOLDS_KEY, {}), [typeId]: ship.holds });
    } catch (e) {
      if (ship.typeId === typeId) ship.error = e.message;
    } finally {
      if (ship.typeId === typeId) ship.loading = false;
    }
  } else if (cached) ship.holds = cached;
  scan.memo = null;
  render();
}

// Buy at / Sell at: '' anywhere, 'hubs', 'offhub', a hub's system ID, or 'me' (within
// `near` jumps of your location: the multi-stop Start system, which follows your character).
function endFilter(v, near) {
  if (!v) return () => true;
  if (v === 'hubs') return (sys, loc) => hubByStation.has(loc);
  if (v === 'offhub') return (sys) => !hubSystems.has(sys);
  if (v === 'me') {
    if (!trip.graph) return () => false;
    const d = tripDistFrom(settings.trips.start);
    return (sys) => { const j = d(sys); return j != null && j <= near; };
  }
  const id = Number(v);
  return (sys) => sys === id;
}

function scanEnd(loc, sys) {
  const hub = hubByStation.get(loc);
  return hub ? { id: loc, systemId: sys, hub, name: hub.name, station: hub.station }
    : { id: loc, systemId: sys, hub: null, name: sysName(sys), station: stationName(loc, sys) };
}

function scanRows() {
  const all = allStations();
  const r = all ? trip.result : scan.result;
  if (!r) return [];
  const f = settings.scan;
  const memoKey = [all, r.finishedAt, JSON.stringify(f), settings.taxPct, settings.flag, settings.trips.start, ship.typeId, ship.holds.length,
    all ? '' : `${Object.keys(jumpCache[settings.flag]?.pairs || {}).length}${JSON.stringify(overrides.jumps)}`, sc.key()].join('|');
  if (scan.memo?.key === memoKey) return scan.memo.rows;

  const taxRate = (Number(settings.taxPct) || 0) / 100;
  const maxVolume = parseAmount(f.cargo) ?? Infinity;
  const maxCost = parseAmount(f.budget) ?? Infinity;
  const minProfit = parseAmount(f.minProfit) ?? 0;
  const maxMargin = f.maxMargin === '' ? Infinity : Number(f.maxMargin);
  const near = Math.max(0, Number(f.near) || 0);
  const q = f.q.trim().toLowerCase();
  const stale = Date.now() - r.finishedAt > 30 * 60_000; // badge rows only once prices are clearly old
  const fromOk = endFilter(f.from, near), toOk = endFilter(f.to, near);
  // Buying near you: the flight to the pickup counts towards profit per jump.
  const approachFrom = f.from === 'me' && trip.graph ? tripDistFrom(settings.trips.start) : null;
  const room = new Map();   // typeId → capacityFor(…)
  const rows = [], groups = new Map();
  for (const c of r.candidates) {
    const fs = all ? c.fs : c.f, ds = all ? c.ds : c.d;
    const fl = all ? c.f : hubById[c.f].stationId, dl = all ? c.d : hubById[c.d].stationId;
    if (!fromOk(fs, fl) || !toOk(ds, dl)) continue;
    if (all && !f.structures && (!isNpcStation(fl) || !isNpcStation(dl))) continue;
    const info = trip.catalog?.[c.t] || r.types?.[c.t] || [`Type ${c.t}`, 0];
    const [name, vol] = info;
    if (q && !name.toLowerCase().includes(q)) continue;
    if (f.hideShips && info[2] === SHIP_CATEGORY) continue;
    let cap = room.get(c.t);
    if (!cap) room.set(c.t, cap = capacityFor(ship.holds, maxVolume, info));
    const sum = summarizeSteps(c.s, { taxRate, unitVolume: vol, maxVolume: cap.m3, maxCost });
    if (!sum.units) continue;
    const margin = (sum.sell * (1 - taxRate) / sum.buy - 1) * 100;
    if (margin > maxMargin) continue;
    let jumps;
    if (!all) jumps = jumpsFor(c.f, c.d);
    else {
      if (!trip.graph) continue;
      jumps = fs === ds ? 0 : tripDistFrom(fs)(ds);
      if (jumps == null) continue; // unreachable with this route setting
    }
    const approach = approachFrom ? approachFrom(fs) : null;
    // Every haul on a pickup → drop-off pair, whatever its own profit, for Single route, many items.
    const gk = `${fl}>${dl}`;
    let g = groups.get(gk);
    if (!g) groups.set(gk, g = { key: gk, fl, fs, dl, ds, jumps, approach, hauls: [] });
    g.hauls.push({ key: `${c.t}:${gk}`, t: c.t, name, vol, steps: c.s, pools: poolsFor(cap) });
    if (sum.profit < minProfit) continue;
    const total = jumps == null ? null : jumps + (approach ?? 0);
    rows.push({
      key: `${c.t}:${fl}:${dl}`, typeId: c.t, name, vol, from: scanEnd(fl, fs), to: scanEnd(dl, ds), jumps, approach, stale,
      ranged: !!c.x, holds: sum.volume > maxVolume + 1e-6 ? cap.holds : [],
      ...sum, margin,
      ppj: total == null ? null : sum.profit / Math.max(1, total),
      iskm3: sum.volume > 0 ? sum.profit / sum.volume : null,
    });
  }
  const key = { ppj: r => r.ppj ?? -Infinity, profit: r => r.profit, iskm3: r => r.iskm3 ?? -Infinity, margin: r => r.margin }[f.rank] || (r => r.ppj ?? -Infinity);
  rows.sort((a, b) => key(b) - key(a));
  scan.memo = { key: memoKey, rows, groups: [...groups.values()], stale, routes: null };
  return rows;
}

// Holds an item may use for Single route, many items: its special holds, then the fleet hangar,
// then the cargo hold (manifest.js fills them in that order).
const FLEET_HANGAR = 912;
function poolsFor(cap) {
  const special = cap.holds.filter(h => h.attr !== FLEET_HANGAR).map(h => String(h.attr));
  return [...special, ...(cap.holds.some(h => h.attr === FLEET_HANGAR) ? [String(FLEET_HANGAR)] : []), 'cargo'];
}

// Single route, many items: for each pickup → drop-off pair, the most profitable mix of items
// that fits one hold and budget (manifest.js), ranked like Best arbitrage items.
function routeRows() {
  if (!(allStations() ? trip.result : scan.result)) return [];
  scanRows();
  const m = scan.memo;
  if (!m) return [];
  if (m.routes) return m.routes;
  const f = settings.scan;
  const taxRate = (Number(settings.taxPct) || 0) / 100;
  const maxCost = parseAmount(f.budget) ?? Infinity;
  const minProfit = parseAmount(f.minProfit) ?? 0;
  const pools = { cargo: parseAmount(f.cargo) ?? Infinity, ...Object.fromEntries(ship.holds.map(h => [String(h.attr), h.m3])) };
  const routes = [];
  for (const g of m.groups) {
    const load = packRoute(g.hauls, { pools, taxRate, maxCost });
    if (!load.items.length || load.profit < minProfit) continue;
    const total = g.jumps == null ? null : g.jumps + (g.approach ?? 0);
    routes.push({
      ...load, key: g.key, jumps: g.jumps, approach: g.approach, stale: m.stale,
      from: scanEnd(g.fl, g.fs), to: scanEnd(g.dl, g.ds),
      ppj: total == null ? null : load.profit / Math.max(1, total),
      iskm3: load.volume > 0 ? load.profit / load.volume : null,
      margin: load.cost ? load.profit / load.cost * 100 : 0,
    });
  }
  const key = { ppj: r => r.ppj ?? -Infinity, profit: r => r.profit, iskm3: r => r.iskm3 ?? -Infinity, margin: r => r.margin }[f.rank] || (r => r.ppj ?? -Infinity);
  m.routes = routes.sort((a, b) => key(b) - key(a));
  return m.routes;
}

function scanRowToRoute(row) {
  const taxRate = (Number(settings.taxPct) || 0) / 100;
  const spread = row.sell * (1 - taxRate) - row.buy;
  return {
    item: { typeId: row.typeId, name: row.name }, from: row.from.hub, to: row.to.hub, buy: row.buy, sell: row.sell,
    jumps: row.jumps, spread, iskPerJump: row.jumps ? spread / row.jumps : null,
    units: row.units, depthProfit: row.profit, depthPerJump: row.ppj, metric: row.ppj,
    stale: row.stale, overridden: false, status: row.jumps ? 'ok' : 'unknown', pinned: row.key === ui.scanPick,
  };
}

// For the map: the best-ranked item on each directed hub pair, plus the row the user picked.
function scanGraphRoutes() {
  const best = new Map();
  for (const row of scan.rows) {
    if (!row.from.hub || !row.to.hub || row.from.hub === row.to.hub) continue;
    const route = scanRowToRoute(row);
    const k = `${row.from.hub.id}>${row.to.hub.id}`;
    best.set(k, better(route, best.get(k)));
  }
  return [...best.values()];
}

// ⤳ for a Best items / Single route row: the approach from your location and the haul itself.
function routeWhMark(row) {
  if (!sc.inUse() || !trip.graph) return '';
  const haul = row.from.hub && row.to.hub && jumpOverride(pairKey(row.from.hub.id, row.to.hub.id)) != null ? null : pathBetweenEnds(row.from, row.to);
  const approach = row.approach != null ? pathBetween(travel(), settings.trips.start, row.from.systemId, tripFlag()) : null;
  return whMark(haul, approach);
}

// A picked row that isn't a plain hub-to-hub haul is drawn like a multi-stop trip: your
// location (when buying near you), the pickup, the drop-off.
function scanRowPath(row) {
  if (!trip.graph || (!allStations() && row.approach == null)) return null;
  const flag = tripFlag();
  const pts = [...(row.approach != null ? [{ systemId: settings.trips.start, label: `You: ${sysName(settings.trips.start)}` }] : []),
    { systemId: row.from.systemId, label: `Buy ${row.name} at ${row.from.station}` },
    { systemId: row.to.systemId, label: `Sell ${row.name} at ${row.to.station}` }];
  const path = [];
  for (let i = 1; i < pts.length; i++) {
    const seg = pathBetween(travel(), pts[i - 1].systemId, pts[i].systemId, flag) || [pts[i - 1].systemId, pts[i].systemId];
    path.push(...(path.length ? seg.slice(1) : seg));
  }
  const first = row.approach != null ? 0 : 1;
  return { path, stops: pts.map((p, i) => ({ ...p, n: i + first })) };
}

// Pickup → drop-off system path for a Best items or Single route row (its route strip), cached per route.
const rowPaths = new Map();
function rowPath(row) {
  if (row.jumps == null || !trip.graph) return null;
  const k = `${row.from.systemId}-${row.to.systemId}-${settings.flag}-${sc.key()}-${!!(row.from.hub && row.to.hub)}`;
  if (rowPaths.has(k)) return rowPaths.get(k);
  const path = row.from.hub && row.to.hub && row.from.hub !== row.to.hub ? pathFor({ from: row.from.hub, to: row.to.hub })
    : pathBetween(travel(), row.from.systemId, row.to.systemId, tripFlag());
  if (rowPaths.size > 2000) rowPaths.clear();
  if (path) rowPaths.set(k, path); // hub paths can still be loading; retry next render
  return path;
}

// Buy at / Sell at options depend on the market and your location's name.
function syncScanOptions() {
  const all = allStations(), where = trip.graph ? sysName(settings.trips.start) : 'your location';
  const key = `${all}|${where}`;
  if (scan.optKey !== key) {
    scan.optKey = key;
    for (const [id, k] of [['scFrom', 'from'], ['scTo', 'to']]) {
      const opts = [new Option(all ? 'Anywhere' : 'Any hub', ''),
        ...(all ? [new Option('Trade hubs', 'hubs'), new Option('Away from hubs', 'offhub')] : []),
        ...HUBS.map(h => new Option(all ? `${h.name} (system)` : h.name, String(h.id))),
        new Option(`Near me (${where})`, 'me')];
      if (!opts.some(o => o.value === settings.scan[k])) settings.scan[k] = '';
      if (!$(id)) continue;
      $(id).replaceChildren(...opts);
      $(id).value = settings.scan[k];
    }
  }
  if (!$('scNearWrap')) return;
  const nearMe = settings.scan.from === 'me' || settings.scan.to === 'me';
  $('scNearWrap').hidden = !nearMe;
  $('scStartWrap').hidden = !nearMe;
  $('scStructuresWrap').hidden = !all;
}

function renderShipNote() {
  const note = $('scShipNote');
  if (!note) return;
  note.hidden = !ship.typeId;
  if (!ship.typeId) return;
  const name = `${trip.catalog?.[ship.typeId]?.[0] || `Ship ${ship.typeId}`}${ship.fromMe ? ' (your ship)' : ''}`;
  const m3 = (v) => `${Math.round(v).toLocaleString()} m³`;
  note.textContent = ship.loading ? `${name}: loading its holds…`
    : ship.error ? `${name}: couldn't load its holds (${ship.error}), so only Cargo m³ counts.`
    : ship.holds.length ? `${name}: items that fit also go in its ${ship.holds.map(h => `${h.name.toLowerCase()} (${m3(h.m3)})`).join(', ')}, on top of Cargo m³. Base sizes, before skills.`
    : `${name} has no special holds, so only Cargo m³ counts.`;
}

// Each section is its own page (best-items, single-route, multi-stop, hub-routes.html), sharing this
// script, the map and the item list; a section renders only on the page that has it.
function renderScan() {
  scan.rows = scanRows(); // the map's "Whole market (scan)" view uses them on every page
  if ($('scanBtn')) renderScanTable();
  if ($('loadBody')) renderLoads();
}

function renderScanTable() {
  const all = allStations();
  syncScanOptions();
  renderShipNote();
  const st = all ? trip.status : scan.status, r = all ? trip.result : scan.result;
  const btn = $('scanBtn'), label = $('scanStatus'), bar = $('scanProgress');
  const busy = !!st && (st.state === 'running' || st.state === 'computing');
  btn.disabled = busy;
  btn.textContent = busy ? 'Scanning…' : all ? (r ? 'Rescan universe' : 'Scan universe') : 'Scan market';
  showProgress(bar, st, (all ? trip : scan).loading);

  const t = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const warnings = (busy ? st.warnings : r?.warnings) || [];
  label.classList.toggle('warn', warnings.length > 0 || st?.state === 'error');
  label.title = warnings.join('\n');
  if (busy) label.textContent = st.state === 'computing' ? (all ? 'Matching stations…' : 'Comparing order books…')
    : `${all ? 'Scanning every region' : 'Fetching orders'}: ${st.done}/${st.total || '…'} pages${all || st.remote ? tabNote(st) : ''}`;
  else if (st?.state === 'error') label.textContent = `Scan failed: ${st.error}`;
  else if (!all && scan.notice) label.textContent = scan.notice;
  else if (!r) label.textContent = all ? 'Needs a universe scan (a few minutes)' : 'No scan yet';
  else {
    label.textContent = `${r.candidates.length.toLocaleString()} profitable ${all ? 'hauls · universe scan' : 'item routes · scanned'} ${t(r.finishedAt)}`
      + (r.expiresAt > Date.now() ? ` · ESI refreshes ~${t(r.expiresAt)}` : ' · prices may have moved, rescan')
      + (warnings.length ? ` · ⚠ ${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : '');
  }

  const body = $('scanBody'), more = $('scanMore');
  if (!body) return; // Single route shares the filters, not the table
  if (!r || !scan.rows.length) {
    const nearMe = settings.scan.from === 'me' || settings.scan.to === 'me';
    body.innerHTML = `<tr class="empty"><td colspan="13">${
      r ? (all && !trip.graph ? 'Loading map data…' : nearMe ? 'Nothing matches these filters. Try allowing more jumps from your location.' : 'Nothing matches these filters.')
        : busy ? (all ? `Scanning every order in New Eden, which takes a few minutes${tabNote(st)}.` : `Scanning every order in the five hub regions, which takes about a minute${tabNote(st)}.`)
        : all ? 'Scan the universe to rank hauls between every station.' : 'Run a market scan to rank every item.'}</td></tr>`;
    more.hidden = true;
    return;
  }

  const shown = scan.rows.slice(0, ui.scanLimit);
  const watched = new Set(settings.items.map(i => i.typeId));
  const n = (v) => (v == null ? '<span class="muted">—</span>' : formatIsk(v));
  const loc = (e, extra = '') => `<div class="loc"><b>${esc(e.name)}</b><small title="${esc(e.station)}">${esc(e.station)}</small>${extra}</div>`;
  const jumpsOf = (j) => `${j} jump${j === 1 ? '' : 's'}`;
  const rank = settings.scan.rank;
  body.innerHTML = shown.map((row, i) => {
    const w = watched.has(row.typeId);
    const jumpsCell = (row.jumps == null ? '<span class="muted">?</span>'
      : row.approach != null ? `<span title="${jumpsOf(row.approach)} from you to the pickup, then ${jumpsOf(row.jumps)} to the drop-off">${row.approach} + ${row.jumps}</span>`
      : row.jumps) + (row.jumps == null ? '' : routeWhMark(row));
    const holds = row.holds.length
      ? `<small class="hold" title="Also uses the ${esc(row.holds.map(h => h.name.toLowerCase()).join(' and '))}">+ ${esc(row.holds.map(h => h.name).join(', '))}</small>` : '';
    return `
    <tr data-i="${i}" class="${i === 0 ? 'top' : ''} ${row.key === ui.scanPick ? 'picked' : ''}">
      <td class="l rank">${i + 1}</td>
      <td class="l item" title="${esc(row.name)}"><button class="star ${w ? 'on' : ''}" type="button" data-star
        aria-label="${w ? 'In watchlist' : `Add ${esc(row.name)} to watchlist`}">${w ? '★' : '☆'}</button>${esc(row.name)}${copyButton(row.name)}${row.stale ? '<span class="badge stale">OLD</span>' : ''}</td>
      <td class="l">${loc(row.from)}</td>
      <td class="l">${loc(row.to, row.ranged ? '<small class="note">sells into ranged buy orders</small>' : '')}</td>
      <td class="jumps">${jumpsCell}${routeStrip(rowPath(row)) || ''}</td>
      <td>${row.units.toLocaleString()}</td>
      <td>${row.vol ? Math.round(row.volume).toLocaleString() : '<span class="muted">?</span>'}${holds}</td>
      <td>${n(row.cost)}</td>
      <td>${n(row.buy)} → ${n(row.sell)}</td>
      <td class="${row.margin > 50 ? 'warn-m' : ''}">${row.margin.toFixed(1)}%</td>
      <td class="${rank === 'profit' ? 'metric' : ''}">${n(row.profit)}</td>
      <td class="${rank === 'ppj' ? 'metric' : ''}">${n(row.ppj)}</td>
      <td class="${rank === 'iskm3' ? 'metric' : ''}">${n(row.iskm3)}</td>
    </tr>`;
  }).join('');
  more.hidden = scan.rows.length <= ui.scanLimit;
  more.textContent = `Show more (${(scan.rows.length - ui.scanLimit).toLocaleString()} left)`;

  body.querySelectorAll('tr[data-i]').forEach(tr => tr.addEventListener('click', (e) => {
    const row = shown[Number(tr.dataset.i)];
    if (e.target.closest('[data-star]')) {
      if (!watched.has(row.typeId)) addItem(row.typeId, row.name);
      render();
      return;
    }
    settings.graphItem = 'scan';
    saveSettings();
    ui.selectedHub = row.from.hub?.id ?? null;
    ui.scanPick = row.key;
    ui.tripPick = null;
    ui.loadPick = null;
    const geo = scanRowPath(row);
    ui.scanTrip = !!geo;
    galaxy.setTrip(geo);
    render();
    if (settings.view === 'map') galaxy.fitPath(geo?.path || pathFor({ from: row.from.hub, to: row.to.hub }));
    $('mapView').closest('.panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }));
}

function renderLoads() {
  const all = allStations(), r = all ? trip.result : scan.result;
  const routes = routeRows();
  const body = $('loadBody'), more = $('loadMore'), label = $('loadStatus');
  label.textContent = r ? `${routes.length.toLocaleString()} route${routes.length === 1 ? '' : 's'}` : '';
  const picked = ui.loadPick && routes.find(x => x.key === ui.loadPick);
  if (ui.loadPick && r && !picked) ui.loadPick = null;
  $('loadDetail').hidden = !picked;
  $('loadDetail').parentElement.classList.toggle('has-detail', !!picked);
  if (!routes.length) {
    body.innerHTML = `<tr class="empty"><td colspan="11">${r ? 'No route with these filters.' : 'Waiting for a market scan.'}</td></tr>`;
    more.hidden = true;
    return;
  }
  const shown = routes.slice(0, ui.loadLimit);
  const n = (v) => (v == null ? '<span class="muted">—</span>' : formatIsk(v));
  const loc = (e) => `<div class="loc"><b>${esc(e.name)}</b><small title="${esc(e.station)}">${esc(e.station)}</small></div>`;
  const rank = settings.scan.rank;
  body.innerHTML = shown.map((rt, i) => {
    const names = rt.items.slice(0, 3).map(e => `<span class="nw"><b>${esc(e.name)}</b>${copyButton(e.name)}</span>`).join(', ');
    const jumps = rt.jumps == null ? '<span class="muted">?</span>' : `${rt.approach != null ? `${rt.approach} + ${rt.jumps}` : rt.jumps}${routeWhMark(rt)}`;
    return `<tr data-key="${esc(rt.key)}" class="${i === 0 ? 'top' : ''} ${rt.key === ui.loadPick ? 'picked' : ''}">
      <td class="l rank">${i + 1}</td>
      <td class="l">${loc(rt.from)}</td><td class="l">${loc(rt.to)}</td><td class="jumps">${jumps}${routeStrip(rowPath(rt)) || ''}</td>
      <td class="l itm">${rt.items.length} item${rt.items.length === 1 ? '' : 's'}: ${names}${rt.items.length > 3 ? ` +${rt.items.length - 3} more` : ''}${rt.stale ? '<span class="badge stale">OLD</span>' : ''}</td>
      <td>${Math.round(rt.volume).toLocaleString()}</td><td>${n(rt.cost)}</td>
      <td class="${rank === 'margin' ? 'metric' : ''}">${rt.margin.toFixed(1)}%</td>
      <td class="${rank === 'profit' ? 'metric' : ''}">${n(rt.profit)}</td>
      <td class="${rank === 'ppj' ? 'metric' : ''}">${n(rt.ppj)}</td>
      <td class="${rank === 'iskm3' ? 'metric' : ''}">${n(rt.iskm3)}</td></tr>`;
  }).join('');
  more.hidden = routes.length <= ui.loadLimit;
  more.textContent = `Show more (${(routes.length - ui.loadLimit).toLocaleString()} left)`;
  if (picked) renderLoadDetail(picked);
}

function renderLoadDetail(rt) {
  const holdName = Object.fromEntries(ship.holds.map(h => [String(h.attr), h.name]));
  const jumps = rt.jumps == null ? '' : ` · ${rt.approach != null ? `${rt.approach} jumps from you, then ` : ''}${rt.jumps} jump${rt.jumps === 1 ? '' : 's'}`;
  $('loadWhere').textContent = `Buy at ${rt.from.station}, sell at ${rt.to.station}${jumps}. Sell into buy orders; prices are the first and last order filled.`;
  const n = (v) => formatIsk(v);
  $('loadItems').innerHTML = rt.items.map(e => {
    const holds = Object.keys(e.used).filter(p => p !== 'cargo').map(p => holdName[p]).filter(Boolean);
    const px = e.worstBuy !== e.buy || e.worstSell !== e.sell ? `${n(e.buy)}–${n(e.worstBuy)} → ${n(e.sell)}–${n(e.worstSell)}` : `${n(e.buy)} → ${n(e.sell)}`;
    return `<tr><td class="l">${esc(e.name)}${copyButton(e.name)}${holds.length ? `<small class="hold">in ${esc(holds.join(', ').toLowerCase())}</small>` : ''}</td>
      <td>${e.units.toLocaleString()}</td><td>${Math.round(e.volume).toLocaleString()}</td><td>${px}</td><td>${n(e.profit)}</td></tr>`;
  }).join('') + `<tr class="total"><td class="l"><b>Total</b></td><td></td><td><b>${Math.round(rt.volume).toLocaleString()}</b></td>
    <td><b>${n(rt.cost)}</b> spent</td><td><b>${n(rt.profit)}</b></td></tr>`;
}

function selectLoad(rt) {
  ui.loadPick = rt?.key ?? null;
  if (!rt) { if (ui.scanTrip) { ui.scanTrip = false; galaxy.setTrip(null); } renderLoads(); return; }
  settings.graphItem = 'scan';
  saveSettings();
  ui.scanPick = null;
  ui.tripPick = null;
  ui.selectedHub = rt.from.hub?.id ?? null;
  const geo = scanRowPath({ ...rt, name: 'cargo' });
  ui.scanTrip = !!geo;
  galaxy.setTrip(geo);
  render();
  if (settings.view === 'map') galaxy.fitPath(geo?.path || pathFor({ from: rt.from.hub, to: rt.to.hub }));
}

function bindLoads() {
  if (!$('loadBody')) return;
  $('loadBody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) selectLoad(routeRows().find(x => x.key === tr.dataset.key));
  });
  $('loadClear').addEventListener('click', () => selectLoad(null));
  $('loadMore').addEventListener('click', () => { ui.loadLimit += 50; renderLoads(); });
  $('loadCopy').addEventListener('click', async () => {
    const rt = routeRows().find(x => x.key === ui.loadPick);
    if (!rt) return;
    try { await navigator.clipboard.writeText(multibuyText(rt.items)); $('loadCopy').textContent = 'Copied'; }
    catch { $('loadCopy').textContent = 'Copy failed'; }
    setTimeout(() => { $('loadCopy').textContent = 'Copy for multibuy'; }, 1500);
  });
}

const hubScan = scanClient('scan'), uniScan = scanClient('uscan');

async function loadScanResult() {
  scan.loading = true;
  renderScan();
  try { scan.result = (await hubScan.result()) ?? scan.result; }
  catch { /* keep the previous result */ }
  scan.loading = false;
  render();
}

async function pollScan() {
  clearTimeout(scan.polling);
  try { scan.status = await hubScan.status(); }
  catch (e) { scan.status = { state: 'error', error: e.message }; }
  const busy = ['running', 'computing'].includes(scan.status.state);
  if (busy) scan.polling = setTimeout(pollScan, 1500);
  else if (scan.status.result && scan.status.result.finishedAt !== scan.result?.finishedAt) await loadScanResult();
  renderScan();
  return scan.status;
}

async function startScan() {
  if (allStations()) { tripStartScan(); return; }
  scan.notice = null;
  try {
    const res = await hubScan.start();
    scan.status = res;
    if (!res.started && res.reason === 'fresh') {
      const at = new Date(res.result.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      scan.notice = `Already current — ESI publishes new market data after ${at}`;
      setTimeout(() => { scan.notice = null; renderScan(); }, 6000);
    }
  } catch (e) { scan.status = { state: 'error', error: e.message }; }
  pollScan();
}

// Ship field: a ship picked by hand fills Cargo m³ with its base hold (unless that's locked to
// your character) and adds its special holds for the items that fit them.
const shipByName = new Map();
function initShipList(catalog) {
  const names = [];
  for (const [id, info] of Object.entries(catalog)) {
    if (info[2] !== SHIP_CATEGORY) continue;
    shipByName.set(info[0].toLowerCase(), Number(id));
    names.push(info[0]);
  }
  if (!$('scShip')) return;
  $('scShips').innerHTML = names.sort().map(n => `<option value="${esc(n)}">`).join('');
  const id = ship.typeId || Number(settings.scan.ship);
  $('scShip').value = id ? catalog[id]?.[0] || '' : '';
}
function useShip(typeId) {
  const input = $('scShip');
  ship.fromMe = !!typeId;
  const id = typeId || Number(settings.scan.ship) || null;
  loadShipHolds(id);
  if (!input) return;
  input.disabled = !!typeId;
  input.classList.toggle('from-me', !!typeId);
  input.title = typeId ? 'Your current ship. Turn off "Use my ship\'s cargo" in the character menu to pick one.' : '';
  input.value = id ? trip.catalog?.[id]?.[0] || '' : '';
}

function bindScanFilters() {
  const fields = { scScope: 'scope', scCargo: 'cargo', scBudget: 'budget', scMinProfit: 'minProfit', scFrom: 'from', scTo: 'to', scNear: 'near', scMaxMargin: 'maxMargin', scRank: 'rank', scQuery: 'q' };
  syncScanOptions();
  let timer;
  for (const [id, key] of Object.entries({ scHideShips: 'hideShips', scStructures: 'structures' })) {
    if (!$(id)) continue;
    $(id).checked = !!settings.scan[key];
    $(id).addEventListener('change', () => { settings.scan[key] = $(id).checked; ui.scanLimit = 50; saveSettings(); render(); });
  }
  for (const [id, key] of Object.entries(fields)) {
    const input = $(id);
    if (!input) continue; // Multi-stop routes only has Cargo m³ and Budget
    input.value = settings.scan[key];
    const isSelect = input.tagName === 'SELECT';
    input.addEventListener(isSelect ? 'change' : 'input', () => {
      settings.scan[key] = input.value;
      ui.scanLimit = 50; ui.loadLimit = 30;
      if (key === 'scope') { ui.scanPick = null; if (ui.scanTrip) { ui.scanTrip = false; galaxy.setTrip(null); } }
      clearTimeout(timer);
      timer = setTimeout(() => { saveSettings(); render(); }, isSelect ? 0 : 200);
    });
  }
  if (!$('scanBtn')) return;
  $('scShip').addEventListener('change', () => {
    const v = $('scShip').value.trim().toLowerCase();
    const id = v ? shipByName.get(v) : null;
    $('scShip').classList.toggle('bad', !!v && !id);
    if (v && !id) return;
    settings.scan.ship = id ? String(id) : '';
    const cargo = id ? trip.catalog?.[id]?.[3] : null;
    if (cargo && !$('scCargo').disabled) { settings.scan.cargo = String(Math.floor(cargo)); $('scCargo').value = settings.scan.cargo; }
    saveSettings();
    loadShipHolds(id);
  });
  mountFitButton($('scCargo'), { types: () => trip.catalog, shipInput: $('scShip') });
  $('scanBtn').addEventListener('click', startScan);
  $('scanMore')?.addEventListener('click', () => { ui.scanLimit += 100; renderScan(); });
}

// ---------------------------------------------------------------------------
// Multi-stop routes: chained hauls from the universe scan (see trips.js)
// ---------------------------------------------------------------------------
const trip = { result: null, status: null, poll: null, loading: false, graph: null, catalog: null, stations: {}, memo: null, byName: new Map() };
const tripFlag = () => (settings.flag === 'secure' ? 'secure' : 'shortest');

async function tripLoadResult() {
  trip.loading = true;
  renderTrips();
  if (allStations()) renderScan();
  try { trip.result = (await uniScan.result()) ?? trip.result; trip.memo = null; }
  catch { /* keep the previous result */ }
  trip.loading = false;
  render();
}

async function tripPoll() {
  clearTimeout(trip.poll);
  try { trip.status = await uniScan.status(); }
  catch (e) { trip.status = { state: 'error', error: e.message }; }
  const busy = ['running', 'computing'].includes(trip.status.state);
  if (busy) trip.poll = setTimeout(tripPoll, 1500);
  else if (trip.status.result && trip.status.result.finishedAt !== trip.result?.finishedAt) await tripLoadResult();
  renderTrips();
  if (allStations()) renderScan();
}

async function tripStartScan() {
  try { trip.status = await uniScan.start(); }
  catch (e) { trip.status = { state: 'error', error: e.message }; }
  tripPoll();
}

function tripDistFrom(sys) {
  const g = travel();
  const d = jumpsFrom(g, sys, tripFlag());
  return (to) => { const i = g.indexOf.get(to); return i == null || d[i] < 0 ? null : d[i]; };
}

function tripList() {
  const r = trip.result, t = settings.trips;
  if (!r || !trip.graph || !trip.catalog) return [];
  const key = [r.finishedAt, JSON.stringify(t), settings.taxPct, settings.scan.cargo, settings.scan.budget, tripFlag(), sc.key()].join('|');
  if (trip.memo?.key === key) return trip.memo.trips;
  const cached = tripCacheGet(key);
  if (cached) { trip.memo = { key, trips: cached }; return cached; }
  const legs = evaluateLegs(r, {
    catalog: trip.catalog, taxRate: (Number(settings.taxPct) || 0) / 100,
    maxVolume: parseAmount(settings.scan.cargo) ?? Infinity, maxCost: parseAmount(settings.scan.budget) ?? Infinity,
    minProfit: parseAmount(t.minProfit) ?? 0, hideShips: t.hideShips, hideHubs: t.hideHubs, structures: t.structures, isNpcStation,
  });
  const trips = planTrips(legs, {
    start: t.start, distFrom: tripDistFrom, maxLegs: Number(t.legs) || 3,
    maxLink: t.link === '' ? 3 : Math.max(0, Number(t.link) || 0), rank: t.rank,
  }).map(tr => ({ ...tr, key: tr.legs.map(l => `${l.t}:${l.f}:${l.d}`).join('>') }));
  trip.memo = { key, trips };
  tripCachePut(key, trips);
  return trips;
}

// Planned trips for this browser session (sessionStorage), keyed by the scan and every setting
// that shapes them, so going back to an earlier search or reloading the page doesn't re-plan.
const TRIP_CACHE = 'arbi.tripSearches', TRIP_CACHE_MAX = 12;
function tripCacheRead() {
  try { return JSON.parse(sessionStorage.getItem(TRIP_CACHE) || '[]'); } catch { return []; }
}
function tripCacheGet(key) {
  return tripCacheRead().find(e => e.key === key)?.trips ?? null;
}
function tripCachePut(key, trips) {
  const list = [{ key, trips }, ...tripCacheRead().filter(e => e.key !== key)].slice(0, TRIP_CACHE_MAX);
  // Full storage: drop the oldest searches until it fits (or give up quietly).
  while (list.length) {
    try { sessionStorage.setItem(TRIP_CACHE, JSON.stringify(list)); return; } catch { list.pop(); }
  }
}

// Wormhole systems aren't in universe.json: shortcuts.js looks their names up.
const sysName = (id) => (trip.graph ? systemInfo(trip.graph, id)?.name : null) || sc.sysName(id);
const stationName = (loc, sys) => trip.stations[loc]?.[0] || (isNpcStation(loc) ? `Station ${loc}` : `Structure in ${sysName(sys)}`);

// Where each waypoint falls on a trip's path, for routeStrip: [[path index, label]].
function tripMarks(path, marks) {
  let i = 0;
  return marks.map((m) => {
    while (i < path.length - 1 && path[i] !== m.systemId) i++;
    return [i, m.n ? `Stop ${m.n}: ${m.label.split(' — ')[1] || ''}` : 'Start'];
  });
}

// Full gate path: start → first pickup → … → last drop-off, plus the numbered waypoints.
function tripGeometry(tr) {
  const stops = tripStops(tr);
  const path = [];
  let at = settings.trips.start;
  for (const st of stops) {
    const seg = pathBetween(travel(), at, st.systemId, tripFlag()) || [at, st.systemId];
    path.push(...(path.length ? seg.slice(1) : seg));
    at = st.systemId;
  }
  const label = (st) => (st.action === 'buy' ? `Buy ${st.buy.name}` : st.action === 'sell' ? `Sell ${st.sell.name}`
    : `Sell ${st.sell.name}, buy ${st.buy.name}`);
  return {
    path, stops,
    marks: [{ systemId: settings.trips.start, n: 0, label: `Start: ${sysName(settings.trips.start)}` },
      ...stops.map((st, i) => ({ systemId: st.systemId, n: i + 1, label: `${sysName(st.systemId)} — ${label(st)}` }))],
  };
}

function selectTrip(tr) {
  ui.tripPick = tr?.key ?? null;
  ui.scanTrip = false;
  if (!tr) { galaxy.setTrip(null); render(); return; }
  const geo = tripGeometry(tr);
  galaxy.setTrip({ path: geo.path, stops: geo.marks });
  if (settings.view !== 'map') setView('map');
  galaxy.fitPath(geo.path);
  render();
  $('mapView').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function tripStopsHtml(tr) {
  const geo = tripGeometry(tr);
  let at = settings.trips.start;
  const rows = [`<li><span class="n start">0</span><span class="where">${esc(sysName(at))}<small>start</small></span></li>`];
  geo.stops.forEach((st, i) => {
    const hop = tripDistFrom(at)(st.systemId);
    const seg = hop ? pathBetween(travel(), at, st.systemId, tripFlag()) : null;
    const strip = seg && routeStrip(seg, [[0, i ? `Stop ${i}` : 'Start'], [seg.length - 1, `Stop ${i + 1}`]]);
    at = st.systemId;
    const sell = st.sell ? `Sell <b>${formatIsk(st.sell.units, 1)} ${esc(st.sell.name)}</b>${copyButton(st.sell.name)} → <span class="up">+${formatIsk(st.sell.profit)}</span>` : '';
    const buy = st.buy ? `Buy <b>${formatIsk(st.buy.units, 1)} ${esc(st.buy.name)}</b>${copyButton(st.buy.name)} for ${formatIsk(st.buy.cost)}${st.buy.x ? ' (sell point uses ranged buy orders)' : ''}` : '';
    rows.push(`<li><span class="n">${i + 1}</span>
      <span class="where">${esc(stationName(st.locationId, st.systemId))}<small>${esc(sysName(st.systemId))}</small></span>
      <span class="act">${[sell, buy].filter(Boolean).join('<br>')}</span>
      <span class="hop">${hop == null ? '' : hop === 0 ? 'same system' : `${strip || ''}${hop} jump${hop === 1 ? '' : 's'} from previous stop`}</span></li>`);
  });
  return rows.join('');
}

function tripText(tr) {
  const geo = tripGeometry(tr);
  const lines = [`Start: ${sysName(settings.trips.start)}`];
  geo.stops.forEach((st, i) => {
    const acts = [st.sell && `SELL ${formatIsk(st.sell.units, 1)} ${st.sell.name}`, st.buy && `BUY ${formatIsk(st.buy.units, 1)} ${st.buy.name}`].filter(Boolean);
    lines.push(`${i + 1}. ${stationName(st.locationId, st.systemId)} (${sysName(st.systemId)}) — ${acts.join(', then ')}`);
  });
  lines.push(`Total: ${formatIsk(tr.profit)} profit over ${tr.jumps} jumps (${formatIsk(tr.perJump)}/jump)`);
  lines.push('', 'Systems in order:', ...geo.marks.slice(1).map(m => sysName(m.systemId)).filter((s, i, a) => s !== a[i - 1]));
  return lines.join('\n');
}

function renderTrips() {
  if (!$('tripBody')) return;
  const st = trip.status, r = trip.result;
  const busy = !!st && ['running', 'computing'].includes(st.state);
  const label = $('tripStatus'), bar = $('tripProgress');
  $('tripScanBtn').disabled = busy;
  $('tripScanBtn').textContent = busy ? 'Scanning…' : r ? 'Rescan universe' : 'Scan universe';
  showProgress(bar, st, trip.loading);
  const startOk = !!trip.graph && travel().indexOf.has(settings.trips.start);
  $('tpStart').classList.toggle('bad', !!trip.graph && !startOk);

  const body = $('tripBody');
  let trips = [];
  if (busy) label.textContent = st.state === 'computing' ? 'Matching stations…' : `Scanning every region: ${st.done}/${st.total || '…'} pages${tabNote(st)}`;
  else if (st?.state === 'error') label.textContent = `Universe scan failed: ${st.error}`;
  else if (!r) label.textContent = 'Needs a universe scan (a few minutes)';
  else {
    trips = tripList();
    const age = Math.round((Date.now() - r.finishedAt) / 60_000);
    label.textContent = `${trips.length} routes · universe scan from ${age < 1 ? 'just now' : `${age} min ago`}`;
  }
  if (!r) body.innerHTML = '<tr class="empty"><td colspan="7">Run a universe scan to plan multi-stop routes.</td></tr>';
  else if (!trip.graph || !trip.catalog) body.innerHTML = '<tr class="empty"><td colspan="7">Loading map and item data…</td></tr>';
  else {
    body.innerHTML = trips.slice(0, 30).map((tr, i) => {
      const route = [settings.trips.start, ...tripStops(tr).map(s => s.systemId)]
        .filter((s, k, a) => s !== a[k - 1]).map(s => `<span class="sys">${esc(sysName(s))}</span>`).join(' → ');
      const items = tr.legs.map(l => `<span class="nw">${esc(l.name)}${copyButton(l.name)}</span>`).join(' · ');
      return `<tr data-key="${esc(tr.key)}" class="${tr.key === ui.tripPick ? 'picked' : ''}">
        <td class="l rank">${i + 1}</td>
        <td class="l route">${route}<span class="itm">${items}</span></td>
        <td>${tr.legs.length}</td><td>${tr.jumps}${sc.inUse() ? whMark(tripGeometry(tr).path) : ''}</td><td>${formatIsk(tr.peakCost)}</td>
        <td>${formatIsk(tr.profit)}</td><td class="metric">${formatIsk(tr.perJump)}</td></tr>`;
    }).join('') || '<tr class="empty"><td colspan="7">No chained routes with these settings — try more empty jumps between hauls or a lower min profit.</td></tr>';
  }
  const picked = ui.tripPick && trips.find(t => t.key === ui.tripPick);
  if (ui.tripPick && r && trip.graph && !picked) { ui.tripPick = null; galaxy.setTrip(null); }
  $('tripDetail').hidden = !picked;
  $('tripDetail').parentElement.classList.toggle('has-detail', !!picked);
  if (picked) $('tripStops').innerHTML = tripStopsHtml(picked);
}

function bindStart() {
  const t = settings.trips;
  $('tpStart')?.addEventListener('change', async () => {
    const text = $('tpStart').value.trim();
    // Known space locally; J-codes and Thera through ESI (they only route once a shortcut reaches them).
    let id = trip.byName.get(text.toLowerCase());
    if (!id && text) { try { id = await sc.systemByName(text); } catch { /* keep the old start */ } }
    if (id) { t.start = id; saveSettings(); trip.memo = null; scan.memo = null; }
    render(); // Near me (…) in Best arbitrage items follows it too
  });
}

function bindTrips() {
  if (!$('tripBody')) return;
  const t = settings.trips;
  const fields = { tpLegs: 'legs', tpLink: 'link', tpMinProfit: 'minProfit', tpRank: 'rank' };
  for (const [id, key] of Object.entries(fields)) {
    const input = $(id);
    input.value = t[key];
    input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', () => { t[key] = input.value; saveSettings(); renderTrips(); });
  }
  for (const [id, key] of Object.entries({ tpHideShips: 'hideShips', tpHideHubs: 'hideHubs', tpStructures: 'structures' })) {
    $(id).checked = !!t[key];
    $(id).addEventListener('change', () => { t[key] = $(id).checked; saveSettings(); renderTrips(); });
  }
  $('tripScanBtn').addEventListener('click', tripStartScan);
  $('tripBody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) selectTrip(tripList().find(x => x.key === tr.dataset.key));
  });
  $('tripClear').addEventListener('click', () => selectTrip(null));
  $('tripCopy').addEventListener('click', async () => {
    const picked = tripList().find(x => x.key === ui.tripPick);
    if (!picked) return;
    try { await navigator.clipboard.writeText(tripText(picked)); $('tripCopy').textContent = 'Copied'; }
    catch { $('tripCopy').textContent = 'Copy failed'; }
    setTimeout(() => { $('tripCopy').textContent = 'Copy waypoints'; }, 1500);
  });
}

// Signed in with Follow on: multi-stop routes start where your character is (see me.js).
function followLocation(loc) {
  const input = $('tpStart');
  // In wormhole space too, once a shortcut (say, your own recorded jump) links that system in.
  if (loc && trip.graph && (travel().indexOf.has(loc.systemId) || isJSpace(loc.systemId)) && loc.systemId !== settings.trips.start) {
    settings.trips.start = loc.systemId; saveSettings(); trip.memo = null;
    if (ui.tripPick) selectTrip(null);
  }
  if (input) {
    if (trip.graph) input.value = sysName(settings.trips.start);
    input.disabled = !!loc;
    input.title = loc ? 'Following your character — untick Follow to choose a system by hand' : '';
  }
  render();
}
// Ship cargo → Cargo m³, wallet → Budget (both feed the market scan and multi-stop routes).
function useFromMe(id, key, value, what) {
  const input = $(id);
  if (value != null) { settings.scan[key] = String(Math.floor(value)); saveSettings(); trip.memo = null; }
  if (input) {
    if (value != null) input.value = settings.scan[key];
    input.disabled = value != null;
    input.classList.toggle('from-me', value != null);
    input.title = value != null ? `${what} — turn off in the character menu to edit` : '';
  }
  render();
}
const meCtl = createMe({
  el: $('me'), returnTo: location.pathname, systemName: (id) => sysName(id), isk: formatIsk,
  shipInfo: (id) => (trip.catalog?.[id] ? { name: trip.catalog[id][0], cargo: trip.catalog[id][2] === SHIP_CATEGORY ? trip.catalog[id][3] ?? null : null } : null),
  onFollow: followLocation,
  onCargo: (m3) => useFromMe('scCargo', 'cargo', m3, 'From your current ship (base hold)'),
  onShip: useShip,
  onBudget: (isk) => useFromMe('scBudget', 'budget', isk, 'Your wallet balance'),
  onStatus: () => watch.load(),
});

function initTripData(u) {
  trip.graph = buildGraph(u);
  sc.setBase(trip.graph);
  for (let i = 0; i < trip.graph.n; i++) trip.byName.set(trip.graph.name[i].toLowerCase(), trip.graph.id[i]);
  if ($('tpSystems')) $('tpSystems').innerHTML = [...trip.graph.name].sort().map(n => `<option value="${esc(n)}">`).join('');
  if (!trip.graph.indexOf.has(settings.trips.start) && !isJSpace(settings.trips.start)) { settings.trips.start = DEFAULTS.trips.start; saveSettings(); } // unknown ID from a link
  sc.resolveNames([settings.trips.start]);
  if ($('tpStart')) $('tpStart').value = sysName(settings.trips.start);
  meCtl.reapply(); // system names are available now
  renderTrips();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function bindSetting(id, key, { parse = v => v, after } = {}) {
  const input = $(id);
  if (!input) return;
  if (input.type === 'checkbox') input.checked = !!settings[key]; else input.value = settings[key];
  input.addEventListener('change', () => {
    settings[key] = parse(input.type === 'checkbox' ? input.checked : input.value);
    ui.sort.key = null;
    saveSettings();
    after?.();
    render();
  });
}

function syncMetricAvailability() {
  const depthOpt = $('metric').querySelector('option[value=depth]');
  depthOpt.disabled = settings.sellMode !== 'instant';
  depthOpt.textContent = settings.sellMode === 'instant' ? 'Depth profit / jump' : 'Depth profit / jump (instant mode only)';
}

const galaxy = createMapSwitch({
  flat: new GalaxyMap($('mapCanvas'), { tooltip: $('mapTip'), onSelectHub: (id) => selectHub(id) }),
  create3d: async () => {
    const [THREE, { GalaxyMap3D }] = await Promise.all([loadThree(), import('./map3d.js')]);
    return new GalaxyMap3D($('mapGl'), $('mapOverlay'), { THREE, tooltip: $('mapTip'), onSelectHub: (id) => selectHub(id) });
  },
  flatEl: $('mapCanvas'),
  spaceEls: [$('mapGl'), $('mapOverlay')],
  // No WebGL or the CDN is unreachable: show Top-down without overwriting the saved choice.
  onUnavailable: (e) => {
    const opt = $('mapLayout').querySelector('option[value=space]');
    opt.disabled = true;
    opt.textContent = 'In-game 3D (unavailable)';
    opt.title = `The 3D map couldn't start: ${e.message}`;
    $('mapLayout').value = '3d';
  },
});
galaxy.setSecurityColors(settings.secColors);
galaxy.setLayout(settings.mapLayout);
fetch('data/universe.json')
  .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
  .then(u => { galaxy.setUniverse(u); initTripData(u); scan.memo = null; $('mapMsg').hidden = true; render(); })
  .catch(e => { $('mapMsg').textContent = `Star map data unavailable (${e.message}). Run “npm run build:map”, or use the Schematic view.`; });

function setView(view) {
  settings.view = view;
  saveSettings();
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  $('mapTools').hidden = view !== 'map';
  $('legendMap').hidden = view !== 'map';
  render();
}
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
$('mapZoomIn').addEventListener('click', () => galaxy.zoomBy(1.6));
$('mapZoomOut').addEventListener('click', () => galaxy.zoomBy(1 / 1.6));
$('mapFitHubs').addEventListener('click', () => galaxy.fitHubs());
$('mapFitAll').addEventListener('click', () => galaxy.fitAll());
$('mapFitRoute').addEventListener('click', () => {
  const top = graphModel(allRoutes().filter(r => settings.graphItem === 'all' || String(r.item.typeId) === settings.graphItem)).top;
  if (top) galaxy.fitPath(pathFor(top.route)); else galaxy.fitHubs();
});
bindSetting('mapLayout', 'mapLayout', { after: () => galaxy.setLayout(settings.mapLayout) });
bindSetting('secColors', 'secColors', { after: () => galaxy.setSecurityColors(settings.secColors) });
setView(settings.view);

bindSetting('flag', 'flag', { after: () => fetchJumps(settings.flag).catch(e => { ui.lastError = e.message; }).finally(render) });
bindSetting('sellMode', 'sellMode', { after: syncMetricAvailability });
bindSetting('metric', 'metric');
bindSetting('taxPct', 'taxPct', { parse: v => Math.min(100, Math.max(0, Number(v) || 0)) });
bindSetting('graphItem', 'graphItem');
bindSetting('showAll', 'showAll');
syncMetricAvailability();

$('refreshBtn').addEventListener('click', refresh);
$('overridesPanel').addEventListener('input', onOverrideInput);
$('overridesPanel').addEventListener('focusout', () => setTimeout(render, 0));
$('ovItem').addEventListener('change', (e) => { ovItem = Number(e.target.value); renderOverrides(); });
$('ovClear').addEventListener('click', () => {
  overrides.prices = {}; overrides.jumps = {};
  saveOverrides();
  document.activeElement?.blur();
  render();
});

const search = $('itemSearch');
let debounce;
search.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(onSearch, 150); });
search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); lookupExact(); }
  if (e.key === 'Escape') { search.value = ''; pickerShow([]); }
});
document.addEventListener('click', (e) => { if (!e.target.closest('.picker')) pickerShow([]); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.selectedHub && !e.target.closest?.('input, select')) selectHub(null); });

mountSectionNav();
bindScanFilters();
bindStart();
bindLoads();
bindRouteTip();
bindTrips();
fetch('data/types.json').then(r => r.json()).then(t => { trip.catalog = t; trip.memo = null; scan.memo = null; initShipList(t); render(); meCtl.reapply(); }).catch(() => { trip.catalog = {}; });
fetch('data/stations.json').then(r => r.json()).then(t => { trip.stations = t; scan.memo = null; render(); }).catch(() => {});
tripPoll();
// Scans started or finished in another tab.
uniScan.onChange(() => tripPoll());
hubScan.onChange(() => pollScan());
drawToggle = mountToggle($('whToggle'), sc);
render();   // show last session's data (marked stale) immediately
refresh();  // then fetch once; further refreshes are manual
pollScan().then(st => { if (st.state === 'idle' && !st.result) startScan(); });
