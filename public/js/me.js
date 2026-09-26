// Signed-in character (EVE SSO, handled by the server): the header chip and the "use my …"
// options, shared by both pages. Tokens never reach the browser; /api/me/* return only results.
//
// Options (remembered per browser):
//   Follow        — your current system becomes the page's starting point
//   Ship cargo    — your current ship's base cargo hold becomes Cargo m³
//   Wallet        — your wallet balance becomes Max investment

const POLL_MS = 20_000;
const WALLET_MS = 120_000;   // ESI caches the wallet for 2 min
const KEYS = { follow: 'me.follow', useShip: 'me.useShip', useWallet: 'me.useWallet' };
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SCOPE = {
  location: 'esi-location.read_location.v1', online: 'esi-location.read_online.v1', ship: 'esi-location.read_ship_type.v1',
  wallet: 'esi-wallet.read_character_wallet.v1',
};

function pref(key, fallback) { try { const v = localStorage.getItem(KEYS[key]); return v == null ? fallback : v === '1'; } catch { return fallback; } }
function setPref(key, on) { try { localStorage.setItem(KEYS[key], on ? '1' : '0'); } catch { /* storage disabled */ } }

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
  return body;
}

/**
 * @param {object} o
 * @param {HTMLElement} o.el                       where the chip goes
 * @param {string} o.returnTo                      page to come back to after signing in
 * @param {(id: number) => string} o.systemName
 * @param {(typeId: number) => {name, cargo}|null} o.shipInfo   ship name and base cargo m³ (types.json)
 * @param {(v: number) => string} o.isk            ISK formatter
 * @param {(loc|null) => void} o.onFollow          your location while following, null when it stops
 * @param {(m3: number|null) => void} [o.onCargo]  your ship's cargo while "use ship" is on, null when off
 * @param {(isk: number|null) => void} [o.onBudget] your wallet while "use wallet" is on, null when off
 * @param {(status) => void} [o.onStatus]          sign-in state changes (for pages that show more)
 */
export function createMe({ el, returnTo, systemName, shipInfo = () => null, isk = String, onFollow, onCargo = () => {}, onBudget = () => {}, onStatus = () => {} }) {
  const me = {
    status: null, loc: null, online: null, ship: null, wallet: null, errors: {}, timer: null, walletAt: 0,
    follow: pref('follow', true), useShip: pref('useShip', false), useWallet: pref('useWallet', false),
  };
  const has = (k) => me.status?.scopes?.includes(SCOPE[k]);

  const cargoOf = () => (me.ship ? shipInfo(me.ship.typeId)?.cargo ?? null : null);
  const push = () => {
    onFollow(me.follow && me.loc ? me.loc : null);
    onCargo(me.useShip && cargoOf() ? cargoOf() : null);
    onBudget(me.useWallet && me.wallet != null ? me.wallet : null);
  };

  async function fetchPart(key, url, apply) {
    if (!has(key)) return false;
    try { const v = await getJson(url); delete me.errors[key]; return apply(v); }
    catch (e) {
      if (e.status === 401) { me.status = { ...me.status, loggedIn: false }; onStatus(me.status); }
      me.errors[key] = e.message; return false;
    }
  }

  // The first check always runs (a page opened in a background tab still shows where you are);
  // after that, only while the tab is visible.
  let checked = false;
  async function poll() {
    clearTimeout(me.timer);
    if (!me.status?.loggedIn) return;
    if (!checked || document.visibilityState === 'visible') {
      checked = true;
      const was = { sys: me.loc?.systemId, st: me.loc?.stationId, ship: me.ship?.typeId, wallet: me.wallet };
      const wantWallet = Date.now() - me.walletAt > WALLET_MS;
      await Promise.all([
        fetchPart('location', '/api/me/location', (v) => { me.loc = v; }),
        fetchPart('online', '/api/me/online', (v) => { me.online = v; }),
        fetchPart('ship', '/api/me/ship', (v) => { me.ship = v; }),
        wantWallet && fetchPart('wallet', '/api/me/wallet', (v) => { me.wallet = v.balance; me.walletAt = Date.now(); }),
      ]);
      if (!me.status.loggedIn) { render(); push(); return; }
      if (was.sys !== me.loc?.systemId || was.st !== me.loc?.stationId || was.ship !== me.ship?.typeId || was.wallet !== me.wallet) push();
      render();
    }
    me.timer = setTimeout(poll, POLL_MS);
  }

  // Redraws happen on every poll; keep the menu open if it was.
  function render() {
    const open = !!el.querySelector('details[open]');
    draw();
    if (open) el.querySelector('details')?.setAttribute('open', '');
  }

  function draw() {
    const s = me.status;
    if (!s) { el.innerHTML = ''; return; }
    if (!s.configured) {
      el.innerHTML = `<span class="me-off" title="${esc(s.hint || `Register an application at developers.eveonline.com with callback ${s.callbackUrl}, then put its Client ID in sso.config.json. See “Signing in” in the README.`)}">EVE login not set up</span>`;
      return;
    }
    if (!s.loggedIn) {
      el.innerHTML = `<a class="btn small" href="/sso/login?return=${encodeURIComponent(returnTo)}" title="Sign in with EVE Online to use your location, ship, wallet and market orders">Log in with EVE</a>`;
      return;
    }
    const where = me.loc ? systemName(me.loc.systemId) : (has('location') ? '…' : '');
    const docked = me.loc ? (me.loc.stationId || me.loc.structureId ? 'docked' : 'in space') : '';
    const ship = me.ship ? shipInfo(me.ship.typeId) : null;
    const dot = me.online == null ? '' : `<i class="me-dot ${me.online.online ? 'on' : ''}" title="${me.online.online ? 'Online' : 'Offline'}"></i>`;
    const errs = Object.entries(me.errors);
    const opt = (key, label, detail, enabled, why) => `<label class="me-opt${enabled ? '' : ' off'}" title="${esc(enabled ? detail : why)}">
      <input type="checkbox" data-me="${key}"${me[key] ? ' checked' : ''}${enabled ? '' : ' disabled'}> <span>${label}<small>${esc(enabled ? detail : why)}</small></span></label>`;
    el.innerHTML = `<details class="me-menu">
      <summary>
        <span class="me-face"><img src="https://images.evetech.net/characters/${s.characterId}/portrait?size=64" alt="" width="30" height="30">${dot}</span>
        <span class="me-who"><b>${esc(s.name)}</b><small>${[where && `${esc(where)} · ${docked}`, me.wallet != null && `${isk(me.wallet)} ISK`].filter(Boolean).join(' · ')}</small></span>
        ${errs.length ? '<span class="me-err">!</span>' : ''}
      </summary>
      <div class="me-pop">
        ${ship || me.ship ? `<div class="me-ship">Flying <b>${esc(me.ship?.name || '')}</b> (${esc(ship?.name || `type ${me.ship?.typeId}`)})</div>` : ''}
        ${opt('follow', 'Follow my location', where ? `Start from ${where}, updated every 20 s` : 'Waiting for your location', has('location'), 'Needs the location scope — sign in again')}
        ${opt('useShip', 'Use my ship\'s cargo', ship?.cargo ? `${Math.round(ship.cargo).toLocaleString()} m³ base hold (no skills, expanders or special holds)` : 'Your ship has no cargo hold', has('ship') && !!ship?.cargo, has('ship') ? 'Your current ship has no cargo hold' : 'Needs the ship scope — sign in again')}
        ${opt('useWallet', 'Use my wallet as max investment', me.wallet != null ? `${isk(me.wallet)} ISK` : 'Loading balance…', has('wallet'), 'Needs the wallet scope — sign in again')}
        ${errs.map(([k, m]) => `<div class="me-warn">${esc(k)}: ${esc(m)}</div>`).join('')}
        <button class="btn small ghost" type="button" data-me="logout">Sign out</button>
      </div>
    </details>`;
  }

  el.addEventListener('change', (e) => {
    const key = e.target.dataset.me;
    if (!(key in KEYS)) return;
    me[key] = e.target.checked;
    setPref(key, me[key]);
    push();
    render();
    el.querySelector('details')?.setAttribute('open', '');
  });
  el.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-me=logout]')) return;
    await fetch('/api/me/logout', { method: 'POST', headers: { 'X-Eve-Arbi': '1' } }).catch(() => {});
    Object.assign(me, { loc: null, online: null, ship: null, wallet: null, errors: {} });
    me.status = { ...me.status, loggedIn: false, scopes: [] };
    onStatus(me.status); push(); render();
  });
  document.addEventListener('click', (e) => { if (!el.contains(e.target)) el.querySelector('details')?.removeAttribute('open'); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); });

  getJson('/api/me').then(s => { me.status = s; onStatus(s); render(); poll(); })
    .catch(() => { me.status = null; render(); });

  return {
    get status() { return me.status; },
    get location() { return me.loc; },
    has,
    render,
    refresh: () => { me.walletAt = 0; return poll(); },
    // Re-send location/cargo/wallet, e.g. once the page has loaded the data needed to use them.
    reapply: () => { push(); render(); },
  };
}
