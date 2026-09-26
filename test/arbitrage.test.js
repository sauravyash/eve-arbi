import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUBS, extractHubBooks, matchDepth, computeRoutes, formatIsk } from '../public/js/arbitrage.js';

const [JITA, AMARR] = HUBS;
const order = (o) => ({ volumeRemain: 10, range: 'REGION', regionId: 0, systemId: 0, locationId: 0, ...o });

test('extractHubBooks: asks only from hub station, bids by reach', () => {
  const payload = { orders: [
    order({ isBuyOrder: false, price: 100, locationId: JITA.stationId, systemId: JITA.id }),
    order({ isBuyOrder: false, price: 90, locationId: 60015260, systemId: JITA.id }), // other Jita station: excluded
    order({ isBuyOrder: true, price: 120, locationId: 1, systemId: AMARR.id, range: 'STATION' }), // wrong station: excluded
    order({ isBuyOrder: true, price: 115, locationId: 2, systemId: AMARR.id, range: '_1' }),
    order({ isBuyOrder: true, price: 110, locationId: 3, systemId: 999, range: 'REGION', regionId: AMARR.regionId }),
    order({ isBuyOrder: true, price: 118, locationId: 4, systemId: 999, range: '_5', regionId: AMARR.regionId }), // remote numeric range: excluded
    order({ isBuyOrder: true, price: 110, locationId: AMARR.stationId, systemId: AMARR.id, range: 'STATION', volumeRemain: 5 }),
  ] };
  const b = extractHubBooks(payload);
  assert.deepEqual(b[JITA.id].asks, [{ price: 100, volume: 10 }]);
  assert.deepEqual(b[AMARR.id].bids, [{ price: 115, volume: 10 }, { price: 110, volume: 15 }]);
});

test('matchDepth stops when margin goes non-positive', () => {
  const asks = [{ price: 100, volume: 5 }, { price: 105, volume: 10 }];
  const bids = [{ price: 110, volume: 8 }, { price: 104, volume: 50 }];
  // 5@100→110 (+50), 3@105→110 (+15), then 105 vs 104 → stop
  assert.deepEqual(pick(matchDepth(asks, bids)), { units: 8, profit: 65, cost: 5 * 100 + 3 * 105 });
  // 10% tax: 110→99 < 100 → nothing
  assert.deepEqual(pick(matchDepth(asks, bids, 0.1)), { units: 0, profit: 0, cost: 0 });
});

test('computeRoutes: spread, isk/jump, overrides and statuses', () => {
  const hubs = [JITA, AMARR];
  const books = {
    [JITA.id]: { asks: [{ price: 100, volume: 4 }], bids: [{ price: 95, volume: 4 }] },
    [AMARR.id]: { asks: [{ price: 130, volume: 1 }], bids: [{ price: 120, volume: 2 }] },
  };
  const jumps = () => 10;
  const r = computeRoutes({ item: 'x', books, jumps, hubs });
  const ja = r.find(x => x.from === JITA);
  assert.equal(ja.spread, 20);
  assert.equal(ja.iskPerJump, 2);
  assert.equal(ja.units, 2);
  assert.equal(ja.depthProfit, 40);

  const relist = computeRoutes({ item: 'x', books, jumps, hubs, sellMode: 'relist' }).find(x => x.from === JITA);
  assert.equal(relist.spread, 30);
  assert.equal(relist.units, null);

  const ov = computeRoutes({ item: 'x', books, jumps, hubs, overrides: { [AMARR.id]: { sell: '200' } } }).find(x => x.from === JITA);
  assert.equal(ov.spread, 100);
  assert.equal(ov.overridden, true);

  assert.equal(computeRoutes({ item: 'x', books: null, jumps, hubs })[0].status, 'unknown');
  assert.equal(computeRoutes({ item: 'x', books, jumps: () => null, hubs })[0].status, 'unknown');
  const empty = { [JITA.id]: { asks: [], bids: [] }, [AMARR.id]: { asks: [], bids: [] } };
  assert.equal(computeRoutes({ item: 'x', books: empty, jumps, hubs })[0].status, 'nomarket');
});

test('formatIsk', () => {
  assert.equal(formatIsk(1234567), '1.23M');
  assert.equal(formatIsk(-2500), '−2.50k');
  assert.equal(formatIsk(null), '—');
});

test('summarizeSteps applies tax, cargo and budget caps', async () => {
  const { summarizeSteps } = await import('../public/js/arbitrage.js');
  const steps = [[10, 100, 150], [10, 120, 140], [10, 130, 135]];
  assert.deepEqual(
    pick(summarizeSteps(steps)), { units: 30, profit: 10 * 50 + 10 * 20 + 10 * 5, cost: 1000 + 1200 + 1300 });
  // 10% tax: step 3 sells at 121.5 < 130 → stop after two steps
  assert.equal(summarizeSteps(steps, { taxRate: 0.1 }).units, 20);
  // 15 m³ cargo at 1 m³/unit
  const cargo = summarizeSteps(steps, { unitVolume: 1, maxVolume: 15 });
  assert.deepEqual([cargo.units, cargo.profit, cargo.volume, cargo.worstBuy], [15, 600, 15, 120]);
  // 1,500 ISK budget: 10 @100 + 4 @120
  assert.equal(summarizeSteps(steps, { maxCost: 1500 }).units, 14);
});

test('bait buy orders with min volume are ignored', () => {
  const payload = { orders: [
    order({ isBuyOrder: true, price: 999, locationId: JITA.stationId, systemId: JITA.id, minVolume: 1000 }),
    order({ isBuyOrder: true, price: 90, locationId: JITA.stationId, systemId: JITA.id, minVolume: 1 }),
  ] };
  assert.deepEqual(extractHubBooks(payload)[JITA.id].bids, [{ price: 90, volume: 10 }]);
});

function pick({ units, profit, cost }) { return { units, profit, cost }; }
