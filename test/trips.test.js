import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, jumpsFrom, pathBetween, outOfNullSec } from '../public/js/galaxy.js';
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

test('planTrips buys on the way while earlier cargo is still aboard', () => {
  const legs = evaluateLegs(result, { catalog, hideShips: true });
  const trips = planTrips(legs, { start: 1, distFrom, maxLegs: 3, maxLink: 1, maxReuse: 10 });
  const best = trips[0];
  // A→C: sell Ten, buy Twenty; D (on the way to E): buy Thirty; E: sell both. 4 jumps, +2800.
  assert.deepEqual(best.legs.map(l => l.t), [10, 20, 30]);
  assert.equal(best.jumps, 4);
  assert.equal(best.profit, 2800);
  assert.equal(best.perJump, 700);
  assert.equal(best.startJumps, 0);
  assert.deepEqual(best.events.map(e => `${e.kind}${e.leg}:${e.hop}`), ['buy0:0', 'sell0:2', 'buy1:0', 'buy2:1', 'sell1:1', 'sell2:0']);
  assert.equal(best.peakVolume, 20);                                // Twenty and Thirty aboard together
  assert.ok(trips.every(t => t.legs.length >= 2));
  assert.ok(trips.every(t => !t.legs.some(l => l.t === 40)));      // low-sec leg never used
  // With an empty hold, the next pickup is at most maxLink jumps away: C → D is 1.
  const viaHop = trips.find(t => t.legs.map(l => l.t).join() === '10,30');
  assert.deepEqual(viaHop.events.map(e => e.hop), [0, 2, 1, 1]);
  const tight = planTrips(legs, { start: 1, distFrom, maxLegs: 3, maxLink: 0, maxReuse: 10 });
  assert.equal(tight.some(t => t.legs.map(l => l.t).join() === '10,30'), false);
  assert.deepEqual(tight[0].legs.map(l => l.t), [10, 20, 30]);     // D is still on the way to E
});

test('planTrips keeps what is aboard within the hold and budget, buying part of a load', () => {
  const legs = evaluateLegs(result, { catalog, hideShips: true, maxVolume: 15 });
  const [best] = planTrips(legs, { start: 1, distFrom, maxLegs: 3, maxLink: 1, maxVolume: 15 });
  assert.deepEqual(best.legs.map(l => [l.t, l.units]), [[10, 10], [20, 10], [30, 5]]); // only 5 m³ left at D
  assert.equal(best.profit, 2650);
  assert.equal(best.peakVolume, 15);
  const broke = evaluateLegs(result, { catalog, hideShips: true, maxCost: 1500 });
  const [cheap] = planTrips(broke, { start: 1, distFrom, maxLegs: 3, maxLink: 1, maxCost: 1500 });
  assert.deepEqual(cheap.legs.map(l => [l.t, l.units]), [[10, 10], [20, 10], [30, 5]]);
  assert.equal(cheap.peakCost, 1500);
  // Room for nothing more than one load: hauls go one after another.
  const [one] = planTrips(evaluateLegs(result, { catalog, hideShips: true }), { start: 1, distFrom, maxLegs: 3, maxLink: 1, maxVolume: 10 });
  assert.deepEqual(one.legs.map(l => l.t), [10, 20]);
  assert.equal(one.peakVolume, 10);
});

test('planTrips counts the flight from a start away from the first pickup', () => {
  const legs = evaluateLegs(result, { catalog, hideShips: true });
  const [best] = planTrips(legs, { start: 2, distFrom, maxLegs: 2, maxLink: 0 });
  assert.equal(best.startJumps, 1);
  assert.equal(best.jumps, best.startJumps + best.events.reduce((n, e) => n + (e.hop || 0), 0) - best.events[0].hop);
});

test('tripStops merges a sale and the next purchase at the same station', () => {
  const legs = evaluateLegs(result, { catalog, hideShips: true });
  const [best] = planTrips(legs, { start: 1, distFrom, maxLegs: 2, maxLink: 0 });
  assert.deepEqual(tripStops(best).map(s => [s.systemId, s.sells.map(l => l.t), s.buys.map(l => l.t)]),
    [[1, [], [10]], [3, [10], [20]], [5, [20], []]]);
  // Trips saved before hauls shared the hold have no events: one haul after another.
  const { events, ...old } = best;
  assert.deepEqual(tripStops(old).map(s => s.systemId), [1, 3, 5]);
});

test('planTrips limits how often one haul headlines the list', () => {
  const many = { candidates: [cand(99, 3, 5, 100, 10000)], types: { 99: ['Big', 1] } };
  for (let k = 0; k < 6; k++) { many.candidates.push(cand(100 + k, 1, 3, 100, 101 + k)); many.types[100 + k] = [`Small ${k}`, 1]; }
  const legs = evaluateLegs(many, {});
  const has99 = (trips) => trips.filter(t => t.legs.some(l => l.t === 99)).length;
  assert.equal(has99(planTrips(legs, { start: 1, distFrom, maxLegs: 2, maxLink: 0 })), 2);
  assert.equal(has99(planTrips(legs, { start: 1, distFrom, maxLegs: 2, maxLink: 0, maxReuse: 10 })), 6);
});

test('planTrips ignores a haul listed twice', () => {
  const legs = evaluateLegs(result, { catalog, hideShips: true });
  const trips = planTrips([...legs, ...legs], { start: 1, distFrom, maxLegs: 3, maxLink: 1, maxReuse: 10 });
  assert.equal(new Set(trips.map(t => t.legs.map(l => `${l.t}:${l.f}:${l.d}`).join('>'))).size, trips.length);
  assert.ok(trips.every(t => new Set(t.legs.map(l => l.t)).size === t.legs.length));
});

test('jumpsFrom with nonull flies through high- and low-sec but never null-sec', () => {
  // 1 (1.0) – 2 (0.3) – 3 (1.0), and 1 – 4 (-0.2, null) – 5 (0.2) – 3: nonull goes via 2.
  const N = {
    regions: [{ id: 9, name: 'R' }],
    systems: { id: [1, 2, 3, 4, 5, 6], name: ['A', 'B', 'C', 'D', 'E', 'F'], sec: [1, 0.3, 1, -0.2, 0.2, 0.0], region: [0, 0, 0, 0, 0, 0] },
    jumps: [0, 1, 1, 2, 0, 3, 3, 4, 4, 2, 2, 5],
  };
  const gn = buildGraph(N);
  const d = (flag, a, b) => jumpsFrom(gn, a, flag)[gn.indexOf.get(b)];
  assert.equal(d('shortest', 1, 3), 2);
  assert.equal(d('nonull', 1, 3), 2);
  assert.equal(d('secure', 1, 3), -1);                              // the only ways cross low- or null-sec
  assert.equal(d('nonull', 1, 4), -1);
  assert.equal(d('nonull', 1, 6), -1);                              // 0.0 is null-sec
  assert.deepEqual(pathBetween(gn, 1, 3, 'nonull'), [1, 2, 3]);
  assert.equal(d('nonull', 4, 3), 2);                               // from null-sec: leave by the nearest way out
  assert.deepEqual([1, 2, 4, 6, 999].map(id => outOfNullSec(gn, id)), [true, true, false, false, false]);
});

test('planTrips reads jumps from rows (jumps option) exactly as from distFrom', () => {
  const legs = evaluateLegs(result, { catalog, hideShips: true, maxVolume: 15 });
  const jumps = { indexOf: g.indexOf, from: (sys) => jumpsFrom(g, sys, 'secure') };
  const opts = { start: 2, maxLegs: 3, maxLink: 1, maxVolume: 15, maxReuse: 10 };
  assert.deepEqual(planTrips(legs, { ...opts, jumps }), planTrips(legs, { ...opts, distFrom }));
  // A start the graph doesn't know (wormhole space without a shortcut) reaches nothing.
  assert.deepEqual(planTrips(legs, { ...opts, start: 31000005, jumps }), []);
});
