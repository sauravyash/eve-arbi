import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, jumpsFrom, pathBetween } from '../public/js/galaxy.js';
import { evaluateLegs, planTrips, tripStops } from '../public/js/trips.js';

// Chain 1 – 2 – 3 – 4 – 5 (all high-sec), with low-sec 6 hanging off 5.
const U = {
  regions: [{ id: 9, name: 'R' }],
  systems: { id: [1, 2, 3, 4, 5, 6], name: ['A', 'B', 'C', 'D', 'E', 'L'], sec: [1, 1, 1, 1, 1, 0.2], region: [0, 0, 0, 0, 0, 0] },
  jumps: [0, 1, 1, 2, 2, 3, 3, 4, 4, 5],
};
const g = buildGraph(U);
const distFrom = (a) => { const d = jumpsFrom(g, a, 'secure'); return (b) => { const i = g.indexOf.get(b); return i == null || d[i] < 0 ? null : d[i]; }; };

test('pathBetween walks gate by gate and respects high-sec routing', () => {
  assert.deepEqual(pathBetween(g, 1, 4), [1, 2, 3, 4]);
  assert.deepEqual(pathBetween(g, 4, 4), [4]);
  assert.equal(pathBetween(g, 1, 6, 'secure'), null);
});

const cand = (t, fs, ds, buy, sell, n = 10) => ({ t, f: fs * 100, fs, d: ds * 100, ds, s: [[n, buy, sell]] });
const result = {
  candidates: [
    cand(10, 1, 3, 100, 200),      // A→C  +1000
    cand(20, 3, 5, 100, 250),      // C→E  +1500 (starts where the first one ends)
    cand(30, 4, 5, 100, 130),      // D→E  +300  (1 empty jump from C)
    cand(40, 5, 6, 100, 900),      // E→L  low-sec: unreachable when secure
    cand(50, 1, 2, 100, 150),      // a ship
  ],
  types: { 10: ['Ten', 1], 20: ['Twenty', 1], 30: ['Thirty', 1], 40: ['Forty', 1], 50: ['Rifter', 2500] },
};
const catalog = { 50: ['Rifter', 2500, 6] };

test('evaluateLegs applies limits and hides ships', () => {
  const legs = evaluateLegs(result, { catalog, hideShips: true, maxVolume: 50 });
  assert.deepEqual(legs.map(l => [l.t, l.units, l.profit]), [[10, 10, 1000], [20, 10, 1500], [30, 10, 300], [40, 10, 8000]]);
  assert.equal(evaluateLegs(result, { catalog }).length, 5);
});

test('planTrips chains hauls end to start and counts empty hops', () => {
  const legs = evaluateLegs(result, { catalog, hideShips: true });
  const trips = planTrips(legs, { start: 1, distFrom, maxLegs: 3, maxLink: 1, maxReuse: 10 });
  const best = trips[0];
  assert.deepEqual(best.legs.map(l => l.t), [10, 20]);          // A→C, then C→E: 4 jumps, +2500
  assert.equal(best.jumps, 4);
  assert.equal(best.profit, 2500);
  assert.equal(best.perJump, 625);
  assert.ok(trips.every(t => t.legs.length >= 2));
  assert.ok(trips.every(t => !t.legs.some(l => l.t === 40)));  // low-sec leg never used
  const viaHop = trips.find(t => t.legs.map(l => l.t).join() === '10,30');
  assert.deepEqual(viaHop.links, [1]);                          // C → D empty, then D→E
  assert.equal(planTrips(legs, { start: 1, distFrom, maxLink: 0 }).some(t => t.legs[1]?.t === 30), false);
});

test('tripStops merges a sale and the next purchase at the same station', () => {
  const legs = evaluateLegs(result, { catalog, hideShips: true });
  const [best] = planTrips(legs, { start: 1, distFrom, maxLegs: 2, maxLink: 0 });
  assert.deepEqual(tripStops(best).map(s => [s.systemId, s.action]), [[1, 'buy'], [3, 'sell+buy'], [5, 'sell']]);
});

test('planTrips limits how often one haul headlines the list', () => {
  const many = { candidates: [cand(99, 3, 5, 100, 10000)], types: { 99: ['Big', 1] } };
  for (let k = 0; k < 6; k++) { many.candidates.push(cand(100 + k, 1, 3, 100, 101 + k)); many.types[100 + k] = [`Small ${k}`, 1]; }
  const legs = evaluateLegs(many, {});
  const trips = planTrips(legs, { start: 1, distFrom, maxLegs: 2, maxLink: 0 });
  assert.equal(trips.filter(t => t.legs.some(l => l.t === 99)).length, 2);
  assert.equal(planTrips(legs, { start: 1, distFrom, maxLegs: 2, maxLink: 0, maxReuse: 10 }).length, 6);
});
