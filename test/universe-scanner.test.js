import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestOrders, mergeRegion, pairsForType, buildScanContext, rangeCode, REGION, TOP_LEVELS } from '../universe-scanner.js';

const ord = (o) => ({ type_id: 34, min_volume: 1, volume_remain: 10, range: 'region', ...o });

test('ingest groups buy orders by station and range, and drops bait orders', () => {
  const scratch = new Map();
  ingestOrders(scratch, [
    ord({ location_id: 1, system_id: 10, is_buy_order: false, price: 5 }),
    ord({ location_id: 1, system_id: 10, is_buy_order: false, price: 5, volume_remain: 3 }),
    ord({ location_id: 1, system_id: 10, is_buy_order: true, price: 4, range: 'station' }),
    ord({ location_id: 1, system_id: 10, is_buy_order: true, price: 4, range: '5' }),
    ord({ location_id: 1, system_id: 10, is_buy_order: true, price: 4, min_volume: 100 }),
  ], 7);
  const t = scratch.get(34);
  assert.deepEqual([...t.a.get(1).m], [[5, 13]]);
  assert.deepEqual([...t.b.values()].map(g => [g.r, g.g, [...g.m]]), [[-1, 7, [[4, 10]]], [5, 7, [[4, 10]]]]);
  assert.deepEqual(['station', 'solarsystem', '10', 'region'].map(rangeCode), [-1, 0, 10, REGION]);
});

test('mergeRegion keeps only the best levels per side', () => {
  const scratch = new Map(), book = new Map();
  const orders = [];
  for (let i = 0; i < TOP_LEVELS + 5; i++) {
    orders.push(ord({ location_id: 1, system_id: 10, is_buy_order: false, price: 100 + i }));
    orders.push(ord({ location_id: 1, system_id: 10, is_buy_order: true, price: 50 + i }));
  }
  ingestOrders(scratch, orders, 1);
  mergeRegion(book, scratch);
  const e = book.get(34);
  assert.equal(e.asks[0].a.length, TOP_LEVELS);
  assert.equal(e.asks[0].a[0][0], 100);                   // cheapest ask first
  assert.equal(e.bids[0].lv[0][0], 50 + TOP_LEVELS + 4);  // highest bid first
});

// Chain 10 – 11 – 12 – 13 – 14. Systems 10–13 are region 1, 14 is region 2.
// NPC stations: 101 in 10, 111 in 11, 131 in 13, 141 in 14. System 12 has none.
const U = {
  regions: [{ id: 1, name: 'R1' }, { id: 2, name: 'R2' }],
  systems: { id: [10, 11, 12, 13, 14], name: ['A', 'B', 'C', 'D', 'E'], sec: [0.9, 0.9, 0.9, 0.9, 0.9], region: [0, 0, 0, 0, 1] },
  jumps: [0, 1, 1, 2, 2, 3, 3, 4],
};
const STATIONS = { 101: ['A station', 10], 111: ['B station', 11], 131: ['D station', 13], 141: ['E station', 14] };
const ctx = buildScanContext(U, STATIONS);
const seller = { l: 101, s: 10, a: [[100, 1e6]] };
const bid = (o) => ({ l: 131, s: 13, g: 1, lv: [[120, 1e6]], ...o });
const pairs = (bids) => pairsForType(34, { asks: [seller], bids }, ctx, { minProfit: 1 })
  .map(c => ({ d: c.d, ds: c.ds, x: !!c.x, units: c.s.reduce((n, [u]) => n + u, 0) }));

test("ranged buy order: sell at the nearest in-range station, not the order's own", () => {
  const r = pairs([bid({ r: 2 })]); // placed in 13, reaches 11 (2 jumps) — 12 has no station
  assert.deepEqual(r.find(p => p.d === 111), { d: 111, ds: 11, x: true, units: 1e6 });
  assert.ok(r.some(p => p.d === 131 && !p.x)); // its own station is still offered
});

test('ranges never cross a region border', () => {
  // Placed in 14 (region 2) with a 3-jump range: 11 is in range by distance but in region 1.
  assert.deepEqual(pairs([bid({ l: 141, s: 14, g: 2, r: 3 })]), [{ d: 141, ds: 14, x: false, units: 1e6 }]);
});

test('station-range order can only be filled at its own station', () => {
  assert.deepEqual(pairs([bid({ r: -1 })]), [{ d: 131, ds: 13, x: false, units: 1e6 }]);
});

test('region-range order: enter the region at its nearest station; same-region = sell where you buy', () => {
  assert.ok(pairs([bid({ l: 141, s: 14, g: 2, r: REGION })]).some(p => p.d === 141));
  const local = pairs([bid({ l: 111, s: 11, g: 1, r: REGION })]);
  assert.deepEqual(local.find(p => p.d === 101), { d: 101, ds: 10, x: true, units: 1e6 }); // 0 jumps
});

test('one sell point fills several orders it can reach, best price first', () => {
  const r = pairs([bid({ r: 2, lv: [[130, 5]] }), bid({ l: 111, s: 11, g: 1, r: -1, lv: [[110, 5]] })]);
  const at111 = r.find(p => p.d === 111);
  assert.equal(at111.units, 10); // 5 @130 via range + 5 @110 in the station
});
