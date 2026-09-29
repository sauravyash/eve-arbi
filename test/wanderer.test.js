import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWanderer, wandererUrls } from '../public/js/wormholes.js';
import { wandererConnections } from '../wanderer.js';

test('parseWanderer reads a map\'s connections, with or without the data wrapper', () => {
  const rows = [
    { solar_system_source: 30000142, solar_system_target: 31000123, wormhole_type: 'K162', time_status: 1, mass_status: 2, updated_at: '2026-09-28T08:00:00Z' },
    { solar_system_source: 31000123, solar_system_target: 31000456, time_status: 0, mass_status: 0, inserted_at: '2026-09-28T07:00:00Z' },
    { solar_system_source: 5, solar_system_target: 5 },            // self loop
    { solar_system_source: null, solar_system_target: 30000142 },  // incomplete
  ];
  const links = parseWanderer({ data: rows });
  assert.deepEqual(links.map(l => [l.a, l.b, l.note, l.src, l.expiresAt]), [
    [30000142, 31000123, 'K162 · end of life · mass critical', 'wanderer', null],
    [31000123, 31000456, '', 'wanderer', null],
  ]);
  assert.equal(links[0].at, Date.parse('2026-09-28T08:00:00Z'));
  assert.equal(parseWanderer(rows).length, 2);
  assert.deepEqual(parseWanderer({ error: 'nope' }), []);
});

test('wandererUrls only allows public https sites and plain map slugs', () => {
  assert.deepEqual(wandererUrls('https://wanderer.ltd/', 'my-map_1'), [
    'https://wanderer.ltd/api/maps/my-map_1/connections', 'https://wanderer.ltd/api/map/connections?slug=my-map_1']);
  assert.deepEqual(wandererUrls('https://maps.example.org/wanderer', 'x'),
    ['https://maps.example.org/wanderer/api/maps/x/connections', 'https://maps.example.org/wanderer/api/map/connections?slug=x']);
  for (const bad of ['http://wanderer.ltd', 'https://localhost', 'https://127.0.0.1', 'https://0x7f000001', 'https://[::1]',
    'https://wanderer.ltd:8443', 'https://user:pw@wanderer.ltd', 'https://intranet', 'https://box.local', 'not a url', '']) {
    assert.equal(wandererUrls(bad, 'map'), null, bad);
  }
  for (const bad of ['', '../x', 'a/b', 'a?b', 'x'.repeat(101)]) assert.equal(wandererUrls('https://wanderer.ltd', bad), null, bad);
});

test('wandererConnections forwards the token, falls back to the older path and reports errors', async (t) => {
  const calls = [];
  const answers = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push([url, init.headers.Authorization, init.redirect]);
    const [status, body] = answers.shift();
    return new Response(body, { status });
  });
  const q = (o) => new URLSearchParams(o);

  answers.push([404, 'not found'], [200, '{"data":[]}']);
  let r = await wandererConnections(q({ url: 'https://wanderer.ltd', map: 'm' }), 'tok', 'ua');
  assert.deepEqual(r, { status: 200, body: '{"data":[]}' });
  assert.deepEqual(calls.map(c => c[0]), ['https://wanderer.ltd/api/maps/m/connections', 'https://wanderer.ltd/api/map/connections?slug=m']);
  assert.deepEqual(calls[0].slice(1), ['Bearer tok', 'manual']);

  answers.push([401, '{"error":"Unauthorized"}']);
  r = await wandererConnections(q({ url: 'https://wanderer.ltd', map: 'm' }), 'bad', 'ua');
  assert.equal(r.status, 401);

  answers.push([200, '<html>']);
  r = await wandererConnections(q({ url: 'https://wanderer.ltd', map: 'm' }), 'tok', 'ua');
  assert.equal(r.status, 502);

  const n = calls.length;
  assert.equal((await wandererConnections(q({ url: 'https://localhost', map: 'm' }), 'tok', 'ua')).status, 400);
  assert.equal((await wandererConnections(q({ url: 'https://wanderer.ltd', map: 'm' }), '', 'ua')).status, 400);
  assert.equal((await wandererConnections(q({ url: 'https://wanderer.ltd', map: 'm' }), 'a\r\nX: y', 'ua')).status, 400);
  assert.equal(calls.length, n);   // refused before any request
});
