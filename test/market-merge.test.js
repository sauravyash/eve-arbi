import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUBS } from '../public/js/arbitrage.js';
import {
  normalizeEsiOrder, normalizeTycoonOrder, mergeOrders, hubBook, bookQuote, volumeWeightedTop,
  mergeHistory, historyChange, parseFuzzwork, parseGoonXml, consensus,
} from '../public/js/market-merge.js';

const [JITA] = HUBS;
const esi = (o) => normalizeEsiOrder({
  order_id: 1, type_id: 34, is_buy_order: false, price: 5, volume_remain: 100, volume_total: 100, min_volume: 1,
  location_id: JITA.stationId, system_id: JITA.id, range: 'region', issued: '2026-09-26T08:00:00Z', duration: 90, ...o,
}, JITA.regionId);
const ty = (o) => normalizeTycoonOrder({
  orderId: 1, typeId: 34, isBuyOrder: false, price: 5, volumeRemain: 100, volumeTotal: 100, minVolume: 1,
  locationId: JITA.stationId, systemId: JITA.id, regionId: JITA.regionId, range: 'REGION',
  issued: Date.parse('2026-09-26T08:00:00Z'), duration: 90, ...o,
});

test('normalizers produce the same shape from ESI and Tycoon', () => {
  assert.deepEqual(esi({}), ty({}));
  assert.equal(esi({ range: '5' }).range, '_5');
  assert.equal(esi({ range: 'solarsystem' }).range, 'SOLARSYSTEM');
});

test('mergeOrders dedupes by order ID and keeps the fresher copy', () => {
  const { orders, stats } = mergeOrders([
    { id: 'esi', live: true, regions: [JITA.regionId], orders: [esi({ volume_remain: 60 }), esi({ order_id: 2 })] },
    { id: 'tycoon', orders: [ty({ volumeRemain: 100 }), ty({ orderId: 2 })] },
  ]);
  assert.equal(orders.length, 2);
  assert.equal(stats.duplicates, 2);
  assert.equal(stats.conflicts, 1);
  const o1 = orders.find(o => o.orderId === 1);
  assert.equal(o1.volumeRemain, 60); // lower remaining volume = later snapshot
  assert.deepEqual(o1.sources, ['esi', 'tycoon']);
});

test('mergeOrders: a modified order (later issued) wins even with more volume', () => {
  const { orders } = mergeOrders([
    { id: 'esi', orders: [esi({ price: 4.9, volume_remain: 80, issued: '2026-09-26T09:00:00Z' })] },
    { id: 'tycoon', orders: [ty({ price: 5, volumeRemain: 50 })] },
  ]);
  assert.equal(orders[0].price, 4.9);
});

test('mergeOrders flags NPC-station orders missing from the live source as ghosts, not structure orders', () => {
  const { orders, stats } = mergeOrders([
    { id: 'esi', live: true, regions: [JITA.regionId], orders: [] },
    { id: 'tycoon', orders: [
      ty({ orderId: 10 }),                                                  // NPC station, ESI doesn't have it
      ty({ orderId: 11, locationId: 1043202973535 }),                       // structure: ESI can't see it
      ty({ orderId: 12, regionId: 10000043, locationId: 60008494 }),        // region ESI didn't fetch
    ] },
  ]);
  const g = Object.fromEntries(orders.map(o => [o.orderId, o.ghost]));
  assert.deepEqual(g, { 10: true, 11: false, 12: false });
  assert.equal(stats.ghosts, 1);
  assert.equal(stats.only.tycoon, 3);
});

test('hubBook hides ghosts and bait buy orders; bookQuote summarises', () => {
  const { orders } = mergeOrders([
    { id: 'esi', live: true, regions: [JITA.regionId], orders: [
      esi({ order_id: 1, price: 5 }), esi({ order_id: 2, price: 6 }),
      esi({ order_id: 3, is_buy_order: true, price: 4.5, volume_remain: 10 }),
      esi({ order_id: 4, is_buy_order: true, price: 4.8, min_volume: 50 }), // bait
    ] },
    { id: 'tycoon', orders: [ty({ orderId: 9, price: 4 })] }, // ghost, would be best ask
  ]);
  const q = bookQuote(hubBook(orders, JITA));
  assert.deepEqual(q, { sell: 5, buy: 4.5, sellVolume: 200, buyVolume: 10, sellOrders: 2, buyOrders: 1 });
  assert.equal(bookQuote(hubBook(orders, JITA, { includeGhosts: true })).sell, 4);
});

test('volumeWeightedTop averages the best slice of volume', () => {
  const asks = [{ price: 10, volumeRemain: 5 }, { price: 20, volumeRemain: 95 }];
  assert.equal(volumeWeightedTop(asks, 0.1), 15); // 5@10 + 5@20
  assert.equal(volumeWeightedTop([], 0.1), null);
});

test('mergeHistory: ESI wins shared days, Tycoon fills older ones, conflicts counted', () => {
  const t = [
    { date: Date.parse('2026-09-23T00:00:00Z'), average: 3, highest: 3, lowest: 3, volume: 1, orderCount: 1 },
    { date: Date.parse('2026-09-24T00:00:00Z'), average: 3.5, highest: 4, lowest: 3, volume: 2, orderCount: 2 },
  ];
  const e = [
    { date: '2026-09-24', average: 3.8, highest: 4, lowest: 3, volume: 5, order_count: 5 },
    { date: '2026-09-25', average: 4, highest: 4, lowest: 4, volume: 6, order_count: 6 },
  ];
  const { days, stats } = mergeHistory(e, t);
  assert.deepEqual(days.map(d => [d.date, d.average, d.src]),
    [['2026-09-23', 3, 'tycoon'], ['2026-09-24', 3.8, 'both'], ['2026-09-25', 4, 'esi']]);
  assert.equal(stats.shared, 1);
  assert.equal(stats.conflicts, 1);
  assert.equal(stats.onlyTycoon, 1);
  assert.ok(Math.abs(historyChange(days, 1) - (4 - 3.8) / 3.8 * 100) < 1e-9);
  assert.equal(historyChange(days, 5), null);
});

test('parseFuzzwork converts strings and nulls empty sides', () => {
  const r = parseFuzzwork({ 34: {
    buy: { max: '3.7', volume: '100.0', orderCount: '3', percentile: '3.6' },
    sell: { min: '0', volume: '0', orderCount: '0', percentile: '0' },
  } });
  assert.equal(r[34].buy, 3.7);
  assert.equal(r[34].buyOrders, 3);
  assert.equal(r[34].sell, null);
});

test('parseGoonXml reads each type block', () => {
  const xml = `<goonmetrics><price_data><type id="34"><updated>2026-09-26T11:22:10Z</updated>
    <all><weekly_movement>362.5</weekly_movement></all><buy><max>3.68</max><listed>81</listed></buy>
    <sell><min>3.79</min><listed>72</listed></sell></type></price_data></goonmetrics>`;
  assert.deepEqual(parseGoonXml(xml)[34], {
    updated: Date.parse('2026-09-26T11:22:10Z'), weeklyMovement: 362.5, buy: 3.68, buyVolume: 81, sell: 3.79, sellVolume: 72,
  });
});

test('consensus finds the median and outliers', () => {
  const c = consensus([{ id: 'a', value: 100 }, { id: 'b', value: 101 }, { id: 'c', value: 110 }, { id: 'd', value: null }]);
  assert.equal(c.median, 101);
  assert.equal(c.n, 3);
  assert.deepEqual(c.outliers, ['c']);
  assert.equal(consensus([]).median, null);
});
