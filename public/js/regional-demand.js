// Regional demand page: for one item, the regions that buy it steadily but have little of it listed
// (demand.js), from 90 days of ESI history kept on the server (/api/demand, demand-store.js) and
// EVE Tycoon's live orders. Click a region for its chart and stations.

import { HUBS, DEFAULT_TAX_PCT, formatIsk } from './arbitrage.js';
import { normalizeTycoonOrder, isNpcStation, stationQuotes } from './market-merge.js';
import { buildGraph, jumpsFrom } from './galaxy.js';
import { analyse, rankRegions, regionSupply, dailySeries, lastDay, WINDOW } from './demand.js';
import { KEEP_DAYS } from './demand-store.js';
import { createShortcuts, mountToggle } from './shortcuts.js';
import { createMe } from './me.js';
import { itemPic, copyButton } from './watchlist.js';
import { secColor, secLabel } from './map.js';
import { readUrl, writeUrl } from './url-state.js';
import { mountSectionNav } from './nav.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const LS = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota or disabled */ } },
};
const JITA = HUBS[0];
const PAGE = 25;
const MAX_ROUNDS = 12;   // /api/demand calls per item while the server reports pending regions
const HUB_REGIONS = new Set(HUBS.map(h => h.regionId));

const DEFAULTS = {
  type: 0, region: 0, refHub: JITA.id, home: JITA.id, flag: 'secure', tax: DEFAULT_TAX_PCT, broker: 3,
  rank: 'isk', minDaily: '1', minActive: '', maxDays: '', skipHubs: true, structures: true,
};
const settings = { ...DEFAULTS, ...LS.get('demand.settings', {}) };
const URL_FIELDS = [
  ['type', v => v > 0], ['region', v => v >= 0], ['refHub', HUBS.map(h => h.id)], ['home', v => v > 0], ['flag', ['secure', 'shortest']],
  ['tax', v => v >= 0 && v <= 100], ['broker', v => v >= 0 && v <= 100], ['rank', ['isk', 'shortage', 'score']],
  'minDaily', 'minActive', 'maxDays', 'skipHubs', 'structures',
];
readUrl(settings, DEFAULTS, URL_FIELDS);
writeUrl(settings, DEFAULTS, URL_FIELDS);
const save = () => { LS.set('demand.settings', settings); writeUrl(settings, DEFAULTS, URL_FIELDS); };

// Per item: history {regionId: rows}, Tycoon orders, and how each load went.
const items = {};   // typeId → {history, at, pending, orders, ordersAt, loading, error}
const locNames = new Map();
const ui = { limit: PAGE, ver: 0, memo: null };
let base = null, types = null, stations = null, typeNames = null, meCtl = null;
let drawToggle = () => {};
const sc = createShortcuts({ onChange: () => { drawToggle(); ui.ver++; render(); } });

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isk = (v) => (v == null || !Number.isFinite(v) ? '—' : formatIsk(v));
const num = (v) => (v == null || !Number.isFinite(v) ? '—' : Math.abs(v) < 1000 ? String(Math.round(v * 10) / 10) : formatIsk(v, 1));
const pct = (v, digits = 0) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(digits)}%`);
const typeName = (t) => types?.[t]?.[0] || `Type ${t}`;
const refHub = () => HUBS.find(h => h.id === settings.refHub) || JITA;
const regionName = (id) => base?.regionName.get(id) || `Region ${id}`;
const sysName = (id) => sc.sysName(id);

function parseAmount(v) {
  const m = String(v ?? '').trim().toLowerCase().replace(/[, _]/g, '').match(/^(\d*\.?\d+)([kmb]?)$/);
  if (!m) return null;
  return Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1);
}
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function secSpan(id) {
  const i = base?.indexOf.get(id);
  if (i == null) return '';
  return `<span class="sec" style="--sec:${secColor(base.sec[i])}">${secLabel(base.sec[i])}</span>`;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------
// History: the server fetches what's stale (a few regions at a time on Cloudflare); ask again until
// nothing is pending, or it stops making progress.
async function loadHistory(it, typeId) {
  let last = Infinity;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await fetch(`/api/demand/${typeId}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(res.status === 404 && body.error === 'Unknown item' ? 'ESI has no market for this item' : body.error || `HTTP ${res.status}`);
    it.history = body.regions || {};
    it.at = body.at || {};
    it.pending = body.pending || 0;
    ui.ver++; render();
    if (!it.pending || it.pending >= last) return;
    last = it.pending;
  }
}

async function loadOrders(it, typeId) {
  const res = await fetch(`/api/tycoon/v1/market/orders/${typeId}`);
  if (!res.ok) throw new Error(`EVE Tycoon: HTTP ${res.status}`);
  const body = await res.json();
  for (const [id, n] of Object.entries(body.stationNames || {})) locNames.set(Number(id), n);
  for (const [id, n] of Object.entries(body.structureNames || {})) locNames.set(Number(id), n);
  it.orders = (body.orders || []).map(normalizeTycoonOrder);
  it.ordersAt = Date.parse(res.headers.get('x-fetched-at')) || Date.now();
}

async function refresh() {
  const typeId = settings.type;
  if (!typeId) { render(); return; }
  const it = items[typeId] ||= {};
  if (it.loading) return;
  it.loading = true; it.error = null;
  const btn = $('refreshBtn');
  btn.classList.add('loading'); btn.disabled = true;
  render();
  const errs = (await Promise.allSettled([loadOrders(it, typeId), loadHistory(it, typeId)]))
    .filter(r => r.status === 'rejected').map(r => r.reason.message);
  it.error = errs.join(' · ') || null;
  it.loading = false;
  btn.classList.remove('loading'); btn.disabled = false;
  ui.ver++;
  render();
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------
function compute() {
  const typeId = settings.type, it = items[typeId];
  if (!it?.history || !it.orders) return null;
  const g = base && sc.travelGraph();
  const key = [ui.ver, typeId, settings.refHub, settings.home, settings.flag, settings.tax, settings.broker, settings.rank,
    settings.minDaily, settings.minActive, settings.maxDays, settings.skipHubs, settings.structures, !!g, sc.key()].join('|');
  if (ui.memo?.key === key) return ui.memo.value;

  const hub = refHub();
  const asks = it.orders.filter(o => !o.isBuyOrder && o.locationId === hub.stationId);
  const cost = asks.length ? Math.min(...asks.map(o => o.price)) : null;
  const supply = regionSupply(it.orders, { structures: settings.structures, isNpc: isNpcStation });
  const all = analyse({ history: it.history, supply, cost,
    taxRate: (Number(settings.tax) || 0) / 100, brokerRate: (Number(settings.broker) || 0) / 100 });

  // Jumps from home: to the nearest system in each region.
  const d = g && g.indexOf.has(settings.home) ? jumpsFrom(g, settings.home, settings.flag) : null;
  if (d) {
    const nearest = new Map();
    for (let i = 0; i < base.n; i++) {
      const j = d[i];
      if (j < 0) continue;
      const r = base.regionId[i];
      if (!nearest.has(r) || j < nearest.get(r)) nearest.set(r, j);
    }
    for (const r of all) r.jumps = nearest.get(r.regionId) ?? null;
  }
  const minActive = (Number(settings.minActive) || 0) / 100;
  const maxDays = parseAmount(settings.maxDays) ?? Infinity;
  const rows = rankRegions(all, {
    rank: settings.rank, minDaily: parseAmount(settings.minDaily) ?? 0, minActive, maxDays,
    skip: settings.skipHubs ? HUB_REGIONS : new Set(),
  });
  const traded = all.filter(r => r.daily > 0).length;
  const value = { rows, all, cost, hub, d, g, traded, end: lastDay(it.history) };
  ui.memo = { key, value };
  return value;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderStatus() {
  const el = $('status'), it = items[settings.type];
  let msg = 'Pick an item';
  if (it?.loading) msg = it.history ? `Fetching history · ${it.pending} region${it.pending === 1 ? '' : 's'} to go…` : 'Loading…';
  else if (it?.history) {
    const ats = Object.values(it.at || {});
    msg = `History ${ats.length ? ago(Math.min(...ats)) : '—'} · orders ${it.ordersAt ? ago(it.ordersAt) : '—'}`;
    if (it.pending) msg += ` · ${it.pending} region${it.pending === 1 ? '' : 's'} not fetched yet`;
  }
  if (it?.error) msg += ` · ${it.error}`;
  el.textContent = msg;
  el.classList.toggle('warn', !!(it?.error || it?.pending));
}

function renderKpis(v) {
  const el = $('kpis');
  if (!v) { el.innerHTML = ''; return; }
  const kpi = (label, value, sub) => `<div class="kpi"><span>${label}</span><b>${value}</b><small>${sub}</small></div>`;
  const top = v.rows[0];
  const t = settings.type;
  el.innerHTML = `<div class="kpi rd-what">${itemPic(t, typeName(t), 32)}<b>${esc(typeName(t))}</b>${copyButton(typeName(t))}</div>` + [
    kpi(`Cost at ${esc(v.hub.name)}`, isk(v.cost), v.cost == null ? 'No sell orders at the hub station' : 'lowest sell order'),
    kpi('Regions trading it', String(v.traded), `of ${Object.keys(items[t].history).length}, last ${WINDOW} days`),
    kpi('Top region', top ? esc(regionName(top.regionId)) : '—',
      top ? `${num(top.daily)}/day · ${Number.isFinite(top.daysOfStock) ? `${num(top.daysOfStock)} days of stock` : 'none listed'}` : 'Nothing passes your filters'),
    kpi('Top ISK/day', top ? isk(top.iskDay) : '—', top?.margin != null ? `${isk(top.margin)} per unit after fees` : ''),
  ].join('');
}

function renderRanking(v) {
  const body = $('rankBody');
  const it = items[settings.type];
  $('rankCount').textContent = v ? `· ${v.rows.length} region${v.rows.length === 1 ? '' : 's'}` : '';
  if (!v) {
    const msg = !settings.type ? 'Pick an item to see where it sells steadily and where stock is thin.'
      : it?.error && !it.loading ? `Couldn't load this item: ${esc(it.error)}` : 'Loading…';
    body.innerHTML = `<tr class="empty"><td colspan="11" class="l muted">${msg}</td></tr>`;
    $('moreBtn').hidden = true;
    return;
  }
  if (!v.rows.length) {
    body.innerHTML = `<tr class="empty"><td colspan="11" class="l muted">${v.traded ? 'No region passes your filters. Try a lower minimum or untick Skip hub regions.' : `Nothing traded in the last ${WINDOW} days.`}</td></tr>`;
    $('moreBtn').hidden = true;
    return;
  }
  body.innerHTML = v.rows.slice(0, ui.limit).map((r, i) => `<tr data-r="${r.regionId}" class="${settings.region === r.regionId ? 'open' : ''}">
      <td class="l">${i + 1}</td>
      <td class="l region"><b>${esc(regionName(r.regionId))}</b>${HUB_REGIONS.has(r.regionId) ? '<span class="badge ov">hub</span>' : ''}</td>
      <td>${r.jumps ?? '<span class="muted" title="Not reachable with this route setting">?</span>'}</td>
      <td>${num(r.daily)}</td>
      <td>${pct(r.active)}<small>swing ${r.swing == null ? '—' : r.swing.toFixed(2)}</small></td>
      <td>${num(r.stock)}${!r.stock && r.active >= 0.5
        ? '<small class="warn-num" title="It trades most days but no sell orders are visible: the market is probably in player structures that don\'t publish their orders (common in null-sec), not empty">hidden market?</small>'
        : `<small>${r.sellOrders} order${r.sellOrders === 1 ? '' : 's'}</small>`}</td>
      <td class="${r.daysOfStock < 3 ? 'up' : ''}">${Number.isFinite(r.daysOfStock) ? num(r.daysOfStock) : '∞'}</td>
      <td>${isk(r.price)}${r.lowest != null ? `<small>ask ${isk(r.lowest)}</small>` : ''}</td>
      <td class="${r.markup > 0 ? 'up' : r.markup < 0 ? 'down' : ''}">${r.markup == null ? '—' : `${r.markup > 0 ? '+' : ''}${pct(r.markup)}`}</td>
      <td class="metric">${r.iskDay ? isk(r.iskDay) : '—'}</td>
      <td>${r.score ? isk(r.score) : '—'}</td>
    </tr>`).join('');
  $('moreBtn').hidden = v.rows.length <= ui.limit;
}

function renderChart(rows, end) {
  const svg = $('rdChart');
  const days = dailySeries(rows, end, KEEP_DAYS);
  const W = 900, H = 240, pad = 6, n = days.length, bw = W / n;
  const maxV = Math.max(1, ...days.map(d => d.volume));
  const prices = days.map(d => d.average).filter(p => p != null);
  const lo = Math.min(...prices), hi = Math.max(...prices);
  const y = (p) => (hi > lo ? pad + (1 - (p - lo) / (hi - lo)) * (H * 0.55) : H * 0.3);
  const windowX = (n - WINDOW) * bw;
  const bars = days.map((d, i) => {
    const h = d.volume / maxV * (H * 0.4);
    return `<rect class="rd-vol" x="${(i * bw + 1).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}"><title>${d.date}: ${num(d.volume)} units${d.average != null ? ` at ${isk(d.average)}` : ''}</title></rect>`;
  }).join('');
  const pts = days.map((d, i) => (d.average != null ? `${(i * bw + bw / 2).toFixed(1)},${y(d.average).toFixed(1)}` : null)).filter(Boolean);
  svg.innerHTML = `<rect class="rd-window" x="${windowX}" y="0" width="${W - windowX}" height="${H}"><title>The ${WINDOW} days the ranking uses</title></rect>${bars}`
    + (pts.length > 1 ? `<polyline class="rd-price" points="${pts.join(' ')}"/>` : '');
  svg.nextElementSibling?.classList?.contains('rd-chart-axis') || svg.insertAdjacentHTML('afterend', '<div class="rd-chart-axis"></div>');
  svg.nextElementSibling.innerHTML = `<span>${days[0].date}</span><span>price ${isk(lo)} – ${isk(hi)} · peak ${num(maxV)}/day</span><span>${end}</span>`;
}

function renderDetail(v) {
  const panel = $('detail');
  const r = v?.all.find(x => x.regionId === settings.region);
  panel.hidden = !r;
  if (!r) return;
  const it = items[settings.type];
  $('detailTitle').innerHTML = `${esc(regionName(r.regionId))} <span class="count">· ${esc(typeName(settings.type))}</span>`;
  const kpi = (label, value, sub) => `<div class="kpi"><span>${label}</span><b>${value}</b><small>${sub}</small></div>`;
  $('detailKpis').innerHTML = [
    kpi('Daily volume', num(r.daily), `median · mean ${num(r.mean)}`),
    kpi('Active days', pct(r.active), `swing ${r.swing == null ? '—' : r.swing.toFixed(2)}`),
    kpi('Stock', num(r.stock), Number.isFinite(r.daysOfStock) ? `${num(r.daysOfStock)} days at this rate` : 'no trades'),
    kpi('Price', isk(r.price), r.markup == null ? '' : `${r.markup > 0 ? '+' : ''}${pct(r.markup, 1)} vs ${esc(v.hub.name)}`),
    kpi('ISK/day', isk(r.iskDay), r.margin != null ? `${isk(r.margin)} per unit after fees` : ''),
  ].join('');
  renderChart(it.history[r.regionId] || [], v.end);

  const quotes = [...stationQuotes(it.orders).values()]
    .filter(q => q.regionId === r.regionId && (q.asks.length || q.bids.length) && (settings.structures || isNpcStation(q.locationId)))
    .sort((a, b) => b.askVolume - a.askVolume || (b.bestBid ?? 0) - (a.bestBid ?? 0));
  const jumps = (sys) => { const i = v.g?.indexOf.get(sys); return v.d && i != null && v.d[i] >= 0 ? v.d[i] : null; };
  $('stationsBody').innerHTML = quotes.map(q => {
    const npc = isNpcStation(q.locationId);
    const name = (npc ? stations?.[q.locationId]?.[0] : null) || locNames.get(q.locationId) || (npc ? `Station ${q.locationId}` : `Structure in ${sysName(q.systemId)}`);
    const j = jumps(q.systemId);
    return `<tr class="static">
      <td class="l"><span class="place"><b title="${esc(name)}">${esc(name)}</b>${npc ? '' : '<span class="badge ov">structure</span>'}<small>${esc(sysName(q.systemId))} ${secSpan(q.systemId)}</small></span></td>
      <td>${j ?? '<span class="muted">?</span>'}</td>
      <td>${q.asks.length || '—'}</td>
      <td>${q.askVolume ? num(q.askVolume) : '—'}</td>
      <td>${isk(q.bestAsk)}</td>
      <td>${isk(q.bestBid)}</td>
    </tr>`;
  }).join('') || '<tr class="empty"><td colspan="6" class="l muted">No orders for this item in the region right now: nobody is selling it.</td></tr>';
}

function render() {
  const v = compute();
  renderStatus();
  renderKpis(v);
  renderRanking(v);
  renderDetail(v);
  const home = $('home');
  if (base && document.activeElement !== home) home.value = sysName(settings.home);
  const item = $('item');
  if (types && settings.type && document.activeElement !== item) item.value = typeName(settings.type);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function bindSetting(id, key, { prop = 'value', parse = v => v, event = 'change' } = {}) {
  const el = $(id);
  el[prop] = settings[key];
  el.addEventListener(event, () => { settings[key] = parse(el[prop]); save(); ui.limit = PAGE; render(); });
}

function pickItem(typeId) {
  if (!typeId || typeId === settings.type) return;
  settings.type = typeId; settings.region = 0; ui.limit = PAGE;
  save();
  render();
  refresh();
}

// The datalist only holds names matching what's typed, so it stays small with ~20k items.
function suggest() {
  if (!typeNames) return;
  const q = $('item').value.trim().toLowerCase();
  if (q.length < 2) { $('itemList').innerHTML = ''; return; }
  const starts = [], has = [];
  for (const [name, , label] of typeNames) {
    if (name.startsWith(q)) starts.push(label); else if (name.includes(q)) has.push(label);
    if (starts.length >= 40) break;
  }
  $('itemList').innerHTML = [...starts, ...has].slice(0, 40).map(n => `<option value="${esc(n)}">`).join('');
}

function followLocation(loc) {
  const input = $('home');
  if (loc?.systemId && loc.systemId !== settings.home) { settings.home = loc.systemId; save(); }
  input.disabled = !!loc;
  input.title = loc ? 'Following your character — untick Follow in the character menu to choose a system by hand' : '';
  render();
}

function init() {
  mountSectionNav();
  meCtl = createMe({
    el: $('me'), returnTo: '/regional-demand.html', systemName: sysName, isk: formatIsk, onFollow: followLocation,
    shipInfo: (id) => (types?.[id] ? { name: types[id][0] } : null),
  });
  drawToggle = mountToggle($('whToggle'), sc);

  $('refHub').innerHTML = HUBS.map(h => `<option value="${h.id}">${esc(h.name)}</option>`).join('');
  bindSetting('refHub', 'refHub', { parse: Number });
  bindSetting('flag', 'flag');
  bindSetting('tax', 'tax', { parse: Number, event: 'input' });
  bindSetting('broker', 'broker', { parse: Number, event: 'input' });
  bindSetting('rank', 'rank');
  bindSetting('minDaily', 'minDaily', { event: 'input' });
  bindSetting('minActive', 'minActive', { event: 'input' });
  bindSetting('maxDays', 'maxDays', { event: 'input' });
  bindSetting('skipHubs', 'skipHubs', { prop: 'checked' });
  bindSetting('structures', 'structures', { prop: 'checked' });

  $('home').addEventListener('change', async () => {
    const input = $('home');
    const id = await sc.systemByName(input.value).catch(() => null);
    input.classList.toggle('bad', !id);
    if (!id) return;
    settings.home = id; save(); render();
  });
  const item = $('item');
  item.addEventListener('input', () => {
    suggest();
    const t = typeNames?.find(x => x[0] === item.value.trim().toLowerCase())?.[1];
    if (t) { item.classList.remove('bad'); pickItem(t); }
  });
  item.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const t = typeNames?.find(x => x[0] === item.value.trim().toLowerCase())?.[1];
    item.classList.toggle('bad', !t);
    if (t) pickItem(t);
  });
  $('rankBody').addEventListener('click', (e) => {
    if (e.target.closest('a, button')) return;
    const tr = e.target.closest('tr[data-r]');
    if (!tr) return;
    const r = Number(tr.dataset.r);
    settings.region = settings.region === r ? 0 : r;
    save(); render();
    if (settings.region) $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('closeDetail').addEventListener('click', () => { settings.region = 0; save(); render(); });
  $('moreBtn').addEventListener('click', () => { ui.limit += PAGE; render(); });
  $('refreshBtn').addEventListener('click', () => refresh());

  fetch('data/universe.json').then(r => r.json()).then(u => {
    base = buildGraph(u);
    sc.setBase(base);
    $('systemList').innerHTML = [...base.name].sort().map(n => `<option value="${esc(n)}">`).join('');
    ui.memo = null; render(); meCtl.reapply();
  }).catch(() => { $('home').placeholder = 'Star map unavailable'; });
  fetch('data/stations.json').then(r => (r.ok ? r.json() : {})).then(s => { stations = s; ui.memo = null; render(); }).catch(() => {});
  fetch('data/types.json').then(r => r.json()).then(t => {
    types = t;
    typeNames = Object.entries(t).map(([id, v]) => [v[0].toLowerCase(), Number(id), v[0]]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    render(); meCtl.reapply();
  }).catch(() => {});
  render();
  refresh();
}

init();
