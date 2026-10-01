// Route planner page: a stack of waypoints flown leg by leg over the stargate map plus the wormhole
// shortcuts in use (shortcuts.js), drawn on the star map (map.js / map3d.js) as numbered stops.
// The maths lives in route-plan.js; this file is state, DOM and the map.
//
// Kept in this browser (localStorage, routes.*): settings, the stack, systems to avoid and saved
// routes. The stack, avoid list and route settings are mirrored in the query string, so a link
// carries the whole route.

import { GalaxyMap, secColor, secLabel } from './map.js';
import { createMapSwitch, loadThree, migrateMapLayout } from './map-switch.js';
import { buildGraph, systemInfo } from './galaxy.js';
import { withLinks, isJSpace, whSummary } from './wormholes.js';
import { createShortcuts, mountToggle, SOURCE_LABEL, pairKey } from './shortcuts.js';
import { createMe } from './me.js';
import { formatIsk } from './arbitrage.js';
import { readUrl, writeUrl } from './url-state.js';
import {
  FLAGS, FLAG_LABEL, planRoute, findPath, jumpMatrix, optimizeOrder, orderCost, usableLinks, linkShipSize, linkExpiry,
  routeSummary, parseWaypointText, chatLinks, encodeStops, decodeStops, formatDuration, UNREACHABLE,
  parseBridgeText, bridgeText, lyBetween, BRIDGE_RANGE_LY,
} from './route-plan.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const LS = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota or disabled */ } },
};
const MAX_STOPS = 40;
const DEFAULTS = {
  flag: 'secure', ship: '', minLeft: '0', hotKills: '', secPerJump: 45, passJ: true, roundTrip: false, keepEnd: false,
  mapLayout: 'space', secColors: true, mode: 'add', onlyNotable: false,
};
const settings = { ...DEFAULTS, ...migrateMapLayout(LS.get('routes.settings', {})) };
const URL_FIELDS = [
  ['flag', FLAGS], ['ship', ['', 'medium', 'large', 'xlarge', 'capital']], ['minLeft', ['0', '30', '60', '120', '240']],
  'hotKills', 'passJ', 'roundTrip',
];
let stops = LS.get('routes.stops', []).filter(s => s?.id > 0);
let avoid = LS.get('routes.avoid', []).filter(id => id > 0);
let saved = LS.get('routes.saved', []);

// A shared link carries the route: wp = the stack, av = systems to avoid.
{
  const q = new URLSearchParams(location.search);
  readUrl(settings, DEFAULTS, URL_FIELDS);
  if (q.has('wp')) stops = decodeStops(q.get('wp')).slice(0, MAX_STOPS);
  if (q.has('av')) avoid = q.get('av').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0);
}

function save() {
  LS.set('routes.settings', settings);
  LS.set('routes.stops', stops);
  LS.set('routes.avoid', avoid);
  writeUrl(settings, DEFAULTS, URL_FIELDS);
  const q = new URLSearchParams(location.search);
  if (stops.length) q.set('wp', encodeStops(stops)); else q.delete('wp');
  if (avoid.length) q.set('av', avoid.join(',')); else q.delete('av');
  const qs = q.toString().replace(/%2C/g, ',').replace(/%3A/g, ':');   // readable share links
  history.replaceState(history.state, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
}

const ui = { bridgeFrom: null, kills: null, traffic: null, liveAt: 0, liveError: null, note: '', fitOnce: true, dragFrom: -1 };
const sc = createShortcuts({ onChange: () => { drawToggle?.(); syncScout(); render(); } });
let base = null, systems = null, drawToggle = null, meCtl = null, memo = null;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sysName = (id) => sc.sysName(id);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------------------
// Travel graph: stargates plus the shortcuts this route may use
// ---------------------------------------------------------------------------
// Jump bridges have their own switch; the rest count while wormholes are on.
const offered = () => sc.links().filter(l => sc.settings.on || l.src === 'bridge');

function travel() {
  if (!base) return null;
  const links = usableLinks(offered(), { ship: settings.ship, minLeftMs: Number(settings.minLeft) * 60_000, whInfo: sc.whInfo });
  const key = `${links.map(l => l.key).sort().join(',')}|${sc.names.size}`;
  if (memo?.key !== key) memo = { key, g: withLinks(base, links, sc.names), links: new Map(links.map(l => [l.key, l])) };
  return memo.g;
}
const linkFor = (a, b) => memo?.links.get(pairKey(a, b)) || null;
const isShortcut = (a, b) => !!memo?.g.shortcuts?.has(pairKey(a, b));

function hotSystems() {
  const min = Number(settings.hotKills);
  if (!(min > 0) || !ui.kills) return [];
  return [...ui.kills].filter(([, k]) => k.ship + k.pod >= min).map(([id]) => id);
}

function routeOpts() {
  const mine = new Set(stops.map(s => s.id));
  const av = new Set([...avoid, ...hotSystems()].filter(id => !mine.has(id)));
  return { flag: settings.flag, avoid: av, passJSpace: settings.passJ };
}

function plan() {
  const g = travel();
  if (!g || !stops.length) return null;
  const flown = settings.roundTrip && stops.length > 1 ? [...stops, { id: stops[0].id }] : stops;
  const opts = routeOpts();
  const r = planRoute(g, flown, opts);
  // What the same stack costs without any shortcut, to show what the wormholes save.
  const gates = g.shortcuts?.size ? planRoute(base, flown, opts) : null;
  return { ...r, g, opts, gatesJumps: gates && !gates.broken ? gates.jumps : null };
}

// ---------------------------------------------------------------------------
// Editing the stack
// ---------------------------------------------------------------------------
function changed({ fit = false } = {}) {
  ui.note = '';
  save();
  render({ fit });
}

function addStop(id, at = stops.length) {
  if (!id || stops.length >= MAX_STOPS) return;
  if (stops[at - 1]?.id === id) return;   // the same system twice in a row is no waypoint
  stops.splice(at, 0, { id });
  sc.resolveNames([id]);
  changed({ fit: stops.length <= 2 });
}

// The position where a new waypoint adds fewest jumps (never before your start).
function insertBest(id) {
  const g = travel();
  if (!g || stops.length < 2) return addStop(id);
  const opts = routeOpts();
  const jumps = (a, b) => findPath(g, a, b, opts)?.jumps ?? UNREACHABLE;
  let best = stops.length, bestCost = jumps(stops[stops.length - 1].id, id);
  for (let k = 1; k < stops.length; k++) {
    const c = jumps(stops[k - 1].id, id) + jumps(id, stops[k].id) - jumps(stops[k - 1].id, stops[k].id);
    if (c < bestCost) { bestCost = c; best = k; }
  }
  addStop(id, best);
  ui.note = `Inserted ${sysName(id)} as waypoint ${best}: ${bestCost >= UNREACHABLE ? 'no route' : `+${plural(bestCost, 'jump')}`}.`;
  render();
}

function setStart(id) {
  if (stops.length && stops[0].id === id) return;
  if (stops.length) stops[0] = { id }; else stops.push({ id });
  sc.resolveNames([id]);
  changed();
}

function toggleAvoid(id) {
  avoid = avoid.includes(id) ? avoid.filter(a => a !== id) : [...avoid, id];
  changed();
}

function move(from, to) {
  if (from === to || to < 0 || to >= stops.length) return;
  const [s] = stops.splice(from, 1);
  stops.splice(to, 0, s);
  changed();
}

function optimize() {
  const g = travel();
  if (!g || stops.length < 3) return;
  const ids = stops.map(s => s.id), opts = routeOpts();
  const d = jumpMatrix(g, ids, opts);
  const before = orderCost(d, ids.map((_, i) => i), settings.roundTrip);
  const order = optimizeOrder(d, { keepEnd: settings.keepEnd, roundTrip: settings.roundTrip });
  const after = orderCost(d, order, settings.roundTrip);
  if (after < before) stops = order.map(i => stops[i]);
  save();
  ui.note = after < before
    ? `Reordered: ${before >= UNREACHABLE ? 'now' : `${before} →`} ${plural(after, 'jump')}${before < UNREACHABLE ? `, ${before - after} fewer` : ''}.`
    : 'Already the shortest order.';
  render({ fit: true });
}

// Names (or chat links) typed or pasted → system IDs; J-codes and Thera through ESI.
async function resolveTokens(tokens) {
  const found = [], missing = [];
  for (const t of tokens) {
    const id = t.id || await sc.systemByName(t.name).catch(() => null);
    if (id) found.push(id); else missing.push(t.name);
  }
  return { found, missing };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function secTag(g, id) {
  const s = systemInfo(g, id);
  if (!s || isJSpace(id) || s.regionId == null) return '<span class="sec js" title="Wormhole space">J</span>';
  return `<span class="sec" style="--sec:${secColor(s.sec)}">${secLabel(s.sec)}</span>`;
}

function left(ms) {
  if (!ms) return '';
  const d = ms - Date.now();
  if (d <= 0) return 'closing';
  return d >= 3_600_000 ? `${Math.floor(d / 3_600_000)}h ${Math.floor((d % 3_600_000) / 60_000)}m left` : `${Math.ceil(d / 60_000)}m left`;
}

function viaHtml(a, b) {
  const l = linkFor(a, b);
  if (!l) return isShortcut(a, b) ? '<span class="wh">Wormhole</span>' : '<span class="muted">Gate</span>';
  const info = l.type ? sc.whInfo(l.type) : null;
  const ship = linkShipSize(l, sc.whInfo);
  const exp = left(linkExpiry(l));
  if (l.src === 'bridge') return `<span class="wh bridge" title="${esc(['Jump bridge (Ansiblex): any ship but capitals', l.note].filter(Boolean).join('\n'))}">Jump bridge${l.note ? ` · ${esc(l.note)}` : ''}</span>`;
  const bits = [l.kind === 'jump' ? 'Jump' : 'Wormhole', l.type, ship && `${ship} ships`, exp].filter(Boolean);
  const title = [info ? whSummary(info) : l.note, `Source: ${SOURCE_LABEL[l.src] || l.src}`].filter(Boolean).join('\n');
  return `<span class="wh${ship ? '' : ' unknown'}" title="${esc(title)}">${esc(bits.join(' · '))}</span>`;
}

function renderStack(p) {
  const g = p?.g || travel();
  $('stackCount').textContent = stops.length ? `· ${stops.length}` : '';
  if (!stops.length) {
    $('stack').innerHTML = '<li class="empty">Click systems on the map, or type one below. The first is where you start.</li>';
    return;
  }
  $('stack').innerHTML = stops.map((s, k) => {
    const leg = k ? p?.legs[k - 1] : null;
    const info = g && systemInfo(g, s.id);
    const legText = !k ? '<span class="leg start">Start</span>'
      : !leg?.path ? '<span class="leg bad">No route</span>'
        : `<span class="leg${leg.fallback ? ' warn' : ''}" title="${leg.fallback === 'flag' ? `No ${FLAG_LABEL[leg.flag].toLowerCase()} route: this leg leaves it`
          : leg.fallback === 'avoid' ? 'Every way passes an avoided system: this leg goes through one' : ''}">${plural(leg.jumps, 'jump')}${leg.fallback ? ' ⚠' : ''}</span>`;
    const flagSel = k ? `<select data-flag="${k}" aria-label="Route preference for the leg to ${esc(sysName(s.id))}" title="Route preference for this leg">
        <option value="">Default</option>${FLAGS.map(f => `<option value="${f}"${s.flag === f ? ' selected' : ''}>${FLAG_LABEL[f]}</option>`).join('')}</select>` : '';
    return `<li draggable="true" data-k="${k}">
      <span class="grip" aria-hidden="true">⋮⋮</span>
      <span class="n${k ? '' : ' s'}">${k ? k : 'S'}</span>
      <span class="who"><b>${esc(sysName(s.id))}</b> ${g ? secTag(g, s.id) : ''}<small>${esc(info?.region || (isJSpace(s.id) ? 'Wormhole space' : ''))}</small></span>
      ${legText}
      ${flagSel}
      <span class="ops">
        <button type="button" class="x" data-up="${k}" aria-label="Move up" title="Move up"${k ? '' : ' disabled'}>↑</button>
        <button type="button" class="x" data-down="${k}" aria-label="Move down" title="Move down"${k < stops.length - 1 ? '' : ' disabled'}>↓</button>
        <button type="button" class="x" data-del="${k}" aria-label="Remove" title="Remove">×</button>
      </span>
    </li>`;
  }).join('');
}

function renderSummary(p) {
  const box = $('summary');
  if (!p || stops.length < 2) {
    box.innerHTML = (stops.length === 1 ? `Starting in <b>${esc(sysName(stops[0].id))}</b>. Add a destination.` : '')
      + (ui.note ? `<span class="note">${esc(ui.note)}</span>` : '');
    return;
  }
  const s = routeSummary(p.g, p.path, isShortcut);
  const kills = p.path.slice(1).reduce((t, id) => { const k = ui.kills?.get(id); return t + (k ? k.ship + k.pod : 0); }, 0);
  const hot = p.path.slice(1).filter(id => (ui.kills?.get(id)?.ship ?? 0) > 0).length;
  const saved = p.gatesJumps != null && p.gatesJumps > p.jumps ? p.gatesJumps - p.jumps : 0;
  let holes = 0, bridged = 0;
  for (let i = 1; i < p.path.length; i++) {
    if (isShortcut(p.path[i - 1], p.path[i])) { if (linkFor(p.path[i - 1], p.path[i])?.src === 'bridge') bridged++; else holes++; }
  }
  const what = [holes && 'wormholes', bridged && 'jump bridges'].filter(Boolean).join(' and ');
  const stat = (v, l, cls = '') => `<div class="st ${cls}"><b>${v}</b><span>${l}</span></div>`;
  box.innerHTML = `<div class="stats">
      ${stat(p.jumps, 'jumps', 'main')}
      ${stat(formatDuration(p.jumps * Number(settings.secPerJump || 45)), 'estimated')}
      ${stat(s.high, 'high-sec')}
      ${stat(s.low, 'low-sec', s.low ? 'low' : '')}
      ${stat(s.null, 'null-sec', s.null ? 'null' : '')}
      ${s.jspace || holes ? stat(holes, plural(holes, 'wormhole').replace(/^\d+ /, ''), 'wh') : ''}
      ${bridged ? stat(bridged, plural(bridged, 'bridge').replace(/^\d+ /, ''), 'wh') : ''}
      ${ui.kills ? stat(kills, `kills/h on route${hot ? ` · ${plural(hot, 'system')}` : ''}`, kills ? 'low' : '') : ''}
    </div>
    <p>${p.broken ? `<b class="bad">${plural(p.broken, 'leg')} with no route.</b> ` : ''}
      ${saved ? `<b class="whtext">${what ? what[0].toUpperCase() + what.slice(1) : 'Shortcuts'} save ${plural(saved, 'jump')}</b> (${p.gatesJumps} by stargates only). ` : ''}
      ${s.lowEntries ? `Leaves high-sec ${s.lowEntries === 1 ? 'once' : `${s.lowEntries} times`}. ` : ''}
      ${s.regions.length ? `Through ${esc(s.regions.join(' → '))}.` : ''}
      ${ui.note ? `<span class="note">${esc(ui.note)}</span>` : ''}</p>`;
}

function renderTable(p) {
  const body = $('routeBody');
  if (!p || stops.length < 2 || !p.path.length) {
    $('routeCount').textContent = '';
    body.innerHTML = `<tr><td class="l muted" colspan="9">${stops.length < 2 ? 'Add at least two systems.' : 'No route.'}</td></tr>`;
    return;
  }
  const g = p.g;
  // Which path index each waypoint lands on (legs join end to end).
  const wpAt = new Map();
  let at = 0;
  wpAt.set(0, ['Start']);
  p.legs.forEach((l, k) => {
    if (!l.path) return;
    at += l.jumps;
    const label = settings.roundTrip && k === p.legs.length - 1 ? 'Back at start' : `Waypoint ${k + 1}`;
    wpAt.set(at, [...(wpAt.get(at) || []), label]);
  });
  const forced = new Set();
  for (const l of p.legs) if (l.fallback === 'avoid' && l.path) for (const id of l.path.slice(1, -1)) if (p.opts.avoid.has(id)) forced.add(id);
  const hotMin = Number(settings.hotKills);
  const rows = p.path.map((id, i) => {
    const prev = i ? p.path[i - 1] : null;
    const k = ui.kills?.get(id), killsN = k ? k.ship + k.pod : 0;
    const info = systemInfo(g, id);
    const wasHigh = prev != null && systemInfo(g, prev) && systemInfo(g, prev).regionId != null && systemInfo(g, prev).sec >= 0.45;
    const nowHigh = info && info.regionId != null && info.sec >= 0.45;
    const notes = [...(wpAt.get(i) || []).map(w => `<span class="tag wp">${esc(w)}</span>`)];
    if (wasHigh && !nowHigh) notes.push('<span class="tag low">Leaves high-sec</span>');
    if (forced.has(id)) notes.push('<span class="tag bad">Avoided, no other way</span>');
    if (hotMin > 0 && killsN >= hotMin) notes.push('<span class="tag low">Hot</span>');
    const wh = prev != null && isShortcut(prev, id);
    const notable = wpAt.has(i) || wh || killsN > 0 || forced.has(id) || (wasHigh && !nowHigh);
    if (settings.onlyNotable && !notable) return '';
    return `<tr class="${wpAt.has(i) ? 'wp' : ''}${wh ? ' whrow' : ''}" data-id="${id}">
      <td class="l">${i}</td>
      <td class="l"><b>${esc(sysName(id))}</b></td>
      <td>${secTag(g, id)}</td>
      <td class="l">${esc(info?.region || (isJSpace(id) ? 'Wormhole space' : '—'))}</td>
      <td class="l">${i ? viaHtml(prev, id) : ''}</td>
      <td class="${killsN ? 'hotv' : 'muted'}">${k ? `${k.ship} / ${k.pod}` : ui.kills ? '0 / 0' : '—'}</td>
      <td class="muted">${ui.traffic ? (ui.traffic.get(id) ?? 0).toLocaleString('en-US') : '—'}</td>
      <td class="l">${notes.join(' ')}</td>
      <td class="ops">
        <button type="button" class="x" data-add="${id}" title="Add as a waypoint here" aria-label="Add ${esc(sysName(id))} as a waypoint">+</button>
        <button type="button" class="x" data-avoid="${id}" title="${avoid.includes(id) ? 'Stop avoiding' : 'Avoid this system'}" aria-label="Avoid ${esc(sysName(id))}">⊘</button>
      </td>
    </tr>`;
  });
  $('routeCount').textContent = `· ${plural(p.jumps, 'jump')}`;
  body.innerHTML = rows.join('') || '<tr><td class="l muted" colspan="9">Nothing notable on this route.</td></tr>';
}

function renderAvoid() {
  const hot = hotSystems();
  $('avoidCount').textContent = avoid.length || hot.length ? `· ${avoid.length}${hot.length ? ` + ${hot.length} hot` : ''}` : '';
  $('avoidList').innerHTML = avoid.length
    ? avoid.map(id => `<li>${esc(sysName(id))} <button type="button" class="x" data-unavoid="${id}" aria-label="Stop avoiding ${esc(sysName(id))}">×</button></li>`).join('')
    : '<li class="empty">No systems.</li>';
}

// ---------------------------------------------------------------------------
// Jump bridges
// ---------------------------------------------------------------------------
const ly = (a, b) => (systems ? lyBetween(systems, base.indexOf.get(a), base.indexOf.get(b)) : null);
const lyText = (d) => (d == null ? '' : `${d.toFixed(d < 10 ? 1 : 0)} ly`);

// Bridge mode: the first click picks one end, the second adds the bridge.
function bridgeEnd(id) {
  if (isJSpace(id)) { ui.note = 'Jump bridges only join known space.'; return render(); }
  if (!ui.bridgeFrom || ui.bridgeFrom === id) {
    ui.bridgeFrom = ui.bridgeFrom === id ? null : id;
    ui.note = ui.bridgeFrom ? `Bridge from ${sysName(id)}: click the other end.` : '';
    return render();
  }
  const a = ui.bridgeFrom, d = ly(a, id);
  ui.bridgeFrom = null;
  const added = sc.addBridges([{ a, b: id }]);
  ui.note = added ? `Added the bridge ${sysName(a)} » ${sysName(id)}${d != null ? ` (${lyText(d)}${d > BRIDGE_RANGE_LY ? ', beyond an Ansiblex\'s 5 ly' : ''})` : ''}.`
    : `You already have ${sysName(a)} » ${sysName(id)}.`;
  render();
}

function renderBridges() {
  const list = sc.bridges(), on = sc.settings.bridges;
  $('useBridges').checked = on;
  $('bridgeCount').textContent = list.length ? `· ${list.length}${on ? '' : ' · off'}` : '';
  $('bridgeCountLink').textContent = list.length ? `(${list.length})` : 'add';
  $('bridgeList').innerHTML = list.length ? list.map((b) => {
    const d = ly(b.a, b.b), far = d != null && d > BRIDGE_RANGE_LY;
    return `<li class="${on ? '' : 'off'}">
      <span class="ends"><b>${esc(sysName(b.a))}</b> ${secTag(base, b.a)} » <b>${esc(sysName(b.b))}</b> ${secTag(base, b.b)}</span>
      <small class="${far ? 'far' : ''}" title="${far ? 'Farther than an Ansiblex reaches: check the pair' : 'Distance'}">${lyText(d)}${far ? ' ⚠' : ''}</small>
      <button type="button" class="x" data-unbridge="${b.key}" aria-label="Remove the bridge ${esc(sysName(b.a))} to ${esc(sysName(b.b))}">×</button>
      ${b.note ? `<small class="note">${esc(b.note)}</small>` : ''}
    </li>`;
  }).join('') : '<li class="empty">None yet.</li>';
  $('bridgeCopy').disabled = $('bridgeClear').disabled = !list.length;
}

function renderSaved() {
  $('savedList').innerHTML = saved.length ? saved.map((r, k) => `<li>
      <button type="button" class="link" data-load="${k}" title="${esc(r.stops.map(s => sysName(s.id)).join(' → '))}">${esc(r.name)}</button>
      <small>${plural(r.stops.length, 'stop')}</small>
      <button type="button" class="x" data-unsave="${k}" aria-label="Delete ${esc(r.name)}">×</button>
    </li>`).join('') : '<li class="empty">None yet.</li>';
}

function renderMap(p, fit) {
  if (!base) return;
  const path = p?.path?.length > 1 ? p.path : stops.map(s => s.id);
  const marks = new Map();
  stops.forEach((s, k) => {
    const m = marks.get(s.id) || { systemId: s.id, ns: [], label: sysName(s.id) };
    m.ns.push(k ? String(k) : 'S');
    marks.set(s.id, m);
  });
  if (ui.bridgeFrom) marks.set(-1, { systemId: ui.bridgeFrom, ns: ['B'], label: `Bridge from ${sysName(ui.bridgeFrom)}: click the other end` });
  galaxy.setTrip(marks.size ? { path, stops: [...marks.values()].map(m => ({ systemId: m.systemId, n: m.ns.join(','), label: m.label })) } : null);
  if (fit && path.length) galaxy.fitPath(path);
}

function render({ fit = false } = {}) {
  for (const b of document.querySelectorAll('[data-mode]')) b.setAttribute('aria-checked', String(b.dataset.mode === settings.mode));
  const p = plan();
  renderStack(p);
  renderSummary(p);
  renderTable(p);
  renderAvoid();
  renderSaved();
  if (base) renderBridges();
  if (p) sc.resolveNames(p.path.filter(id => !base.indexOf.has(id)));
  renderMap(p, fit || (ui.fitOnce && base && stops.length > 1));
  if (base && stops.length > 1) ui.fitOnce = false;
  $('optimizeBtn').disabled = stops.length < 3;
  const n = memo?.links.size ?? 0;
  $('status').textContent = !base ? 'Loading star map…'
    : `${n ? `${plural(n, 'shortcut')} in use · ` : ''}${ui.liveError ? `kills unavailable (${ui.liveError})` : ui.liveAt ? `kills as of ${new Date(ui.liveAt).toISOString().slice(11, 16)} EVE` : 'loading kills…'}`;
}

// ---------------------------------------------------------------------------
// Live data: kills and traffic per system in the last hour (ESI, public)
// ---------------------------------------------------------------------------
async function loadLive() {
  try {
    const [k, j] = await Promise.all(['universe/system_kills/', 'universe/system_jumps/'].map(async (p) => {
      const r = await fetch(`/api/esi/${p}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }));
    ui.kills = new Map(k.map(r => [r.system_id, { ship: r.ship_kills || 0, pod: r.pod_kills || 0 }]));
    ui.traffic = new Map(j.map(r => [r.system_id, r.ship_jumps || 0]));
    ui.liveAt = Date.now(); ui.liveError = null;
  } catch (e) { ui.liveError = e.message; }
  render();
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
function pick(id) {
  if (settings.mode === 'bridge') return bridgeEnd(id);
  if (settings.mode === 'start') setStart(id);
  else if (settings.mode === 'avoid') toggleAvoid(id);
  else if (settings.mode === 'insert') insertBest(id);
  else addStop(id);
}

const galaxy = createMapSwitch({
  flat: new GalaxyMap($('mapCanvas'), { tooltip: $('mapTip'), onPickSystem: pick }),
  create3d: async () => {
    const [THREE, { GalaxyMap3D }] = await Promise.all([loadThree(), import('./map3d.js')]);
    return new GalaxyMap3D($('mapGl'), $('mapOverlay'), { THREE, tooltip: $('mapTip'), onPickSystem: pick });
  },
  flatEl: $('mapCanvas'),
  spaceEls: [$('mapGl'), $('mapOverlay')],
  onUnavailable: (e) => {
    const opt = $('mapLayout').querySelector('option[value=space]');
    opt.disabled = true;
    opt.textContent = 'In-game 3D (unavailable)';
    opt.title = `The 3D map couldn't start: ${e.message}`;
    $('mapLayout').value = '3d';
  },
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function bindSetting(id, key, { parse = (v) => v, after } = {}) {
  const el = $(id);
  const isCheck = el.type === 'checkbox';
  if (isCheck) el.checked = !!settings[key]; else el.value = settings[key] ?? '';
  el.addEventListener('change', () => {
    settings[key] = isCheck ? el.checked : parse(el.value);
    save();
    after?.();
    render();
  });
}

// EVE Scout's Thera/Turnur feed is a shortcuts.js setting shared with every page.
function syncScout() { $('scout').checked = !!sc.settings.scout; }

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const was = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = was; }, 1200);
  } catch { prompt('Copy:', text); }
}

function bind() {
  bindSetting('flag', 'flag');
  bindSetting('ship', 'ship');
  bindSetting('minLeft', 'minLeft');
  bindSetting('hotKills', 'hotKills', { parse: v => (Number(v) > 0 ? String(Math.round(Number(v))) : '') });
  bindSetting('secPerJump', 'secPerJump', { parse: v => Math.min(600, Math.max(5, Number(v) || DEFAULTS.secPerJump)) });
  bindSetting('passJ', 'passJ');
  bindSetting('roundTrip', 'roundTrip');
  bindSetting('keepEnd', 'keepEnd');
  bindSetting('onlyNotable', 'onlyNotable');
  bindSetting('secColors', 'secColors', { after: () => galaxy.setSecurityColors(settings.secColors) });
  bindSetting('mapLayout', 'mapLayout', { after: () => galaxy.setLayout(settings.mapLayout).then(() => renderMap(plan(), true)) });
  $('scout').addEventListener('change', (e) => sc.update({ scout: e.target.checked }));
  $('useBridges').addEventListener('change', (e) => sc.update({ bridges: e.target.checked }));

  $('bridgeAdd').addEventListener('click', async () => {
    const pairs = parseBridgeText($('bridgeText').value);
    if (!pairs.length) { $('bridgeMsg').textContent = 'No pairs found: one bridge per line, like "1DQ1-A » 8QT-H4".'; return; }
    $('bridgeMsg').textContent = 'Looking up…';
    const found = [], missing = new Set();
    for (const p of pairs) {
      const [a, b] = await Promise.all([p.a, p.b].map(n => sc.systemByName(n).catch(() => null)));
      if (!a) missing.add(p.a);
      if (!b) missing.add(p.b);
      if (a && b && !isJSpace(a) && !isJSpace(b)) found.push({ a, b, note: p.note });
    }
    const added = sc.addBridges(found);
    const far = found.filter(f => (ly(f.a, f.b) ?? 0) > BRIDGE_RANGE_LY).length;
    $('bridgeMsg').textContent = `${plural(added, 'bridge')} added${found.length > added ? `, ${found.length - added} already there` : ''}`
      + `${missing.size ? `; not found: ${[...missing].join(', ')}` : ''}${far ? `; ${far} beyond 5 ly (flagged)` : ''}.`;
    if (!missing.size) $('bridgeText').value = '';
  });
  $('bridgeList').addEventListener('click', (e) => {
    const key = e.target.closest('[data-unbridge]')?.dataset.unbridge;
    if (key) sc.removeBridge(key);
  });
  $('bridgeCopy').addEventListener('click', (e) => copy(bridgeText(sc.bridges(), sysName), e.currentTarget));
  $('bridgeClear').addEventListener('click', () => { if (confirm(`Remove all ${sc.bridges().length} jump bridges?`)) sc.removeBridge(null); });

  const setMode = (mode) => { settings.mode = mode; ui.bridgeFrom = null; save(); render(); };
  for (const b of document.querySelectorAll('[data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, select, textarea, [contenteditable]')) return;
    const mode = { a: 'add', i: 'insert', s: 'start', x: 'avoid', b: 'bridge' }[e.key.toLowerCase()];
    if (mode) setMode(mode);
  });

  $('mapZoomIn').addEventListener('click', () => galaxy.zoomBy(1.6));
  $('mapZoomOut').addEventListener('click', () => galaxy.zoomBy(1 / 1.6));
  $('mapFitAll').addEventListener('click', () => galaxy.fitAll());
  $('mapFitRoute').addEventListener('click', () => { const p = plan(); if (p?.path.length) galaxy.fitPath(p.path); else galaxy.fitAll(); });

  $('addForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('addInput').value.trim();
    if (!text) return;
    const id = await sc.systemByName(text).catch(() => null);
    $('addInput').classList.toggle('bad', !id);
    if (!id) return;
    $('addInput').value = '';
    if (settings.mode === 'insert') insertBest(id); else if (settings.mode === 'start') setStart(id); else addStop(id);
  });

  // The stack: per-leg preference, up/down/remove, and drag to reorder.
  const stack = $('stack');
  stack.addEventListener('change', (e) => {
    const k = Number(e.target.dataset.flag);
    if (!(k > 0)) return;
    if (e.target.value) stops[k].flag = e.target.value; else delete stops[k].flag;
    changed();
  });
  stack.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.up) move(Number(b.dataset.up), Number(b.dataset.up) - 1);
    else if (b.dataset.down) move(Number(b.dataset.down), Number(b.dataset.down) + 1);
    else if (b.dataset.del) { stops.splice(Number(b.dataset.del), 1); changed(); }
  });
  stack.addEventListener('dragstart', (e) => {
    const li = e.target.closest('li[data-k]');
    if (!li) return;
    ui.dragFrom = Number(li.dataset.k);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', li.dataset.k);
    li.classList.add('dragging');
  });
  stack.addEventListener('dragover', (e) => {
    const li = e.target.closest('li[data-k]');
    if (!li || ui.dragFrom < 0) return;
    e.preventDefault();
    for (const x of stack.querySelectorAll('.over')) x.classList.remove('over');
    li.classList.add('over');
  });
  stack.addEventListener('drop', (e) => {
    const li = e.target.closest('li[data-k]');
    if (!li || ui.dragFrom < 0) return;
    e.preventDefault();
    const from = ui.dragFrom;
    ui.dragFrom = -1;
    move(from, Number(li.dataset.k));
  });
  stack.addEventListener('dragend', () => { ui.dragFrom = -1; render(); });

  $('optimizeBtn').addEventListener('click', optimize);
  $('reverseBtn').addEventListener('click', () => {
    // Each leg's preference stays with the leg, which now runs the other way.
    const flags = stops.map(s => s.flag);
    stops = stops.map(s => ({ id: s.id })).reverse();
    flags.slice(1).reverse().forEach((f, k) => { if (f) stops[k + 1].flag = f; });
    changed({ fit: true });
  });
  $('clearBtn').addEventListener('click', () => { stops = []; changed(); });

  const paste = async (replace) => {
    const tokens = parseWaypointText($('pasteText').value);
    if (!tokens.length) return;
    $('pasteMsg').textContent = 'Looking up…';
    const { found, missing } = await resolveTokens(tokens);
    if (replace) stops = [];
    for (const id of found) if (stops.length < MAX_STOPS && stops[stops.length - 1]?.id !== id) stops.push({ id });
    sc.resolveNames(found);
    $('pasteMsg').textContent = `${plural(found.length, 'system')} added${missing.length ? `; not found: ${missing.join(', ')}` : ''}.`;
    if (!missing.length) $('pasteText').value = '';
    changed({ fit: true });
  };
  $('pasteAdd').addEventListener('click', () => paste(false));
  $('pasteReplace').addEventListener('click', () => paste(true));

  $('copyNames').addEventListener('click', (e) => copy(stops.map(s => sysName(s.id)).join('\n'), e.currentTarget));
  $('copyLinks').addEventListener('click', (e) => copy(chatLinks(stops.map(s => ({ id: s.id, name: sysName(s.id) }))), e.currentTarget));
  $('copyRoute').addEventListener('click', (e) => {
    const p = plan();
    copy((p?.path || []).map((id, i) => `${i}. ${sysName(id)}`).join('\n'), e.currentTarget);
  });
  $('copyShare').addEventListener('click', (e) => { save(); copy(location.href, e.currentTarget); });

  $('routeBody').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b?.dataset.avoid) return toggleAvoid(Number(b.dataset.avoid));
    if (b?.dataset.add) return insertBest(Number(b.dataset.add));
    const tr = e.target.closest('tr[data-id]');
    if (tr) galaxy.fitPath([Number(tr.dataset.id)]);
  });
  $('avoidList').addEventListener('click', (e) => {
    const id = Number(e.target.closest('[data-unavoid]')?.dataset.unavoid);
    if (id) toggleAvoid(id);
  });

  $('saveForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('saveName').value.trim() || stops.map(s => sysName(s.id)).slice(0, 3).join(' → ');
    if (!stops.length || !name) return;
    saved = [{ name, stops: structuredClone(stops), at: Date.now() }, ...saved.filter(r => r.name !== name)].slice(0, 30);
    LS.set('routes.saved', saved);
    $('saveName').value = '';
    renderSaved();
  });
  $('savedList').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b?.dataset.load) { stops = structuredClone(saved[Number(b.dataset.load)].stops); sc.resolveNames(stops.map(s => s.id)); changed({ fit: true }); }
    else if (b?.dataset.unsave) { saved.splice(Number(b.dataset.unsave), 1); LS.set('routes.saved', saved); renderSaved(); }
  });

  $('refreshBtn').addEventListener('click', () => { sc.refresh(true); loadLive(); });

  // Another tab changed the stack or saved a route.
  window.addEventListener('storage', (e) => {
    if (e.key === 'routes.saved') { saved = LS.get('routes.saved', []); renderSaved(); }
  });
}

function init() {
  bind();
  syncScout();
  drawToggle = mountToggle($('whToggle'), sc);
  galaxy.setSecurityColors(settings.secColors);
  galaxy.setLayout(settings.mapLayout);
  meCtl = createMe({
    el: $('me'), returnTo: '/route-planner.html', systemName: sysName, isk: (v) => formatIsk(v),
    // Following your location makes your system the start of the stack.
    onFollow: (loc) => { if (loc?.systemId && base) setStart(loc.systemId); },
  });
  fetch('data/universe.json')
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then(u => {
      base = buildGraph(u);
      systems = u.systems;
      sc.setBase(base);
      galaxy.setUniverse(u);
      galaxy.update({ shown: [], hubs: [], top: null, sel: null, maxV: 0, pathFor: () => null });
      $('systemList').innerHTML = [...base.name].sort().map(n => `<option value="${esc(n)}">`).join('');
      $('mapMsg').hidden = true;
      sc.resolveNames([...stops.map(s => s.id), ...avoid]);
      if (stops.length < 2) galaxy.fitAll();
      render();
      meCtl.reapply();
    })
    .catch(e => { $('mapMsg').textContent = `Star map data unavailable (${e.message}). Run “npm run build:map”.`; });
  render();
  loadLive();
  // ESI updates both counts hourly.
  setInterval(() => { if (document.visibilityState === 'visible') loadLive(); }, 15 * 60_000);
}

init();
