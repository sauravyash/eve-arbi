import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../public/js/galaxy.js';
import { withLinks } from '../public/js/wormholes.js';
import {
  findPath, planRoute, jumpMatrix, optimizeOrder, orderCost, usableLinks, linkShipSize, linkExpiry,
  routeSummary, parseWaypointText, chatLinks, encodeStops, decodeStops, formatDuration, UNREACHABLE,
  parseBridgeText, bridgeText, lyBetween,
} from '../public/js/route-plan.js';

// A line of systems 1–6 with a low-sec pocket: 1(hi) 2(hi) 3(low) 4(hi) 5(hi) 6(null),
// plus a high-sec detour 2–7–8–4 around system 3.
function universe() {
  const ids = [1, 2, 3, 4, 5, 6, 7, 8];
  const sec = [0.9, 0.8, 0.3, 0.7, 0.6, -0.2, 0.5, 0.5];
  const gates = [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [2, 7], [7, 8], [8, 4]];
  const at = (id) => ids.indexOf(id);
  return buildGraph({
    systems: { id: ids, name: ids.map(i => `S${i}`), sec, region: ids.map(i => (i <= 4 ? 0 : 1)) },
    regions: [{ id: 100, name: 'West' }, { id: 200, name: 'East' }],
    jumps: gates.flatMap(([a, b]) => [at(a), at(b)]),
  });
}

test('findPath takes the shortest way, or the high-sec detour when asked', () => {
  const g = universe();
  assert.deepEqual(findPath(g, 1, 5).path, [1, 2, 3, 4, 5]);
  const safe = findPath(g, 1, 5, { flag: 'secure' });
  assert.deepEqual(safe.path, [1, 2, 7, 8, 4, 5]);
  assert.equal(safe.jumps, 5);
  assert.equal(safe.fallback, null);
});

test('findPath avoids systems, and says when it had to relax the preference or the avoid list', () => {
  const g = universe();
  assert.deepEqual(findPath(g, 1, 5, { avoid: new Set([3]) }).path, [1, 2, 7, 8, 4, 5]);
  // The destination is in null-sec: still reachable, ending outside the preference is allowed.
  const toNull = findPath(g, 1, 6, { flag: 'secure' });
  assert.equal(toNull.fallback, null);
  assert.equal(toNull.path.at(-1), 6);
  // Every way to 4 is avoided: fly through anyway, flagged.
  const forced = findPath(g, 1, 5, { avoid: new Set([3, 7]) });
  assert.equal(forced.fallback, 'avoid');
  assert.deepEqual(forced.path, [1, 2, 3, 4, 5]);
  assert.equal(findPath(g, 1, 999), null);
});

test('wormhole space counts as allowed on safe routes unless passJSpace is off', () => {
  const g = withLinks(universe(), [{ a: 1, b: 31000001 }, { a: 31000001, b: 5 }]);
  assert.deepEqual(findPath(g, 1, 5, { flag: 'secure' }).path, [1, 31000001, 5]);
  assert.deepEqual(findPath(g, 1, 5, { flag: 'secure', passJSpace: false }).path, [1, 2, 7, 8, 4, 5]);
});

test('planRoute flies legs in order with per-leg preferences', () => {
  const g = universe();
  const r = planRoute(g, [{ id: 1 }, { id: 4, flag: 'secure' }, { id: 6 }], { flag: 'shortest' });
  assert.deepEqual(r.legs.map(l => l.jumps), [4, 2]);
  assert.deepEqual(r.path, [1, 2, 7, 8, 4, 5, 6]);
  assert.equal(r.jumps, 6);
  assert.equal(planRoute(g, [{ id: 1 }, { id: 999 }]).broken, 1);
});

test('optimizeOrder finds the cheapest order and keeps the start (and destination when asked)', () => {
  const g = universe();
  const ids = [1, 6, 2, 5];   // start at 1, visit 6, 2 and 5
  const d = jumpMatrix(g, ids);
  const order = optimizeOrder(d);
  assert.deepEqual(order.map(i => ids[i]), [1, 2, 5, 6]);
  assert.equal(orderCost(d, order), 5);
  const keep = optimizeOrder(d, { keepEnd: true });
  assert.equal(ids[keep.at(-1)], 5);
  assert.equal(ids[keep[0]], 1);
});

test('optimizeOrder heuristic (more than 10 waypoints) visits each once and beats the given order', () => {
  // Points on a line, shuffled: the best order walks them left to right.
  const pos = [0, 9, 3, 12, 1, 7, 4, 11, 2, 8, 5, 10, 6];
  const d = pos.map(a => pos.map(b => Math.abs(a - b)));
  const order = optimizeOrder(d);
  assert.equal(order[0], 0);
  assert.deepEqual([...order].sort((a, b) => a - b), [...pos.keys()]);
  assert.equal(orderCost(d, order), 12);
});

test('jumpMatrix marks unreachable pairs', () => {
  const d = jumpMatrix(universe(), [1, 999]);
  assert.equal(d[0][1], UNREACHABLE);
});

test('usableLinks filters by ship size, time left and your switches', () => {
  const now = 10 * 3_600_000;
  const info = (code) => ({ Q063: { ships: 'medium' }, A239: { ships: 'large' } }[code]);
  const links = [
    { key: 'a', type: 'Q063', expiresAt: now + 5 * 3_600_000 },
    { key: 'b', type: 'A239', expiresAt: now + 10 * 60_000 },
    { key: 'c', note: 'C247 · xlarge ships' },
    { key: 'd', note: 'K162 · end of life', at: now - 3.5 * 3_600_000 },
    { key: 'e', use: false },
  ];
  const keys = (o) => usableLinks(links, { now, whInfo: info, ...o }).map(l => l.key);
  assert.deepEqual(keys({}), ['a', 'b', 'c', 'd']);
  assert.deepEqual(keys({ ship: 'large' }), ['b', 'c', 'd']);
  assert.deepEqual(keys({ minLeftMs: 60 * 60_000 }), ['a', 'c']);
  assert.equal(linkShipSize(links[2]), 'xlarge');
  assert.equal(linkExpiry(links[3]), now + 0.5 * 3_600_000);
});

test('routeSummary counts security bands, regions and wormhole steps', () => {
  const g = withLinks(universe(), [{ a: 5, b: 31000001 }]);
  const path = [1, 2, 3, 4, 5, 31000001];
  const s = routeSummary(g, path, (a, b) => g.shortcuts.has(a < b ? `${a}-${b}` : `${b}-${a}`));
  assert.deepEqual({ ...s, minSec: Math.round(s.minSec * 10) / 10 },
    { jumps: 5, high: 3, low: 1, null: 0, jspace: 1, wormholes: 1, regions: ['West', 'East'], minSec: 0.3, lowEntries: 2 });
});

test('parseWaypointText reads lists, arrows, chat links and numbered lines', () => {
  assert.deepEqual(parseWaypointText('Jita\nPerimeter, Urlen'), [{ name: 'Jita' }, { name: 'Perimeter' }, { name: 'Urlen' }]);
  assert.deepEqual(parseWaypointText('Jita → Amarr -> Hek > Rens'), [{ name: 'Jita' }, { name: 'Amarr' }, { name: 'Hek' }, { name: 'Rens' }]);
  assert.deepEqual(parseWaypointText('1. Jita (0.9)\n2) 1DQ1-A -0.4'), [{ name: 'Jita' }, { name: '1DQ1-A' }]);
  assert.deepEqual(parseWaypointText('<url=showinfo:5//30000142>Jita</url> → <url=showinfo:5//30002187>Amarr</url>'),
    [{ id: 30000142, name: 'Jita' }, { id: 30002187, name: 'Amarr' }]);
});

test('chat links, stop encoding and durations', () => {
  assert.equal(chatLinks([{ id: 30000142, name: 'Jita' }, { id: 30002187, name: 'Amarr' }]),
    '<url=showinfo:5//30000142>Jita</url> → <url=showinfo:5//30002187>Amarr</url>');
  const stops = [{ id: 30000142 }, { id: 30002187, flag: 'secure' }];
  assert.equal(encodeStops(stops), '30000142,30002187:secure');
  assert.deepEqual(decodeStops('30000142,30002187:secure,x,5:bogus'), [...stops, { id: 5 }]);
  assert.equal(formatDuration(20), '< 1 min');
  assert.equal(formatDuration(4320), '1 h 12 min');
});

test('parseBridgeText reads bridge lists in the usual formats', () => {
  assert.deepEqual(parseBridgeText([
    '1DQ1-A » 8QT-H4 - Imperium Bridge',
    'E3OI-U @ 1-1 <-> 8QT-H4 @ 3-2',
    'J5A-IX → MJXW-P',
    'Q-HESZ\tUMI-KK',
    'BWF-ZZ, 3-FKCZ',
    'not a bridge',
    'Jita » jita',
  ].join('\r\n')), [
    { a: '1DQ1-A', b: '8QT-H4', note: 'Imperium Bridge' },
    { a: 'E3OI-U', b: '8QT-H4' },
    { a: 'J5A-IX', b: 'MJXW-P' },
    { a: 'Q-HESZ', b: 'UMI-KK' },
    { a: 'BWF-ZZ', b: '3-FKCZ' },
  ]);
  const name = (id) => ({ 1: '1DQ1-A', 2: '8QT-H4' }[id]);
  const text = bridgeText([{ a: 1, b: 2, note: 'Home' }, { a: 2, b: 1 }], name);
  assert.equal(text, '1DQ1-A » 8QT-H4 - Home\n8QT-H4 » 1DQ1-A');
  assert.deepEqual(parseBridgeText(text)[0], { a: '1DQ1-A', b: '8QT-H4', note: 'Home' });
});

test('jump bridges take every ship but capitals and never expire', () => {
  const bridge = { key: 'br', kind: 'bridge', src: 'bridge', at: 0, expiresAt: null };
  assert.equal(linkShipSize(bridge), 'xlarge');
  assert.equal(linkExpiry(bridge), null);
  assert.deepEqual(usableLinks([bridge], { ship: 'xlarge', minLeftMs: 4 * 3_600_000 }).map(l => l.key), ['br']);
  assert.deepEqual(usableLinks([bridge], { ship: 'capital' }), []);
});

test('lyBetween measures in three dimensions', () => {
  const systems = { x: [0, 3], y: [0, 4], z3: [0, 12] };
  assert.equal(lyBetween(systems, 0, 1), 13);
  assert.equal(lyBetween(null, 0, 1), null);
});
