import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, jumpsFrom, jumpsBetween, pathBetween, systemInfo, inHighSec } from '../public/js/galaxy.js';
import { stationQuotes, parseAdam, parseEvepraisal, parseZkill } from '../public/js/market-merge.js';
import { buildRangeContext, bookEntry, pairsForType, rangeCodeOf, sellPoints, REGION } from '../public/js/ranges.js';
import { summarizeSteps } from '../public/js/arbitrage.js';

// A–B–C–D chain in high-sec, with a low-sec shortcut A–L–D.
const U = {
  regions: [{ id: 1, name: 'R1' }, { id: 2, name: 'R2' }],
  systems: { id: [10, 11, 12, 13, 14], name: ['A', 'B', 'C', 'D', 'L'], sec: [0.9, 0.8, 0.7, 0.6, 0.3], region: [0, 0, 1, 1, 0] },
  jumps: [0, 1, 1, 2, 2, 3, 0, 4, 4, 3],
};

test('BFS jump counts respect the route flag', () => {
  const g = buildGraph(U);
  assert.equal(jumpsBetween(g, 10, 13, 'shortest'), 2); // via L
  assert.equal(jumpsBetween(g, 10, 13, 'secure'), 3);   // around L
  assert.equal(jumpsBetween(g, 10, 14, 'secure'), null);
  assert.equal(jumpsBetween(g, 10, 999), null);
  assert.equal(jumpsFrom(g, 10, 'secure'), jumpsFrom(g, 10, 'secure')); // cached
  assert.deepEqual(systemInfo(g, 12), { id: 12, name: 'C', sec: 0.7, regionId: 2, region: 'R2' });
  assert.equal(inHighSec(g, 13), true);
  assert.equal(inHighSec(g, 14), false); // low-sec
  assert.equal(inHighSec(g, 999), false); // unknown, e.g. wormhole space
});

const o = (x) => ({ orderId: Math.random(), volumeRemain: 10, minVolume: 1, ghost: false, regionId: 1, ...x });

test('high-sec routing from outside high-sec leaves by the nearest high-sec, then stays in it', () => {
  // L1 (0.3) – L2 (0.2) – A (0.9) – B (0.8); L1 – N (0.1) – C (0.7); L1 – L3 (0.4) – L4 (0.1).
  // Nearest high-sec from L1 is 2 jumps: A and C. L3/L4 lead nowhere safe and stay unreachable.
  const g = buildGraph({
    regions: [{ id: 1, name: 'R' }],
    systems: { id: [1, 2, 3, 4, 5, 6, 7, 8], name: ['L1', 'L2', 'A', 'B', 'N', 'C', 'L3', 'L4'],
               sec: [0.3, 0.2, 0.9, 0.8, 0.1, 0.7, 0.4, 0.1], region: [0, 0, 0, 0, 0, 0, 0, 0] },
    jumps: [0, 1, 1, 2, 2, 3, 0, 4, 4, 5, 0, 6, 6, 7],
  });
  const j = (b) => jumpsBetween(g, 1, b, 'secure');
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(j), [0, 1, 2, 3, 1, 2, null, null]);
  assert.deepEqual(pathBetween(g, 1, 4, 'secure'), [1, 2, 3, 4]);
  assert.deepEqual(pathBetween(g, 1, 6, 'secure'), [1, 5, 6]);
  assert.equal(jumpsBetween(g, 3, 1, 'secure'), null); // from high-sec it still never leaves
});

test('stationQuotes groups by station and skips ghosts and bait bids', () => {
  const q = stationQuotes([
    o({ locationId: 1, systemId: 10, isBuyOrder: false, price: 100 }),
    o({ locationId: 1, systemId: 10, isBuyOrder: false, price: 90, ghost: true }),
    o({ locationId: 2, systemId: 13, isBuyOrder: true, price: 150 }),
    o({ locationId: 2, systemId: 13, isBuyOrder: true, price: 200, minVolume: 5 }),
  ]);
  assert.equal(q.get(1).bestAsk, 100);
  assert.equal(q.get(2).bestBid, 150);
  assert.equal(q.get(2).bids.length, 1);
});

test('rangeCodeOf reads market-merge range spellings', () => {
  assert.deepEqual(['STATION', 'SOLARSYSTEM', 'REGION', '_5', '_40'].map(rangeCodeOf), [-1, 0, REGION, 5, 40]);
});

test('bookEntry groups asks by station and bids by station × range, skipping ghosts, bait and disallowed sources', () => {
  const e = bookEntry([
    o({ locationId: 1, systemId: 10, isBuyOrder: false, price: 100 }),
    o({ locationId: 1, systemId: 10, isBuyOrder: false, price: 100, volumeRemain: 5 }),
    o({ locationId: 1, systemId: 10, isBuyOrder: false, price: 90, ghost: true }),
    o({ locationId: 9, systemId: 11, isBuyOrder: false, price: 50 }),                      // filtered by allowSource
    o({ locationId: 2, systemId: 13, isBuyOrder: true, price: 150, range: 'STATION' }),
    o({ locationId: 2, systemId: 13, isBuyOrder: true, price: 140, range: '_1', regionId: 2 }),
    o({ locationId: 2, systemId: 13, isBuyOrder: true, price: 200, range: 'REGION', minVolume: 5 }), // bait
  ], { allowSource: (q) => q.locationId !== 9 });
  assert.deepEqual(e.asks, [{ l: 1, s: 10, a: [[100, 15]] }]);
  assert.deepEqual(e.bids.map(b => [b.r, b.g, b.lv]), [[-1, 1, [[150, 10]]], [1, 2, [[140, 10]]]]);
});

test('watchlist hauls sell into a ranged buy order at the nearest in-range station', () => {
  // U: 10 – 11 – 12 – 13, plus 10 – 14 – 13 (10, 11, 14 in region 1; 12, 13 in region 2).
  // NPC stations: 1 in 11, 5 in 12, 2 in 13. Buying at 11, the 1-jump order placed in 13 can be filled at 12.
  const g = buildGraph(U);
  const ctx = buildRangeContext(g, { 1: ['S1', 11], 5: ['S5', 12], 2: ['S2', 13] });
  const entry = bookEntry([
    o({ locationId: 1, systemId: 11, isBuyOrder: false, price: 100, volumeRemain: 5 }),
    o({ locationId: 2, systemId: 13, isBuyOrder: true, price: 130, volumeRemain: 8, range: '_1', regionId: 2 }),
  ]);
  const hauls = pairsForType(34, entry, ctx, { minProfit: 0, keep: false });
  const near = hauls.find(h => h.d === 5);
  assert.ok(near, 'sells at station 5: in range of the order, 1 jump from the source instead of 2');
  assert.equal(near.x, true);
  assert.equal(jumpsBetween(g, near.fs, near.ds, 'shortest'), 1);
  assert.deepEqual(summarizeSteps(near.s, { unitVolume: 1, maxVolume: 3 }).units, 3); // cargo cap still applies
  assert.ok(hauls.some(h => h.d === 2 && !h.x)); // the order's own station is still an option
});

test('watchlist hauls list a ranged order in its own system once, at its own station', () => {
  // Stations 2 and 7 are both in 13; the solar-system-range order sits at 7, not the lowest ID.
  const ctx = buildRangeContext(buildGraph(U), { 1: ['S1', 11], 2: ['S2', 13], 7: ['S7', 13] });
  const entry = bookEntry([
    o({ locationId: 1, systemId: 11, isBuyOrder: false, price: 100, volumeRemain: 5 }),
    o({ locationId: 7, systemId: 13, isBuyOrder: true, price: 130, volumeRemain: 8, range: 'SOLARSYSTEM', regionId: 2 }),
  ]);
  const hauls = pairsForType(34, entry, ctx, { minProfit: 0, keep: false });
  assert.deepEqual(hauls.map(h => h.d), [7]);
});

test('community API parsers', () => {
  const a = parseAdam({ 34: { buy_price: '3.70', sell_price: '3.69', buy_volume: '10', sell_volume: '20', lupdate: '2026-09-26 13:45:06' } },
    { 34: { percentile_buy: '3.6', percentile_sell: '3.8' } });
  assert.deepEqual(a[34], { sell: 3.69, buy: 3.7, sellVolume: 20, buyVolume: 10, sellPct: 3.8, buyPct: 3.6, at: Date.parse('2026-09-26T13:45:06Z') });
  const e = parseEvepraisal({ summaries: [{ market_name: 'jita', prices: { buy: { max: 3.66, order_count: 2, volume: 5 },
    sell: { min: 3.79, order_count: 0, volume: 0 }, updated: '2026-09-26T11:45:35Z' } }] });
  assert.equal(e.jita.buy, 3.66);
  assert.equal(e.jita.sell, null);
  const z = parseZkill({ '2026-09-25': 3.79, '2026-09-24': 3.81, typeID: 34, currentPrice: '3.9' });
  assert.deepEqual(z.days.map(d => d.date), ['2026-09-24', '2026-09-25']);
  assert.equal(z.current, 3.9);
});

test('sellPoints: a ranged order adds the nearest in-range station to your home', () => {
  // Same map as above; home in 11. The 1-jump order placed in 13 can be filled at 12 (station 5).
  const ctx = buildRangeContext(buildGraph(U), { 1: ['S1', 11], 5: ['S5', 12], 2: ['S2', 13] });
  const entry = bookEntry([
    o({ locationId: 2, systemId: 13, isBuyOrder: true, price: 130, volumeRemain: 8, range: '_1', regionId: 2 }),
    o({ locationId: 5, systemId: 12, isBuyOrder: true, price: 120, volumeRemain: 4, range: 'STATION', regionId: 2 }),
  ]);
  const pts = sellPoints(entry, ctx, 11);
  assert.deepEqual(pts.map(p => [p.locationId, p.bestBid, p.bidVolume, p.via?.locationId ?? null]),
    [[2, 130, 8, null], [5, 130, 8, 2]]);
});
