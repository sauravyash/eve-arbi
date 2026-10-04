import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, jumpsBetween, pathBetween, ZARZAKH, zarzakhEntries, passesZarzakh } from '../public/js/galaxy.js';
import { findPath, planRoute, routeSummary } from '../public/js/route-plan.js';
import { computeRoutes, barredFromZarzakh } from '../public/js/arbitrage.js';
import { evaluateLegs, planTrips } from '../public/js/trips.js';

const Z = ZARZAKH;
// High-sec 1 – low-sec 2 – Zarzakh – low-sec 3 – null-sec 4, and a long way round Zarzakh: 2 – 5 – 6 – 3.
function universe() {
  const ids = [1, 2, Z, 3, 4, 5, 6];
  const sec = [0.9, 0.3, -1, 0.3, -0.2, 0.2, 0.2];
  const gates = [[1, 2], [2, Z], [Z, 3], [3, 4], [2, 5], [5, 6], [6, 3]];
  const at = (id) => ids.indexOf(id);
  return buildGraph({
    systems: { id: ids, name: ids.map(String), sec, region: ids.map(() => 0) },
    regions: [{ id: 100, name: 'R' }],
    jumps: gates.flatMap(([a, b]) => [at(a), at(b)]),
  });
}

test('routes never fly through Zarzakh, but may start or end there', () => {
  const g = universe();
  assert.deepEqual(pathBetween(g, 1, 3), [1, 2, 5, 6, 3]);   // not 1 – 2 – Z – 3
  assert.equal(jumpsBetween(g, 1, 4), 5);
  assert.deepEqual(pathBetween(g, 1, Z), [1, 2, Z]);
  assert.deepEqual(pathBetween(g, Z, 4), [Z, 3, 4]);
});

test('Zarzakh counts as out of null-sec for High + low-sec, never as high-sec', () => {
  const g = universe();
  assert.equal(jumpsBetween(g, 1, Z, 'nonull'), 2);
  assert.equal(jumpsBetween(g, 1, Z, 'secure'), null);
  // From Zarzakh on Safest: the fewest jumps out to high-sec.
  assert.deepEqual(pathBetween(g, Z, 1, 'secure'), [Z, 2, 1]);
});

test('the route planner leaves Zarzakh by the gate it came in through', () => {
  const g = universe();
  assert.deepEqual(findPath(g, 1, 3).path, [1, 2, 5, 6, 3]);
  const r = planRoute(g, [{ id: 1 }, { id: Z }, { id: 4 }]);
  assert.deepEqual(r.path, [1, 2, Z, 2, 5, 6, 3, 4]);
  assert.equal(r.jumps, 7);
  // Starting there, any gate will do.
  assert.equal(planRoute(g, [{ id: Z }, { id: 4 }]).jumps, 2);
  assert.equal(routeSummary(g, r.path).zarzakh, 1);
  // Capitals can't go in at all.
  assert.equal(findPath(g, 1, Z, { noZarzakh: true }), null);
});

test('path helpers count entries and spot paths through Zarzakh', () => {
  assert.equal(zarzakhEntries([1, 2, Z, 2, Z]), 2);
  assert.equal(zarzakhEntries([Z, 3]), 0);
  assert.equal(passesZarzakh([1, Z, 3]), true);
  assert.equal(passesZarzakh([1, 2, Z]), false);
  assert.equal(passesZarzakh([Z, 3]), false);
  assert.equal(barredFromZarzakh(1_300_000), true);   // freighters, carriers
  assert.equal(barredFromZarzakh(500_000), false);    // Orca
});

test('hub routes into or out of Zarzakh lose the toll from their depth profit', () => {
  const hubs = [{ id: 1, name: 'A' }, { id: Z, name: 'Zarzakh', toll: true }];
  const books = {
    1: { asks: [{ price: 100, volume: 10 }], bids: [{ price: 90, volume: 10 }] },
    [Z]: { asks: [{ price: 300, volume: 10 }], bids: [{ price: 200, volume: 10 }] },
  };
  const [out] = computeRoutes({ item: {}, books, jumps: () => 2, hubs, toll: 250 });
  assert.equal(out.to.id, Z);
  assert.equal(out.toll, 250);
  assert.equal(out.depthProfit, 10 * 100 - 250);
  assert.equal(out.spread, 100);   // per unit: unchanged
});

test('trips pay the toll on each arrival in Zarzakh', () => {
  const g = universe();
  const distFrom = (a) => (b) => jumpsBetween(g, a, b);
  const cand = (t, fs, ds, buy, sell) => ({ t, f: fs * 10, fs, d: ds * 10, ds, s: [[10, buy, sell]] });
  const legs = evaluateLegs({ candidates: [cand(1, 1, Z, 100, 200), cand(2, Z, 4, 100, 300)], types: { 1: ['A', 1], 2: ['B', 1] } });
  const [tr] = planTrips(legs, { start: 1, distFrom, entryFee: (s) => (s === Z ? 400 : 0), maxReuse: 10 });
  assert.equal(tr.toll, 400);
  assert.equal(tr.profit, 1000 + 2000 - 400);
});
