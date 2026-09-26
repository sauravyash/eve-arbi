import { HUBS, pairKey, extractHubBooks, computeRoutes, summarizeSteps, formatIsk } from './arbitrage.js';
import { GalaxyMap } from './map.js';
import { buildGraph, jumpsFrom, pathBetween, systemInfo } from './galaxy.js';
import { isNpcStation } from './market-merge.js';
import { evaluateLegs, planTrips, tripStops, SHIP_CATEGORY } from './trips.js';
import { createMe } from './me.js';
import { readUrl, writeUrl } from './url-state.js';

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
const LS = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota or disabled */ } },
};

// PLEX trades on the global market (no regional orders), so it can't be hauled.
// Starter set: a high-value item, a mineral, and a T1 hull.
const DEFAULT_ITEMS = [
  { typeId: 40520, name: 'Large Skill Injector' },
  { typeId: 37, name: 'Isogen' },
  { typeId: 587, name: 'Rifter' },
];
const JUMP_TTL = 24 * 3600_000;

const DEFAULTS = {
  items: DEFAULT_ITEMS, flag: 'secure', sellMode: 'instant', metric: 'unit', taxPct: 0, graphItem: 'all', showAll: false,
  view: 'map', mapLayout: '3d', secColors: true,
  scan: { cargo: '', budget: '', minProfit: '5m', from: '', to: '', maxMargin: '100', rank: 'ppj', q: '', hideShips: false },
  trips: { start: 30000142, legs: '3', link: '3', minProfit: '1m', rank: 'perJump', hideShips: false, hideHubs: false, structures: false },
};
const settings = Object.assign(structuredClone(DEFAULTS), LS.get('arbi.settings', {}));
settings.scan = { ...DEFAULTS.scan, ...settings.scan };
settings.trips = { ...DEFAULTS.trips, ...settings.trips };
// Settings mirrored in the query string (url-state.js); the item list and overrides stay local.
const hubIds = ['', ...HUBS.map(h => String(h.id))];
const URL_FIELDS = [
  ['flag', ['secure', 'shortest', 'insecure']], ['sellMode', ['instant', 'relist']], ['metric', ['unit', 'depth']],
  ['taxPct', v => v >= 0 && v <= 100], 'graphItem', 'showAll', ['view', ['map', 'schematic']], ['mapLayout', ['3d', '2d']], 'secColors',
  'scan.cargo', 'scan.budget', 'scan.minProfit', ['scan.from', hubIds], ['scan.to', hubIds], 'scan.maxMargin',
  ['scan.rank', ['ppj', 'profit', 'iskm3', 'margin']], 'scan.q', 'scan.hideShips',
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

const ui = { tripPick: null, selectedHub: null, sort: { key: null, dir: -1 }, refreshing: false, lastError: null, scanPick: null, scanLimit: 50 };

const saveSettings = () => { LS.set('arbi.settings', settings); writeUrl(settings, DEFAULTS, URL_FIELDS); };
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
function jumpsFor(a, b) {
  const k = pairKey(a, b);
  const o = Number(overrides.jumps[k]);
  if (overrides.jumps[k] !== '' && overrides.jumps[k] != null && o > 0) return o;
  const path = jumpCache[settings.flag]?.pairs[k];
  return path ? path.length - 1 : null;
}

// Gate-by-gate system path for a route, in travel direction.
function pathFor(r) {
  const path = jumpCache[settings.flag]?.pairs[pairKey(r.from.id, r.to.id)];
  if (!path) return null;
  return r.from.id < r.to.id ? path : [...path].reverse();
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
  for (const [id, color] of [['ah-best', '#2dd4bf'], ['ah-pos', '#8aa0b8']]) {
    const mk = el('marker', { id, viewBox: '0 0 10 10', refX: '5', refY: '5', markerWidth: '3.2', markerHeight: '3.2', orient: 'auto', markerUnits: 'strokeWidth' }, defs);
    el('path', { d: 'M1,1 L9,5 L1,9 z', fill: color }, mk);
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

function renderFocus(routes) {
  const box = $('focus');
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
    box.innerHTML = `No profitable route ${where} right now. Best is ${esc(best.from.name)} → ${esc(best.to.name)} (${esc(best.item.name)}) at ${formatIsk(best.metric)}/jump.`;
    return;
  }
  const unitLabel = settings.graphItem === 'scan' ? 'profit/jump (whole haul)'
    : settings.metric === 'depth' && settings.sellMode === 'instant' ? 'ISK/jump (depth)' : 'ISK/jump per unit';
  box.innerHTML = `Best ${where}: <strong>${esc(best.from.name)} → ${esc(best.to.name)}</strong> · ${esc(best.item.name)}
    · <span class="big">${formatIsk(best.metric)}</span> ${unitLabel}
    · ${best.jumps} jumps · buy ${formatIsk(best.buy)} / sell ${formatIsk(best.sell)}
    ${best.units != null ? ` · ${best.units.toLocaleString()} units deep (${formatIsk(best.depthProfit)})` : ''}
    ${best.stale ? '<span class="badge stale">STALE</span>' : ''}${best.overridden ? '<span class="badge ov">OVERRIDE</span>' : ''}`;
}

function selectHub(id) {
  ui.selectedHub = id;
  ui.scanPick = null;
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
    li.innerHTML = `<span class="dot ${status === 'cached' ? 'stale' : status}" title="${esc(tip)}"></span>
      <span class="nm" title="${esc(item.name)}">${esc(item.name)}</span><span class="id">${item.typeId}</span>
      <button class="x" type="button" aria-label="Remove ${esc(item.name)}">×</button>`;
    li.querySelector('button').addEventListener('click', () => removeItem(item.typeId));
    return li;
  }));

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
  saveSettings();
  fetchItem(item).finally(() => { saveMarket(); saveSettings(); render(); });
}

function removeItem(typeId) {
  settings.items = settings.items.filter(i => i.typeId !== typeId);
  saveSettings();
  render();
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
      <td class="l">${esc(r.item.name)}</td>
      <td>${r.jumps ?? '<span class="muted">?</span>'}</td>
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
    const live = jumpCache[settings.flag]?.pairs[k] ? jumpCache[settings.flag].pairs[k].length - 1 : null;
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
// Whole-market scan (server walks every order in the hub regions; we rank and filter here)
// ---------------------------------------------------------------------------
const scan = { result: null, status: null, polling: null, rows: [] };

// "500m", "2.5b", "12,000" → number; blank or invalid → null
function parseAmount(v) {
  const m = String(v ?? '').trim().toLowerCase().replace(/[,\s_]/g, '').match(/^(\d*\.?\d+)([kmbt]?)$/);
  if (!m) return null;
  return Number(m[1]) * { '': 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[m[2]];
}

function scanRows() {
  const r = scan.result;
  if (!r) return [];
  const f = settings.scan;
  const taxRate = (Number(settings.taxPct) || 0) / 100;
  const maxVolume = parseAmount(f.cargo) ?? Infinity;
  const maxCost = parseAmount(f.budget) ?? Infinity;
  const minProfit = parseAmount(f.minProfit) ?? 0;
  const maxMargin = f.maxMargin === '' ? Infinity : Number(f.maxMargin);
  const q = f.q.trim().toLowerCase();
  const stale = Date.now() - r.finishedAt > 30 * 60_000; // badge rows only once prices are clearly old
  const rows = [];
  for (const c of r.candidates) {
    if (f.from && String(c.f) !== f.from) continue;
    if (f.to && String(c.d) !== f.to) continue;
    const [name, vol] = r.types[c.t] || [`Type ${c.t}`, 0];
    if (q && !name.toLowerCase().includes(q)) continue;
    if (f.hideShips && trip.catalog?.[c.t]?.[2] === SHIP_CATEGORY) continue;
    const sum = summarizeSteps(c.s, { taxRate, unitVolume: vol, maxVolume, maxCost });
    if (!sum.units || sum.profit < minProfit) continue;
    const margin = (sum.sell * (1 - taxRate) / sum.buy - 1) * 100;
    if (margin > maxMargin) continue;
    const jumps = jumpsFor(c.f, c.d);
    rows.push({
      key: `${c.t}:${c.f}:${c.d}`, typeId: c.t, name, vol, from: hubById[c.f], to: hubById[c.d], jumps, stale,
      ...sum, margin,
      ppj: jumps ? sum.profit / jumps : null,
      iskm3: sum.volume > 0 ? sum.profit / sum.volume : null,
    });
  }
  const key = { ppj: r => r.ppj ?? -Infinity, profit: r => r.profit, iskm3: r => r.iskm3 ?? -Infinity, margin: r => r.margin }[f.rank] || (r => r.ppj ?? -Infinity);
  return rows.sort((a, b) => key(b) - key(a));
}

function scanRowToRoute(row) {
  const taxRate = (Number(settings.taxPct) || 0) / 100;
  const spread = row.sell * (1 - taxRate) - row.buy;
  return {
    item: { typeId: row.typeId, name: row.name }, from: row.from, to: row.to, buy: row.buy, sell: row.sell,
    jumps: row.jumps, spread, iskPerJump: row.jumps ? spread / row.jumps : null,
    units: row.units, depthProfit: row.profit, depthPerJump: row.ppj, metric: row.ppj,
    stale: row.stale, overridden: false, status: row.jumps ? 'ok' : 'unknown', pinned: row.key === ui.scanPick,
  };
}

// For the map: the best-ranked item on each directed hub pair, plus the row the user picked.
function scanGraphRoutes() {
  const best = new Map();
  for (const row of scan.rows) {
    const route = scanRowToRoute(row);
    const k = `${row.from.id}>${row.to.id}`;
    best.set(k, better(route, best.get(k)));
  }
  return [...best.values()];
}

function renderScan() {
  const st = scan.status, r = scan.result;
  const btn = $('scanBtn'), label = $('scanStatus'), bar = $('scanProgress');
  const busy = !!st && (st.state === 'running' || st.state === 'computing');
  btn.disabled = busy;
  btn.textContent = busy ? 'Scanning…' : 'Scan market';
  bar.hidden = !busy;
  if (busy) bar.firstElementChild.style.width = `${st.total ? Math.round(100 * st.done / st.total) : 3}%`;

  const t = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const warnings = (busy ? st.warnings : r?.warnings) || [];
  label.classList.toggle('warn', warnings.length > 0 || st?.state === 'error');
  label.title = warnings.join('\n');
  if (busy) label.textContent = st.state === 'computing' ? 'Comparing order books…' : `Fetching orders: ${st.done}/${st.total || '…'} pages`;
  else if (st?.state === 'error') label.textContent = `Scan failed: ${st.error}`;
  else if (scan.notice) label.textContent = scan.notice;
  else if (!r) label.textContent = 'No scan yet';
  else {
    label.textContent = `${r.candidates.length.toLocaleString()} profitable item routes · scanned ${t(r.finishedAt)}`
      + (r.expiresAt > Date.now() ? ` · ESI refreshes ~${t(r.expiresAt)}` : ' · prices may have moved, rescan')
      + (warnings.length ? ` · ⚠ ${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : '');
  }

  scan.rows = scanRows();
  const body = $('scanBody'), more = $('scanMore');
  if (!r || !scan.rows.length) {
    body.innerHTML = `<tr class="empty"><td colspan="13">${
      r ? 'Nothing matches these filters.'
        : busy ? 'Scanning every order in the five hub regions — about a minute.' : 'Run a market scan to rank every item.'}</td></tr>`;
    more.hidden = true;
    return;
  }

  const shown = scan.rows.slice(0, ui.scanLimit);
  const watched = new Set(settings.items.map(i => i.typeId));
  const n = (v) => (v == null ? '<span class="muted">—</span>' : formatIsk(v));
  const loc = (h) => `<div class="loc"><b>${esc(h.name)}</b><small title="${esc(h.station)}">${esc(h.station)}</small></div>`;
  const rank = settings.scan.rank;
  body.innerHTML = shown.map((row, i) => {
    const w = watched.has(row.typeId);
    return `
    <tr data-i="${i}" class="${i === 0 ? 'top' : ''} ${row.key === ui.scanPick ? 'picked' : ''}">
      <td class="l rank">${i + 1}</td>
      <td class="l item" title="${esc(row.name)}"><button class="star ${w ? 'on' : ''}" type="button" data-star
        aria-label="${w ? 'In watchlist' : `Add ${esc(row.name)} to watchlist`}">${w ? '★' : '☆'}</button>${esc(row.name)}${row.stale ? '<span class="badge stale">OLD</span>' : ''}</td>
      <td class="l">${loc(row.from)}</td>
      <td class="l">${loc(row.to)}</td>
      <td>${row.jumps ?? '<span class="muted">?</span>'}</td>
      <td>${row.units.toLocaleString()}</td>
      <td>${row.vol ? Math.round(row.volume).toLocaleString() : '<span class="muted">?</span>'}</td>
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
    ui.selectedHub = row.from.id;
    ui.scanPick = row.key;
    render();
    if (settings.view === 'map') galaxy.fitPath(pathFor({ from: row.from, to: row.to }));
    $('mapView').closest('.panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }));
}

async function loadScanResult() {
  try { scan.result = (await getJson('/api/scan/result')).data; }
  catch { /* 404: no scan yet */ }
  render();
}

async function pollScan() {
  clearTimeout(scan.polling);
  try { scan.status = (await getJson('/api/scan')).data; }
  catch (e) { scan.status = { state: 'error', error: e.message }; }
  const busy = ['running', 'computing'].includes(scan.status.state);
  if (busy) scan.polling = setTimeout(pollScan, 1500);
  else if (scan.status.result && scan.status.result.finishedAt !== scan.result?.finishedAt) await loadScanResult();
  renderScan();
  return scan.status;
}

async function startScan() {
  scan.notice = null;
  try {
    const res = (await getJson('/api/scan', { method: 'POST' })).data;
    scan.status = res;
    if (!res.started && res.reason === 'fresh') {
      const at = new Date(res.result.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      scan.notice = `Already current — ESI publishes new market data after ${at}`;
      setTimeout(() => { scan.notice = null; renderScan(); }, 6000);
    }
  } catch (e) { scan.status = { state: 'error', error: e.message }; }
  pollScan();
}

function bindScanFilters() {
  const hubOpts = () => [new Option('Any hub', ''), ...HUBS.map(h => new Option(h.name, String(h.id)))];
  $('scFrom').replaceChildren(...hubOpts());
  $('scTo').replaceChildren(...hubOpts());
  const fields = { scCargo: 'cargo', scBudget: 'budget', scMinProfit: 'minProfit', scFrom: 'from', scTo: 'to', scMaxMargin: 'maxMargin', scRank: 'rank', scQuery: 'q' };
  let timer;
  $('scHideShips').checked = !!settings.scan.hideShips;
  $('scHideShips').addEventListener('change', () => { settings.scan.hideShips = $('scHideShips').checked; saveSettings(); render(); });
  for (const [id, key] of Object.entries(fields)) {
    const input = $(id);
    input.value = settings.scan[key];
    const isSelect = input.tagName === 'SELECT';
    input.addEventListener(isSelect ? 'change' : 'input', () => {
      settings.scan[key] = input.value;
      ui.scanLimit = 50;
      clearTimeout(timer);
      timer = setTimeout(() => { saveSettings(); render(); }, isSelect ? 0 : 200);
    });
  }
  $('scanBtn').addEventListener('click', startScan);
  $('scanMore').addEventListener('click', () => { ui.scanLimit += 100; renderScan(); });
}

// ---------------------------------------------------------------------------
// Multi-stop routes: chained hauls from the universe scan (see trips.js)
// ---------------------------------------------------------------------------
const trip = { result: null, status: null, poll: null, graph: null, catalog: null, stations: {}, memo: null, byName: new Map() };
const tripFlag = () => (settings.flag === 'secure' ? 'secure' : 'shortest');

async function tripLoadResult() {
  try { trip.result = (await getJson('/api/uscan/result')).data; trip.memo = null; }
  catch { /* 404: no universe scan yet */ }
  render();
}

async function tripPoll() {
  clearTimeout(trip.poll);
  try { trip.status = (await getJson('/api/uscan')).data; }
  catch (e) { trip.status = { state: 'error', error: e.message }; }
  const busy = ['running', 'computing'].includes(trip.status.state);
  if (busy) trip.poll = setTimeout(tripPoll, 1500);
  else if (trip.status.result && trip.status.result.finishedAt !== trip.result?.finishedAt) await tripLoadResult();
  renderTrips();
}

async function tripStartScan() {
  try { trip.status = (await getJson('/api/uscan', { method: 'POST' })).data; }
  catch (e) { trip.status = { state: 'error', error: e.message }; }
  tripPoll();
}

function tripDistFrom(sys) {
  const d = jumpsFrom(trip.graph, sys, tripFlag());
  return (to) => { const i = trip.graph.indexOf.get(to); return i == null || d[i] < 0 ? null : d[i]; };
}

function tripList() {
  const r = trip.result, t = settings.trips;
  if (!r || !trip.graph || !trip.catalog) return [];
  const key = [r.finishedAt, JSON.stringify(t), settings.taxPct, settings.scan.cargo, settings.scan.budget, tripFlag()].join('|');
  if (trip.memo?.key === key) return trip.memo.trips;
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
  return trips;
}

const sysName = (id) => (trip.graph ? systemInfo(trip.graph, id)?.name : null) || `System ${id}`;
const stationName = (loc, sys) => trip.stations[loc]?.[0] || (isNpcStation(loc) ? `Station ${loc}` : `Structure in ${sysName(sys)}`);

// Full gate path: start → first pickup → … → last drop-off, plus the numbered waypoints.
function tripGeometry(tr) {
  const stops = tripStops(tr);
  const path = [];
  let at = settings.trips.start;
  for (const st of stops) {
    const seg = pathBetween(trip.graph, at, st.systemId, tripFlag()) || [at, st.systemId];
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
  if (!tr) { galaxy.setTrip(null); renderTrips(); return; }
  const geo = tripGeometry(tr);
  galaxy.setTrip({ path: geo.path, stops: geo.marks });
  if (settings.view !== 'map') setView('map');
  galaxy.fitPath(geo.path);
  renderTrips();
  $('mapView').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function tripStopsHtml(tr) {
  const geo = tripGeometry(tr);
  let at = settings.trips.start;
  const rows = [`<li><span class="n start">0</span><span class="where">${esc(sysName(at))}<small>start</small></span></li>`];
  geo.stops.forEach((st, i) => {
    const hop = tripDistFrom(at)(st.systemId);
    at = st.systemId;
    const sell = st.sell ? `Sell <b>${formatIsk(st.sell.units, 1)} ${esc(st.sell.name)}</b> → <span class="up">+${formatIsk(st.sell.profit)}</span>` : '';
    const buy = st.buy ? `Buy <b>${formatIsk(st.buy.units, 1)} ${esc(st.buy.name)}</b> for ${formatIsk(st.buy.cost)}${st.buy.x ? ' (sell point uses ranged buy orders)' : ''}` : '';
    rows.push(`<li><span class="n">${i + 1}</span>
      <span class="where">${esc(stationName(st.locationId, st.systemId))}<small>${esc(sysName(st.systemId))}</small></span>
      <span class="act">${[sell, buy].filter(Boolean).join('<br>')}</span>
      <span class="hop">${hop == null ? '' : hop === 0 ? 'same system' : `${hop} jump${hop === 1 ? '' : 's'} from previous stop`}</span></li>`);
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
  const st = trip.status, r = trip.result;
  const busy = !!st && ['running', 'computing'].includes(st.state);
  const label = $('tripStatus'), bar = $('tripProgress');
  $('tripScanBtn').disabled = busy;
  $('tripScanBtn').textContent = busy ? 'Scanning…' : r ? 'Rescan universe' : 'Scan universe';
  bar.hidden = !busy;
  if (busy) bar.firstElementChild.style.width = `${st.total ? Math.round(100 * st.done / st.total) : 3}%`;
  const startOk = !!trip.graph && trip.graph.indexOf.has(settings.trips.start);
  $('tpStart').classList.toggle('bad', !!trip.graph && !startOk);

  const body = $('tripBody');
  let trips = [];
  if (busy) label.textContent = st.state === 'computing' ? 'Matching stations…' : `Scanning every region: ${st.done}/${st.total || '…'} pages`;
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
      const items = tr.legs.map(l => esc(l.name)).join(' · ');
      return `<tr data-key="${esc(tr.key)}" class="${tr.key === ui.tripPick ? 'picked' : ''}">
        <td class="l rank">${i + 1}</td>
        <td class="l route">${route}<span class="itm">${items}</span></td>
        <td>${tr.legs.length}</td><td>${tr.jumps}</td><td>${formatIsk(tr.peakCost)}</td>
        <td>${formatIsk(tr.profit)}</td><td class="metric">${formatIsk(tr.perJump)}</td></tr>`;
    }).join('') || '<tr class="empty"><td colspan="7">No chained routes with these settings — try more empty jumps between hauls or a lower min profit.</td></tr>';
  }
  const picked = ui.tripPick && trips.find(t => t.key === ui.tripPick);
  if (ui.tripPick && r && trip.graph && !picked) { ui.tripPick = null; galaxy.setTrip(null); }
  $('tripDetail').hidden = !picked;
  $('tripDetail').parentElement.classList.toggle('has-detail', !!picked);
  if (picked) $('tripStops').innerHTML = tripStopsHtml(picked);
}

function bindTrips() {
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
  $('tpStart').addEventListener('change', () => {
    const id = trip.byName.get($('tpStart').value.trim().toLowerCase());
    if (id) { t.start = id; saveSettings(); }
    renderTrips();
  });
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
  if (loc && trip.graph?.indexOf.has(loc.systemId) && loc.systemId !== settings.trips.start) {
    settings.trips.start = loc.systemId; saveSettings(); trip.memo = null;
    if (ui.tripPick) selectTrip(null);
  }
  if (trip.graph) input.value = sysName(settings.trips.start);
  input.disabled = !!loc;
  input.title = loc ? 'Following your character — untick Follow to choose a system by hand' : '';
  renderTrips();
}
// Ship cargo → Cargo m³, wallet → Budget (both feed the market scan and multi-stop routes).
function useFromMe(id, key, value, what) {
  const input = $(id);
  if (value != null) { settings.scan[key] = String(Math.floor(value)); input.value = settings.scan[key]; saveSettings(); trip.memo = null; }
  input.disabled = value != null;
  input.classList.toggle('from-me', value != null);
  input.title = value != null ? `${what} — turn off in the character menu to edit` : '';
  render();
}
const meCtl = createMe({
  el: $('me'), returnTo: '/', systemName: (id) => sysName(id), isk: formatIsk,
  shipInfo: (id) => (trip.catalog?.[id] ? { name: trip.catalog[id][0], cargo: trip.catalog[id][3] ?? null } : null),
  onFollow: followLocation,
  onCargo: (m3) => useFromMe('scCargo', 'cargo', m3, 'From your current ship (base hold)'),
  onBudget: (isk) => useFromMe('scBudget', 'budget', isk, 'Your wallet balance'),
});

function initTripData(u) {
  trip.graph = buildGraph(u);
  for (let i = 0; i < trip.graph.n; i++) trip.byName.set(trip.graph.name[i].toLowerCase(), trip.graph.id[i]);
  $('tpSystems').innerHTML = [...trip.graph.name].sort().map(n => `<option value="${esc(n)}">`).join('');
  if (!trip.graph.indexOf.has(settings.trips.start)) { settings.trips.start = DEFAULTS.trips.start; saveSettings(); } // unknown ID from a link
  $('tpStart').value = sysName(settings.trips.start);
  meCtl.reapply(); // system names are available now
  renderTrips();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function bindSetting(id, key, { parse = v => v, after } = {}) {
  const input = $(id);
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

const galaxy = new GalaxyMap($('mapCanvas'), { tooltip: $('mapTip'), onSelectHub: (id) => selectHub(id) });
galaxy.layout = settings.mapLayout;
galaxy.secColors = settings.secColors;
fetch('data/universe.json')
  .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
  .then(u => { galaxy.setUniverse(u); initTripData(u); $('mapMsg').hidden = true; render(); })
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

bindScanFilters();
bindTrips();
fetch('data/types.json').then(r => r.json()).then(t => { trip.catalog = t; trip.memo = null; render(); meCtl.reapply(); }).catch(() => { trip.catalog = {}; });
fetch('data/stations.json').then(r => r.json()).then(t => { trip.stations = t; renderTrips(); }).catch(() => {});
tripPoll();
render();   // show last session's data (marked stale) immediately
refresh();  // then fetch once; further refreshes are manual
pollScan().then(st => { if (st.state === 'idle' && !st.result) startScan(); });
