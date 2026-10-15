// Warfare page: null-sec sovereignty and faction warfare occupancy, who dominates each system in
// practice, sov campaigns, and which alliances and corporations are fighting, on one star map.
//
// Sources (all public, through the app's caching proxy):
//   ESI  /sovereignty/map/, /sovereignty/campaigns/, /sovereignty/structures/, /fw/systems/,
//        /universe/system_kills/ and /universe/names/
//   zKillboard /api/kills/… for the regions with the most kills, and for any alliance, corporation
//        or system you look at. Its killmails carry attackers and victim, so no ESI killmail calls.
// The maths lives in war-data.js and the painting in war-map.js; this file is state, fetching and DOM.
//
// Kept in this browser (localStorage, war.settings). Colour by, window and regions are mirrored in
// the query string.

import { WarMap } from './war-map.js';
import { secColor, secLabel, isLightTheme } from './map.js';
import { buildGraph, systemInfo, isNullSec, isHighSec } from './galaxy.js';
import { createMe } from './me.js';
import { formatIsk } from './arbitrage.js';
import { readUrl, writeUrl } from './url-state.js';
import { factionName } from './fw.js';
import {
  sideId, sideKind, allianceColor, sovIndex, territories, campaignRows, structuresBySystem, fights, efficiency,
  hotRegions, idsToName, dominance, dominanceBySide, fwIndex,
} from './war-data.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const LS = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota or disabled */ } },
};
const DEFAULTS = {
  colorBy: 'sov', space: 'null', window: 10800, regions: 6, mapLayout: '3d',
  lOwner: true, lKills: true, lCampaigns: true, lFights: true, mutual: false, alliOnly: false,
};
const URL_FIELDS = [['colorBy', ['sov', 'dom']], ['space', ['null', 'lownull', 'all']], ['window', [3600, 10800, 86400]], ['regions', [3, 6, 10, 16]]];
const settings = { ...DEFAULTS, ...LS.get('war.settings', {}) };
readUrl(settings, DEFAULTS, URL_FIELDS);
const save = () => { LS.set('war.settings', settings); writeUrl(settings, DEFAULTS, URL_FIELDS); };

let graph = null;
const raw = { sov: [], campaigns: [], structures: [], kills: [], fw: [] };
const killmails = new Map();   // killmail_id → zKillboard killmail
const asked = new Set();       // zKillboard paths already loaded (per window)
const names = new Map();       // id → name
const ui = { coreAt: null, coreError: null, fightsBusy: 0, fightsDone: 0, fightsTodo: 0, fightsError: null, picked: null, focus: null };
let d = null;   // derived: compute()

// Whether a system is in the Space picked: null-sec, low and null, or anywhere (J-space too).
function inSpace(sid) {
  if (settings.space === 'all') return true;
  const info = graph && systemInfo(graph, sid);
  if (!info) return false;   // J-space and anything else off the star map
  return settings.space === 'null' ? isNullSec(info.sec) : !isHighSec(info.sec);
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------
async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function loadCore() {
  try {
    const [sov, campaigns, structures, kills, fw] = await Promise.all([
      'sovereignty/map/', 'sovereignty/campaigns/', 'sovereignty/structures/', 'universe/system_kills/', 'fw/systems/',
    ].map(p => getJson(`/api/esi/${p}`)));
    Object.assign(raw, { sov, campaigns, structures, kills, fw });
    ui.coreAt = Date.now(); ui.coreError = null;
  } catch (e) { ui.coreError = e.message; }
  compute();
  render();
  resolveNames();
}

// One zKillboard list; its killmails join the pool. Paths are relative to /api/zkill/.
async function loadZkill(path) {
  const key = `${path}|${settings.window}`;
  if (asked.has(key)) return 0;
  asked.add(key);
  try {
    const rows = await getJson(`/api/zkill/${path}pastSeconds/${settings.window}/`);
    let added = 0;
    for (const km of Array.isArray(rows) ? rows : []) if (km?.killmail_id && !killmails.has(km.killmail_id)) { killmails.set(km.killmail_id, km); added++; }
    return added;
  } catch (e) { asked.delete(key); throw e; }
}

// The hottest regions, one at a time (zKillboard takes about one request a second).
async function loadFights() {
  if (!graph) return;
  const regions = hotRegions(raw.kills, (sid) => systemInfo(graph, sid)?.regionId ?? null, settings.regions, inSpace);
  ui.fightsTodo = regions.length; ui.fightsDone = 0; ui.fightsError = null; ui.fightsBusy++;
  render();
  for (const { regionId } of regions) {
    try { await loadZkill(`kills/regionID/${regionId}/`); } catch (e) { ui.fightsError = e.message; }
    ui.fightsDone++;
    compute(); render();
  }
  ui.fightsBusy--;
  resolveNames();
  render();
}

async function loadExtra(path) {
  ui.fightsBusy++; render();
  try { if (await loadZkill(path)) { compute(); resolveNames(); } } catch (e) { ui.fightsError = e.message; }
  ui.fightsBusy--;
  render();
}
const ZKILL_KIND = { alliance: 'allianceID', corporation: 'corporationID', faction: 'factionID' };
const loadSide = (key) => loadExtra(`kills/${ZKILL_KIND[sideKind(key)]}/${sideId(key)}/`);
const loadSystem = (sid) => loadExtra(`kills/systemID/${sid}/`);

// ESI answers a whole batch with 404 if any id is unknown, so a failed batch is split in two.
async function nameBatch(ids) {
  if (!ids.length) return;
  const r = await fetch('/api/esi/universe/names/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ids) });
  if (r.ok) { for (const x of await r.json()) names.set(x.id, x.name); return; }
  if (ids.length === 1) { names.set(ids[0], null); return; }
  const h = Math.ceil(ids.length / 2);
  await Promise.all([nameBatch(ids.slice(0, h)), nameBatch(ids.slice(h))]);
}
let naming = null;
async function resolveNames() {
  if (naming) return naming.then(resolveNames);
  const todo = idsToName({ sov: d?.sov, campaigns: raw.campaigns, fightSides: d?.fights.sides }).filter(id => !names.has(id));
  if (!todo.length) return;
  naming = (async () => { for (let i = 0; i < todo.length; i += 500) await nameBatch(todo.slice(i, i + 500)).catch(() => {}); })();
  await naming;
  naming = null;
  fillFind();
  render();
}

// ---------------------------------------------------------------------------
// Derived data
// ---------------------------------------------------------------------------
function compute() {
  const cutoff = Date.now() - settings.window * 1000;
  const recent = [...killmails.values()].filter(km => Date.parse(km.killmail_time) >= cutoff && inSpace(km.solar_system_id));
  const sov = sovIndex(raw.sov);
  const f = fights(recent);
  const dom = dominance(f.systems);
  d = {
    sov, fights: f, dom, domSides: dominanceBySide(dom), fw: fwIndex(raw.fw),
    terr: territories(sov, raw.kills, raw.campaigns, raw.structures),
    camps: campaignRows(raw.campaigns),
    structs: structuresBySystem(raw.structures),
    kills: new Map(raw.kills.map(r => [r.system_id, { ship: r.ship_kills || 0, pod: r.pod_kills || 0, npc: r.npc_kills || 0 }])),
  };
  d.campBySys = new Map(d.camps.map(c => [c.systemId, c]));
  d.terrBy = new Map(d.terr.map(t => [t.allianceId, t]));
  d.domBy = new Map(d.domSides.map(r => [r.side, r]));
  if (ui.focus) setFocus(ui.focus.kind, ui.focus.key, { fit: false });
}

// ---------------------------------------------------------------------------
// Names and colours
// ---------------------------------------------------------------------------
function idName(id) {
  if (id >= 500000 && id < 501000) return names.get(id) || factionName(id);
  return names.get(id) || `#${id}`;
}
const sideName = (key) => idName(sideId(key));
const colorOf = (key) => allianceColor(sideId(key), isLightTheme());
const sysName = (sid) => (graph ? systemInfo(graph, sid)?.name : null) || names.get(sid) || `System ${sid}`;

function sideHtml(key, { link = true } = {}) {
  const kind = sideKind(key);
  const tag = kind === 'corporation' ? '<small>corp</small>' : kind === 'faction' ? '<small>NPC faction</small>' : '';
  const inner = `<i class="sw-a" style="--c:${colorOf(key)}"></i><span>${esc(sideName(key))}</span>${tag}`;
  return link ? `<a href="#" class="side-name" data-side="${key}">${inner}</a>` : `<span class="side-name">${inner}</span>`;
}

// What colours a system on the map, per Colour by.
function owner(sid) {
  if (!d) return null;
  if (settings.colorBy === 'dom') {
    const x = d.dom.get(sid);
    return x ? { key: x.side, color: colorOf(x.side), strength: x.contested ? 0.3 : 1 } : null;
  }
  const s = d.sov.get(sid);
  if (s?.alliance) return { key: `a:${s.alliance}`, color: colorOf(`a:${s.alliance}`), strength: 1 };
  const fw = d.fw.get(sid);
  if (fw) return { key: `f:${fw.occupier}`, color: colorOf(`f:${fw.occupier}`), strength: fw.status === 'uncontested' ? 1 : 0.4 };
  // NPC null-sec has no sov to claim: whoever dominates it holds it in practice, drawn faint.
  const x = d.dom.get(sid);
  if (s?.faction && x && !x.contested && isNullSec(systemInfo(graph, sid)?.sec ?? 1)) return { key: x.side, color: colorOf(x.side), strength: 0.3 };
  return null;
}

// ---------------------------------------------------------------------------
// Focus: an alliance/corp, a conflict or nothing, highlighted on the map
// ---------------------------------------------------------------------------
function setFocus(kind, key, { fit = true } = {}) {
  if (!kind) { ui.focus = null; return; }
  const systems = new Set();
  let label = '';
  if (kind === 'side') {
    if (key.startsWith('a:')) for (const s of d.terrBy.get(sideId(key))?.systemIds || []) systems.add(s);
    for (const s of d.fights.sides.get(key)?.systems.keys() || []) systems.add(s);
    if (key.startsWith('f:')) for (const [s, fw] of d.fw) if (fw.occupier === sideId(key)) systems.add(s);
    label = sideHtml(key, { link: false });
  } else if (kind === 'conflict') {
    const c = d.fights.conflicts.find(x => `${x.a}|${x.b}` === key);
    for (const s of c?.systems.keys() || []) systems.add(s);
    const [a, b] = key.split('|');
    label = `${sideHtml(a, { link: false })} <span>vs</span> ${sideHtml(b, { link: false })}`;
  }
  ui.focus = { kind, key, systems, label };
  if (fit && systems.size) map.fitSystems([...systems]);
}

function focusSide(key) {
  ui.picked = null;
  setFocus('side', key);
  render();
  loadSide(key);
}

function pickSystem(sid) {
  ui.picked = sid;
  render();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const ago = (t) => {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const until = (t) => {
  const m = Math.round((t - Date.now()) / 60000);
  return m <= 0 ? 'now' : m < 60 ? `in ${m}m` : `in ${Math.floor(m / 60)}h ${m % 60}m`;
};
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const WINDOW_LABEL = { 3600: '1 h', 10800: '3 h', 86400: '24 h' };

function render() {
  renderStatus();
  if (!d) return;
  renderFocus();
  renderCampaigns();
  renderDominance();
  renderAlliances();
  renderConflicts();
  renderDetail();
  $('legendOwner').textContent = settings.colorBy === 'dom'
    ? 'Dominant side (faint where contested)' : 'Sov holder or FW occupier; faint: contested, or NPC null-sec held by kills';
  map.setWar({
    owner, kills: d.kills, campaigns: d.campBySys, fights: d.fights.systems, focus: ui.focus?.systems || null, picked: ui.picked,
    layers: { owner: settings.lOwner, kills: settings.lKills, campaigns: settings.lCampaigns, fights: settings.lFights },
    tooltip,
  });
}

function renderStatus() {
  const parts = [];
  if (!graph) parts.push('Loading star map…');
  else if (ui.coreError) parts.push(`ESI unavailable (${ui.coreError})`);
  else if (!ui.coreAt) parts.push('Loading sovereignty…');
  else parts.push(`sov & kills as of ${new Date(ui.coreAt).toISOString().slice(11, 16)} EVE`);
  $('status').textContent = parts.join(' · ');
  const f = d?.fights;
  $('fightStatus').textContent = [
    ui.fightsBusy ? `Loading zKillboard${ui.fightsTodo ? ` (${ui.fightsDone}/${ui.fightsTodo} regions)` : ''}…` : '',
    f ? `${plural(f.kills, 'kill')} · ${formatIsk(f.isk)} ISK in the last ${WINDOW_LABEL[settings.window]}` : '',
    ui.fightsError ? `zKillboard: ${ui.fightsError}` : '',
  ].filter(Boolean).join(' · ');
}

function renderFocus() {
  const f = ui.focus;
  $('focusInfo').innerHTML = f
    ? `Showing ${f.label} <span>· ${plural(f.systems.size, 'system')}</span> <button id="clearFocus" class="btn small ghost" type="button">Clear</button>`
    : '<span>Click an alliance, conflict or system for details</span>';
  $('mapFitFocus').disabled = !f?.systems.size;
}

function renderCampaigns() {
  $('campCount').textContent = d.camps.length || '';
  $('campList').innerHTML = d.camps.length ? d.camps.map(c => {
    const info = graph && systemInfo(graph, c.systemId);
    return `<li><button type="button" class="wf-camp" data-sys="${c.systemId}">
      <span class="what">${esc(c.label)} · ${esc(info?.name || c.systemId)}<small>${esc(info?.region || '')}</small></span>
      <span class="when ${c.upcoming ? 'upcoming' : ''}">${c.upcoming ? until(c.start) : `${pct(c.attackers)} · ${ago(c.start)}`}</span>
      <span class="who">Defender&nbsp;${sideHtml(`a:${c.defender}`, { link: false })}</span>
      <span class="score" title="Attackers ${pct(c.attackers)}, defenders ${pct(c.defenders)}"><i style="width:${Math.round(c.attackers * 100)}%"></i></span>
    </button></li>`;
  }).join('') : `<li class="empty">${ui.coreAt ? 'No sov campaigns right now.' : 'Loading…'}</li>`;
}

function renderDominance() {
  const rows = d.domSides.filter(r => !settings.alliOnly || r.side.startsWith('a:')).slice(0, 80);
  $('domCount').textContent = rows.length ? d.domSides.reduce((t, r) => t + r.held.length, 0) + ' systems held' : '';
  $('domBody').innerHTML = rows.length ? rows.map(r => {
    const sov = r.side.startsWith('a:') ? d.terrBy.get(sideId(r.side))?.systems : null;
    return `<tr data-side="${r.side}" class="${ui.focus?.key === r.side ? 'on' : ''}">
      <td class="l">${sideHtml(r.side, { link: false })}</td>
      <td>${r.held.length || ''}</td><td class="dim">${r.leading.length || ''}</td><td>${r.kills}</td><td class="dim">${sov || ''}</td></tr>`;
  }).join('') : `<tr><td class="l dim" colspan="5">${ui.fightsBusy ? 'Loading zKillboard…' : 'No fights loaded yet.'}</td></tr>`;
}

function renderAlliances() {
  $('allCount').textContent = d.terr.length || '';
  $('allBody').innerHTML = d.terr.map(t => {
    const key = `a:${t.allianceId}`;
    return `<tr data-side="${key}" class="${ui.focus?.key === key ? 'on' : ''}">
      <td class="l">${sideHtml(key, { link: false })}</td><td>${t.systems}</td><td>${t.ships || ''}</td>
      <td>${t.adm == null ? '' : t.adm.toFixed(1)}</td><td>${t.campaigns ? `<span class="tag">${t.campaigns}</span>` : ''}</td></tr>`;
  }).join('');
}

function renderConflicts() {
  let rows = d.fights.conflicts;
  if (settings.mutual) rows = rows.filter(c => c.kills[c.a] > 0 && c.kills[c.b] > 0);
  if (settings.alliOnly) rows = rows.filter(c => c.a.startsWith('a:') && c.b.startsWith('a:'));
  $('fightCount').textContent = rows.length || '';
  $('fightBody').innerHTML = rows.slice(0, 150).map(c => {
    const share = c.totalIsk > 0 ? c.isk[c.a] / c.totalIsk : 0.5;
    const where = [...c.systems].sort((x, y) => y[1] - x[1]);
    const key = `${c.a}|${c.b}`;
    const win = (s) => (c.isk[s] > c.isk[s === c.a ? c.b : c.a] ? 'win' : 'lose');
    return `<tr data-conflict="${key}" class="${ui.focus?.key === key ? 'on' : ''}">
      <td class="l">${sideHtml(c.a)}</td><td class="${win(c.a)}">${c.kills[c.a]}</td><td class="${win(c.a)}">${formatIsk(c.isk[c.a])}</td>
      <td class="l"><span class="wf-bar" title="${pct(share)} of the ISK destroyed was killed by ${esc(sideName(c.a))}"><i style="--c:${colorOf(c.a)};width:${share * 100}%"></i><i style="--c:${colorOf(c.b)};width:${(1 - share) * 100}%"></i></span></td>
      <td class="${win(c.b)}">${formatIsk(c.isk[c.b])}</td><td class="${win(c.b)}">${c.kills[c.b]}</td><td class="l">${sideHtml(c.b)}</td>
      <td class="l">${esc(sysName(where[0][0]))}${where.length > 1 ? ` <span class="dim">+${where.length - 1}</span>` : ''}</td><td>${ago(c.last)}</td></tr>`;
  }).join('') || `<tr><td class="l dim" colspan="9">${ui.fightsBusy ? 'Loading zKillboard…' : 'No player fights in the loaded killmails.'}</td></tr>`;
}

function renderDetail() {
  if (ui.picked != null) return void ($('detail').innerHTML = systemDetail(ui.picked));
  if (ui.focus?.kind === 'side') return void ($('detail').innerHTML = sideDetail(ui.focus.key));
  $('detail').innerHTML = '';
}

function stat(v, label, cls = '') { return `<div class="st ${cls}"><b>${v}</b><span>${label}</span></div>`; }

function sideDetail(key) {
  const s = d.fights.sides.get(key);
  const t = key.startsWith('a:') ? d.terrBy.get(sideId(key)) : null;
  const dm = d.domBy.get(key);
  const eff = s ? efficiency(s.iskKilled, s.iskLost) : null;
  const enemies = d.fights.conflicts.filter(c => c.a === key || c.b === key).slice(0, 8);
  const kind = sideKind(key), id = sideId(key);
  const zk = `https://zkillboard.com/${kind}/${id}/`;
  return `<div class="card">
    <h3>${sideHtml(key, { link: false })}</h3>
    <div class="stats">
      ${t ? stat(t.systems, 'sov systems') : ''}
      ${stat(dm?.held.length || 0, 'systems dominated')}
      ${stat(s?.kills || 0, 'kills', 'good')}${stat(s?.losses || 0, 'losses', 'bad')}
      ${stat(formatIsk(s?.iskKilled || 0), 'ISK destroyed')}${stat(formatIsk(s?.iskLost || 0), 'ISK lost')}
      ${stat(pct(eff), 'ISK efficiency', eff == null ? '' : eff >= 0.5 ? 'good' : 'bad')}
      ${t?.adm != null ? stat(t.adm.toFixed(1), 'avg ADM') : ''}
    </div>
    ${enemies.length ? `<div class="facts"><span>Fighting (last ${WINDOW_LABEL[settings.window]})</span></div><ul>${enemies.map(c => {
      const other = c.a === key ? c.b : c.a;
      return `<li>${sideHtml(other)}<span class="n">${plural(c.kills[key], 'kill')} · ${c.kills[other]} loss${c.kills[other] === 1 ? '' : 'es'} · ${formatIsk(c.isk[key])} / ${formatIsk(c.isk[other])}</span></li>`;
    }).join('')}</ul>` : `<div class="facts">${ui.fightsBusy ? 'Loading its killmails…' : 'No fights in the loaded killmails.'}</div>`}
    <div class="links"><a href="${zk}" target="_blank" rel="noopener">zKillboard</a>
      ${kind !== 'faction' ? `<a href="https://evewho.com/${kind === 'alliance' ? 'alliance' : 'corporation'}/${id}" target="_blank" rel="noopener">EveWho</a>` : ''}</div>
  </div>`;
}

function systemDetail(sid) {
  const info = graph && systemInfo(graph, sid);
  const sov = d.sov.get(sid), fw = d.fw.get(sid), dm = d.dom.get(sid), k = d.kills.get(sid), camp = d.campBySys.get(sid);
  const f = d.fights.systems.get(sid);
  const structs = d.structs.get(sid) || [];
  const hhmm = (t) => new Date(t).toISOString().slice(11, 16);
  const facts = [];
  if (sov?.alliance) facts.push(`<span>Sov ${sideHtml(`a:${sov.alliance}`)}</span>`);
  else if (sov?.faction && !fw) facts.push(`<span>${info && isNullSec(info.sec) ? 'NPC null-sec' : 'Empire space'}: <b>${esc(idName(sov.faction))}</b></span>`);
  if (fw) facts.push(`<span>Occupied by ${sideHtml(`f:${fw.occupier}`)} · ${esc(fw.status)}${fw.contest ? ` ${pct(fw.contest)}` : ''}</span>`);
  for (const s of structs) facts.push(`<span>${s.type} ADM <b>${s.adm?.toFixed(1) ?? '—'}</b>${s.vulnStart ? ` · vulnerable ${hhmm(s.vulnStart)}–${hhmm(s.vulnEnd)} EVE` : ''}</span>`);
  if (camp) facts.push(`<span style="color:var(--violet)">${esc(camp.label)} campaign: attackers ${pct(camp.attackers)}${camp.upcoming ? ` (starts ${until(camp.start)})` : ''}</span>`);
  return `<div class="card">
    <h3>${esc(info?.name || sid)} ${info ? `<span class="sec" style="color:${secColor(info.sec)}">${secLabel(info.sec)}</span><small>${esc(info.region)}</small>` : ''}</h3>
    <div class="facts">${facts.join('') || '<span>No sovereignty or warzone here.</span>'}</div>
    <div class="stats">
      ${stat(k?.ship || 0, 'ship kills/h')}${stat(k?.pod || 0, 'pod kills/h')}${stat(k?.npc || 0, 'NPC kills/h')}
      ${stat(f?.kills || 0, `PvP kills, ${WINDOW_LABEL[settings.window]}`)}${stat(formatIsk(f?.isk || 0), 'ISK destroyed')}
    </div>
    ${dm ? `<div class="facts"><span>Dominance: ${dm.contested ? '<b>contested</b>' : `<b>${pct(dm.share)}</b> of kills by the leader`}</span></div>
      <ul>${dm.contenders.slice(0, 6).map(([s, n]) => `<li>${sideHtml(s)}<span class="n">${plural(n, 'kill')}</span></li>`).join('')}</ul>`
      : '<div class="facts"><span>No player kills loaded here.</span></div>'}
    <div class="links">
      <button type="button" class="linkish" data-load-sys="${sid}">Load this system's kills from zKillboard</button>
      <a href="https://zkillboard.com/system/${sid}/" target="_blank" rel="noopener">zKillboard</a>
      ${info ? `<a href="https://evemaps.dotlan.net/system/${encodeURIComponent(info.name.replace(/ /g, '_'))}" target="_blank" rel="noopener">Dotlan</a>` : ''}
    </div>
  </div>`;
}

function tooltip(sid) {
  const info = graph && systemInfo(graph, sid);
  if (!info || !d) return '';
  const sov = d.sov.get(sid), fw = d.fw.get(sid), dm = d.dom.get(sid), k = d.kills.get(sid), camp = d.campBySys.get(sid), f = d.fights.systems.get(sid);
  const war = [];
  if (k && (k.ship || k.pod)) war.push(`<span class="k">${k.ship} ships, ${k.pod} pods killed in the last hour</span>`);
  if (f) war.push(`<span class="f">${plural(f.kills, 'PvP kill')} · ${formatIsk(f.isk)} ISK (${WINDOW_LABEL[settings.window]})</span>`);
  if (camp) war.push(`<span class="c">${esc(camp.label)} campaign · attackers ${pct(camp.attackers)}</span>`);
  return `<b>${esc(info.name)}</b> <span class="sec" style="--sec:${secColor(info.sec)};color:${secColor(info.sec)}">${secLabel(info.sec)}</span>
    <div class="reg">${esc(info.region)}</div>
    ${sov?.alliance ? `<div class="holder">Sov&nbsp;${sideHtml(`a:${sov.alliance}`, { link: false })}</div>` : ''}
    ${fw ? `<div class="holder">FW&nbsp;${sideHtml(`f:${fw.occupier}`, { link: false })}&nbsp;· ${esc(fw.status)}</div>` : ''}
    ${dm ? `<div class="holder">${dm.contested ? 'Contested, led by' : 'Dominated by'}&nbsp;${sideHtml(dm.side, { link: false })}&nbsp;${pct(dm.share)}</div>` : ''}
    ${war.length ? `<div class="war">${war.join('<br>')}</div>` : ''}`;
}

function fillFind() {
  const opts = new Set();
  for (const t of d?.terr || []) opts.add(idName(t.allianceId));
  for (const k of d?.fights.sides.keys() || []) opts.add(sideName(k));
  $('findList').innerHTML = [...opts].filter(n => !n.startsWith('#')).sort().map(n => `<option value="${esc(n)}">`).join('');
}

function find(text) {
  const q = text.trim().toLowerCase();
  if (!q || !d) return;
  for (const k of [...d.terr.map(t => `a:${t.allianceId}`), ...d.fights.sides.keys()]) {
    if (sideName(k).toLowerCase() === q) return focusSide(k);
  }
  if (graph) {
    for (let i = 0; i < graph.n; i++) {
      if (graph.name[i].toLowerCase() === q) { map.fitSystems([graph.id[i]]); return pickSystem(graph.id[i]); }
    }
  }
}

// ---------------------------------------------------------------------------
// Map and wiring
// ---------------------------------------------------------------------------
const map = new WarMap($('mapCanvas'), { tooltip: $('mapTip'), onPickSystem: (sid) => pickSystem(sid) });

function bindSetting(id, key, { parse = (v) => v, after } = {}) {
  const el = $(id);
  const isCheck = el.type === 'checkbox';
  if (isCheck) el.checked = !!settings[key]; else el.value = String(settings[key] ?? '');
  el.addEventListener('change', () => {
    settings[key] = isCheck ? el.checked : parse(el.value);
    save();
    after?.();
    render();
  });
}

function bind() {
  bindSetting('colorBy', 'colorBy');
  bindSetting('window', 'window', { parse: Number, after: () => { compute(); loadFights(); if (ui.focus?.kind === 'side') loadSide(ui.focus.key); } });
  bindSetting('regions', 'regions', { parse: Number, after: () => loadFights() });
  bindSetting('space', 'space', { after: () => { compute(); loadFights(); } });
  bindSetting('mapLayout', 'mapLayout', { after: () => map.setLayout(settings.mapLayout) });
  for (const [id, key] of [['lOwner', 'lOwner'], ['lKills', 'lKills'], ['lCampaigns', 'lCampaigns'], ['lFights', 'lFights'], ['mutual', 'mutual'], ['alliOnly', 'alliOnly']]) bindSetting(id, key);

  $('find').addEventListener('change', (e) => find(e.target.value));
  $('find').addEventListener('keydown', (e) => { if (e.key === 'Enter') find(e.target.value); });
  $('mapZoomIn').addEventListener('click', () => map.zoomBy(1.5));
  $('mapZoomOut').addEventListener('click', () => map.zoomBy(1 / 1.5));
  $('mapFitAll').addEventListener('click', () => map.fitAll());
  $('mapFitFocus').addEventListener('click', () => ui.focus?.systems.size && map.fitSystems([...ui.focus.systems]));
  $('refreshBtn').addEventListener('click', () => { asked.clear(); loadCore().then(loadFights); });

  // Clicks anywhere on the page: a side's name, a table row, a campaign, Clear.
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('#clearFocus')) { ui.focus = null; ui.picked = null; return render(); }
    const loadSys = t.closest('[data-load-sys]');
    if (loadSys) return loadSystem(Number(loadSys.dataset.loadSys));
    const side = t.closest('a[data-side], tr[data-side]');
    if (side) { e.preventDefault(); return focusSide(side.dataset.side); }
    const conflict = t.closest('tr[data-conflict]');
    if (conflict) { ui.picked = null; setFocus('conflict', conflict.dataset.conflict); return render(); }
    const camp = t.closest('[data-sys]');
    if (camp) { const sid = Number(camp.dataset.sys); map.fitSystems([sid]); return pickSystem(sid); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.target.closest('input, select, textarea')) { ui.focus = null; ui.picked = null; render(); }
  });
  addEventListener('themechange', () => render());
}

function init() {
  bind();
  map.setLayout(settings.mapLayout);
  const me = createMe({ el: $('me'), returnTo: '/warfare.html', systemName: sysName, isk: (v) => formatIsk(v), onFollow: () => {} });
  fetch('data/universe.json')
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then(u => {
      graph = buildGraph(u);
      map.setUniverse(u);
      $('mapMsg').hidden = true;
      me.reapply();
      return loadCore().then(loadFights);
    })
    .catch(e => { $('mapMsg').textContent = `Star map data unavailable (${e.message}). Run “npm run build:map”.`; });
  render();
  // ESI's kill counts and sov change hourly at most; zKillboard is cached for an hour.
  setInterval(() => { if (document.visibilityState === 'visible') { asked.clear(); loadCore().then(loadFights); } }, 20 * 60_000);
}

init();
