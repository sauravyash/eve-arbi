// Watchlists: the item lists on Hub arbitrage ('hub') and Market watch ('market').
//   - Signed in with EVE: saved to your character on the server (/api/me/watchlists/{name}), so
//     they follow you to any browser. The first time a character signs in, a list you built
//     while signed out is copied to it.
//   - Signed out: kept for this browser session (sessionStorage), gone when the tab closes.
// New lists start empty.

export const LIST_NAMES = ['hub', 'market'];
export const MAX_ITEMS = 300;

/** Validates a list from anywhere (a request body, storage): [{typeId, name}], deduped, capped. */
export function cleanItems(list) {
  const out = [], seen = new Set();
  for (const it of Array.isArray(list) ? list : []) {
    const typeId = Number(it?.typeId);
    if (!Number.isSafeInteger(typeId) || typeId <= 0 || seen.has(typeId)) continue;
    seen.add(typeId);
    out.push({ typeId, name: String(it.name ?? `Type ${typeId}`).slice(0, 120) });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

// EVE University wiki page for an item (its search jumps straight to an exact title match).
export const wikiUrl = (name) => `https://wiki.eveuniversity.org/Special:Search?search=${encodeURIComponent(name)}&go=Go`;

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The item's icon, linking to its EVE University wiki page (hidden on narrow screens by CSS). */
export const itemPic = (typeId, name, size = 32) =>
  `<a class="item-pic" href="${wikiUrl(name)}" target="_blank" rel="noopener" title="${esc(name)} on EVE University wiki">`
  + `<img src="https://images.evetech.net/types/${typeId}/icon?size=${size <= 32 ? 32 : 64}" alt="" width="${size}" height="${size}" loading="lazy"></a>`;

/** A small button that copies an item name to the clipboard (e.g. to paste into EVE's market search). */
export const copyButton = (name) =>
  `<button class="copy" type="button" data-copy="${esc(name)}" aria-label="Copy ${esc(name)}" title="Copy name">`
  + '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg></button>';

// One capture-phase handler for every copy button, so the click never reaches the row's own select handler.
globalThis.document?.addEventListener('click', async (e) => {
  const btn = e.target.closest?.('button[data-copy]');
  if (!btn) return;
  e.stopPropagation();
  e.preventDefault();
  let ok = true;
  try { await navigator.clipboard.writeText(btn.dataset.copy); } catch { ok = false; }
  btn.classList.add(ok ? 'done' : 'fail');
  btn.title = ok ? 'Copied' : 'Copy failed';
  clearTimeout(btn._t);
  btn._t = setTimeout(() => { btn.classList.remove('done', 'fail'); btn.title = 'Copy name'; }, 1200);
}, true);

/** A Remove button; pages handle clicks on [data-remove]. */
export const removeButton = (typeId, name) =>
  `<button class="del" type="button" data-remove="${typeId}" aria-label="Remove ${esc(name)} from watchlist" title="Remove from watchlist">`
  + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg><span>Remove</span></button>';

const storage = (name) => ({
  get(k) { try { const v = globalThis[name].getItem(k); return v ? JSON.parse(v) : undefined; } catch { return undefined; } },
  set(k, v) { try { globalThis[name].setItem(k, JSON.stringify(v)); } catch { /* quota or disabled */ } },
  remove(k) { try { globalThis[name].removeItem(k); } catch { /* disabled */ } },
});
const LS = storage('localStorage');     // signed-in state and a copy of the account's list
const SS = storage('sessionStorage');   // the signed-out list
const sameIds = (a, b) => a.length === b.length && a.every((x, i) => x.typeId === b[i].typeId);

/**
 * @param {'hub'|'market'} name
 * @param {object} o
 * @param {Array} [o.legacy]         the list from before watchlists were stored separately
 * @param {Array} [o.legacyDefaults] the old starter list: a legacy list equal to it starts empty
 * @param {(items, mode) => void} o.onLoad  called when the list is (re)loaded; mode 'account'|'local'
 */
export function createWatchlist(name, { legacy, legacyDefaults = [], onLoad }) {
  const key = `watchlist.${name}`;
  let local = SS.get(key);
  if (local === undefined) {
    // A list from an older version (localStorage) moves here once.
    const kept = LS.get(key);
    const old = cleanItems(kept ?? legacy);
    local = kept === undefined && sameIds(old, cleanItems(legacyDefaults)) ? [] : old;
    SS.set(key, local);
    LS.remove(key);
  }
  local = cleanItems(local);
  // Copy of your account's list from last time, so a signed-in page doesn't flash the local one.
  const acctKey = `${key}.account`;
  let mode = LS.get(`${key}.mode`) === 'account' ? 'account' : 'local';
  let timer = null, pendingSave = null;
  const setMode = (m) => { mode = m; LS.set(`${key}.mode`, m); };

  async function put(items, keepalive = false) {
    const res = await fetch(`/api/me/watchlists/${name}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Eve-Arbi': '1' }, body: JSON.stringify({ items }), keepalive,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  const api = {
    get mode() { return mode; },
    /** The list to show before load() answers. */
    initial: () => (mode === 'account' ? cleanItems(LS.get(acctKey)) : local.slice()),

    /** Asks the server for your character's list; falls back to this browser's. */
    async load() {
      let items = null, saved = true;
      try {
        const res = await fetch(`/api/me/watchlists/${name}`);
        if (res.ok) { const body = await res.json(); items = cleanItems(body.items); saved = body.saved !== false; }
      } catch { /* offline: use this browser's list */ }
      if (items) {
        setMode('account');
        // First sign-in: this character has never saved a list, so it takes this browser's.
        if (!saved && local.length) { items = local.slice(); put(items).catch(() => {}); }
      } else {
        setMode('local');
        items = local.slice();
      }
      if (mode === 'account') LS.set(acctKey, items);
      onLoad(items, mode);
      return items;
    },

    /** Saves the list wherever it lives now (account saves are batched for half a second). */
    save(items) {
      items = cleanItems(items);
      if (mode === 'local') { local = items; SS.set(key, items); return; }
      LS.set(acctKey, items);
      pendingSave = items;
      clearTimeout(timer);
      timer = setTimeout(flush, 500);
    },
  };
  function flush(keepalive = false) {
    clearTimeout(timer);
    if (!pendingSave) return;
    const list = pendingSave; pendingSave = null;
    put(list, keepalive).catch(e => console.warn(`Watchlist not saved (${e.message})`));
  }
  // Leaving within the half second still saves.
  globalThis.addEventListener?.('pagehide', () => flush(true));
  return api;
}
