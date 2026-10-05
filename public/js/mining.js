// Mining page: where to sell a load of ore, gas or ice (mining-value.js), with jumps that count
// wormhole shortcuts (shortcuts.js), managed on the Routes page.
//
// Prices: EVE Tycoon's orders for each item in every region, player structures included (one call
// per item, through the caching proxy). Only buy orders are kept.

import { HUBS, DEFAULT_TAX_PCT, formatIsk } from './arbitrage.js';
import { normalizeTycoonOrder, isNpcStation } from './market-merge.js';
import { buildGraph, jumpsFrom, pathBetween, systemInfo } from './galaxy.js';
import { buildRangeContext } from './ranges.js';
import { priceLoad, parsePaste } from './mining-value.js';
import { shortcutsOn, isJSpace } from './wormholes.js';
import { createShortcuts, mountToggle } from './shortcuts.js';
import { createMe } from './me.js';
import { createAssets } from './mining-assets.js';
import { itemPic, removeButton, copyButton } from './watchlist.js';
import { secColor, secLabel } from './map.js';
import { readUrl, writeUrl } from './url-state.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const LS = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota or disabled */ } },
};
const JITA = HUBS[0];
const PAGE = 25;
const CONCURRENCY = 3;
const KIND_LABEL = { ore: 'Ore', moon: 'Moon ore', ice: 'Ice', gas: 'Gas', mineral: 'Mineral' };

const DEFAULTS = { home: JITA.id, flag: 'secure', tax: DEFAULT_TAX_PCT, taxV: 1, maxJumps: '', minShare: '', structures: true, rank: 'isk', kind: '' };
const { wh: _oldWh, ...stored } = LS.get('mining.settings', {});   // wh moved to shortcuts.js
// Sales tax used to default to 0%; a saved 0 from then becomes the in-game base rate, once (taxV).
if (!stored.taxV && !Number(stored.tax)) delete stored.tax;
const settings = { ...DEFAULTS, ...stored };
const URL_FIELDS = [
  ['home', v => v > 0], ['flag', ['secure', 'nonull', 'shortest']], ['tax', v => v >= 0 && v <= 100], 'maxJumps', 'minShare', 'structures',
  ['rank', ['isk', 'perJump', 'near']],
];
readUrl(settings, DEFAULTS, URL_FIELDS);
writeUrl(settings, DEFAULTS, URL_FIELDS);
const save = () => { LS.set('mining.settings', settings); writeUrl(settings, DEFAULTS, URL_FIELDS); };

const load = { items: LS.get('mining.items', []).filter(it => it?.typeId > 0) };   // [{typeId, qty}]
const saveLoad = () => LS.set('mining.items', load.items);
const books = {};                                           // typeId → {orders, at, error, loading}
const locNames = new Map();                                 // structure/station ID → name (from Tycoon)
const ui = { limit: PAGE, open: null, ver: 0, memo: null, error: null };
const sc = createShortcuts({ onChange: () => { drawToggle?.(); render(); meCtl?.render(); } });
let base = null, ctx = null, types = null, stations = null, typeByName = null, meCtl = null, assets = null, drawToggle = null;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isk = (v) => formatIsk(v);
const num = (v) => (v == null || !Number.isFinite(v) ? '—' : Math.abs(v) < 1000 ? String(Math.round(v)) : formatIsk(v, 1));
const typeName = (t) => types?.[t]?.[0] || `Type ${t}`;
const kindOf = (t) => (typeof types?.[t]?.[4] === 'string' ? types[t][4] : null);
const taxRate = () => (Number(settings.tax) || 0) / 100;

function parseAmount(v) {
  const m = String(v ?? '').trim().toLowerCase().replace(/[, _]/g, '').match(/^(\d*\.?\d+)([kmb]?)$/);
  if (!m) return null;
  return Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1);
}
function ago(ms) {
  if (!ms) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// ---------------------------------------------------------------------------
// Systems and wormhole shortcuts
// ---------------------------------------------------------------------------
const sysName = (id) => sc.sysName(id);
function secSpan(id) {
  const i = base?.indexOf.get(id);
  if (i == null) return isJSpace(id) ? '<span class="sec wh">WH</span>' : '';
  const sec = base.sec[i];
  return `<span class="sec" style="--sec:${secColor(sec)}">${secLabel(sec)}</span>`;
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------
async function fetchBook(typeId) {
  const b = books[typeId] ||= {};
  b.loading = true;
  renderStatus();
  try {
    const res = await fetch(`/api/tycoon/v1/market/orders/${typeId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    for (const [id, n] of Object.entries(body.stationNames || {})) locNames.set(Number(id), n);
    for (const [id, n] of Object.entries(body.structureNames || {})) locNames.set(Number(id), n);
    b.orders = (body.orders || []).filter(o => o.isBuyOrder).map(normalizeTycoonOrder);
    b.at = Date.parse(res.headers.get('x-fetched-at')) || Date.now();
    b.error = null;
  } catch (e) {
    b.error = e.message;
  } finally {
    b.loading = false;
    ui.ver++;
  }
}

async function refresh(force = false) {
  const todo = load.items.map(it => it.typeId).filter(t => force || (!books[t]?.orders && !books[t]?.loading));
  const btn = $('refreshBtn');
  btn.classList.add('loading'); btn.disabled = true;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, async () => {
    while (next < todo.length) { await fetchBook(todo[next++]); render(); }
  }));
  await sc.refresh(force);
  btn.classList.remove('loading'); btn.disabled = false;
  render();
}

// ---------------------------------------------------------------------------
// Pricing the load
// ---------------------------------------------------------------------------
function compute() {
  if (!base || !ctx || !types) return null;
  const g = sc.travelGraph();
  const key = [ui.ver, sc.key(), JSON.stringify(load.items), settings.home, settings.flag, settings.tax, settings.maxJumps,
    settings.minShare, settings.structures, settings.rank, !!stations].join('|');
  if (ui.memo?.key === key) return ui.memo.value;

  const items = load.items.filter(it => it.qty > 0 && books[it.typeId]?.orders);
  const rows = priceLoad(
    items.map(it => ({ typeId: it.typeId, qty: it.qty, volume: types[it.typeId]?.[1] || 0 })),
    Object.fromEntries(items.map(it => [it.typeId, books[it.typeId].orders])),
    base, ctx,
    { fromSystem: base.indexOf.has(settings.home) ? settings.home : null, taxRate: taxRate(),
      always: HUBS.map(h => [h.stationId, h.id]), allowStation: (l) => settings.structures || isNpcStation(l) },
  );
  const homeKnown = g.indexOf.has(settings.home);
  const d = homeKnown ? jumpsFrom(g, settings.home, settings.flag) : null;
  for (const r of rows) {
    const i = g.indexOf.get(r.systemId);
    r.jumps = d && i != null && d[i] >= 0 ? d[i] : null;
  }
  const maxJumps = settings.maxJumps === '' ? Infinity : Number(settings.maxJumps);
  const minShare = (Number(settings.minShare) || 0) / 100;
  // Without a known starting point every station stays in, with unknown jumps.
  const inReach = rows.filter(r => !d || (r.jumps != null && r.jumps <= maxJumps));
  const here = rows.filter(r => r.jumps === 0).reduce((best, r) => (!best || r.isk > best.isk ? r : best), null);
  const jita = rows.find(r => r.locationId === JITA.stationId) || null;
  const score = {
    isk: (r) => r.isk,
    perJump: (r) => (r.jumps == null ? -Infinity : r.isk / (r.jumps + 1)),
    near: (r) => (r.jumps == null ? -1e15 : -r.jumps * 1e15 + r.isk),
  }[settings.rank] || ((r) => r.isk);
  const list = inReach.filter(r => r.share >= minShare - 1e-9 && r.isk > 0).sort((a, b) => score(b) - score(a));

  // Best station for each item on its own: within your limits, and anywhere reachable.
  const reachable = rows.filter(r => !d || r.jumps != null);
  const perItem = items.map((it, k) => {
    const pick = (set) => set.reduce((best, r) => (r.lines[k].isk > 0 && (!best || r.lines[k].isk > best.lines[k].isk) ? r : best), null);
    return { ...it, near: pick(inReach), any: pick(reachable), jita: jita?.lines[k] || null, k };
  });
  const split = perItem.reduce((s, p) => s + (p.near?.lines[p.k].isk || 0), 0);
  const stops = new Set(perItem.filter(p => p.near).map(p => p.near.locationId)).size;
  const value = { rows: list, perItem, here, jita, split, stops, homeKnown, d, g, priced: items.length };
  ui.memo = { key, value };
  return value;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function placeHtml(locationId, systemId) {
  const npc = isNpcStation(locationId);
  const name = (npc ? stations?.[locationId]?.[0] : null) || locNames.get(locationId);
  const i = base?.indexOf.get(systemId);
  const region = i != null ? base.regionName.get(base.regionId[i]) : isJSpace(systemId) ? 'Wormhole space' : '';
  const title = name || (npc ? `Station ${locationId}` : `Structure in ${sysName(systemId)}`);
  return `<span class="place"><b title="${esc(title)}">${esc(title)}</b>${npc ? '' : '<span class="badge ov">structure</span>'}`
    + `<small>${esc(sysName(systemId))} ${secSpan(systemId)} · ${esc(region)}</small></span>`;
}

// Jumps, marked when the route uses a shortcut.
function jumpsHtml(r, v) {
  if (r.jumps == null) return `<span class="muted" title="${v.homeKnown ? 'Not reachable with this route setting' : 'Your system isn\'t on the map yet'}">?</span>`;
  const n = shortcutsOn(v.g, pathBetween(v.g, settings.home, r.systemId, settings.flag));
  return n ? `${r.jumps}<span class="wh-mark" title="Route uses ${n} wormhole shortcut${n > 1 ? 's' : ''}">⤳</span>` : String(r.jumps);
}
const avg = (line) => (line?.units ? line.gross / line.units : null);

function renderStatus(v = ui.memo?.value) {
  const el = $('status');
  const loading = load.items.filter(it => books[it.typeId]?.loading).length;
  const errors = load.items.filter(it => books[it.typeId]?.error);
  const ats = load.items.map(it => books[it.typeId]?.at).filter(Boolean);
  let msg;
  if (!load.items.length) msg = 'Add what you mined';
  else if (loading) msg = `Loading prices · ${load.items.length - loading}/${load.items.length}…`;
  else if (ats.length) msg = `${v?.priced ?? ats.length} item${ats.length > 1 ? 's' : ''} priced · ${ago(Math.min(...ats))}`;
  else msg = 'No prices yet';
  if (errors.length) msg += ` · ${errors.length} failed`;
  el.textContent = msg;
  el.title = errors.map(it => `${typeName(it.typeId)}: ${books[it.typeId].error}`).join('\n');
  el.classList.toggle('warn', errors.length > 0);
}

function renderLoad(v) {
  const m3 = load.items.reduce((s, it) => s + it.qty * (types?.[it.typeId]?.[1] || 0), 0);
  $('loadCount').textContent = load.items.length ? `· ${load.items.length} item${load.items.length > 1 ? 's' : ''}, ${num(m3)} m³` : '';
  const byType = new Map((v?.perItem || []).map(p => [p.typeId, p]));
  $('loadBody').innerHTML = load.items.map(it => {
    const t = it.typeId, name = typeName(t), p = byType.get(t), b = books[t];
    const kind = kindOf(t);
    const price = (line) => (line?.best != null ? isk(line.best) : '—');
    const status = b?.loading ? '<span class="muted">loading…</span>' : b?.error ? `<span class="neg" title="${esc(b.error)}">failed</span>` : null;
    return `<tr data-t="${t}">
      <td class="l item">${itemPic(t, name, 24)} <span>${esc(name)}</span>${copyButton(name)}${kind ? `<span class="badge ov">${KIND_LABEL[kind]}</span>` : ''}</td>
      <td><input class="qty" type="text" inputmode="numeric" data-qty="${t}" value="${it.qty}" aria-label="Units of ${esc(name)}"></td>
      <td>${num(it.qty * (types?.[t]?.[1] || 0))}</td>
      <td>${status || price(p?.jita)}</td>
      <td>${status || (p?.near ? `${price(p.near.lines[p.k])} <small class="muted">${esc(sysName(p.near.systemId))}</small>` : '—')}</td>
      <td>${removeButton(t, name)}</td>
    </tr>`;
  }).join('') || '<tr class="empty"><td colspan="6" class="l muted">Nothing yet. Pick an item above or paste your ore hold.</td></tr>';
}

function renderKpis(v) {
  const el = $('kpis');
  if (!v || !v.priced) { el.innerHTML = ''; return; }
  const best = v.rows[0];
  const kpi = (label, value, sub) => `<div class="kpi"><span>${label}</span><b>${value}</b><small>${sub}</small></div>`;
  el.innerHTML = [
    kpi('Best one stop', best ? isk(best.isk) : '—', best ? `${esc(sysName(best.systemId))} · ${best.jumps ?? '?'} jumps` : 'Nothing buys this within your limits'),
    kpi('Split by item', v.split ? isk(v.split) : '—', v.stops ? `${v.stops} stop${v.stops > 1 ? 's' : ''}, each within your limits` : '—'),
    kpi('Sell here', v.here ? isk(v.here.isk) : '—', v.here ? `${esc(sysName(v.here.systemId))}, ${Math.round(v.here.share * 100)}% of the load` : 'No buyers in your system'),
    kpi('Jita 4-4', v.jita ? isk(v.jita.isk) : '—', v.jita ? `${v.jita.jumps ?? '?'} jumps · ${Math.round(v.jita.share * 100)}% of the load` : ''),
  ].join('');
}

function diff(a, b) {
  if (b == null) return '<span class="muted">—</span>';
  const d = a - b;
  if (Math.abs(d) < 0.5) return '<span class="muted">±0</span>';
  return `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : '−'}${isk(Math.abs(d))}</span>`;
}

function renderStations(v) {
  const body = $('stationsBody');
  if (!v || !v.priced) {
    body.innerHTML = `<tr class="empty"><td colspan="7" class="l muted">${load.items.length ? 'Loading prices…' : 'Add items to your load to see where they sell best.'}</td></tr>`;
    $('moreBtn').hidden = true;
    return;
  }
  if (!v.rows.length) {
    // Restricted routes leave a home outside them by the nearest allowed system; from Pochven there's no way in.
    const hint = settings.flag !== 'shortest' && v.homeKnown && !v.d.some(j => j > 0)
      ? `No gate route from here into ${settings.flag === 'secure' ? 'high-sec' : 'high- or low-sec'}. Set Route to Shortest.` : 'Nothing buys this load within your limits. Try more jumps or a lower minimum.';
    body.innerHTML = `<tr class="empty"><td colspan="7" class="l muted">${hint}</td></tr>`;
    $('moreBtn').hidden = true;
    return;
  }
  const rows = v.rows.slice(0, ui.limit);
  body.innerHTML = rows.map((r, i) => {
    const partial = r.share < 0.999;
    const main = `<tr data-l="${r.locationId}" class="${i === 0 ? 'top' : ''}${ui.open === r.locationId ? ' open' : ''}">
      <td class="l">${i + 1}</td>
      <td class="l">${placeHtml(r.locationId, r.systemId)}</td>
      <td>${jumpsHtml(r, v)}</td>
      <td class="${partial ? 'warn-num' : ''}" title="${partial ? 'Buy orders here can\'t take your whole load' : ''}">${Math.round(r.share * 100)}%</td>
      <td class="metric">${isk(r.isk)}</td>
      <td>${diff(r.isk, v.here?.isk)}</td>
      <td>${diff(r.isk, v.jita?.isk)}</td>
    </tr>`;
    if (ui.open !== r.locationId) return main;
    const lines = r.lines.map(l => {
      const it = load.items.find(x => x.typeId === l.typeId);
      return `<tr><td class="l">${esc(typeName(l.typeId))}${copyButton(typeName(l.typeId))}</td><td>${num(l.units)} / ${num(it?.qty)}</td><td>${l.units ? isk(avg(l)) : '—'}</td>
        <td>${l.best != null ? isk(l.best) : '—'}</td><td>${isk(l.isk)}</td></tr>`;
    }).join('');
    return `${main}<tr class="items-row"><td></td><td colspan="6" class="l">
      <table class="routes mini mn-lines"><thead><tr><th class="l">Item</th><th>Sold</th><th>Avg price</th><th>Top price</th><th>ISK after tax</th></tr></thead>
      <tbody>${lines}</tbody></table></td></tr>`;
  }).join('');
  $('moreBtn').hidden = v.rows.length <= ui.limit;
}

function renderPerItem(v) {
  const body = $('perItemBody');
  if (!v || !v.priced) { body.innerHTML = '<tr class="empty"><td colspan="9" class="l muted">—</td></tr>'; return; }
  const cell = (r, k) => (r
    ? [`<td class="l">${placeHtml(r.locationId, r.systemId)}</td>`, `<td>${jumpsHtml(r, v)}</td>`]
    : ['<td class="l muted">No buyers</td>', '<td></td>']);
  body.innerHTML = v.perItem.map(p => {
    const [nearPlace, nearJumps] = cell(p.near, p.k), [anyPlace, anyJumps] = cell(p.any, p.k);
    const nl = p.near?.lines[p.k], al = p.any?.lines[p.k];
    const partial = (l) => (l && l.units < p.qty ? ` <small class="warn-num" title="Only ${num(l.units)} of ${num(p.qty)} units sell there">${Math.round(l.units / p.qty * 100)}%</small>` : '');
    return `<tr class="static">
      <td class="l item">${itemPic(p.typeId, typeName(p.typeId), 24)} <span>${esc(typeName(p.typeId))}</span>${copyButton(typeName(p.typeId))}</td>
      <td>${num(p.qty)}</td>
      ${nearPlace}${nearJumps}
      <td>${nl?.units ? isk(avg(nl)) : '—'}</td>
      <td class="metric">${nl ? isk(nl.isk) : '—'}${partial(nl)}</td>
      ${anyPlace}${anyJumps}
      <td>${al ? isk(al.isk) : '—'}${partial(al)}</td>
    </tr>`;
  }).join('');
}

function render() {
  const v = compute();
  renderStatus(v);
  renderLoad(v);
  renderKpis(v);
  renderStations(v);
  renderPerItem(v);
  sc.resolveNames([settings.home]);
  const input = $('home');
  if (base && document.activeElement !== input) input.value = sysName(settings.home);
}

// ---------------------------------------------------------------------------
// Load editing
// ---------------------------------------------------------------------------
function addItems(items, { replace = false } = {}) {
  if (replace) load.items = [];
  for (const { typeId, qty } of items) {
    const cur = load.items.find(it => it.typeId === typeId);
    if (cur) cur.qty += qty; else load.items.push({ typeId, qty });
  }
  saveLoad();
  ui.open = null; ui.limit = PAGE;
  render();
  refresh();
}

function fillItemList() {
  if (!types) return;
  const want = settings.kind;
  $('itemList').innerHTML = Object.entries(types)
    .filter(([, v]) => typeof v[4] === 'string' && (!want || v[4] === want))
    .map(([, v]) => v[0]).sort().map(n => `<option value="${esc(n)}">`).join('');
}

function addFromInputs() {
  const name = $('itemName').value.trim();
  const t = typeByName?.get(name.toLowerCase());
  const qtyText = $('itemQty').value.trim();
  const qty = qtyText ? parseAmount(qtyText) : 1;
  $('itemName').classList.toggle('bad', !t);
  $('itemQty').classList.toggle('bad', !(qty > 0));
  if (!t || !(qty > 0)) return;
  $('itemName').value = ''; $('itemQty').value = '';
  addItems([{ typeId: t, qty: Math.round(qty) }]);
}

// ---------------------------------------------------------------------------
// Settings and wiring
// ---------------------------------------------------------------------------
function bindSetting(id, key, { prop = 'value', parse = v => v, event = 'change', after } = {}) {
  const el = $(id);
  el[prop] = settings[key];
  el.addEventListener(event, () => { settings[key] = parse(el[prop]); save(); ui.limit = PAGE; after?.(); render(); });
}

// Signed in with Follow on: your character's system is where the jumps start, wormhole space included.
function followLocation(loc) {
  const input = $('home');
  if (loc?.systemId && loc.systemId !== settings.home) { settings.home = loc.systemId; save(); }
  input.disabled = !!loc;
  input.title = loc ? 'Following your character — untick Follow in the character menu to choose a system by hand' : '';
  render();
}

function init() {
  meCtl = createMe({
    el: $('me'), returnTo: '/mining.html', systemName: sysName, isk,
    shipInfo: (id) => (types?.[id] ? { name: types[id][0], cargo: types[id][2] === 6 ? types[id][3] ?? null : null } : null),
    onFollow: followLocation, onStatus: () => { render(); assets?.statusChanged(); },
  });
  assets = createAssets({
    types: () => types, stations: () => stations, sysName, me: () => meCtl,
    // "Where to sell" on an asset location: that station's ore becomes the load, priced from there.
    onSell: (items, systemId) => {
      if (systemId && !$('home').disabled) { settings.home = systemId; save(); }
      addItems(items, { replace: true });
      $('loadTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  });

  bindSetting('flag', 'flag');
  bindSetting('tax', 'tax', { parse: Number, event: 'input' });
  bindSetting('maxJumps', 'maxJumps', { event: 'input' });
  bindSetting('minShare', 'minShare', { event: 'input' });
  bindSetting('structures', 'structures', { prop: 'checked' });
  bindSetting('rank', 'rank');
  bindSetting('kind', 'kind', { after: fillItemList });

  $('home').addEventListener('change', async () => {
    const input = $('home');
    const id = await sc.systemByName(input.value).catch(() => null);
    input.classList.toggle('bad', !id);
    if (!id) return;
    settings.home = id; save(); render();
  });

  $('addBtn').addEventListener('click', addFromInputs);
  for (const id of ['itemName', 'itemQty']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') addFromInputs(); });
  $('pasteBtn').addEventListener('click', () => {
    if (!typeByName) return;
    const { items, unknown } = parsePaste($('pasteBox').value, (n) => typeByName.get(n.toLowerCase()) ?? null);
    $('pasteNote').textContent = `${items.length} item${items.length === 1 ? '' : 's'} added${unknown.length ? ` · not recognised: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''}` : ''}`;
    if (!items.length) return;
    $('pasteBox').value = '';
    addItems(items, { replace: $('pasteReplace').checked });
  });
  $('clearBtn').addEventListener('click', () => { load.items = []; saveLoad(); ui.open = null; render(); });
  $('loadBody').addEventListener('change', (e) => {
    const t = Number(e.target.dataset.qty);
    if (!t) return;
    const qty = parseAmount(e.target.value);
    e.target.classList.toggle('bad', !(qty > 0));
    if (!(qty > 0)) return;
    load.items.find(it => it.typeId === t).qty = Math.round(qty);
    saveLoad(); render();
  });
  $('loadBody').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (!rm) return;
    load.items = load.items.filter(it => it.typeId !== Number(rm.dataset.remove));
    saveLoad(); render();
  });
  $('stationsBody').addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const tr = e.target.closest('tr[data-l]');
    if (!tr) return;
    const l = Number(tr.dataset.l);
    ui.open = ui.open === l ? null : l;
    renderStations(compute());
  });
  $('moreBtn').addEventListener('click', () => { ui.limit += PAGE; renderStations(compute()); });
  $('refreshBtn').addEventListener('click', () => refresh(true));
  drawToggle = mountToggle($('whToggle'), sc);

  fetch('data/universe.json').then(r => r.json()).then(u => {
    base = buildGraph(u);
    sc.setBase(base);
    $('systemList').innerHTML = [...base.name].sort().map(n => `<option value="${esc(n)}">`).join('');
    return fetch('data/stations.json').then(r => (r.ok ? r.json() : {})).catch(() => ({})).then(s => {
      stations = s;
      ctx = buildRangeContext(base, s);
      ui.memo = null; render(); meCtl.reapply(); assets.render();
    });
  }).catch(() => { $('home').placeholder = 'Star map unavailable'; });
  fetch('data/types.json').then(r => r.json()).then(t => {
    types = t;
    typeByName = new Map(Object.entries(t).map(([id, v]) => [v[0].toLowerCase(), Number(id)]));
    fillItemList();
    ui.memo = null; render(); meCtl.reapply(); assets.render();
  }).catch(() => {});
  render();
  refresh();
}

init();
