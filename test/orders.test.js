import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMyOrder, orderStanding, expiresAt } from '../public/js/orders.js';
import { buildGraph } from '../public/js/galaxy.js';
import { buildRangeContext } from '../public/js/ranges.js';

// 10 – 11 – 12, one region. Stations: 1 in 10, 2 in 11, 3 in 12.
const U = { regions: [{ id: 1, name: 'R' }], systems: { id: [10, 11, 12], name: ['A', 'B', 'C'], sec: [1, 1, 1], region: [0, 0, 0] }, jumps: [0, 1, 1, 2] };
const ctx = buildRangeContext(buildGraph(U), { 1: ['S1', 10], 2: ['S2', 11], 3: ['S3', 12] });
const sys = { 1: 10, 2: 11, 3: 12 };
const m = (x) => ({ orderId: Math.random(), minVolume: 1, regionId: 1, volumeRemain: 10, range: 'STATION', ...x });

test('normalizeMyOrder handles ESI omitting is_buy_order on sells', () => {
  const o = normalizeMyOrder({ order_id: 5, type_id: 34, price: 4, volume_remain: 1, volume_total: 2, location_id: 2, region_id: 1,
    range: 'region', issued: '2026-09-20T00:00:00Z', duration: 90 }, (l) => sys[l]);
  assert.equal(o.isBuyOrder, false);
  assert.equal(o.systemId, 11);
  assert.equal(o.range, 'REGION');
  assert.equal(expiresAt(o), Date.parse('2026-12-19T00:00:00Z'));
});

test('sell orders: undercut only by cheaper sellers at the same station, ignoring your own', () => {
  const mine = m({ orderId: 1, isBuyOrder: false, price: 100, locationId: 2, systemId: 11 });
  const market = [mine, m({ orderId: 2, isBuyOrder: false, price: 99, locationId: 3, systemId: 12 }),  // other station
    m({ orderId: 3, isBuyOrder: false, price: 95, locationId: 2, systemId: 11 })];                      // your corp's
  assert.equal(orderStanding(mine, market, { ownIds: new Set([1, 3]), ctx }).status, 'alone');
  const s = orderStanding(mine, market, { ownIds: new Set([1]), ctx });
  assert.deepEqual([s.status, s.best, s.diff, s.pct], ['undercut', 95, 5, 5]);
  assert.equal(orderStanding(mine, [mine, m({ isBuyOrder: false, price: 101, locationId: 2 })], { ownIds: new Set([1]) }).status, 'best');
});

test('buy orders: outbid by any higher order whose range reaches your station', () => {
  const mine = m({ orderId: 1, isBuyOrder: true, price: 50, locationId: 2, systemId: 11 });
  const far = m({ isBuyOrder: true, price: 60, locationId: 3, systemId: 12, range: '_1' }); // 1 jump away, range 1: reaches
  const short = m({ isBuyOrder: true, price: 70, locationId: 3, systemId: 12 });            // station range: doesn't
  const bait = m({ isBuyOrder: true, price: 90, locationId: 2, systemId: 11, minVolume: 50 });
  const s = orderStanding(mine, [mine, far, short, bait], { ownIds: new Set([1]), ctx });
  assert.deepEqual([s.status, s.best, s.rivals], ['outbid', 60, 1]);
  // Without the star map we can only compare against the same station.
  assert.equal(orderStanding(mine, [mine, far], { ownIds: new Set([1]), ctx: null }).status, 'alone');
});
