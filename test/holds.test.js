import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shipHolds, capacityFor } from '../public/js/holds.js';
import { summarizeSteps } from '../public/js/arbitrage.js';

// Orca's dogma (ESI, trimmed): cargo 30,000, mining hold 150,000, fleet hangar 40,000, fuel bay 6,400.
const ORCA = [{ attribute_id: 38, value: 30000 }, { attribute_id: 1556, value: 150000 },
  { attribute_id: 912, value: 40000 }, { attribute_id: 1549, value: 6400 }, { attribute_id: 908, value: 400000 }];
const VELDSPAR = ['Veldspar', 0.1, 25, 462];
const ICE = ['Clear Icicle', 1000, 25, 465];
const TRITANIUM = ['Tritanium', 0.01, 4, 18];
const OXYGEN_ISOTOPES = ['Oxygen Isotopes', 0.03, 4, 423];
const RIFTER = ['Rifter', 2500, 6, 140];   // ships carry cargo m³ at [3], not a group

test('shipHolds keeps the special holds a ship has, skipping ship-only bays', () => {
  assert.deepEqual(shipHolds(ORCA).map(h => [h.name, h.m3]),
    [['Fleet hangar', 40000], ['Mining hold', 150000], ['Fuel bay', 6400]]);
  assert.deepEqual(shipHolds([{ attribute_id: 38, value: 1460 }]), []);
  assert.deepEqual(shipHolds(undefined), []);
});

test('capacityFor adds every hold an item fits in to the cargo hold', () => {
  const holds = shipHolds(ORCA);
  assert.equal(capacityFor(holds, 30000, VELDSPAR).m3, 30000 + 40000 + 150000);
  assert.equal(capacityFor(holds, 30000, ICE).m3, 30000 + 40000 + 150000);
  assert.equal(capacityFor(holds, 30000, OXYGEN_ISOTOPES).m3, 30000 + 40000 + 6400);
  assert.equal(capacityFor(holds, 30000, TRITANIUM).m3, 30000 + 40000);
  // A ship's [3] is its own cargo, never mistaken for a group ID.
  assert.deepEqual(capacityFor(holds, 30000, RIFTER).holds.map(h => h.name), ['Fleet hangar']);
  assert.equal(capacityFor([], 5000, VELDSPAR).m3, 5000);
  assert.equal(capacityFor(holds, Infinity, VELDSPAR).m3, Infinity);
});

test('mineral and planetary holds only take their own items', () => {
  const holds = shipHolds([{ attribute_id: 1558, value: 45000 }, { attribute_id: 1653, value: 60000 }]);
  assert.deepEqual(capacityFor(holds, 0, TRITANIUM).holds.map(h => h.name), ['Mineral hold']);
  assert.deepEqual(capacityFor(holds, 0, ['Aqueous Liquids', 0.005, 42, 1033]).holds.map(h => h.name), ['Planetary commodities hold']);
  assert.deepEqual(capacityFor(holds, 0, VELDSPAR).holds, []);
  // An item list from before group IDs were stored (no [3]) still matches by category.
  assert.deepEqual(capacityFor(holds, 0, ['Aqueous Liquids', 0.005, 42]).holds.map(h => h.name), ['Planetary commodities hold']);
});

test('the extra room lets a haul carry more', () => {
  const steps = [[1_000_000, 10, 12]]; // 1M units of 0.1 m³ ore, 2 ISK profit each
  const cargoOnly = summarizeSteps(steps, { unitVolume: 0.1, maxVolume: 5000 });
  const withHold = summarizeSteps(steps, { unitVolume: 0.1, maxVolume: capacityFor(shipHolds([{ attribute_id: 1556, value: 16000 }]), 5000, VELDSPAR).m3 });
  assert.equal(cargoOnly.units, 50_000);
  assert.equal(withHold.units, 210_000);
});
