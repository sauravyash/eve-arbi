// Regional demand page: for one item, the regions that buy it steadily but have little of it listed
// (demand.js), from 90 days of ESI history kept on the server (/api/demand, demand-store.js) and
// EVE Tycoon's live orders. Click a region for its chart and stations. Below that, the faction
// warfare systems being fought over near home (fw.js): the item's market around each, and which FW
// staples the warzones are short of.

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
import { hotspots, nearestOf, localMarket, stapleRow, factionName, FW_STAPLES, STAPLE_RANKS } from './fw.js';

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
  fwMax: '20', fwRadius: 3, fwShow: 8, fwSort: 'heat', fwRank: 'isk',
};
const settings = { ...DEFAULTS, ...LS.get('demand.settings', {}) };
const URL_FIELDS = [
  ['type', v => v > 0], ['region', v => v >= 0], ['refHub', HUBS.map(h => h.id)], ['home', v => v > 0], ['flag', ['secure', 'shortest']],
  ['tax', v => v >= 0 && v <= 100], ['broker', v => v >= 0 && v <= 100], ['rank', ['isk', 'shortage', 'score']],
  'minDaily', 'minActive', 'maxDays', 'skipHubs', 'structures',
  'fwMax', ['fwRadius', v => v >= 0 && v <= 15], ['fwShow', [8, 15, 30]], ['fwSort', ['heat', 'jumps']], ['fwRank', ['isk', 'shortage', 'margin']],
];
readUrl(settings, DEFAULTS, URL_FIELDS);
writeUrl(settings, DEFAULTS, URL_FIELDS);
const save = () => { LS.set('demand.settings', settings); writeUrl(settings, DEFAULTS, URL_FIELDS); };

// Per item: history {regionId: rows}, Tycoon orders, and how each load went.
const items = {};   // typeId → {history, at, pending, orders, ordersAt, loading, error}
const locNames = new Map();
const ui = { limit: PAGE, ver: 0, memo: null, fwMemo: null };
// Faction warfare: ESI's warzone systems and last-hour kills; the staples scan's items (history for
// the warzone regions only, so kept apart from `items`).
const fw = { systems: null, kills: null, at: 0, error: null };
const staples = {};   // typeId → {history, at, pending, orders, ordersAt, error}
const scan = { running: false, done: 0, regions: null };
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
async function loadHistory(it, typeId, regions) {
  let last = Infinity;
  const q = regions?.length ? `?regions=${regions.join(',')}` : '';
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await fetch(`/api/demand/${typeId}${q}`);
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

async function loadFw() {
  try {
    const [systems, kills] = await Promise.all(['fw/systems/', 'universe/system_kills/'].map(async (p) => {
      const r = await fetch(`/api/esi/${p}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }));
    Object.assign(fw, { systems, kills, at: Date.now(), error: null });
  } catch (e) { fw.error = `warzones unavailable (${e.message})`; }
  ui.ver++; render();
}

// History and orders for every FW staple, three at a time, history for the hotspots' regions only.
async function scanStaples() {
  const v = computeFw(compute());
  if (scan.running || !v?.spots.length) return;
  const regions = [...v.regions];
  Object.assign(scan, { running: true, done: 0, regions: new Set(regions) });
  render();
  let next = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (next < FW_STAPLES.length) {
      const { typeId } = FW_STAPLES[next++];
      const it = staples[typeId] ||= {};
      const errs = (await Promise.allSettled([loadOrders(it, typeId), loadHistory(it, typeId, regions)]))
        .filter(r => r.status === 'rejected').map(r => r.reason.message);
      it.error = errs.join(' · ') || null;
      scan.done++; ui.ver++; render();
    }
  }));
  scan.running = false;
  ui.ver++; render();
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------
// The buy hub station's lowest sell order.
function hubCost(orders, hub) {
  let cost = null;
  for (const o of orders) if (!o.isBuyOrder && o.locationId === hub.stationId && (cost == null || o.price < cost)) cost = o.price;
  return cost;
}

function compute() {
  const typeId = settings.type, it = items[typeId];
  if (!it?.history || !it.orders) return null;
  const g = base && sc.travelGraph();
  const key = [ui.ver, typeId, settings.refHub, settings.home, settings.flag, settings.tax, settings.broker, settings.rank,
    settings.minDaily, settings.minActive, settings.maxDays, settings.skipHubs, settings.structures, !!g, sc.key()].join('|');
  if (ui.memo?.key === key) return ui.memo.value;

  const hub = refHub();
  const cost = hubCost(it.orders, hub);
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

// Hotspots near home with the selected item's market around each, and the scanned staples ranked.
function computeFw(v) {
  const g = base && sc.travelGraph();
  if (!fw.systems || !g) return null;
  const key = [ui.ver, fw.at, v ? ui.memo?.key : '', settings.home, settings.flag, settings.fwMax, settings.fwRadius, settings.fwShow,
    settings.fwSort, settings.fwRank, settings.refHub, settings.tax, settings.broker, settings.structures, sc.key()].join('|');
  if (ui.fwMemo?.key === key) return ui.fwMemo.value;

  // The warzones are low-sec: a high-sec only route setting still flies low-sec here.
  const d = g.indexOf.has(settings.home) ? jumpsFrom(g, settings.home, settings.flag === 'secure' ? 'nonull' : settings.flag) : null;
  const at = (dist) => (sys) => { const i = g.indexOf.get(sys); return dist && i != null && dist[i] >= 0 ? dist[i] : null; };
  const fromHome = at(d);
  const max = parseAmount(settings.fwMax) ?? Infinity;
  const radius = Math.max(0, Math.min(15, Math.round(Number(settings.fwRadius) || 0)));
  const taxRate = (Number(settings.tax) || 0) / 100, brokerRate = (Number(settings.broker) || 0) / 100;
  const opts = { structures: settings.structures, isNpc: isNpcStation };

  const all = hotspots(fw.systems, fw.kills)
    .map(h => ({ ...h, jumps: fromHome(h.systemId), regionId: base.regionId[base.indexOf.get(h.systemId)] }))
    .filter(h => max === Infinity || (h.jumps != null && h.jumps <= max));
  if (settings.fwSort === 'jumps') all.sort((a, b) => (a.jumps ?? 1e9) - (b.jumps ?? 1e9) || b.heat - a.heat);
  const spots = all.slice(0, Number(settings.fwShow) || 8);
  const dists = spots.map(h => jumpsFrom(g, h.systemId, 'shortest'));

  // The selected item around each hotspot.
  const it = items[settings.type];
  if (v && it?.orders) {
    spots.forEach((h, k) => {
      const region = v.all.find(r => r.regionId === h.regionId);
      const local = localMarket(it.orders, at(dists[k]), radius, opts);
      const sellAt = local.ask ?? region?.price ?? null;
      h.item = { region, local, margin: sellAt != null && v.cost != null ? sellAt * (1 - taxRate - brokerRate) - v.cost : null };
    });
  }

  // Staples: the warzone regions' demand against what's listed near any hotspot.
  const regions = new Set(spots.map(h => h.regionId));
  const near = at(nearestOf(dists, g.n));
  const hub = refHub();
  const rows = [];
  for (const { typeId, group } of FW_STAPLES) {
    const s = staples[typeId];
    if (!s?.history || !s.orders) continue;
    const cost = hubCost(s.orders, hub);
    const regionRows = analyse({ history: s.history, supply: regionSupply(s.orders, opts), cost, taxRate, brokerRate });
    rows.push({ typeId, group, ...stapleRow({ rows: regionRows, regions, local: localMarket(s.orders, near, radius, opts), cost, taxRate, brokerRate }) });
  }
  rows.sort(STAPLE_RANKS[settings.fwRank] || STAPLE_RANKS.isk);
  const stale = !!scan.regions && [...regions].some(r => !scan.regions.has(r));
  const value = { spots, total: all.length, regions, radius, rows, stale };
  ui.fwMemo = { key, value };
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

const away = (j) => `<small>${j} jump${j === 1 ? '' : 's'} away</small>`;

function renderFw(v) {
  const f = computeFw(v);
  const status = $('fwStatus');
  status.textContent = [
    fw.error || (fw.at ? `warzones ${ago(fw.at)}` : 'loading warzones…'),
    scan.running ? `scanning staples ${scan.done}/${FW_STAPLES.length}…` : '',
  ].filter(Boolean).join(' · ');
  status.classList.toggle('warn', !!fw.error);
  $('fwScanBtn').disabled = scan.running || !f?.spots.length;
  $('fwScanBtn').classList.toggle('loading', scan.running);
  $('fwCount').textContent = f ? `· ${f.spots.length} of ${f.total}` : '';

  const body = $('fwBody');
  if (!f) {
    body.innerHTML = `<tr class="empty"><td colspan="12" class="l muted">${fw.error ? esc(fw.error) : !base ? 'Loading star map…' : 'Loading warzones…'}</td></tr>`;
  } else if (!f.spots.length) {
    body.innerHTML = '<tr class="empty"><td colspan="12" class="l muted">No warzone system within your max jumps. Raise it or clear it.</td></tr>';
  } else {
    const hasItem = !!settings.type;
    body.innerHTML = f.spots.map((h, i) => {
      const name = sysName(h.systemId), m = h.item, kills = h.ships + h.pods;
      return `<tr data-r="${h.regionId}" class="${hasItem && settings.region === h.regionId ? 'open' : ''}">
        <td class="l">${i + 1}</td>
        <td class="l"><span class="place"><b>${esc(name)}</b> ${secSpan(h.systemId)}${copyButton(name)}<small>${esc(regionName(h.regionId))}</small></span></td>
        <td class="l fw-fight"><b>${esc(factionName(h.occupier, true))}</b><small>${h.occupier !== h.owner ? `taken from ${esc(factionName(h.owner, true))}` : 'holding'}</small></td>
        <td class="${h.status === 'vulnerable' ? 'up' : ''}">${pct(h.contest)}<small>${esc(h.status || '—')}</small></td>
        <td>${kills || '—'}${kills ? `<small>${h.ships} ship${h.ships === 1 ? '' : 's'} · ${h.pods} pod${h.pods === 1 ? '' : 's'}</small>` : ''}</td>
        <td class="metric">${num(h.heat)}</td>
        <td>${h.jumps ?? '<span class="muted" title="Not reachable with this route setting">?</span>'}</td>
        ${!m ? `<td colspan="5" class="l muted">${!hasItem ? (i === 0 ? 'Pick an item above to see its market here' : '') : i === 0 ? 'Loading…' : ''}</td>` : `
        <td>${m.region ? num(m.region.daily) : '—'}</td>
        <td class="${!m.local.units ? 'up' : ''}">${num(m.local.units)}<small>${m.local.orders} order${m.local.orders === 1 ? '' : 's'}</small></td>
        <td>${isk(m.local.ask)}${m.local.ask != null ? away(m.local.askJumps) : ''}</td>
        <td>${isk(m.local.bid)}${m.local.bid != null ? away(m.local.bidJumps) : ''}</td>
        <td class="metric ${m.margin > 0 ? 'up' : m.margin < 0 ? 'down' : ''}">${isk(m.margin)}</td>`}
      </tr>`;
    }).join('');
  }

  const sbody = $('fwStapleBody');
  $('fwStapleCount').textContent = f?.rows.length
    ? `· ${f.rows.length} items, stock within ${f.radius} jump${f.radius === 1 ? '' : 's'}${f.stale ? ' · the hotspots changed since the scan: scan again' : ''}` : '';
  if (!f?.rows.length) {
    sbody.innerHTML = `<tr class="empty"><td colspan="9" class="l muted">${scan.running ? 'Scanning…'
      : `Scan ${FW_STAPLES.length} FW staples (navy frigates, small ammo, small-gang modules, paste and cap boosters) against the hotspots above.`}</td></tr>`;
    return;
  }
  sbody.innerHTML = f.rows.map(r => {
    const name = typeName(r.typeId), err = staples[r.typeId]?.error;
    const flip = r.flip != null && r.flip > 0;
    return `<tr data-t="${r.typeId}">
      <td class="l"><span class="fw-item">${itemPic(r.typeId, name, 32)}<span><b>${esc(name)}</b>${copyButton(name)}<small>${esc(r.group)}${err ? ` · ${esc(err)}` : ''}</small></span></span></td>
      <td>${num(r.daily)}</td>
      <td class="${!r.stock && r.daily ? 'up' : ''}">${num(r.stock)}</td>
      <td class="${r.daysOfStock < 3 ? 'up' : ''}">${Number.isFinite(r.daysOfStock) ? num(r.daysOfStock) : '∞'}</td>
      <td>${isk(r.cost)}</td>
      <td>${isk(r.ask ?? r.price)}${r.ask == null && r.price != null ? '<small>no local ask</small>' : r.markup != null ? `<small>${r.markup > 0 ? '+' : ''}${pct(r.markup)}</small>` : ''}</td>
      <td class="${r.margin > 0 ? 'up' : r.margin < 0 ? 'down' : ''}">${isk(r.margin)}</td>
      <td class="metric">${r.iskDay ? isk(r.iskDay) : '—'}</td>
      <td class="${flip ? 'up' : ''}">${isk(r.bid)}${flip ? `<small title="Selling straight into the bid beats the hub cost after sales tax">flip +${isk(r.flip)}</small>` : ''}</td>
    </tr>`;
  }).join('');
}

function render() {
  const v = compute();
  renderStatus();
  renderKpis(v);
  renderRanking(v);
  renderDetail(v);
  renderFw(v);
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
  bindSetting('fwMax', 'fwMax', { event: 'input' });
  bindSetting('fwRadius', 'fwRadius', { parse: Number, event: 'input' });
  bindSetting('fwShow', 'fwShow', { parse: Number });
  bindSetting('fwSort', 'fwSort');
  bindSetting('fwRank', 'fwRank');

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
  $('fwBody').addEventListener('click', (e) => {
    if (e.target.closest('a, button')) return;
    const tr = e.target.closest('tr[data-r]');
    if (!tr || !settings.type) return;
    settings.region = Number(tr.dataset.r);
    save(); render();
    $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('fwStapleBody').addEventListener('click', (e) => {
    if (e.target.closest('a, button')) return;
    const tr = e.target.closest('tr[data-t]');
    if (!tr) return;
    pickItem(Number(tr.dataset.t));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('fwScanBtn').addEventListener('click', () => scanStaples());
  $('closeDetail').addEventListener('click', () => { settings.region = 0; save(); render(); });
  $('moreBtn').addEventListener('click', () => { ui.limit += PAGE; render(); });
  $('refreshBtn').addEventListener('click', () => { refresh(); loadFw(); });

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
  loadFw();
}

init();
