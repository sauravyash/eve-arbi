import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSso, readToken, SCOPES } from '../sso.js';

const CLIENT = 'abc123';
const jwt = (claims) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
const claims = (over = {}) => ({ iss: 'https://login.eveonline.com', aud: [CLIENT, 'EVE Online'], sub: 'CHARACTER:EVE:90000001',
  name: 'Test Pilot', scp: SCOPES[0], exp: Math.floor(Date.now() / 1000) + 1200, ...over });

test('readToken accepts CCP tokens for this app and rejects others', () => {
  assert.deepEqual({ ...readToken(jwt(claims()), CLIENT), expiresAt: 0 }, { characterId: 90000001, name: 'Test Pilot', scopes: [SCOPES[0]], expiresAt: 0 });
  assert.throws(() => readToken(jwt(claims({ aud: ['other', 'EVE Online'] })), CLIENT), /different application/);
  assert.throws(() => readToken(jwt(claims({ iss: 'evil.example' })), CLIENT), /issuer/);
  assert.throws(() => readToken(jwt(claims({ exp: 1 })), CLIENT), /expired/);
  assert.throws(() => readToken(jwt(claims({ sub: 'CORPORATION:EVE:1' })), CLIENT), /character/);
});

let realFetch, calls, tokenFile;
beforeEach(async () => {
  realFetch = globalThis.fetch;
  calls = [];
  tokenFile = path.join(await mkdtemp(path.join(tmpdir(), 'sso-')), 'sso.json');
});
afterEach(() => { globalThis.fetch = realFetch; });

const mockFetch = (handler) => {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const { status = 200, body } = await handler(String(url), init);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
};

test('login: PKCE round trip, state check, token stored server-side, location fetched with the token', async () => {
  const sso = createSso({ clientId: CLIENT, callbackUrl: 'http://localhost:8000/sso/callback', tokenFile, userAgent: 't', log: () => {} });
  assert.deepEqual(await sso.status(), { configured: true, callbackUrl: 'http://localhost:8000/sso/callback', loggedIn: false, characterId: null, name: null, scopes: [] });

  const url = new URL(sso.loginUrl('/market.html'));
  const q = url.searchParams;
  assert.equal(url.origin + url.pathname, 'https://login.eveonline.com/v2/oauth/authorize');
  assert.equal(q.get('scope'), SCOPES.join(' '));
  assert.equal(q.get('code_challenge_method'), 'S256');

  let verifier;
  const token = jwt(claims());
  mockFetch((u, init) => {
    if (u.includes('/oauth/token')) {
      const form = new URLSearchParams(init.body);
      verifier = form.get('code_verifier');
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('client_id'), CLIENT);
      return { body: { access_token: token, refresh_token: 'r1', expires_in: 1200 } };
    }
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    return { body: { solar_system_id: 30002659, station_id: 60011866 } };
  });

  await assert.rejects(sso.finishLogin({ code: 'c', state: 'forged' }), /not started here/);
  const done = await sso.finishLogin({ code: 'c', state: q.get('state') });
  assert.deepEqual(done, { returnTo: '/market.html', name: 'Test Pilot' });
  // The verifier sent to CCP hashes to the challenge sent in the login URL.
  assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'), q.get('code_challenge'));
  await assert.rejects(sso.finishLogin({ code: 'c', state: q.get('state') }), /not started here/); // single use

  assert.equal((await sso.status()).name, 'Test Pilot');
  const saved = JSON.parse(await readFile(tokenFile, 'utf8'));
  assert.equal(saved.refreshToken, 'r1');

  const loc = await sso.location();
  assert.deepEqual([loc.systemId, loc.stationId, loc.structureId], [30002659, 60011866, null]);
  assert.match(calls.at(-1).url, /characters\/90000001\/location\/$/);
});

test('an expiring token is refreshed; a rejected refresh signs you out', async () => {
  const sso = createSso({ clientId: CLIENT, callbackUrl: 'x', tokenFile, userAgent: 't', log: () => {} });
  const q = new URL(sso.loginUrl()).searchParams;
  let refreshOk = true;
  mockFetch((u, init) => {
    if (u.includes('/oauth/token')) {
      const form = new URLSearchParams(init.body);
      if (form.get('grant_type') === 'refresh_token') {
        return refreshOk ? { body: { access_token: jwt(claims({ exp: Math.floor(Date.now() / 1000) + 1200 })), refresh_token: 'r2' } }
          : { status: 400, body: { error: 'invalid_grant' } };
      }
      return { body: { access_token: jwt(claims({ exp: Math.floor(Date.now() / 1000) + 30 })), refresh_token: 'r1' } }; // expires in 30 s
    }
    return { body: { solar_system_id: 30000142 } };
  });
  await sso.finishLogin({ code: 'c', state: q.get('state') });
  await sso.location();
  assert.ok(calls.some(c => c.url.includes('/oauth/token') && new URLSearchParams(c.init.body).get('refresh_token') === 'r1'));

  refreshOk = false;
  const saved = JSON.parse(await readFile(tokenFile, 'utf8'));
  saved.expiresAt = Date.now(); // force a refresh
  await writeFile(tokenFile, JSON.stringify(saved));
  const fresh = createSso({ clientId: CLIENT, callbackUrl: 'x', tokenFile, userAgent: 't', log: () => {} });
  await assert.rejects(fresh.location(), /expired — sign in again/);
  assert.equal((await fresh.status()).loggedIn, false);
});

test('without a client ID, login explains how to set it up', async () => {
  const sso = createSso({ clientId: '', callbackUrl: 'x', tokenFile, userAgent: 't', log: () => {} });
  assert.equal((await sso.status()).configured, false);
  assert.throws(() => sso.loginUrl(), /not set up/);
});

// Sign in with the given scopes, answering ESI calls with `esi(url)`.
async function signedIn(scp, esi) {
  const sso = createSso({ clientId: CLIENT, callbackUrl: 'x', tokenFile, userAgent: 't', log: () => {} });
  const state = new URL(sso.loginUrl()).searchParams.get('state');
  mockFetch(async (u) => (u.includes('/oauth/token')
    ? { body: { access_token: jwt(claims({ scp })), refresh_token: 'r' } }
    : esi(u)));
  await sso.finishLogin({ code: 'c', state });
  return sso;
}

test('a feature whose scope was not granted explains how to allow it', async () => {
  const sso = await signedIn([SCOPES[0]], () => ({ body: {} }));
  await assert.rejects(sso.wallet(), (e) => e.status === 403 && /sign in again to allow esi-wallet/.test(e.message));
});

test('wallet, ship and online come from the right endpoints and are cached', async () => {
  const sso = await signedIn(SCOPES, (u) => {
    if (u.endsWith('/wallet/')) return { body: 1234567.89 };
    if (u.endsWith('/ship/')) return { body: { ship_type_id: 648, ship_name: 'Big Hauler', ship_item_id: 1 } };
    if (u.endsWith('/online/')) return { body: { online: true, last_login: '2026-09-26T10:00:00Z' } };
    return { status: 404, body: { error: 'nope' } };
  });
  assert.deepEqual(await sso.wallet(), { balance: 1234567.89 });
  assert.deepEqual(await sso.ship(), { typeId: 648, name: 'Big Hauler', itemId: 1 });
  assert.equal((await sso.online()).online, true);
  const n = calls.length;
  await sso.wallet();
  assert.equal(calls.length, n); // served from cache
});

test('orders: character orders plus corporation orders, or a role hint when the corp refuses', async () => {
  let corpAllowed = true;
  const sso = await signedIn(SCOPES, (u) => {
    if (u.endsWith('/characters/90000001/orders/')) return { body: [{ order_id: 1, type_id: 34 }] };
    if (u.endsWith('/characters/90000001/')) return { body: { corporation_id: 98000001 } };
    if (u.includes('/corporations/98000001/orders/')) {
      return corpAllowed ? { body: [{ order_id: 1, type_id: 34 }, { order_id: 2, type_id: 35 }] }
        : { status: 403, body: { error: 'Character does not have required role(s)' } };
    }
    return { status: 404, body: {} };
  });
  const r = await sso.orders();
  assert.deepEqual(r.orders.map(o => [o.order_id, o.owner]), [[1, 'character'], [2, 'corporation']]); // no duplicate
  assert.equal(r.corpError, null);

  corpAllowed = false;
  const other = await signedIn(SCOPES, (u) => (u.includes('/corporations/') ? { status: 403, body: { error: 'role' } }
    : u.endsWith('/orders/') ? { body: [] } : { body: { corporation_id: 98000001 } }));
  assert.match((await other.orders()).corpError, /Accountant or Trader/);
});

test('structure market follows X-Pages and filters by type', async () => {
  globalThis.fetch = realFetch;
  const sso = await signedIn(SCOPES, () => ({ body: {} }));
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push({ url: u });
    const page = Number(new URL(u).searchParams.get('page'));
    return new Response(JSON.stringify([{ order_id: page, type_id: page === 2 ? 35 : 34 }]),
      { status: 200, headers: { 'X-Pages': '2', 'Content-Type': 'application/json' } });
  };
  const all = await sso.structureMarket(1035466617946);
  assert.deepEqual(all.map(o => o.order_id), [1, 2]);
  assert.match(calls.at(-1).url, /markets\/structures\/1035466617946\/\?page=2$/);
  assert.deepEqual((await sso.structureMarket(1035466617946, [35])).map(o => o.order_id), [2]);
});

test('clones: jump clones, medical clone, structures named, and the assembled ships in each hangar', async () => {
  const sso = await signedIn(SCOPES, (u) => {
    if (u.endsWith('/characters/90000001/clones/')) {
      return { body: {
        home_location: { location_id: 60003760, location_type: 'station' },
        jump_clones: [
          { jump_clone_id: 7, location_id: 60008494, location_type: 'station', implants: [9941], name: 'Hauler' },
          { jump_clone_id: 8, location_id: 1035466617946, location_type: 'structure', implants: [] },
        ],
        last_clone_jump_date: '2026-10-05T12:00:00Z',
      } };
    }
    if (u.includes('/universe/structures/1035466617946/')) return { body: { name: 'Fort Knocks', solar_system_id: 30000144 } };
    if (u.includes('/characters/90000001/assets/')) {
      return { body: [
        { item_id: 1, type_id: 648, location_id: 60008494, location_flag: 'Hangar', is_singleton: true, quantity: 1 },
        { item_id: 2, type_id: 648, location_id: 60008494, location_flag: 'Hangar', is_singleton: false, quantity: 3 }, // packaged
        { item_id: 3, type_id: 587, location_id: 1035466617946, location_flag: 'Hangar', is_singleton: true, quantity: 1 },
        { item_id: 4, type_id: 34, location_id: 1, location_flag: 'Cargo', is_singleton: false, quantity: 10 },   // inside a ship
        { item_id: 5, type_id: 638, location_id: 60000001, location_flag: 'Hangar', is_singleton: true, quantity: 1 }, // no clone there
      ] };
    }
    return { status: 404, body: {} };
  });
  const c = await sso.clones();
  assert.deepEqual(c.home, { locationId: 60003760, locationType: 'station' });
  assert.deepEqual(c.jumpClones.map(j => [j.cloneId, j.locationType, j.name, j.implants]),
    [[7, 'station', 'Hauler', [9941]], [8, 'structure', null, []]]);
  assert.deepEqual(c.locations, { 1035466617946: { name: 'Fort Knocks', systemId: 30000144 } });
  assert.deepEqual(c.ships, [{ itemId: 1, typeId: 648, locationId: 60008494 }, { itemId: 3, typeId: 587, locationId: 1035466617946 }]);
  assert.equal(c.lastJumpAt, Date.parse('2026-10-05T12:00:00Z'));
});

test('clones without the assets scope still list the clones and say why ships are missing', async () => {
  const sso = await signedIn(SCOPES.filter(s => !s.startsWith('esi-assets')), (u) =>
    (u.endsWith('/clones/') ? { body: { jump_clones: [{ jump_clone_id: 1, location_id: 60008494, location_type: 'station' }] } } : { status: 404, body: {} }));
  const c = await sso.clones();
  assert.equal(c.jumpClones.length, 1);
  assert.equal(c.ships, null);
  assert.match(c.shipsError, /esi-assets\.read_assets/);
});
