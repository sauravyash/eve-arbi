// Mining page, "Ore you own": the ore, ice and gas in your assets by station, each with
// "Where to sell" (the tables below, mining.js) and "Buyback" (Contracts › Corp buyback).

import { isNpcStation } from './market-merge.js';
import { itemPic } from './watchlist.js';
import { byLocation, harvestable, placeOf } from './buyback.js';
import { addToBuyback, BUYBACK_PAGE } from './buyback-calc.js';

const SCOPE = 'esi-assets.read_assets.v1';

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => (v == null || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString('en-US'));
const $ = (id) => document.getElementById(id);

/**
 * @param {object} o
 * @param {() => object|null} o.types          types.json, once loaded
 * @param {() => object|null} o.stations       stations.json, once loaded
 * @param {(id: number) => string} o.sysName
 * @param {() => object|null} o.me             createMe() controller
 * @param {(items: {typeId, qty}[], systemId: number|null) => void} o.onSell   price a load in the tables below
 */
export function createAssets({ types, stations, sysName, me, onSell }) {
  const acct = { assets: null, loading: false, error: null, forChar: null };
  let rows = [];

  const name = (t) => types()?.[t]?.[0] || `Type ${t}`;
  const volOf = (t) => types()?.[t]?.[1] || 0;
  const status = () => me()?.status;
  const place = (l) => placeOf(l, { stations: stations(), locations: acct.assets?.locations, sysName, isNpcStation });

  async function load() {
    if (!status()?.loggedIn) return;
    if (!status().scopes?.includes(SCOPE)) { acct.error = 'needs-scope'; render(); return; }
    acct.loading = true; render();
    try {
      const res = await fetch('/api/me/assets');
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      acct.assets = body; acct.error = null;
    } catch (e) { acct.error = e.message; }
    acct.loading = false;
    render();
  }

  // Once per signed-in character.
  function statusChanged() {
    const s = status();
    const who = s?.loggedIn ? s.characterId : null;
    if (who === acct.forChar) { render(); return; }
    Object.assign(acct, { assets: null, error: null, forChar: who });
    if (who) load();
    render();
  }

  function render() {
    const el = $('asBody');
    const s = status();
    $('asRefresh').hidden = !s?.loggedIn;
    const head = $('asCount');
    head.textContent = '';
    rows = [];
    if (!s?.loggedIn) {
      el.innerHTML = `<p class="hint">${s?.configured ? 'Log in with EVE (top right) to list the ore, ice and gas in your hangars, ships and containers.' : 'EVE login is not set up on this server.'}</p>`;
      return;
    }
    if (acct.error === 'needs-scope') { el.innerHTML = '<p class="hint">Sign out and in again to allow reading your assets (esi-assets.read_assets.v1).</p>'; return; }
    if (acct.error) { el.innerHTML = `<p class="hint warn">Couldn't read your assets: ${esc(acct.error)}</p>`; return; }
    if (!acct.assets) { el.innerHTML = '<p class="hint">Loading your assets…</p>'; return; }
    rows = [...byLocation(harvestable(acct.assets.items, types()))].map(([l, list]) => {
      const vol = list.reduce((s, it) => s + it.qty * volOf(it.typeId), 0);
      return { l, list: list.sort((a, b) => b.qty * volOf(b.typeId) - a.qty * volOf(a.typeId)), vol, where: place(l) };
    }).sort((a, b) => b.vol - a.vol);
    head.textContent = rows.length ? `· ${rows.length} location${rows.length > 1 ? 's' : ''}` : '';
    el.innerHTML = rows.length ? `<div class="table-wrap"><table class="routes mn-table as-table">
      <thead><tr><th class="l">Where</th><th class="l">What</th><th>m³</th><th></th></tr></thead>
      <tbody>${rows.map(r => `<tr class="static">
        <td class="l"><span class="place"><b title="${esc(r.where.name)}">${esc(r.where.name)}</b>${r.where.systemId ? `<small>${esc(sysName(r.where.systemId))}</small>` : ''}</span></td>
        <td class="l as-what">${r.list.slice(0, 6).map(it => `<span class="as-it" title="${esc(name(it.typeId))}">${itemPic(it.typeId, name(it.typeId), 20)}${num(it.qty)}</span>`).join('')}${r.list.length > 6 ? `<small class="muted">+${r.list.length - 6} more</small>` : ''}</td>
        <td>${num(r.vol)}</td>
        <td class="as-act"><button class="btn small" type="button" data-sell="${r.l}" title="Rank the stations that buy these, starting from this one">Where to sell</button>
          <button class="btn small ghost" type="button" data-bb="${r.l}" title="Open these in Contracts › Corp buyback">Buyback</button></td>
      </tr>`).join('')}</tbody></table></div>` : '<p class="hint">No ore, ice, gas or minerals in your assets.</p>';
  }

  $('asRefresh').addEventListener('click', load);
  $('asBody').addEventListener('click', (e) => {
    const sell = e.target.closest('[data-sell]'), bb = e.target.closest('[data-bb]');
    const r = rows.find(x => String(x.l) === (sell || bb)?.dataset[sell ? 'sell' : 'bb']);
    if (!r) return;
    if (sell) { onSell(r.list.map(it => ({ typeId: it.typeId, qty: it.qty })), r.where.systemId || null); return; }
    addToBuyback(r.list.map(it => ({ typeId: it.typeId, qty: it.qty, locationId: r.l })));
    location.href = BUYBACK_PAGE;
  });
  render();

  return { render, statusChanged };
}
