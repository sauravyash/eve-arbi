import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastRollover, compactRows, staleRegions, createDemandStore, KEEP_DAYS } from '../public/js/demand-store.js';
import { dailySeries, regionDemand, regionSupply, analyse, rankRegions, lastDay } from '../public/js/demand.js';

const T = Date.parse('2026-10-01T12:00:00Z');
const esiRow = (date, average, volume, order_count = 1) => ({ date, average, volume, order_count, highest: average, lowest: average });

test('lastRollover is today 11:30 UTC once past it, else yesterday', () => {
  assert.equal(lastRollover(T), Date.parse('2026-10-01T11:30:00Z'));
  assert.equal(lastRollover(Date.parse('2026-10-01T09:00:00Z')), Date.parse('2026-09-30T11:30:00Z'));
});

test('compactRows keeps the last KEEP_DAYS days, oldest first', () => {
  const rows = compactRows([esiRow('2026-09-30', 10, 5, 2), esiRow('2026-01-01', 1, 1), esiRow('2026-09-29', 9, 4)], T);
  assert.deepEqual(rows, [['2026-09-29', 9, 4, 1], ['2026-09-30', 10, 5, 2]]);
  assert.equal(KEEP_DAYS, 90);
  assert.deepEqual(compactRows(null, T), []);
});

test('staleRegions: missing or fetched before the last update', () => {
  const entry = { regions: { 1: { at: T - 60_000 }, 2: { at: Date.parse('2026-10-01T10:00:00Z') } } };
  assert.deepEqual(staleRegions(entry, [1, 2, 3], T), [2, 3]);
});

function harness({ fail = new Set(), unknown = false, maxFetch } = {}) {
  const calls = [], saved = new Map();
  let now = T;
  const store = createDemandStore({
    regionIds: () => [10000002, 10000043, 10000032],
    fetchHistory: async (region, type) => {
      calls.push(region);
      if (unknown) return { status: 404, rows: null };
      if (fail.has(region)) return { status: 502, rows: null };
      return { status: 200, rows: [esiRow('2026-09-30', region / 1e6, type)] };
    },
    load: (t) => saved.get(t),
    save: (t, e) => { saved.set(t, structuredClone(e)); },
    maxFetch, now: () => now,
  });
  return { store, calls, saved, setNow: (v) => { now = v; } };
}

test('demand store fetches every region once a day and serves the stored copy after', async () => {
  const h = harness();
  const a = await h.store.get(34);
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[0], 10000002); // the probe region goes first
  assert.equal(a.pending, 0);
  assert.deepEqual(a.regions[10000043], [['2026-09-30', 10.000043, 34, 1]]);
  await h.store.get(34);
  assert.equal(h.calls.length, 3, 'nothing stale: no ESI calls');
  h.setNow(T + 86_400_000);
  await h.store.get(34);
  assert.equal(h.calls.length, 6, 'next day: every region again');
});

test('demand store: maxFetch leaves the rest pending, failures stay pending', async () => {
  const h = harness({ maxFetch: 2, fail: new Set([10000032]) });
  const a = await h.store.get(34);
  assert.equal(a.pending, 1);
  const b = await h.store.get(34);
  assert.equal(b.pending, 1, 'the failing region is still stale');
  assert.deepEqual(h.calls, [10000002, 10000043, 10000032]);
});

test('demand store rejects an unknown type after one call', async () => {
  const h = harness({ unknown: true });
  await assert.rejects(h.store.get(999999999), { status: 404 });
  assert.equal(h.calls.length, 1);
  assert.equal(h.saved.size, 0);
});

test('demand store shares one refresh between concurrent requests', async () => {
  const h = harness();
  await Promise.all([h.store.get(34), h.store.get(34)]);
  assert.equal(h.calls.length, 3);
});

// --- analysis ---------------------------------------------------------------------------

test('dailySeries fills missing days with zero volume', () => {
  const s = dailySeries([['2026-09-28', 5, 3, 1], ['2026-09-30', 6, 4, 2]], '2026-09-30', 3);
  assert.deepEqual(s.map(d => [d.date, d.volume]), [['2026-09-28', 3], ['2026-09-29', 0], ['2026-09-30', 4]]);
  assert.equal(s[1].average, null);
});

const steady = (days, vol, price, end = '2026-09-30') =>
  dailySeries([], end, days).map(d => [d.date, price, vol, 1]);

test('regionDemand: median volume, active share, swing and recent price', () => {
  const d = regionDemand(steady(30, 10, 100), '2026-09-30');
  assert.equal(d.daily, 10);
  assert.equal(d.active, 1);
  assert.equal(d.swing, 0);
  assert.equal(d.price, 100);
  // Trades on 6 days out of 30: median 0, active 20%.
  const sparse = regionDemand(steady(30, 10, 100).filter((_, i) => i % 5 === 0), '2026-09-30');
  assert.equal(sparse.daily, 0);
  assert.ok(Math.abs(sparse.active - 0.2) < 1e-9);
  assert.ok(sparse.swing > 1);
});

test('regionSupply sums sell orders per region, structures optional', () => {
  const o = (regionId, price, volumeRemain, locationId = 60000001, extra = {}) =>
    ({ regionId, price, volumeRemain, locationId, isBuyOrder: false, ...extra });
  const s = regionSupply([o(1, 5, 10), o(1, 4, 5, 1e12), o(1, 3, 99, 60000001, { isBuyOrder: true }), o(2, 7, 1)],
    { structures: false, isNpc: (l) => l < 64_000_000 });
  assert.deepEqual(s.get(1), { units: 10, orders: 1, lowest: 5 });
  assert.deepEqual(s.get(2), { units: 1, orders: 1, lowest: 7 });
});

test('analyse and rankRegions: ISK/day, shortage and score orderings', () => {
  const history = {
    1: steady(30, 100, 12),   // big market, well stocked
    2: steady(30, 10, 15),    // small market, nearly empty
    3: steady(30, 50, 9),     // sells below cost
  };
  assert.equal(lastDay(history), '2026-09-30');
  const supply = new Map([[1, { units: 3000, orders: 5, lowest: 11 }], [2, { units: 5, orders: 1, lowest: 16 }]]);
  const rows = analyse({ history, supply, cost: 10, taxRate: 0, brokerRate: 0 });
  const r = Object.fromEntries(rows.map(x => [x.regionId, x]));
  assert.equal(r[1].iskDay, 200);         // 100/day × (12 − 10)
  assert.equal(r[2].iskDay, 50);          // 10/day × (15 − 10)
  assert.equal(r[3].iskDay, 0);           // no margin
  assert.equal(r[1].daysOfStock, 30);
  assert.equal(r[2].daysOfStock, 0.5);
  assert.equal(r[3].daysOfStock, 0);      // nothing listed
  assert.ok(Math.abs(r[2].markup - 0.5) < 1e-9);
  assert.deepEqual(rankRegions(rows, { rank: 'isk' }).map(x => x.regionId), [1, 2, 3]);
  assert.deepEqual(rankRegions(rows, { rank: 'shortage' }).map(x => x.regionId), [3, 2, 1]);
  // Score: region 1 has 30 days of stock, so the short region 2 wins.
  assert.deepEqual(rankRegions(rows, { rank: 'score' }).map(x => x.regionId).slice(0, 2), [2, 1]);
  assert.deepEqual(rankRegions(rows, { minDaily: 20, maxDays: 10, skip: new Set([3]) }).map(x => x.regionId), []);
  assert.deepEqual(analyse({ history: {}, supply, cost: 10 }), []);
});

test('analyse: taxes and broker fee come off the sale price', () => {
  const rows = analyse({ history: { 1: steady(30, 10, 100) }, supply: new Map(), cost: 80, taxRate: 0.05, brokerRate: 0.03 });
  assert.equal(rows[0].margin, 100 * 0.92 - 80);
});
