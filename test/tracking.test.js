import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECK_EVERY, TRACK_FOR, newTracked, isActive, nextCheckAt, isDue, checksLeft, resubscribe, withCheck,
  bidReaches, quoteTracked, cleanTracked, haulStatus, goneCheck, lastGood,
} from '../public/js/tracking.js';

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const haul = {
  typeId: 34, name: 'Tritanium', vol: 0.01,
  from: { loc: 60003760, sys: 30000142, regionId: 10000002, name: 'Jita', station: 'Jita 4-4' },
  to: { loc: 60008494, sys: 30002187, regionId: 10000043, name: 'Amarr', station: 'Amarr VIII' },
};

test('a tracked haul is checked right away, then every 10 minutes for an hour', () => {
  let t = newTracked(haul, T0);
  assert.equal(t.key, '34:60003760:60008494');
  assert.ok(isDue(t, T0));
  assert.equal(checksLeft(t, T0), TRACK_FOR / CHECK_EVERY);
  const checks = [];
  for (let now = T0; now < T0 + 2 * TRACK_FOR; now += MIN) {
    if (isDue(t, now)) { checks.push((now - T0) / MIN); t = withCheck(t, now, { profit: 1 }); }
  }
  assert.deepEqual(checks, [0, 10, 20, 30, 40, 50]);
  assert.equal(t.points.length, 6);
  assert.equal(nextCheckAt(t), null);
  assert.equal(isActive(t, T0 + TRACK_FOR), false);
  assert.equal(checksLeft(t, T0 + TRACK_FOR), 0);
});

test('track another hour restarts checks now and keeps the history', () => {
  let t = newTracked(haul, T0);
  t = withCheck(t, T0, { profit: 5 });
  const later = T0 + 3 * TRACK_FOR;
  assert.equal(isDue(t, later), false);
  t = resubscribe(t, later);
  assert.ok(isActive(t, later));
  assert.ok(isDue(t, later));
  assert.equal(t.until, later + TRACK_FOR);
  assert.equal(t.points.length, 1);
});

test('a failed check waits for the next slot instead of retrying every tick', () => {
  let t = withCheck(newTracked(haul, T0), T0, null, 'HTTP 502');
  assert.equal(t.error, 'HTTP 502');
  assert.equal(t.points.length, 0);
  assert.equal(isDue(t, T0 + 5 * MIN), false);
  assert.ok(isDue(t, T0 + 10 * MIN));
});

test('bidReaches follows buy-order ranges, never across regions', () => {
  const to = { loc: 100, sys: 1, regionId: 9 };
  const jumps = (a, b) => (a === b ? 0 : Math.abs(a - b));
  const o = (x) => ({ minVolume: 1, locationId: 200, systemId: 1, regionId: 9, range: 'STATION', ...x });
  assert.ok(bidReaches(o({ locationId: 100 }), to, jumps));
  assert.equal(bidReaches(o({}), to, jumps), false);                                   // other station, station range
  assert.ok(bidReaches(o({ range: 'SOLARSYSTEM' }), to, jumps));
  assert.equal(bidReaches(o({ range: 'SOLARSYSTEM', systemId: 2 }), to, jumps), false);
  assert.ok(bidReaches(o({ range: '_3', systemId: 4 }), to, jumps));                   // 3 jumps away
  assert.equal(bidReaches(o({ range: '_3', systemId: 5 }), to, jumps), false);         // 4 jumps away
  assert.equal(bidReaches(o({ range: '_3', systemId: 4, regionId: 8 }), to, jumps), false);
  assert.ok(bidReaches(o({ range: 'REGION', systemId: 50 }), to, jumps));
  assert.equal(bidReaches(o({ range: 'REGION', systemId: 50, regionId: 8 }), to, jumps), false);
  assert.equal(bidReaches(o({ locationId: 100, minVolume: 10 }), to, jumps), false);   // bait order
});

test('quoteTracked walks the pickup asks against bids at the drop-off within limits', () => {
  const t = newTracked(haul, T0);
  const ask = (price, volumeRemain, locationId = 60003760) => ({ isBuyOrder: false, price, volumeRemain, locationId, systemId: 30000142, regionId: 10000002, minVolume: 1, range: 'REGION' });
  const bid = (price, volumeRemain, x = {}) => ({ isBuyOrder: true, price, volumeRemain, locationId: 60008494, systemId: 30002187, regionId: 10000043, minVolume: 1, range: 'STATION', ...x });
  const orders = [
    ask(10, 100), ask(12, 100), ask(5, 1000, 60008494),   // the last is at the drop-off, not the pickup
    bid(20, 150), bid(11, 1000),
    bid(30, 1000, { locationId: 60000001, regionId: 10000002, systemId: 30000144, range: 'REGION' }),   // another region
  ];
  const q = quoteTracked(orders, t, { taxRate: 0 });
  assert.equal(q.buy, 10);
  assert.equal(q.sell, 20);
  assert.equal(q.units, 150);
  assert.equal(q.profit, 100 * 10 + 50 * 8);
  assert.equal(q.depth, 150);
  assert.equal(q.margin, 100);
  const capped = quoteTracked(orders, t, { taxRate: 0, maxCost: 500 });
  assert.equal(capped.units, 50);
  const none = quoteTracked([bid(20, 10)], t);
  assert.equal(none.buy, null);
  assert.equal(none.units, 0);
  assert.equal(none.margin, null);
});

test('haulStatus says why a haul is no longer worth it', () => {
  assert.equal(haulStatus({ buy: 10, sell: 20, units: 5, profit: 50, depth: 5 }), 'ok');
  assert.equal(haulStatus({ buy: null, sell: 20, units: 0, profit: 0, depth: 0 }), 'no-ask');
  assert.equal(haulStatus({ buy: 10, sell: null, units: 0, profit: 0, depth: 0 }), 'no-bid');
  assert.equal(haulStatus({ buy: 10, sell: 20, units: 0, profit: 0, depth: 5 }), 'nofit');
  assert.equal(haulStatus({ buy: 20, sell: 10, units: 0, profit: 0, depth: 0 }), 'unprofitable');
});

test('goneCheck and lastGood read the price history', () => {
  let t = newTracked(haul, T0);
  assert.equal(goneCheck(t), null);
  assert.equal(lastGood(t), null);
  t = withCheck(t, T0, { buy: 10, sell: 20, units: 5, profit: 50, depth: 5 });
  t = withCheck(t, T0 + 1, { buy: null, sell: 20, units: 0, profit: 0, depth: 0 });
  assert.deepEqual(goneCheck(t), { status: 'no-ask', at: T0 + 1 });
  assert.equal(lastGood(t).at, T0);
  t = withCheck(t, T0 + 2, null, 'HTTP 500');   // a failed check keeps the last result
  assert.deepEqual(goneCheck(t), { status: 'no-ask', at: T0 + 1 });
});

test('cleanTracked drops broken and duplicate entries', () => {
  const t = newTracked(haul, T0);
  assert.deepEqual(cleanTracked([t, t, { typeId: 1 }, null]).map(x => x.key), [t.key]);
  assert.deepEqual(cleanTracked('nope'), []);
});
