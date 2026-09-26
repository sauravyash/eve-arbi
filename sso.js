// EVE Online SSO (OAuth 2 authorization code + PKCE) for one local user, plus the signed-in ESI
// calls the dashboards use: location, online status, current ship, wallet balance, your market
// orders (character and corporation) and structure markets.
//
// - Scopes: SCOPES below, or "scopes" in sso.config.json. They must all be enabled on the app
//   registered at https://developers.eveonline.com. A feature whose scope wasn't granted
//   answers 403 with a hint instead of breaking the rest.
// - PKCE means no client secret: register the app with the callback URL below, then give this
//   server its Client ID (EVE_CLIENT_ID or sso.config.json).
// - Tokens live on the server only (.cache/sso.json) and never reach the browser; the page only
//   gets the results (name, location, ship, balance, orders).

import crypto from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const AUTHORIZE = 'https://login.eveonline.com/v2/oauth/authorize';
const TOKEN = 'https://login.eveonline.com/v2/oauth/token';
const REVOKE = 'https://login.eveonline.com/v2/oauth/revoke';
const ESI = 'https://esi.evetech.net/latest/';
export const SCOPES = [
  'esi-location.read_location.v1',
  'esi-location.read_online.v1',
  'esi-location.read_ship_type.v1',
  'esi-wallet.read_character_wallet.v1',
  'esi-markets.read_character_orders.v1',
  'esi-markets.read_corporation_orders.v1',
  'esi-markets.structure_markets.v1',
];
const PENDING_TTL = 10 * 60_000;
const MIN_TTL = 5_000;      // never ask ESI more often than this for the same thing
const MAX_CACHE = 200;

// What each feature needs, for friendly "sign in again to allow …" errors.
const NEED = {
  location: ['esi-location.read_location.v1', 'your location'],
  online: ['esi-location.read_online.v1', 'online status'],
  ship: ['esi-location.read_ship_type.v1', 'your current ship'],
  wallet: ['esi-wallet.read_character_wallet.v1', 'your wallet balance'],
  orders: ['esi-markets.read_character_orders.v1', 'your market orders'],
  corpOrders: ['esi-markets.read_corporation_orders.v1', 'corporation market orders'],
  structure: ['esi-markets.structure_markets.v1', 'structure markets'],
};

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// Read a JWT's claims. The token comes straight from CCP's token endpoint over TLS, so we check
// issuer, audience and expiry rather than the signature.
export function readToken(jwt, clientId, now = Date.now()) {
  const part = String(jwt).split('.')[1];
  if (!part) throw new Error('Malformed access token');
  const c = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  if (!['login.eveonline.com', 'https://login.eveonline.com'].includes(c.iss)) throw new Error(`Unexpected token issuer ${c.iss}`);
  const aud = [].concat(c.aud || []);
  if (!aud.includes(clientId) || !aud.includes('EVE Online')) throw new Error('Token was issued for a different application');
  if (!(c.exp * 1000 > now)) throw new Error('Token already expired');
  const m = /^CHARACTER:EVE:(\d+)$/.exec(c.sub || '');
  if (!m) throw new Error('Token is not for a character');
  return { characterId: Number(m[1]), name: c.name, scopes: [].concat(c.scp || []), expiresAt: c.exp * 1000 };
}

export function createSso({ clientId, callbackUrl, tokenFile, userAgent, scopes = SCOPES, log = console.log }) {
  const pending = new Map(); // state → {verifier, returnTo, created}
  let session = null;        // {characterId, name, scopes, accessToken, refreshToken, expiresAt}
  let refreshing = null;
  const cache = new Map();   // ESI path → {expires, value}

  const ready = readFile(tokenFile, 'utf8')
    .then(txt => { session = JSON.parse(txt); log(`EVE SSO: signed in as ${session.name}`); })
    .catch(() => {});

  const save = async () => {
    await mkdir(path.dirname(tokenFile), { recursive: true });
    await writeFile(tokenFile, JSON.stringify(session), { mode: 0o600 });
  };

  async function tokenRequest(form) {
    const res = await fetch(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgent, Accept: 'application/json' },
      body: new URLSearchParams({ ...form, client_id: clientId }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`EVE login refused (${res.status}${body.error ? `: ${body.error_description || body.error}` : ''})`);
    return body;
  }

  async function adopt(tok) {
    const claims = readToken(tok.access_token, clientId);
    if (session?.characterId !== claims.characterId) cache.clear();
    session = { ...claims, accessToken: tok.access_token, refreshToken: tok.refresh_token || session?.refreshToken };
    await save();
    return claims;
  }

  async function accessToken() {
    await ready;
    if (!session) throw Object.assign(new Error('Not signed in'), { status: 401 });
    if (session.expiresAt - Date.now() > 60_000) return session.accessToken;
    refreshing ||= tokenRequest({ grant_type: 'refresh_token', refresh_token: session.refreshToken })
      .then(adopt)
      .catch(async (e) => { // refresh token revoked or expired: sign out cleanly
        log(`EVE SSO: refresh failed (${e.message}) — signed out`);
        session = null; await rm(tokenFile, { force: true });
        throw Object.assign(new Error('Your EVE login expired — sign in again'), { status: 401 });
      })
      .finally(() => { refreshing = null; });
    await refreshing;
    return session.accessToken;
  }

  const scopeError = (feature) => {
    const [scope, what] = NEED[feature];
    return Object.assign(new Error(`To show ${what}, sign out and sign in again to allow ${scope}` +
      `${scopes.includes(scope) ? '' : ' (also enable it on your app and in sso.config.json "scopes")'}`), { status: 403, scope });
  };

  // Signed-in ESI GET, cached until ESI's Expires (at least MIN_TTL). `feature` names the scope
  // it needs (null for public data); `paged` follows X-Pages.
  async function esi(feature, pathname, { paged = false, ttl = 0 } = {}) {
    await ready;
    if (!session) throw Object.assign(new Error('Not signed in'), { status: 401 });
    if (feature && !session.scopes.includes(NEED[feature][0])) throw scopeError(feature);
    const key = `${session.characterId}:${pathname}`;
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const get = async (page) => {
      const token = await accessToken();
      const res = await fetch(`${ESI}${pathname}${page ? `?page=${page}` : ''}`, {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = body?.error || `HTTP ${res.status}`;
        throw Object.assign(new Error(`ESI ${pathname.split('/')[0]}: ${msg}`), { status: res.status === 403 || res.status === 404 ? res.status : 502 });
      }
      return { body, pages: Number(res.headers.get('x-pages')) || 1, expires: Date.parse(res.headers.get('expires') || '') };
    };
    const first = await get(paged ? 1 : 0);
    let value = first.body;
    if (paged && first.pages > 1) {
      const rest = await Promise.all(Array.from({ length: first.pages - 1 }, (_, i) => get(i + 2)));
      value = [value, ...rest.map(r => r.body)].flat();
    }
    const expires = Math.max(Date.now() + MIN_TTL, Date.now() + ttl, Number.isFinite(first.expires) ? first.expires : 0);
    cache.set(key, { expires, value });
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    return value;
  }

  return {
    configured: !!clientId,
    callbackUrl,

    async status() {
      await ready;
      return { configured: !!clientId, callbackUrl, loggedIn: !!session, characterId: session?.characterId ?? null,
        name: session?.name ?? null, scopes: session?.scopes ?? [] };
    },

    // Start a login: remember a PKCE verifier under a random state, return CCP's login URL.
    loginUrl(returnTo = '/') {
      if (!clientId) throw Object.assign(new Error('EVE login is not set up — see "Signing in" in the README'), { status: 503 });
      const now = Date.now();
      for (const [k, v] of pending) if (now - v.created > PENDING_TTL) pending.delete(k);
      const state = b64url(crypto.randomBytes(16));
      const verifier = b64url(crypto.randomBytes(32));
      const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
      pending.set(state, { verifier, returnTo: /^\/[\w./-]*$/.test(returnTo) ? returnTo : '/', created: now });
      const q = new URLSearchParams({
        response_type: 'code', redirect_uri: callbackUrl, client_id: clientId, scope: scopes.join(' '),
        code_challenge: challenge, code_challenge_method: 'S256', state,
      });
      return `${AUTHORIZE}?${q}`;
    },

    // CCP redirected back: check state, swap the code for tokens.
    async finishLogin({ code, state }) {
      const p = pending.get(state);
      pending.delete(state);
      if (!code || !p || Date.now() - p.created > PENDING_TTL) throw Object.assign(new Error('Login expired or was not started here — try again'), { status: 400 });
      const claims = await adopt(await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: p.verifier }));
      log(`EVE SSO: signed in as ${claims.name}`);
      return { returnTo: p.returnTo, name: claims.name };
    },

    async location() {
      const b = await esi('location', `characters/${session?.characterId}/location/`);
      return { systemId: b.solar_system_id, stationId: b.station_id ?? null, structureId: b.structure_id ?? null, at: Date.now() };
    },

    async online() {
      const b = await esi('online', `characters/${session?.characterId}/online/`);
      return { online: !!b.online, lastLogin: b.last_login ?? null, lastLogout: b.last_logout ?? null };
    },

    async ship() {
      const b = await esi('ship', `characters/${session?.characterId}/ship/`);
      return { typeId: b.ship_type_id, name: b.ship_name, itemId: b.ship_item_id };
    },

    async wallet() {
      return { balance: Number(await esi('wallet', `characters/${session?.characterId}/wallet/`)) };
    },

    // Your active orders, plus your corporation's when the scope and in-game role allow it.
    async orders() {
      const id = session?.characterId;
      const mine = (await esi('orders', `characters/${id}/orders/`)).map(o => ({ ...o, owner: 'character' }));
      let corp = [], corpError = null;
      try {
        const { corporation_id: corpId } = await esi(null, `characters/${id}/`, { ttl: 3600_000 });
        corp = (await esi('corpOrders', `corporations/${corpId}/orders/`, { paged: true }))
          .filter(o => !mine.some(m => m.order_id === o.order_id)).map(o => ({ ...o, owner: 'corporation' }));
      } catch (e) {
        corpError = e.status === 403 && !e.scope
          ? 'Your character needs the Accountant or Trader corporation role to see corporation orders'
          : e.message;
      }
      return { orders: [...mine, ...corp], corpError };
    },

    // Orders in a player structure (needs docking/market access there), optionally for some types.
    async structureMarket(structureId, typeIds = null) {
      const all = await esi('structure', `markets/structures/${structureId}/`, { paged: true, ttl: 300_000 });
      const want = typeIds && new Set(typeIds);
      return want ? all.filter(o => want.has(o.type_id)) : all;
    },

    async logout() {
      await ready;
      const s = session;
      session = null; cache.clear();
      await rm(tokenFile, { force: true });
      if (s?.refreshToken && clientId) { // best effort: tell CCP to forget the token too
        fetch(REVOKE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgent },
          body: new URLSearchParams({ token_type_hint: 'refresh_token', token: s.refreshToken, client_id: clientId }),
        }).catch(() => {});
      }
    },
  };
}
