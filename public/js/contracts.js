// Contracts & Opportunities page: public contracts (contract-scanner.js) and NPC LP stores,
// each priced against the live hub markets.
//   Item contracts — item-exchange / auction contracts whose items are worth more at a hub
//   Courier        — ISK per jump, plus a market backhaul from the Universe scan near the drop-off
//   LP stores      — ISK per LP for mission runners' loyalty points

import { HUBS, DEFAULT_TAX_PCT, formatIsk, summarizeSteps } from './arbitrage.js';
import { buildGraph, jumpsFrom, jumpsBetween, systemInfo } from './galaxy.js';
import { parseFuzzwork, isNpcStation } from './market-merge.js';
import { contractProfit, lpOfferValue, BLUEPRINT_CATEGORY } from './contract-value.js';
import { createMe } from './me.js';
import { scanClient, tabNote } from './scan-client.js';
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
const PAGE = 50;
const DEFAULTS = {
  home: JITA.id, flag: 'secure', tax: DEFAULT_TAX_PCT, taxV: 1, cargo: '', budget: '', sellHub: 'best', mode: 'instant', structures: true,
  tab: 'items', scope: 'hubs', minPrice: '20m',
};
const X_DEFAULTS = { minProfit: '1m', maxMargin: '', maxJumps: '', rank: 'profit', q: '', priced: true, auctions: false };
const C_DEFAULTS = { minReward: '', maxCollateral: '', maxJumps: '', backJumps: '5', rank: 'perJump', fits: false };
const LP_DEFAULTS = { corp: '', have: '', rank: 'perLp', hideBp: true };
const stored = LS.get('contracts.settings', {});
// Sales tax used to default to 0%; a saved 0 from then becomes the in-game base rate, once (taxV).
if (!stored.taxV && !Number(stored.tax)) delete stored.tax;
const settings = { ...DEFAULTS, ...stored };
settings.x = { ...X_DEFAULTS, ...stored.x };
settings.c = { ...C_DEFAULTS, ...stored.c };
settings.lp = { ...LP_DEFAULTS, ...stored.lp };
// Settings mirrored in the query string (url-state.js).
const URL_DEFAULTS = { ...DEFAULTS, x: X_DEFAULTS, c: C_DEFAULTS, lp: LP_DEFAULTS };
const URL_FIELDS = [
  ['tab', ['items', 'courier', 'lp']], ['home', v => v > 0], ['flag', ['secure', 'shortest']], ['tax', v => v >= 0 && v <= 100],
  'cargo', 'budget', ['sellHub', ['best', ...HUBS.map(h => String(h.id))]], ['mode', ['instant', 'relist']], 'structures',
  ['scope', ['hubs', 'all']], 'minPrice',
  'x.minProfit', 'x.maxMargin', 'x.maxJumps', ['x.rank', ['profit', 'perJump', 'margin']], 'x.q', 'x.priced', 'x.auctions',
  'c.minReward', 'c.maxCollateral', 'c.maxJumps', 'c.backJumps', ['c.rank', ['perJump', 'withBack', 'reward', 'perM3']], 'c.fits',
  'lp.corp', 'lp.have', ['lp.rank', ['perLp', 'profit']], 'lp.hideBp',
];
readUrl(settings, URL_DEFAULTS, URL_FIELDS);
writeUrl(settings, URL_DEFAULTS, URL_FIELDS);
const save = () => { LS.set('contracts.settings', settings); writeUrl(settings, URL_DEFAULTS, URL_FIELDS); };

const cs = { status: null, result: null, poll: null, xLimit: PAGE, cLimit: PAGE, open: null, xMemo: null, cMemo: null };
const us = { result: null, loading: null, backMemo: null };
const conScan = scanClient('cscan'), uniScan = scanClient('uscan');
const lp = { corps: null, byName: new Map(), offers: null, corpId: null, prices: {}, vol: new Map(), status: '', ver: 0 };
let graph = null, types = null, stations = null;
const byName = new Map(); // lower-case system name → system ID

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isk = (v) => formatIsk(v);
const num = (v) => (v == null || !Number.isFinite(v) ? '—' : Math.abs(v) < 1000 ? String(Math.round(v)) : formatIsk(v, 1));
const icon = (id, size = 32) => `https://images.evetech.net/types/${id}/icon?size=${size}`;
const typeName = (t) => types?.[t]?.[0] || cs.result?.types?.[t]?.[0] || `Type ${t}`;
const sysName = (id) => (graph ? systemInfo(graph, id)?.name : null) || String(id);
const hubById = (id) => HUBS.find(h => h.id === id);

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
function left(ms) {
  const d = ms - Date.now();
  if (d <= 0) return 'expired';
  return d > 86_400_000 ? `${Math.floor(d / 86_400_000)}d` : `${Math.ceil(d / 3_600_000)}h`;
}
const secSpan = (sec) => (sec == null ? '' : `<span class="sec" style="--sec:${secColor(sec)}">${secLabel(sec)}</span>`);

// "Station name" with system, security and region. Structures have no public names.
function placeHtml(locationId, systemId, regionId) {
  const sys = graph && systemId ? systemInfo(graph, systemId) : null;
  const npc = isNpcStation(locationId);
  const name = npc ? stations?.[locationId]?.[0] : null;
  const region = sys?.region || graph?.regionName.get(regionId) || '';
  const title = name || (npc ? `Station ${locationId}` : `Structure${sys ? ` in ${sys.name}` : ''}`);
  return `<span class="place"><b title="${esc(title)}">${esc(title)}</b>${npc ? '' : '<span class="badge ov">structure</span>'}`
    + `<small>${sys ? `${esc(sys.name)} ${secSpan(sys.sec)} · ` : ''}${esc(region)}</small></span>`;
}

// Jumps from the home system with the page's route setting (null = unreachable/unknown).
function homeJumps(systemId) {
  if (!graph || systemId == null) return null;
  const i = graph.indexOf.get(systemId);
  const d = i == null ? -1 : jumpsFrom(graph, settings.home, settings.flag)[i];
  return d < 0 ? null : d;
}
const jumps = (a, b) => (graph && a != null && b != null ? (a === b ? 0 : jumpsBetween(graph, a, b, settings.flag)) : null);
const taxRate = () => (Number(settings.tax) || 0) / 100;
const settingsKey = () => [settings.home, settings.flag, settings.tax, settings.cargo, settings.budget, settings.sellHub,
  settings.mode, settings.structures, !!graph, !!types, !!stations].join('|');

// ---------------------------------------------------------------------------
// Contract scan (server-side, see contract-scanner.js)
// ---------------------------------------------------------------------------
async function loadResult() {
  try {
    const r = await conScan.result();
    if (r) { cs.result = r; cs.xMemo = cs.cMemo = null; us.backMemo = null; }
  } catch { /* keep the previous result */ }
  renderAll();
}

async function poll() {
  clearTimeout(cs.poll);
  try { cs.status = await conScan.status(); } catch { /* server restarting */ }
  const st = cs.status?.state;
  if (st === 'running') cs.poll = setTimeout(poll, 1500);
  else if (st === 'done' && cs.status.result?.finishedAt !== cs.result?.finishedAt) await loadResult();
  renderStatus();
}

async function startScan() {
  const minPrice = parseAmount(settings.minPrice || DEFAULTS.minPrice);
  if (minPrice == null) { $('minPrice').classList.add('bad'); return; }
  $('scanBtn').disabled = true;
  const force = cs.result && cs.result.scope === settings.scope && cs.result.minPrice === minPrice ? '1' : undefined;
  try {
    cs.status = await conScan.start({ scope: settings.scope, minPrice, force });
  } catch { /* shown by poll */ }
  poll();
}

const PHASE = {
  lists: (s) => `Listing contracts in every region · ${s.done}/${s.total} pages…`,
  items: (s) => `Opening contracts · ${num(s.done)}/${num(s.total)} (new ones only)…`,
  market: (s) => `Reading hub markets · ${s.done}/${s.total} pages…`,
  computing: () => 'Pricing contracts…',
};

function renderStatus() {
  const st = cs.status, el = $('scanStatus'), bar = $('scanProgress');
  const running = st?.state === 'running';
  $('scanBtn').disabled = running;
  bar.hidden = !running;
  if (running) bar.firstElementChild.style.width = `${st.total ? Math.round(st.done / st.total * 100) : 0}%`;
  const r = cs.result;
  let msg;
  if (running) msg = (PHASE[st.phase] || (() => 'Scanning…'))(st) + tabNote();
  else if (st?.state === 'error') msg = `Scan failed: ${st.error}`;
  else if (r) {
    const fresh = r.expiresAt > Date.now();
    msg = `${num(r.listed)} contracts listed · ${num(r.scanned)} opened (${r.scope === 'all' ? 'all regions' : 'hub regions'}, ≥ ${isk(r.minPrice)}) · `
      + `scanned ${ago(r.finishedAt)}${fresh ? '' : ' · ESI has newer data'}`;
    $('scanBtn').textContent = 'Rescan';
  } else msg = 'No scan yet. The first one opens every contract and takes a few minutes; later scans only open new ones.';
  const warnings = (running ? st?.warnings : r?.warnings) || [];
  el.textContent = msg + (warnings.length ? ` · ${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : '');
  el.title = warnings.join('\n');
  el.classList.toggle('warn', warnings.length > 0 || st?.state === 'error');
}

// ---------------------------------------------------------------------------
// Item contracts
// ---------------------------------------------------------------------------
function itemRows() {
  const r = cs.result;
  if (!r) return [];
  const f = settings.x;
  const key = [r.finishedAt, settingsKey(), JSON.stringify(f)].join('|');
  if (cs.xMemo?.key === key) return cs.xMemo.rows;
  const tx = taxRate();
  const maxCost = parseAmount(settings.budget) ?? Infinity, maxVolume = parseAmount(settings.cargo) ?? Infinity;
  const minProfit = parseAmount(f.minProfit) ?? -Infinity;
  const maxMargin = f.maxMargin === '' ? Infinity : Number(f.maxMargin);
  const maxJumps = f.maxJumps === '' ? Infinity : Number(f.maxJumps);
  const q = f.q.trim().toLowerCase();
  const hubs = settings.sellHub === 'best' ? HUBS : [hubById(Number(settings.sellHub)) || JITA];
  const rows = [];
  for (const c of r.contracts) {
    if (c.k === 'a' && !f.auctions) continue;
    if (!settings.structures && !isNpcStation(c.l)) continue;
    if (c.v > maxVolume) continue;
    if (q && !(c.ti || '').toLowerCase().includes(q) && !c.it.some(([t]) => typeName(t).toLowerCase().includes(q))) continue;
    const jHome = homeJumps(c.s);
    if (c.s != null && jHome == null && settings.flag === 'secure') continue;
    let best = null;
    for (const hub of hubs) {
      const h = c.h[hub.id];
      if (!h) continue;
      const [instant, relist, need, unpriced, thin] = h;
      if (f.priced && unpriced > 0) continue;
      const p = contractProfit(c, { instant, relist, need }, { mode: settings.mode, taxRate: tx });
      if (p.cost > maxCost) continue;
      const jHaul = jumps(c.s, hub.id);
      if (c.s != null && jHaul == null) continue; // can't reach the hub with this route setting
      const total = jHome == null || jHaul == null ? null : jHome + jHaul;
      const row = { c, hub, ...p, unpriced, thin, jHome, jHaul, jumps: total,
        margin: p.cost > 0 ? p.profit / p.cost * 100 : null, perJump: total == null ? null : p.profit / Math.max(1, total) };
      if (!best || row.profit > best.profit) best = row;
    }
    if (!best || best.profit <= 0 || best.profit < minProfit) continue;
    if (best.margin != null && best.margin > maxMargin) continue;
    if (best.jumps != null && best.jumps > maxJumps) continue;
    rows.push(best);
  }
  const k = f.rank;
  rows.sort((a, b) => (b[k] ?? -Infinity) - (a[k] ?? -Infinity));
  cs.xMemo = { key, rows };
  return rows;
}

// Name for a contract: its title, else its first item (+ how many more).
function contractLabel(c) {
  const [t, qty] = c.it[0] || [];
  const first = t != null ? `${qty > 1 ? `${num(qty)} × ` : ''}${typeName(t)}` : 'Empty';
  const more = c.n > 1 ? ` + ${c.n - 1} more` : '';
  return c.ti ? { main: c.ti, sub: `${first}${more}` } : { main: `${first}${more}`, sub: '' };
}

function renderItems() {
  const body = $('xBody');
  if (!cs.result) {
    body.innerHTML = '<tr class="empty"><td colspan="11">Press <b>Scan contracts</b> to open every public contract in the chosen regions.</td></tr>';
    $('xMore').hidden = true;
    return;
  }
  const rows = itemRows();
  const shown = rows.slice(0, cs.xLimit);
  body.innerHTML = shown.map((row, i) => {
    const { c, hub } = row;
    const label = contractLabel(c);
    const t0 = c.it[0]?.[0];
    const notes = [
      c.k === 'a' ? (c.bo ? 'auction · buyout' : 'auction · min bid, may be outbid') : '',
      c.r > 0 ? `pays you ${isk(c.r)}` : '',
      row.need > 0 ? `you supply ${isk(row.need)} of items` : '',
      row.unpriced > 0 ? `${row.unpriced} unpriced line${row.unpriced > 1 ? 's' : ''}` : '',
      row.thin > 0 ? 'more than the buy orders absorb' : '',
    ].filter(Boolean);
    const open = cs.open === c.id;
    return `<tr data-id="${c.id}" class="${i === 0 ? 'top' : ''}${open ? ' open' : ''}">
      <td class="l rank">${i + 1}</td>
      <td class="l item">${t0 != null ? `<img src="${icon(t0)}" alt="" width="24" height="24" loading="lazy">` : ''}<span title="${esc(label.main)}">${esc(label.main)}</span>
        ${label.sub ? `<small>${esc(label.sub)}</small>` : ''}${notes.length ? `<small class="${row.unpriced || row.thin ? 'warn' : ''}">${esc(notes.join(' · '))}</small>` : ''}</td>
      <td class="l">${placeHtml(c.l, c.s, c.g)}</td>
      <td>${row.jumps ?? '?'}<small class="sub">${row.jHome ?? '?'} + ${row.jHaul ?? '?'} to ${esc(hub.name)}</small></td>
      <td>${num(c.v)}</td>
      <td>${isk(row.cost)}</td>
      <td>${isk(row.value)}<small class="sub">${settings.mode === 'relist' ? 'relist' : 'sell'} at ${esc(hub.name)}</small></td>
      <td class="metric">${isk(row.profit)}</td>
      <td>${row.margin == null ? '∞' : `${row.margin.toFixed(1)}%`}</td>
      <td>${isk(row.perJump)}</td>
      <td>${left(c.e)}</td></tr>${open ? itemsDetail(row) : ''}`;
  }).join('') || '<tr class="empty"><td colspan="11">No contract beats the market with these filters.</td></tr>';
  $('xMore').hidden = rows.length <= cs.xLimit;
  $('xMore').textContent = `Show more (${num(rows.length - cs.xLimit)} left)`;
}

function itemsDetail(row) {
  const { c, hub } = row;
  const px = cs.result.prices || {};
  const lines = c.it.map(([t, q, inc, bpc]) => {
    const [bid, ask] = px[t]?.[hub.id] || [];
    const cls = !inc ? 'want' : bpc ? 'bpc' : '';
    const unit = bpc ? null : !inc ? ask : settings.mode === 'relist' ? (ask ?? bid) : bid;
    return `<tr class="${cls}"><td class="l item"><img src="${icon(t)}" alt="" width="20" height="20" loading="lazy">${esc(typeName(t))}
        ${bpc ? ' <span class="badge ov">BPC</span>' : ''}${!inc ? ' <span class="badge stale">you supply</span>' : ''}</td>
      <td>${num(q)}</td><td>${isk(bid)}</td><td>${isk(ask)}</td><td>${unit == null ? '—' : isk(unit * q)}</td></tr>`;
  }).join('');
  const more = c.n > c.it.length ? `<tr><td class="l" colspan="5">+ ${c.n - c.it.length} more lines (counted in the value)</td></tr>` : '';
  return `<tr class="items-row"><td colspan="11">
    <p class="ct-meta">Contract <code>${c.id}</code> · ${c.k === 'a' ? 'auction' : 'item exchange'} · expires in ${left(c.e)}
      · find it in game under <i>Contracts → Search</i> at this station. Unit prices at ${esc(hub.station)}; the value walks the buy orders,
      so big stacks are worth less than top price × quantity.</p>
    <table class="routes mini ct-items"><thead><tr><th class="l">Item</th><th>Qty</th><th>Best buy</th><th>Lowest sell</th><th>≈ Line value</th></tr></thead>
    <tbody>${lines}${more}</tbody></table></td></tr>`;
}

// ---------------------------------------------------------------------------
// Courier contracts + market backhaul
// ---------------------------------------------------------------------------
async function loadUscan() {
  us.loading ||= uniScan.result().catch(() => null)
    .then(r => { us.result = r; us.backMemo = null; cs.cMemo = null; renderCourier(); return r; });
  return us.loading;
}

// The Universe scan's hauls with your settings applied, once per settings change.
function backhauls() {
  const r = us.result;
  if (!r || !graph) return null;
  const key = [r.finishedAt, settingsKey()].join('|');
  if (us.backMemo?.key === key) return us.backMemo;
  const tx = taxRate(), maxVolume = parseAmount(settings.cargo) ?? Infinity, maxCost = parseAmount(settings.budget) ?? Infinity;
  const list = [];
  for (const c of r.candidates) {
    if (!settings.structures && (!isNpcStation(c.f) || !isNpcStation(c.d))) continue;
    const [name, unitVolume] = r.types[c.t] || [`Type ${c.t}`, 0];
    const s = summarizeSteps(c.s, { taxRate: tx, unitVolume, maxVolume, maxCost });
    if (s.units <= 0 || s.profit <= 0) continue;
    const hj = jumps(c.fs, c.ds);
    if (hj == null) continue;
    list.push({ t: c.t, name, fs: c.fs, ds: c.ds, profit: s.profit, hj });
  }
  us.backMemo = { key, list, byDrop: new Map() };
  return us.backMemo;
}

// Best haul (by ISK per jump) starting within `maxJ` jumps of a system.
function bestBackhaul(systemId, maxJ) {
  const b = backhauls();
  if (!b || systemId == null) return null;
  const k = `${systemId}|${maxJ}`;
  if (b.byDrop.has(k)) return b.byDrop.get(k);
  const dist = jumpsFrom(graph, systemId, settings.flag);
  let best = null;
  for (const h of b.list) {
    const i = graph.indexOf.get(h.fs);
    const d = i == null ? -1 : dist[i];
    if (d < 0 || d > maxJ) continue;
    const perJump = h.profit / Math.max(1, d + h.hj);
    if (!best || perJump > best.perJump) best = { ...h, deadhead: d, jumps: d + h.hj, perJump };
  }
  b.byDrop.set(k, best);
  return best;
}

function courierRows() {
  const r = cs.result;
  if (!r) return [];
  const f = settings.c;
  const key = [r.finishedAt, settingsKey(), JSON.stringify(f), us.result?.finishedAt].join('|');
  if (cs.cMemo?.key === key) return cs.cMemo.rows;
  const minReward = parseAmount(f.minReward) ?? 0;
  const maxCollateral = parseAmount(f.maxCollateral) ?? parseAmount(settings.budget) ?? Infinity;
  const cargo = parseAmount(settings.cargo) ?? Infinity;
  const maxJumps = f.maxJumps === '' ? Infinity : Number(f.maxJumps);
  const backJ = f.backJumps === '' ? 5 : Number(f.backJumps);
  const rows = [];
  for (const c of r.couriers) {
    if (!settings.structures && (!isNpcStation(c.l) || !isNpcStation(c.d))) continue;
    if (c.r < minReward || c.c > maxCollateral) continue;
    if (f.fits && c.v > cargo) continue;
    const jHome = homeJumps(c.s), jRoute = jumps(c.s, c.ds);
    const known = jHome != null && jRoute != null;
    if (!known && settings.flag === 'secure' && c.s != null && c.ds != null) continue; // leaves high-sec
    const total = known ? jHome + jRoute : null;
    if (total != null && total > maxJumps) continue;
    const back = us.result ? bestBackhaul(c.ds, backJ) : null;
    const perJump = total != null ? c.r / Math.max(1, total) : null;
    const withBack = total != null ? (c.r + (back?.profit || 0)) / Math.max(1, total + (back?.jumps || 0)) : null;
    rows.push({ c, jHome, jRoute, jumps: total, perJump, withBack, reward: c.r, perM3: c.v > 0 ? c.r / c.v : null, back });
  }
  const k = f.rank;
  rows.sort((a, b) => (b[k] ?? -Infinity) - (a[k] ?? -Infinity));
  cs.cMemo = { key, rows };
  return rows;
}

function renderCourier() {
  const body = $('cBody');
  if (!cs.result) {
    body.innerHTML = '<tr class="empty"><td colspan="10">Press <b>Scan contracts</b> to list courier contracts.</td></tr>';
    $('cMore').hidden = true;
    return;
  }
  const rows = courierRows();
  body.innerHTML = rows.slice(0, cs.cLimit).map((row, i) => {
    const { c, back } = row;
    const backHtml = !us.result ? '<span class="muted">Run the Universe scan on Market watch</span>'
      : !back ? '<span class="muted">Nothing nearby</span>'
      : `<span class="back"><b>+${isk(back.profit)}</b> ${esc(back.name)}<small>${back.deadhead}j to ${esc(sysName(back.fs))} → ${esc(sysName(back.ds))} (${back.hj}j)
          · ${isk(back.perJump)}/jump</small></span>`;
    return `<tr class="${i === 0 ? 'top' : ''}">
      <td class="l rank">${i + 1}</td>
      <td class="l">${placeHtml(c.l, c.s, c.g)}${c.ti ? `<small class="sub">“${esc(c.ti)}”</small>` : ''}</td>
      <td class="l">${placeHtml(c.d, c.ds, null)}</td>
      <td>${row.jumps ?? '?'}<small class="sub">${row.jHome ?? '?'} + ${row.jRoute ?? '?'}</small></td>
      <td>${num(c.v)}</td><td class="metric">${isk(c.r)}</td><td>${isk(c.c)}</td><td>${c.days}<small class="sub">${left(c.e)} to accept</small></td>
      <td>${isk(row.perJump)}${back ? `<small class="sub">${isk(row.withBack)} with backhaul</small>` : ''}</td>
      <td class="l">${backHtml}</td></tr>`;
  }).join('') || '<tr class="empty"><td colspan="10">No courier contracts match these filters.</td></tr>';
  $('cMore').hidden = rows.length <= cs.cLimit;
  $('cMore').textContent = `Show more (${num(rows.length - cs.cLimit)} left)`;
}

// ---------------------------------------------------------------------------
// LP stores
// ---------------------------------------------------------------------------
const lpHub = () => (settings.sellHub === 'best' ? JITA : hubById(Number(settings.sellHub)) || JITA);

async function loadCorps() {
  const cached = LS.get('contracts.corps', null);
  if (cached && Date.now() - cached.at < 7 * 86_400_000) lp.corps = cached.list;
  else {
    try {
      const ids = await (await fetch('/api/esi/corporations/npccorps/')).json();
      const res = await fetch('/api/esi/universe/names/', { method: 'POST', body: JSON.stringify(ids) });
      lp.corps = (await res.json()).map(({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
      LS.set('contracts.corps', { at: Date.now(), list: lp.corps });
    } catch { lp.status = 'Could not load the NPC corporation list from ESI'; lp.corps = []; }
  }
  lp.byName = new Map(lp.corps.map(c => [c.name.toLowerCase(), c.id]));
  $('corpList').innerHTML = lp.corps.map(c => `<option value="${esc(c.name)}">`).join('');
  if (settings.lp.corp) selectCorp();
  else renderLp();
}

async function selectCorp() {
  const id = lp.byName.get(settings.lp.corp.trim().toLowerCase());
  $('lpCorp').classList.toggle('bad', !!settings.lp.corp && !id);
  if (!id) { lp.offers = null; lp.corpId = null; renderLp(); return; }
  if (id === lp.corpId && lp.offers) { await priceOffers(); return; }
  lp.corpId = id; lp.offers = null; lp.status = 'Loading offers…'; renderLp();
  try {
    const res = await fetch(`/api/esi/loyalty/stores/${id}/offers/`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    lp.offers = await res.json();
  } catch (e) { lp.offers = []; lp.status = `Could not load offers (${e.message})`; renderLp(); return; }
  if (lp.corpId !== id) return;
  await priceOffers();
}

// Fuzzwork station aggregates for every product and required item, at the selling hub.
async function priceOffers() {
  const hub = lpHub();
  const ids = [...new Set(lp.offers.flatMap(o => [o.type_id, ...(o.required_items || []).map(r => r.type_id)]))];
  const have = lp.prices[hub.stationId] ||= {};
  const need = ids.filter(t => !(t in have));
  lp.status = need.length ? `Pricing ${need.length} items at ${hub.name}…` : '';
  renderLp();
  try {
    for (let i = 0; i < need.length; i += 100) {
      const res = await fetch(`/api/fuzzwork/aggregates/?station=${hub.stationId}&types=${need.slice(i, i + 100).join(',')}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      Object.assign(have, parseFuzzwork(await res.json()));
    }
    for (const t of need) have[t] ||= null;
    lp.status = '';
  } catch (e) { lp.status = `Pricing failed (${e.message})`; }
  renderLp();
}

function lpRows() {
  if (!lp.offers) return [];
  const hub = lpHub(), prices = lp.prices[hub.stationId] || {};
  const f = settings.lp, lpHave = parseAmount(f.have);
  const rows = [];
  for (const o of lp.offers) {
    const bp = types?.[o.type_id]?.[2] === BLUEPRINT_CATEGORY;
    if (bp && f.hideBp) continue;
    // LP-store blueprints are copies; Fuzzwork's price would be the original's, so leave them unpriced.
    const v = bp ? { revenue: null, reqCost: 0, reqMissing: 0, profit: null, perLp: null }
      : lpOfferValue(o, (t) => prices[t], { mode: settings.mode, taxRate: taxRate() });
    rows.push({ o, bp, ...v, times: lpHave != null && o.lp_cost > 0 ? Math.floor(lpHave / o.lp_cost) : null });
  }
  const k = f.rank;
  rows.sort((a, b) => (b[k] ?? -Infinity) - (a[k] ?? -Infinity));
  return rows;
}

// Average daily volume over the last week in the hub's region (ESI history), for the top rows.
async function loadVolumes(rows) {
  const hub = lpHub();
  const want = rows.map(r => r.o.type_id).filter(t => !lp.vol.has(`${hub.regionId}:${t}`));
  if (!want.length) return;
  for (const t of want) lp.vol.set(`${hub.regionId}:${t}`, undefined);
  let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < want.length) {
      const t = want[i++];
      try {
        const days = await (await fetch(`/api/esi/markets/${hub.regionId}/history/?type_id=${t}`)).json();
        const last = Array.isArray(days) ? days.slice(-7) : [];
        lp.vol.set(`${hub.regionId}:${t}`, last.length ? last.reduce((s, d) => s + d.volume, 0) / 7 : 0);
      } catch { lp.vol.set(`${hub.regionId}:${t}`, null); }
    }
  }));
  renderLp(false);
}

function renderLp(fetchVolumes = true) {
  $('lpStatus').textContent = lp.status;
  const body = $('lpBody');
  if (!lp.offers) {
    body.innerHTML = `<tr class="empty"><td colspan="10">${settings.lp.corp ? 'Unknown corporation — pick one from the list.' : 'Pick an NPC corporation to price its LP store.'}</td></tr>`;
    return;
  }
  if (!lp.offers.length) { body.innerHTML = '<tr class="empty"><td colspan="10">This corporation has no LP store.</td></tr>'; return; }
  const hub = lpHub();
  const prices = lp.prices[hub.stationId] || {};
  const rows = lpRows();
  const top = rows.slice(0, 100);
  body.innerHTML = top.map((r, i) => {
    const { o } = r;
    const req = (o.required_items || []).map(x => `${num(x.quantity)} × ${typeName(x.type_id)}`).join(', ');
    const vol = lp.vol.get(`${hub.regionId}:${o.type_id}`);
    const unit = prices[o.type_id];
    return `<tr class="${i === 0 && r.perLp > 0 ? 'top' : ''}">
      <td class="l rank">${i + 1}</td>
      <td class="l item"><img src="${icon(o.type_id)}" alt="" width="24" height="24" loading="lazy"><span>${o.quantity > 1 ? `${num(o.quantity)} × ` : ''}${esc(typeName(o.type_id))}</span>
        ${r.bp ? '<small class="warn">blueprint copy — value depends on manufacturing</small>' : ''}</td>
      <td>${num(o.lp_cost)}</td><td>${isk(o.isk_cost)}</td>
      <td>${req ? `${isk(r.reqCost)}<small class="sub" title="${esc(req)}">${esc(req)}</small>` : '—'}${r.reqMissing ? '<small class="warn">some not on the market</small>' : ''}</td>
      <td>${isk(r.revenue)}${unit ? `<small class="sub">${isk(unit.buy)} buy · ${isk(unit.sell)} sell</small>` : ''}</td>
      <td>${isk(r.profit)}</td>
      <td class="metric">${r.perLp == null ? '—' : num(r.perLp)}</td>
      <td>${vol === undefined ? '…' : vol == null ? '—' : num(vol)}</td>
      <td>${r.times ?? '—'}</td></tr>`;
  }).join('');
  if (fetchVolumes) loadVolumes(top.slice(0, 40).filter(r => !r.bp));
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function renderAll() {
  renderStatus();
  const tab = settings.tab;
  for (const b of $('tabs').querySelectorAll('button[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const t of ['items', 'courier', 'lp']) $(`panel-${t}`).hidden = t !== tab;
  if (tab === 'items') renderItems();
  if (tab === 'courier') { renderCourier(); if (!us.loading && cs.result) loadUscan(); }
  if (tab === 'lp') { if (!lp.corps) loadCorps(); else renderLp(); }
}

function bind(id, get, set, event = 'change', after = renderAll) {
  const el = $(id);
  const prop = el.type === 'checkbox' ? 'checked' : 'value';
  el[prop] = get();
  el.addEventListener(event, () => { set(el[prop]); save(); after(); });
}

function initHome() {
  const input = $('home');
  for (let i = 0; i < graph.n; i++) byName.set(graph.name[i].toLowerCase(), graph.id[i]);
  $('systemList').innerHTML = [...graph.name].sort().map(n => `<option value="${esc(n)}">`).join('');
  if (!systemInfo(graph, settings.home)) { settings.home = JITA.id; save(); } // unknown ID from a link
  input.value = sysName(settings.home);
  input.addEventListener('change', () => {
    const id = byName.get(input.value.trim().toLowerCase());
    input.classList.toggle('bad', !id);
    if (!id) return;
    settings.home = id; save(); renderAll();
  });
}

// Character options from the header menu (me.js).
function followLocation(loc) {
  const input = $('home');
  if (loc && graph?.indexOf.has(loc.systemId) && loc.systemId !== settings.home) { settings.home = loc.systemId; save(); }
  if (graph) input.value = sysName(settings.home);
  input.disabled = !!loc;
  input.title = loc ? 'Following your character — untick Follow to choose a system by hand' : '';
  renderAll();
}
function fromMe(id, key, v, title) {
  const input = $(id);
  if (v != null) { settings[key] = String(Math.floor(v)); input.value = settings[key]; save(); }
  input.disabled = v != null;
  input.classList.toggle('from-me', v != null);
  input.title = v != null ? title : '';
  renderAll();
}

function init() {
  $('sellHub').innerHTML = '<option value="best">Best hub per contract</option>'
    + HUBS.map(h => `<option value="${h.id}">${h.name}</option>`).join('');
  const reset = () => { cs.xLimit = cs.cLimit = PAGE; renderAll(); };
  for (const [id, key, ev] of [['flag', 'flag'], ['tax', 'tax', 'input'], ['cargo', 'cargo', 'input'], ['budget', 'budget', 'input'],
    ['structures', 'structures']]) {
    bind(id, () => settings[key], (v) => { settings[key] = v; }, ev, reset);
  }
  bind('sellHub', () => settings.sellHub, (v) => { settings.sellHub = v; }, 'change', () => { reset(); if (lp.offers) priceOffers(); });
  bind('mode', () => settings.mode, (v) => { settings.mode = v; }, 'change', reset);
  bind('scope', () => settings.scope, (v) => { settings.scope = v; });
  bind('minPrice', () => settings.minPrice, (v) => { settings.minPrice = v; $('minPrice').classList.toggle('bad', v !== '' && parseAmount(v) == null); }, 'input', () => {});
  for (const [id, k, ev] of [['xMinProfit', 'minProfit', 'input'], ['xMaxMargin', 'maxMargin', 'input'], ['xMaxJumps', 'maxJumps', 'input'],
    ['xRank', 'rank'], ['xQuery', 'q', 'input'], ['xPriced', 'priced'], ['xAuctions', 'auctions']]) {
    bind(id, () => settings.x[k], (v) => { settings.x[k] = v; }, ev, reset);
  }
  for (const [id, k, ev] of [['cMinReward', 'minReward', 'input'], ['cMaxCollateral', 'maxCollateral', 'input'], ['cMaxJumps', 'maxJumps', 'input'],
    ['cBackJumps', 'backJumps', 'input'], ['cRank', 'rank'], ['cFits', 'fits']]) {
    bind(id, () => settings.c[k], (v) => { settings.c[k] = v; }, ev, reset);
  }
  bind('lpCorp', () => settings.lp.corp, (v) => { settings.lp.corp = v; }, 'change', selectCorp);
  bind('lpHave', () => settings.lp.have, (v) => { settings.lp.have = v; }, 'input', () => renderLp(false));
  bind('lpRank', () => settings.lp.rank, (v) => { settings.lp.rank = v; }, 'change', renderLp);
  bind('lpHideBp', () => settings.lp.hideBp, (v) => { settings.lp.hideBp = v; }, 'change', renderLp);

  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    settings.tab = b.dataset.tab; save(); renderAll();
  });
  $('tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = ['items', 'courier', 'lp'];
    const i = (tabs.indexOf(settings.tab) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    settings.tab = tabs[i]; save(); renderAll();
    $(`tab-${tabs[i]}`).focus();
  });
  $('scanBtn').addEventListener('click', startScan);
  $('xMore').addEventListener('click', () => { cs.xLimit += PAGE; renderItems(); });
  $('cMore').addEventListener('click', () => { cs.cLimit += PAGE; renderCourier(); });
  $('xBody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const id = Number(tr.dataset.id);
    cs.open = cs.open === id ? null : id;
    renderItems();
  });

  createMe({
    el: $('me'), returnTo: '/contracts.html', systemName: sysName, isk,
    shipInfo: (id) => (types?.[id] ? { name: types[id][0], cargo: types[id][2] === 6 ? types[id][3] ?? null : null } : null),
    onFollow: followLocation,
    onCargo: (m3) => fromMe('cargo', 'cargo', m3, 'From your current ship (base hold) — turn off in the character menu to edit'),
    onBudget: (v) => fromMe('budget', 'budget', v, 'Your wallet balance — turn off in the character menu to edit'),
  });

  fetch('data/universe.json').then(r => r.json()).then(u => { graph = buildGraph(u); initHome(); cs.xMemo = cs.cMemo = null; renderAll(); })
    .catch(() => { $('home').placeholder = 'Star map unavailable'; });
  fetch('data/types.json').then(r => r.json()).then(t => { types = t; renderAll(); }).catch(() => {});
  fetch('data/stations.json').then(r => (r.ok ? r.json() : {})).then(s => { stations = s; renderAll(); }).catch(() => {});
  poll().then(() => { if (!cs.result && cs.status?.result) loadResult(); });
  renderAll();
}

init();
