// Contracts › Corp buyback: the buyback calculator (buyback.js maths, Jita 4-4 prices from
// Fuzzwork) and a copy of the game's Create Contract window filled in for it.
//
// Signed in, the buyback suggests what you mined (mining ledger) and what you own (assets), and
// the contract is addressed to your corporation unless you type another name. The mining page's
// "Ore you own" panel hands items over through the same stored list (addToBuyback).

import { formatIsk } from './arbitrage.js';
import { parseFuzzwork, isNpcStation } from './market-merge.js';
import { parsePaste } from './mining-value.js';
import { itemPic, copyButton } from './watchlist.js';
import {
  BASES, EXPIRATIONS, appraise, brokerFee, eveDate, contractIsk, receiveAmount, byLocation, itemsText, contractItems,
  summaryText, harvestable, minedTypes, mergeItems, placeOf,
} from './buyback.js';

const JITA_STATION = 60003760;
const DAY = 86_400_000;
const SCOPE = { assets: 'esi-assets.read_assets.v1', mining: 'esi-industry.read_character_mining.v1' };
const KIND_LABEL = { ore: 'Ore', moon: 'Moon ore', ice: 'Ice', gas: 'Gas', mineral: 'Mineral' };
const AVAIL = { public: 'Public', private: 'Private', corp: 'My Corporation' };
// Storage keys kept from when the buyback lived on the mining page, so saved lists carry over.
const KEY = { settings: 'mining.buyback.settings', items: 'mining.buyback.items' };
export const BUYBACK_PAGE = 'corp-buyback.html';

const LS = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota or disabled */ } },
};
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isk = (v) => formatIsk(v);
const num = (v) => (v == null || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString('en-US'));
const m3 = (v) => `${(Math.round(v * 100) / 100).toLocaleString('en-US')} m³`;
const $ = (id) => document.getElementById(id);

function parseAmount(v) {
  const m = String(v ?? '').trim().toLowerCase().replace(/[, _]/g, '').match(/^(\d*\.?\d+)([kmb]?)$/);
  if (!m) return null;
  return Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1);
}
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

const storedItems = () => LS.get(KEY.items, []).filter(it => it?.typeId > 0 && it.qty > 0);  // [{typeId, qty, locationId?}]

/** Adds items to the stored buyback list from another page (honours "Pasting replaces the list"). */
export function addToBuyback(list) {
  const replace = !!LS.get(KEY.settings, {}).replace;
  LS.set(KEY.items, mergeItems(storedItems(), list, { replace }));
}

/**
 * @param {object} o
 * @param {() => object|null} o.types          types.json, once loaded
 * @param {() => Map|null} o.typeByName        lower-case name → type ID
 * @param {() => object|null} o.stations       stations.json, once loaded
 * @param {(id: number) => string} o.sysName
 * @param {() => object|null} o.me             createMe() controller
 */
export function createBuyback({ types, typeByName, stations, sysName, me }) {
  const DEFAULTS = { basis: 'split', rate: 85, corp: 'Eagle Wing Industries', availability: 'private', expiry: 28, desc: '', replace: false };
  const settings = { ...DEFAULTS, ...LS.get(KEY.settings, {}) };
  const saveSettings = () => LS.set(KEY.settings, settings);
  let items = storedItems();
  const saveItems = () => LS.set(KEY.items, items);
  const prices = {};            // typeId → {buy, sell} | null (no orders)
  const priced = { at: 0, loading: false, error: null };
  const acct = { corp: null, ledger: null, assets: null, loading: { assets: false, mining: false }, errors: {}, forChar: null };
  const ui = { step: 4, loc: null };

  const name = (t) => types()?.[t]?.[0] || `Type ${t}`;
  const kindOf = (t) => (typeof types()?.[t]?.[4] === 'string' ? types()[t][4] : null);
  const volOf = (t) => types()?.[t]?.[1] || 0;
  const status = () => me()?.status;
  const hasScope = (k) => !!status()?.scopes?.includes(SCOPE[k]);

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------
  async function fetchPrices(force = false) {
    const want = [...new Set(items.map(it => it.typeId))].filter(t => force || !(t in prices));
    if (!want.length && !(force && items.length)) return;
    priced.loading = true; priced.error = null; render();
    try {
      const ids = force ? [...new Set(items.map(it => it.typeId))] : want;
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const res = await fetch(`/api/fuzzwork/aggregates/?station=${JITA_STATION}&types=${chunk.join(',')}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const got = parseFuzzwork(await res.json());
        for (const t of chunk) prices[t] = got[t] && (got[t].buy != null || got[t].sell != null) ? { buy: got[t].buy, sell: got[t].sell } : null;
      }
      priced.at = Date.now();
    } catch (e) { priced.error = e.message; }
    priced.loading = false;
    render();
  }

  async function getJson(url) {
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  }

  async function loadAccount(what) {
    if (!status()?.loggedIn) return;
    if (what === 'corp') {
      acct.corp = await getJson('/api/me/corporation').catch(() => null);
    } else {
      if (!hasScope(what)) { acct.errors[what] = 'needs-scope'; render(); return; }
      acct.loading[what] = true; render();
      try {
        const v = await getJson(`/api/me/${what}`);
        if (what === 'assets') acct.assets = v; else acct.ledger = v;
        delete acct.errors[what];
      } catch (e) { acct.errors[what] = e.message; }
      acct.loading[what] = false;
    }
    render();
  }

  // Once per signed-in character: corp name, ledger and assets.
  function statusChanged() {
    const s = status();
    const who = s?.loggedIn ? s.characterId : null;
    if (who === acct.forChar) { render(); return; }
    Object.assign(acct, { corp: null, ledger: null, assets: null, errors: {}, forChar: who });
    if (who) { loadAccount('corp'); loadAccount('mining'); loadAccount('assets'); }
    render();
  }

  // -------------------------------------------------------------------------
  // Editing
  // -------------------------------------------------------------------------
  function add(list, { replace = false } = {}) {
    items = mergeItems(items, list, { replace });
    saveItems(); ui.loc = null;
    render(); fetchPrices();
  }

  function addPasted(text) {
    const map = typeByName();
    if (!map) return;
    const { items: got, unknown } = parsePaste(text, (n) => map.get(n.toLowerCase()) ?? null);
    $('bbPasteNote').textContent = got.length || unknown.length
      ? `${got.length} item${got.length === 1 ? '' : 's'} added${unknown.length ? ` · not recognised: ${unknown.slice(0, 4).join(', ')}${unknown.length > 4 ? '…' : ''}` : ''}` : '';
    if (got.length) add(got, { replace: settings.replace });
  }

  function addFromInputs() {
    const t = typeByName()?.get($('bbName').value.trim().toLowerCase());
    const q = $('bbQty').value.trim() ? parseAmount($('bbQty').value) : 1;
    $('bbName').classList.toggle('bad', !t);
    $('bbQty').classList.toggle('bad', !(q > 0));
    if (!t || !(q > 0)) return;
    $('bbName').value = ''; $('bbQty').value = '';
    add([{ typeId: t, qty: Math.round(q) }]);
    $('bbName').focus();
  }

  // -------------------------------------------------------------------------
  // Places
  // -------------------------------------------------------------------------
  const place = (l) => placeOf(l, { stations: stations(), locations: acct.assets?.locations, sysName, isNpcStation });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  const rate = () => Math.max(0, Number(settings.rate) || 0);
  const withVol = (list) => list.map(it => ({ ...it, volume: volOf(it.typeId) }));

  function renderCalc(a) {
    const lineOf = new Map(a.lines.map((l, i) => [items[i] ? `${items[i].typeId}:${items[i].locationId || 0}` : i, l]));
    $('bbCount').textContent = items.length ? `· ${items.length} item${items.length > 1 ? 's' : ''}, ${m3(a.m3)}` : '';
    $('bbUnitHead').textContent = `${BASES[settings.basis]} / unit`;
    const multiLoc = byLocation(items).size > 1;
    $('bbBody').innerHTML = items.map((it) => {
      const key = `${it.typeId}:${it.locationId || 0}`;
      const l = lineOf.get(key);
      const kind = kindOf(it.typeId);
      const p = prices[it.typeId];
      const pending = !(it.typeId in prices);
      const cell = (v) => (pending ? `<span class="muted">${priced.loading ? '…' : '—'}</span>` : v == null ? '<span class="muted">no orders</span>' : isk(v));
      return `<tr data-k="${key}">
        <td class="l item">${itemPic(it.typeId, name(it.typeId), 24)} <span>${esc(name(it.typeId))}</span>${copyButton(name(it.typeId))}${kind ? `<span class="badge ov">${KIND_LABEL[kind]}</span>` : ''}${multiLoc ? `<small class="muted">${esc(place(it.locationId).short)}</small>` : ''}</td>
        <td><input class="qty" type="text" inputmode="numeric" data-bbqty="${key}" value="${it.qty}" aria-label="Units of ${esc(name(it.typeId))}"></td>
        <td>${num(l?.m3)}</td>
        <td>${cell(p?.buy)}</td>
        <td>${cell(p?.sell)}</td>
        <td>${cell(l?.unit)}</td>
        <td>${pending ? '' : isk(l?.value || 0)}</td>
        <td class="metric">${pending ? '' : isk(l?.payout || 0)}</td>
        <td><button class="del" type="button" data-bbdel="${key}" aria-label="Remove ${esc(name(it.typeId))}" title="Remove">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></td>
      </tr>`;
    }).join('') || '<tr class="empty"><td colspan="9" class="l muted">Nothing yet. Paste from your ore hold (Ctrl+V anywhere on this page), pick a suggestion or add an item above.</td></tr>';
    $('bbFoot').innerHTML = items.length ? `<tr>
      <td class="l">Total</td><td></td><td>${num(a.m3)}</td><td>${isk(a.buy)}</td><td>${isk(a.sell)}</td><td></td>
      <td>${isk(a.value)}</td><td class="metric">${isk(a.payout)}</td><td></td></tr>` : '';

    const kpi = (label, value, sub, cls = '') => `<div class="kpi ${cls}"><span>${label}</span><b>${value}</b><small>${sub}</small></div>`;
    $('bbKpis').innerHTML = items.length ? [
      kpi('Jita buy', isk(a.buy), 'Sell to buy orders'),
      kpi('Jita split', isk(a.split), 'Halfway between buy and sell'),
      kpi('Jita sell', isk(a.sell), 'List as sell orders'),
      kpi(`Buyback payout · ${rate()}%`, isk(receiveAmount(a.payout)), `of ${BASES[settings.basis]} ${isk(a.value)}`, 'hero'),
    ].join('') : '';

    const miss = a.missing.length ? ` · no Jita orders for ${a.missing.map(name).slice(0, 3).join(', ')}${a.missing.length > 3 ? '…' : ''}` : '';
    $('bbStatus').textContent = priced.error ? `Prices failed (${priced.error})`
      : priced.loading ? 'Loading Jita prices…' : priced.at ? `Jita 4-4 prices ${ago(priced.at)} (Fuzzwork)${miss}` : '';
    $('bbStatus').classList.toggle('warn', !!priced.error || !!a.missing.length);
    $('bbCopyItems').dataset.copy = itemsText(a.lines, name);
    $('bbCopySummary').dataset.copy = summaryText(a, { name, basis: settings.basis, rate: rate(), corp: corpName() });
    for (const id of ['bbCopyItems', 'bbCopySummary']) $(id).disabled = !items.length;
  }

  function renderSuggest() {
    const s = status();
    const el = $('bbSuggest');
    if (!s?.configured) { el.innerHTML = ''; return; }
    if (!s.loggedIn) {
      el.innerHTML = `<span class="hint">Log in with EVE (top right) to get suggestions from your mining ledger and assets.</span>`;
      return;
    }
    const chips = [];
    const chip = (t, qty, from, locationId = 0) => `<button type="button" class="bb-chip" data-add="${t}" data-q="${qty}" data-loc="${locationId}"
      title="Add ${num(qty)} ${esc(name(t))} (${from})">${itemPic(t, name(t), 20)}<span>${esc(name(t))}</span><small>${num(qty)}</small></button>`;
    // Owned: summed over every location, since a buyback can collect from anywhere you choose.
    const owned = new Map();
    for (const a of harvestable(acct.assets?.items, types())) owned.set(a.typeId, (owned.get(a.typeId) || 0) + a.qty);
    const ownedList = [...owned].sort((a, b) => b[1] * volOf(b[0]) - a[1] * volOf(a[0]));
    if (ownedList.length) chips.push(`<div class="bb-sug-row"><b>You own</b>${ownedList.slice(0, 16).map(([t, q]) => chip(t, q, 'owned, all locations')).join('')}</div>`);
    const mined = minedTypes(acct.ledger).filter(m => !owned.has(m.typeId));
    if (mined.length) chips.push(`<div class="bb-sug-row"><b>Mined, last 30 days</b>${mined.slice(0, 16).map(m => chip(m.typeId, m.qty, 'mined in the last 30 days')).join('')}</div>`);
    const note = (k, what) => (acct.loading[k] ? `Loading your ${what}…`
      : acct.errors[k] === 'needs-scope' ? `Sign out and in again to allow reading your ${what}.`
        : acct.errors[k] ? `Your ${what}: ${acct.errors[k]}` : '');
    const notes = [note('assets', 'assets'), note('mining', 'mining ledger')].filter(Boolean);
    el.innerHTML = chips.join('') + (notes.length ? `<p class="hint">${esc(notes.join(' · '))}</p>` : '')
      + (!chips.length && !notes.length ? '<p class="hint">No ore, ice or gas in your assets or mining ledger.</p>' : '');
  }

  const corpName = () => settings.corp.trim() || acct.corp?.name || '';
  const description = () => settings.desc.trim() || `Buyback ${rate()}% ${BASES[settings.basis]}`;

  function renderContract() {
    const groups = byLocation(items);
    const keys = [...groups.keys()];
    if (ui.loc == null || !groups.has(ui.loc)) ui.loc = keys[0] ?? 0;
    const sel = groups.get(ui.loc) || [];
    const a = appraise(withVol(sel), prices, { basis: settings.basis, rate: rate() });
    const receive = receiveAmount(a.payout);
    const fee = brokerFee(settings.availability, receive);
    const where = place(ui.loc);
    const exp = EXPIRATIONS.find(([d]) => d === Number(settings.expiry)) || EXPIRATIONS.at(-1);
    const corp = corpName();
    const radio = (group, value, label, checked, disabled = false) => `<label class="cw-radio"><input type="radio" name="cw-${group}" value="${value}"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}><i></i>${label}</label>`;
    const copy = (text, label) => `<button class="copy" type="button" data-copy="${esc(text)}" aria-label="Copy ${esc(label)}" title="Copy ${esc(label)}">`
      + '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg></button>';
    const locName = `${where.name}${where.systemId && !where.name.startsWith(sysName(where.systemId)) ? ` (${sysName(where.systemId)})` : ''}`;
    const avail = settings.availability === 'private' ? `Private (<span class="cw-link">${esc(corp || '—')}</span>)` : AVAIL[settings.availability];

    const steps = {
      1: ['Select Contract Type', `
        <h4>Contract Type</h4>
        ${radio('type', 'auction', 'Auction', false, true)}${radio('type', 'courier', 'Courier', false, true)}${radio('type', 'item', 'Item Exchange', true)}
        <label class="cw-check sub"><input type="checkbox" disabled><i></i>Assembled Ships</label>
        <h4>Availability</h4>
        ${radio('avail', 'public', 'Public', settings.availability === 'public')}
        ${radio('avail', 'private', 'Private', settings.availability === 'private')}
        <div class="cw-grid sub">
          <span>Name</span><span class="cw-field"><input id="cwCorp" type="text" value="${esc(settings.corp)}" placeholder="${esc(acct.corp?.name || 'Corporation name')}" spellcheck="false" aria-label="Contract for">${copy(corp, 'name')}</span>
          <span>Search By</span><span class="cw-field cw-select">Exact Terms</span>
        </div>
        ${radio('avail', 'corp', 'My Corporation', settings.availability === 'corp')}
        ${acct.corp && settings.corp.trim() !== acct.corp.name ? `<button class="btn small ghost cw-use" type="button" data-cw="mycorp">Use ${esc(acct.corp.name)} [${esc(acct.corp.ticker)}]</button>` : ''}`],
      2: ['Pick Items', `
        <div class="cw-field cw-select wide">${keys.length > 1
          ? `<select id="cwLoc" aria-label="Location">${keys.map(k => `<option value="${k}"${k === ui.loc ? ' selected' : ''}>${esc(place(k).name)} (${groups.get(k).length})</option>`).join('')}</select>`
          : esc(locName)}</div>
        ${keys.length > 1 ? '<p class="cw-note">Your items are in more than one place: one contract per station.</p>' : ''}
        <table class="cw-items"><thead><tr><th><i class="cw-box on"></i></th><th class="l">Type</th><th>Qty</th><th>Volume</th></tr></thead>
        <tbody>${sel.map(it => `<tr><td><i class="cw-box on"></i></td><td class="l">${itemPic(it.typeId, name(it.typeId), 20)} ${esc(name(it.typeId))}</td><td>${num(it.qty)}</td><td>${num(it.qty * volOf(it.typeId))}</td></tr>`).join('')
          || '<tr><td></td><td class="l muted" colspan="3">No items</td></tr>'}</tbody></table>
        <p class="cw-foot">Number of selected items: ${sel.length} ( ${m3(a.m3)} )</p>`],
      3: ['Select Options', `
        <div class="cw-grid opts">
          <span>I will pay</span><span class="cw-field num">0.00</span>
          <span>I will receive</span><span class="cw-field num strong">${receive.toLocaleString('en-US', { minimumFractionDigits: 2 })}${copy(String(receive), 'amount')}</span>
          <span>Expiration</span><span class="cw-field cw-select"><select id="cwExpiry" aria-label="Expiration">${EXPIRATIONS.map(([d, l]) => `<option value="${d}"${d === exp[0] ? ' selected' : ''}>${l}</option>`).join('')}</select></span>
          <span>Description (optional)</span><span class="cw-field"><input id="cwDesc" type="text" maxlength="120" value="${esc(settings.desc)}" placeholder="${esc(`Buyback ${rate()}% ${BASES[settings.basis]}`)}" aria-label="Description">${copy(description(), 'description')}</span>
        </div>
        <label class="cw-check"><input type="checkbox" disabled><i></i>Also request items from buyer</label>`],
      4: ['Confirm', `
        <dl class="cw-confirm">
          <dt>Contract Type</dt><dd>Item Exchange</dd>
          <dt>Description</dt><dd>${esc(description())}${copy(description(), 'description')}</dd>
          <dt>Availability</dt><dd>${avail}${settings.availability === 'private' && corp ? copy(corp, 'name') : ''}</dd>
          <dt>Location</dt><dd><span class="cw-link">${esc(locName)}</span></dd>
          <dt>Expiration</dt><dd>${eveDate(Date.now() + exp[0] * DAY)} (${exp[0]} day${exp[0] > 1 ? 's' : ''})</dd>
          <dt>Sales Tax</dt><dd>(None)</dd>
          <dt>Broker's Fee</dt><dd>${contractIsk(fee)}</dd>
          <dt>Deposit</dt><dd>0 ISK</dd>
          <dt class="rule">I will pay</dt><dd class="rule">0 ISK</dd>
          <dt>I will receive</dt><dd class="strong">${contractIsk(receive)}${copy(String(receive), 'amount')}</dd>
          <dt>Items For Sale</dt><dd>${contractItems(a.lines, name).map(esc).join('<br>') || '(None)'}</dd>
          <dt>Items Required</dt><dd></dd>
        </dl>`],
    };
    const [title, body] = steps[ui.step];
    $('cwWindow').innerHTML = `
      <div class="cw-title"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l4 4v14H6zM9 9h6M9 13h6M9 17h4"/></svg>Create Contract<span class="cw-x" aria-hidden="true">⋮ — ✕</span></div>
      <nav class="cw-steps" aria-label="Contract steps">${[1, 2, 3, 4].map(n => `<button type="button" data-step="${n}"${n === ui.step ? ' aria-current="step"' : ''}>${n}</button>`).join('')}</nav>
      <h3 class="cw-h">${title} (${ui.step}/4)</h3>
      <div class="cw-body">${body}</div>
      <div class="cw-buttons">
        <button type="button" class="cw-btn" data-step="${Math.max(1, ui.step - 1)}"${ui.step === 1 ? ' disabled' : ''}>Previous</button>
        ${ui.step < 4 ? `<button type="button" class="cw-btn" data-step="${ui.step + 1}">Next</button>`
          : `<button type="button" class="cw-btn" data-copy="${esc(String(receive))}" title="Copy the I will receive amount">Copy amount</button>`}
      </div>`;
    $('cwWindow').classList.toggle('empty', !sel.length);
  }

  function render() {
    if (!$('bbBody')) return;
    const a = appraise(withVol(items), prices, { basis: settings.basis, rate: rate() });
    renderCalc(a);
    renderSuggest();
    renderContract();
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------
  function fillList() {
    const t = types();
    if (!t) return;
    $('bbList').innerHTML = Object.values(t).filter(v => typeof v[4] === 'string').map(v => v[0]).sort()
      .map(n => `<option value="${esc(n)}">`).join('');
  }

  function init() {
    $('bbBasis').value = settings.basis;
    $('bbRate').value = settings.rate;
    $('bbReplace').checked = settings.replace;
    $('bbBasis').addEventListener('change', () => { settings.basis = $('bbBasis').value; saveSettings(); render(); });
    $('bbRate').addEventListener('input', () => {
      const v = Number($('bbRate').value);
      $('bbRate').classList.toggle('bad', !(v >= 0 && v <= 200));
      if (v >= 0 && v <= 200) { settings.rate = v; saveSettings(); render(); }
    });
    $('bbReplace').addEventListener('change', () => { settings.replace = $('bbReplace').checked; saveSettings(); });
    $('bbAdd').addEventListener('click', addFromInputs);
    for (const id of ['bbName', 'bbQty']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') addFromInputs(); });
    $('bbClear').addEventListener('click', () => { items = []; saveItems(); render(); });
    $('bbRefresh').addEventListener('click', () => fetchPrices(true));
    $('bbPaste').addEventListener('paste', (e) => {
      e.preventDefault();
      addPasted(e.clipboardData.getData('text'));
    });
    $('bbPaste').addEventListener('input', () => {   // typed or dropped text: add on Enter/blur instead
      if (/\n\s*$/.test($('bbPaste').value)) { addPasted($('bbPaste').value); $('bbPaste').value = ''; }
    });
    $('bbPaste').addEventListener('blur', () => { if ($('bbPaste').value.trim()) { addPasted($('bbPaste').value); $('bbPaste').value = ''; } });
    // Ctrl+V anywhere that isn't a text field goes to the buyback.
    document.addEventListener('paste', (e) => {
      const t = e.target;
      if (t.closest?.('input, textarea, select, [contenteditable]')) return;
      const text = e.clipboardData?.getData('text');
      if (!text?.trim()) return;
      e.preventDefault();
      addPasted(text);
      $('buyback').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    $('bbBody').addEventListener('change', (e) => {
      const key = e.target.dataset.bbqty;
      if (!key) return;
      const q = parseAmount(e.target.value);
      e.target.classList.toggle('bad', !(q > 0));
      if (!(q > 0)) return;
      const it = items.find(x => `${x.typeId}:${x.locationId || 0}` === key);
      if (it) { it.qty = Math.round(q); saveItems(); render(); }
    });
    $('bbBody').addEventListener('click', (e) => {
      const key = e.target.closest('[data-bbdel]')?.dataset.bbdel;
      if (!key) return;
      items = items.filter(x => `${x.typeId}:${x.locationId || 0}` !== key);
      saveItems(); render();
    });
    $('bbSuggest').addEventListener('click', (e) => {
      const b = e.target.closest('[data-add]');
      if (!b || e.target.closest('a')) return;
      add([{ typeId: Number(b.dataset.add), qty: Number(b.dataset.q) || 1 }]);
    });

    const cw = $('cwWindow');
    cw.addEventListener('click', (e) => {
      const step = e.target.closest('[data-step]')?.dataset.step;
      if (step) { ui.step = Number(step); renderContract(); return; }
      if (e.target.closest('[data-cw=mycorp]') && acct.corp) { settings.corp = acct.corp.name; saveSettings(); render(); }
    });
    cw.addEventListener('change', (e) => {
      const t = e.target;
      if (t.name === 'cw-avail') { settings.availability = t.value; saveSettings(); renderContract(); }
      else if (t.id === 'cwExpiry') { settings.expiry = Number(t.value); saveSettings(); renderContract(); }
      else if (t.id === 'cwLoc') { ui.loc = Number(t.value); renderContract(); }
      else if (t.id === 'cwCorp' || t.id === 'cwDesc') { settings[t.id === 'cwCorp' ? 'corp' : 'desc'] = t.value; saveSettings(); render(); }
    });

    // Items sent from the mining page's "Ore you own" while this page is open in another tab.
    window.addEventListener('storage', (e) => {
      if (e.key !== KEY.items) return;
      items = storedItems(); ui.loc = null;
      render(); fetchPrices();
    });

    render();
    fetchPrices();
  }

  init();
  return {
    render,
    statusChanged,
    typesLoaded: () => { fillList(); render(); },
  };
}
