import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanItems, createWatchlist, wikiUrl, itemPic, removeButton, MAX_ITEMS } from '../public/js/watchlist.js';

// A minimal localStorage and fetch for the browser-side module.
function browser(responses = {}) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k),
  };
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body && JSON.parse(init.body) });
    const r = responses[`${init.method || 'GET'} ${url}`] ?? { status: 401, body: { error: 'Not signed in' } };
    return { ok: r.status < 300, status: r.status, json: async () => r.body };
  };
  return { store, calls };
}

test('cleanItems keeps valid, unique items and caps the list', () => {
  assert.deepEqual(cleanItems([{ typeId: 34, name: 'Tritanium' }, { typeId: '34' }, { typeId: -1 }, { typeId: 'x' }, null, { typeId: 35 }]),
    [{ typeId: 34, name: 'Tritanium' }, { typeId: 35, name: 'Type 35' }]);
  assert.equal(cleanItems(Array.from({ length: MAX_ITEMS + 5 }, (_, i) => ({ typeId: i + 1 }))).length, MAX_ITEMS);
  assert.deepEqual(cleanItems('nope'), []);
});

test('item picture links to the EVE University wiki; names are escaped', () => {
  assert.equal(wikiUrl('Large Skill Injector'), 'https://wiki.eveuniversity.org/Special:Search?search=Large%20Skill%20Injector&go=Go');
  const html = itemPic(587, 'Rifter <b>');
  assert.match(html, /href="https:\/\/wiki\.eveuniversity\.org\/Special:Search\?search=Rifter%20%3Cb%3E&go=Go"/);
  assert.match(html, /types\/587\/icon/);
  assert.doesNotMatch(html, /<b>/);
  assert.match(removeButton(587, 'Rifter'), /data-remove="587"/);
});

test('new watchlists start empty; an untouched old default list is dropped, an edited one kept', () => {
  const defaults = [{ typeId: 34, name: 'Tritanium' }, { typeId: 37, name: 'Isogen' }];
  browser();
  assert.deepEqual(createWatchlist('hub', { onLoad() {} }).initial(), []);
  browser();
  assert.deepEqual(createWatchlist('hub', { legacy: defaults, legacyDefaults: defaults, onLoad() {} }).initial(), []);
  browser();
  const edited = [...defaults, { typeId: 587, name: 'Rifter' }];
  assert.deepEqual(createWatchlist('hub', { legacy: edited, legacyDefaults: defaults, onLoad() {} }).initial(), edited);
});

test('signed out: the list lives in localStorage', async () => {
  const { store } = browser();
  let loaded;
  const w = createWatchlist('market', { onLoad: (items, mode) => { loaded = { items, mode }; } });
  await w.load();
  assert.deepEqual(loaded, { items: [], mode: 'local' });
  w.save([{ typeId: 34, name: 'Tritanium' }]);
  assert.deepEqual(JSON.parse(store.get('watchlist.market')), [{ typeId: 34, name: 'Tritanium' }]);
});

test('signed in: the character list wins, and a never-saved character takes this browser\'s list once', async () => {
  const mine = [{ typeId: 34, name: 'Tritanium' }];
  const { store, calls } = browser({
    'GET /api/me/watchlists/hub': { status: 200, body: { items: [], saved: false } },
    'PUT /api/me/watchlists/hub': { status: 200, body: { saved: true } },
  });
  store.set('watchlist.hub', JSON.stringify(mine));
  let loaded;
  const w = createWatchlist('hub', { onLoad: (items, mode) => { loaded = { items, mode }; } });
  await w.load();
  assert.deepEqual(loaded, { items: mine, mode: 'account' });
  assert.deepEqual(calls.find(c => c.method === 'PUT').body, { items: mine });

  // Deliberately emptied on the account: stays empty.
  const b = browser({ 'GET /api/me/watchlists/hub': { status: 200, body: { items: [], saved: true } } });
  b.store.set('watchlist.hub', JSON.stringify(mine));
  const w2 = createWatchlist('hub', { onLoad: (items) => { loaded = items; } });
  await w2.load();
  assert.deepEqual(loaded, []);
  assert.ok(!b.calls.some(c => c.method === 'PUT'));
});
