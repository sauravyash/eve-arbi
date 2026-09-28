import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, jumpsBetween, pathBetween } from '../public/js/galaxy.js';
import { buildRangeContext } from '../public/js/ranges.js';
import { recordLocation, trailLinks, parseEveScout, withLinks, shortcutsOn, MAX_GAP } from '../public/js/wormholes.js';
import { priceLoad, parsePaste, fill } from '../public/js/mining-value.js';

// A–B–C–D chain in high-sec, with a low-sec detour A–L–D. A, B, L in region 1; C, D in region 2.
const U = {
  regions: [{ id: 1, name: 'R1' }, { id: 2, name: 'R2' }],
  systems: { id: [10, 11, 12, 13, 14], name: ['A', 'B', 'C', 'D', 'L'], sec: [0.9, 0.8, 0.7, 0.6, 0.3], region: [0, 0, 1, 1, 0] },
  jumps: [0, 1, 1, 2, 2, 3, 0, 4, 4, 3],
};
const J = 31_000_123;

test('recordLocation keeps system changes with the gap since the last reading', () => {
  let t = recordLocation(null, { systemId: 10, stationId: 60000001 }, 1_000);
  t = recordLocation(t, { systemId: 10 }, 21_000);                // same system: no hop
  t = recordLocation(t, { systemId: J }, 41_000);
  t = recordLocation(t, { systemId: 13, structureId: 1e12 }, 61_000);
  assert.deepEqual(t.hops, [
    { a: 10, b: J, at: 41_000, gap: 20_000, da: false, db: false },
    { a: J, b: 13, at: 61_000, gap: 20_000, da: false, db: true },
  ]);
  assert.deepEqual(t.last, { s: 13, d: true, at: 61_000 });
  // Old hops age out.
  t = recordLocation(t, { systemId: 13 }, 61_000 + 49 * 3_600_000);
  assert.equal(t.hops.length, 0);
  assert.deepEqual(recordLocation(undefined, null), { hops: [] });
});

test('trailLinks keeps wormhole and non-gate jumps, not gates, long gaps, clone jumps or abyssal trips', () => {
  const g = buildGraph(U);
  const h = (a, b, at, x = {}) => ({ a, b, at, gap: 20_000, da: false, db: false, ...x });
  const links = trailLinks([
    h(10, 11, 1),                                  // stargate
    h(10, J, 2), h(J, 13, 3),                      // in and out of wormhole space
    h(11, 13, 4),                                  // no gate between B and D: wormhole, bridge or cyno
    h(10, 12, 5, { gap: MAX_GAP + 1 }),            // tab was asleep: path unknown
    h(11, 12, 6, { da: true, db: true }),          // docked to docked: jump clone
    h(10, 32_000_001, 7), h(32_000_001, 10, 8),    // abyssal filament
    h(J, 10, 9),                                   // same pair again, later
  ], g);
  assert.deepEqual(links.map(l => [l.a, l.b, l.kind, l.at]), [[J, 10, 'wormhole', 9], [11, 13, 'jump', 4], [J, 13, 'wormhole', 3]]);
  assert.deepEqual(trailLinks([h(10, J, 2)], g, { since: 3 }), []);
});

test('withLinks routes through shortcuts and new wormhole systems without touching the gate graph', () => {
  const g = buildGraph(U);
  const w = withLinks(g, [{ a: 10, b: J }, { a: J, b: 13 }, { a: 11, b: 10 }], new Map([[J, 'J000123']]));
  assert.equal(jumpsBetween(g, 10, 13, 'shortest'), 2);
  assert.equal(jumpsBetween(w, 11, 13, 'shortest'), 2);        // B–C–D is as short as B–A–J–D
  assert.equal(jumpsBetween(w, 10, J, 'shortest'), 1);
  assert.equal(jumpsBetween(w, J, 13, 'shortest'), 1);         // start in wormhole space
  assert.equal(jumpsBetween(w, 10, 13, 'secure'), 3);          // wormhole space is never high-sec
  assert.equal(w.name[w.indexOf.get(J)], 'J000123');
  assert.equal(w.n, g.n + 1);
  assert.equal(g.indexOf.has(J), false);                       // the original graph is unchanged
  assert.equal(withLinks(g, []), g);
  const s = withLinks(g, [{ a: 11, b: 13 }]);
  assert.equal(jumpsBetween(s, 11, 13, 'secure'), 1);
  assert.equal(jumpsBetween(s, 10, 13, 'secure'), 2);          // A–B–D: B and D are high-sec
  assert.equal(shortcutsOn(s, pathBetween(s, 10, 13, 'secure')), 1);
});

test('parseEveScout keeps live wormholes with their system names', () => {
  const now = Date.parse('2026-09-28T08:00:00Z');
  const { links, names } = parseEveScout([
    { signature_type: 'wormhole', out_system_id: 31000005, out_system_name: 'Thera', in_system_id: 30002086, in_system_name: 'Turnur',
      expires_at: '2026-09-28T12:00:00Z', updated_at: '2026-09-28T07:00:00Z', wh_type: 'Q063', max_ship_size: 'medium' },
    { signature_type: 'wormhole', out_system_id: 31000005, in_system_id: 30000142, expires_at: '2026-09-28T07:59:00Z' },
    { signature_type: 'combat', out_system_id: 1, in_system_id: 2 },
  ], now);
  assert.equal(links.length, 1);
  assert.deepEqual(links[0], { a: 31000005, b: 30002086, at: Date.parse('2026-09-28T07:00:00Z'), expiresAt: Date.parse('2026-09-28T12:00:00Z'),
    kind: 'wormhole', src: 'evescout', note: 'Q063 · medium ships' });
  assert.equal(names.get(31000005), 'Thera');
  assert.deepEqual(parseEveScout(null), { links: [], names: new Map() });
});

const o = (x) => ({ orderId: Math.random(), volumeRemain: 100, minVolume: 1, isBuyOrder: true, regionId: 1, range: 'STATION', ...x });

test('priceLoad sells the whole load at each station into every buy order reaching it', () => {
  const g = buildGraph(U);
  const stations = { 60000001: ['A station', 10], 60000002: ['B station', 11], 60000003: ['C station', 12], 60000004: ['D station', 13] };
  const ctx = buildRangeContext(g, stations);
  const books = {
    1: [
      o({ locationId: 60000001, systemId: 10, price: 10, volumeRemain: 50 }),
      o({ locationId: 60000001, systemId: 10, price: 8, volumeRemain: 100 }),
      o({ locationId: 60000002, systemId: 11, price: 12, volumeRemain: 30, range: '_1' }),   // reaches A and B
      o({ locationId: 60000004, systemId: 13, price: 20, volumeRemain: 500, regionId: 2, range: 'REGION' }), // C and D
      o({ locationId: 60000003, systemId: 12, price: 99, minVolume: 50, regionId: 2 }),     // bait: ignored
    ],
    2: [o({ locationId: 60000001, systemId: 10, price: 1000, volumeRemain: 1 })],
  };
  const rows = priceLoad([{ typeId: 1, qty: 100, volume: 1 }, { typeId: 2, qty: 2, volume: 10 }], books, g, ctx,
    { fromSystem: 10, taxRate: 0.1, always: [[60000002, 11], [60000003, 12]] });
  const at = (l) => rows.find(r => r.locationId === l);
  // A: 30 × 12 (ranged from B) + 50 × 10 + 20 × 8 = 1020, plus 1 × 1000 of item 2.
  assert.equal(at(60000001).gross, 2020);
  assert.equal(at(60000001).isk, 2020 * 0.9);
  assert.deepEqual(at(60000001).lines.map(l => [l.units, l.best]), [[100, 12], [1, 1000]]);
  assert.equal(at(60000001).share, (100 + 10) / 120);
  // B: only the ranged order.
  assert.equal(at(60000002).gross, 360);
  // C and D both reach the region-wide order in region 2.
  assert.equal(at(60000003).gross, 2000);
  assert.equal(at(60000004).gross, 2000);
  assert.equal(rows[0].locationId, 60000001);
  // A station asked for with no buyers still gets a row; filtered stations don't.
  const none = priceLoad([{ typeId: 2, qty: 1 }], books, g, ctx, { always: [[60000004, 13]], allowStation: (l) => l !== 60000001 });
  assert.deepEqual(none.map(r => [r.locationId, r.isk]), [[60000004, 0]]);
});

test('fill walks price levels until the load runs out', () => {
  assert.deepEqual(fill([[10, 5], [8, 10]], 7), { units: 7, gross: 66 });
  assert.deepEqual(fill([[10, 5]], 7), { units: 5, gross: 50 });
});

test('parsePaste reads EVE inventory copies and name/quantity lines', () => {
  const ids = { veldspar: 1230, 'compressed fullerite-c50': 62398, 'blue ice': 16264 };
  const r = parsePaste([
    'Veldspar\t12,345\tVeldspar\t\t\t1,234.50 m3',
    'Compressed Fullerite-C50 1 000',
    '250 x Blue Ice',
    'Veldspar 5',
    'Tritanium Thing\t3',
    'Blue Ice',
  ].join('\n'), (n) => ids[n.toLowerCase()] ?? null);
  assert.deepEqual(r.items, [{ typeId: 1230, qty: 12350 }, { typeId: 62398, qty: 1000 }, { typeId: 16264, qty: 251 }]);
  assert.deepEqual(r.unknown, ['Tritanium Thing']);
});
