import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hotspotNeeds, planPurchases, supplyRoute, marketStation } from '../public/js/fw-supply.js';

const sell = (systemId, price, volumeRemain, locationId = 60000000 + systemId) => ({ systemId, isBuyOrder: false, price, volumeRemain, locationId });

test('hotspotNeeds: days of demand less local stock; a shared region splits its demand', () => {
  const near = { 10: 0, 11: 2 };
  const spots = [
    { regionId: 1, jumps: (s) => near[s] ?? null },
    { regionId: 1, jumps: (s) => (s === 20 ? 0 : null) },
    { regionId: 2, jumps: () => null },
  ];
  const items = [{ typeId: 5, orders: [sell(10, 120, 4), sell(11, 150, 1)], rows: [{ regionId: 1, daily: 10, price: 140 }, { regionId: 2, daily: 0, price: 1 }] }];
  const needs = hotspotNeeds(items, spots, { radius: 3, days: 2 });
  assert.deepEqual(needs, [
    { spot: 0, typeId: 5, units: 5, daily: 5, stock: 5, sellAt: 120 },   // 5/day × 2 days − 5 listed; sells under the 120 ask
    { spot: 1, typeId: 5, units: 10, daily: 5, stock: 0, sellAt: 140 },  // nothing listed nearby: the region price
  ]);
});

test('planPurchases: the station that earns most first, within cargo, budget and stops', () => {
  const needs = [
    { spot: 0, typeId: 1, units: 10, sellAt: 100 },
    { spot: 0, typeId: 2, units: 5, sellAt: 1000 },
  ];
  const asks = new Map([
    [1, [{ locationId: 'A', systemId: 1, price: 50, volume: 100 }, { locationId: 'B', systemId: 2, price: 40, volume: 3 }]],
    [2, [{ locationId: 'A', systemId: 1, price: 900, volume: 2 }, { locationId: 'C', systemId: 21, price: 500, volume: 5 }]],
    [3, [{ locationId: 'D', systemId: 4, price: 1, volume: 1e6 }]],   // nothing needs it
  ]);
  const p = planPurchases(needs, asks, { unitVolume: () => 1, feeRate: 0, maxStops: 2 });
  assert.deepEqual(p.stops.map(s => s.locationId), ['C', 'A']);
  assert.equal(p.stops[0].profit, 5 * 500);
  assert.deepEqual(p.stops[1].lines.map(l => [l.typeId, l.units]), [[1, 10]], 'type 2 is already filled at C');
  assert.equal(p.profit, 2500 + 500);
  assert.deepEqual(p.short, []);

  const tight = planPurchases(needs, asks, { unitVolume: () => 1, maxVolume: 6, maxStops: 1 });
  assert.equal(tight.volume, 5);
  assert.equal(tight.stops[0].locationId, 'C');
  assert.deepEqual(tight.short, [{ typeId: 1, spot: 0, units: 10 }]);

  const broke = planPurchases(needs, asks, { unitVolume: () => 1, maxCost: 400, maxStops: 3 });
  assert.ok(broke.cost <= 400);

  // C is 10 jumps off: at 200 ISK a jump its 2500 nets 500, under A's 700 right where you start.
  const far = planPurchases(needs, asks, { unitVolume: () => 1, maxStops: 1, start: 1, jumps: (a, b) => Math.abs(a - b) / 2, iskPerJump: 200 });
  assert.deepEqual(far.stops.map(s => s.locationId), ['A']);
  const none = planPurchases(needs, asks, { unitVolume: () => 1, start: 1, jumps: () => null, iskPerJump: 1 });
  assert.deepEqual(none.stops.map(s => s.locationId), ['A'], 'unreachable stations are skipped; the start system is 0 jumps');

  const fees = planPurchases([{ spot: 0, typeId: 1, units: 10, sellAt: 52 }], asks, { unitVolume: () => 1, feeRate: 0.1 });
  assert.deepEqual(fees.stops.map(s => s.locationId), ['B'], 'at A the fee eats the margin');
});

test('supplyRoute: buys first in the fewest jumps, then drop-offs', () => {
  // A line of systems 1–6: jumps = |a − b|.
  const jumps = (a, b) => Math.abs(a - b);
  const r = supplyRoute(3, [5, 1], [6, 2], jumps);
  assert.deepEqual(r.order.map(s => [s.kind, s.systemId]), [['buy', 1], ['buy', 5], ['sell', 6], ['sell', 2]]);
  assert.equal(r.jumps, 2 + 4 + 1 + 4);
  assert.equal(r.unreachable, false);
  assert.equal(supplyRoute(1, [2], [], () => null).unreachable, true);
});

test('marketStation: the busiest station in range, nearest on a tie', () => {
  const jumps = (s) => ({ 1: 0, 2: 1, 3: 9 }[s] ?? null);
  const orders = [sell(2, 1, 1, 'X'), sell(2, 1, 1, 'X'), sell(1, 1, 1, 'Y'), sell(3, 1, 1, 'Z'), sell(3, 1, 1, 'Z'), sell(3, 1, 1, 'Z'),
    { ...sell(1, 1, 1, 'Y'), isBuyOrder: true }];
  assert.equal(marketStation(orders, jumps, 3).locationId, 'X');
  assert.equal(marketStation([sell(2, 1, 1, 'X'), sell(1, 1, 1, 'Y')], jumps, 3).locationId, 'Y');
  assert.equal(marketStation(orders, jumps, -1), null);
});
