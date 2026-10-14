import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shipSize, clonePlaces, rankClones, bestClone, cloneCooldownLeft, usableShips } from '../public/js/clones.js';

// types.json rows: [name, packaged m³, categoryId, cargo]
const TYPES = {
  587: ['Rifter', 2500, 6, 140], 648: ['Badger', 20000, 6, 3900], 638: ['Raven', 50000, 6, 830],
  28606: ['Orca', 500000, 6, 30000], 20185: ['Charon', 1300000, 6, 465000], 34328: ['Bowhead', 1300000, 6, 4000],
  23757: ['Archon', 1300000, 6, 2175], 28352: ['Rorqual', 1300000, 6, 40000], 11567: ['Avatar', 10000000, 6, 11250],
  34: ['Tritanium', 0.01, 4, 18], 9941: ['Memory Augmentation - Basic', 1, 20, 300],
};
const STATIONS = { 60003760: ['Jita IV - Moon 4 - Caldari Navy Assembly Plant', 30000142], 60008494: ['Amarr VIII (Oris) - Emperor Family Academy', 30002187] };

test('shipSize sorts ships into the wormhole sizes, freighters apart from capitals', () => {
  const size = (id) => shipSize(id, TYPES[id]);
  assert.deepEqual([587, 648, 638, 28606, 20185, 34328, 23757, 28352, 11567].map(size),
    ['small', 'medium', 'large', 'xlarge', 'xlarge', 'xlarge', 'capital', 'capital', 'capital']);
  assert.equal(size(34), null);            // not a ship
  assert.equal(shipSize(1, undefined), null);
});

const DATA = {
  home: { locationId: 60003760, locationType: 'station' },
  jumpClones: [
    { cloneId: 7, locationId: 60008494, locationType: 'station', implants: [9941], name: 'Hauler' },
    { cloneId: 8, locationId: 1035466617946, locationType: 'structure', implants: [] },
    { cloneId: 9, locationId: 1099999999999, locationType: 'structure', implants: [] },   // no docking access
  ],
  locations: { 1035466617946: { name: 'Fort Knocks', systemId: 30000144 } },
  ships: [
    { itemId: 1, typeId: 648, locationId: 60008494 }, { itemId: 2, typeId: 648, locationId: 60008494 },
    { itemId: 3, typeId: 587, locationId: 60008494 }, { itemId: 4, typeId: 587, locationId: 1035466617946 },
    { itemId: 5, typeId: 34, locationId: 60008494 },   // an assembled container or the like: not a ship
  ],
};

test('clonePlaces puts each clone in its system with the ships parked there, biggest hold first', () => {
  const p = clonePlaces(DATA, TYPES, STATIONS);
  assert.deepEqual(p.map(x => [x.kind, x.systemId, x.locationName]), [
    ['jump', 30002187, 'Amarr VIII (Oris) - Emperor Family Academy'],
    ['jump', 30000144, 'Fort Knocks'],
    ['jump', null, 'Structure (no docking access)'],
    ['home', 30000142, 'Jita IV - Moon 4 - Caldari Navy Assembly Plant'],
  ]);
  assert.deepEqual(p[0].ships.map(s => [s.name, s.count, s.size]), [['Badger', 2, 'medium'], ['Rifter', 1, 'small']]);
  assert.deepEqual(usableShips(p[0], 'medium').map(s => s.name), ['Badger']);
  assert.deepEqual(clonePlaces(null), []);
});

test('rankClones and bestClone pick the clone with a fitting ship and fewest jumps', () => {
  const places = clonePlaces(DATA, TYPES, STATIONS);
  const jumps = { 30002187: 12, 30000144: 3 };
  const from = (id) => jumps[id] ?? null;

  // Any ship: Fort Knocks (a Rifter) wins; the unseen structure ranks last; the medical clone is left out.
  const any = rankClones(places, from, { size: '' });
  assert.deepEqual(any.map(r => [r.place.systemId, r.jumps, r.usable]), [[30000144, 3, true], [30002187, 12, true], [null, null, false]]);
  assert.deepEqual(bestClone(any, 20).saved, 17);

  // A hauler is wanted: only Amarr has one.
  const medium = rankClones(places, from, { size: 'medium' });
  assert.equal(medium[0].place.systemId, 30002187);
  assert.equal(bestClone(medium, 20).jumps, 12);
  assert.equal(bestClone(medium, 12), null);               // saves nothing
  // Without needing a ship, every placed clone counts.
  assert.equal(rankClones(places, from, { size: 'medium', needShip: false })[0].place.systemId, 30000144);
  assert.equal(bestClone(rankClones(places, () => null), 5), null);   // no route from any
});

test('cloneCooldownLeft counts down the 24 h after a clone jump', () => {
  const h = 3_600_000;
  assert.equal(cloneCooldownLeft(null), 0);
  assert.equal(cloneCooldownLeft(0 + 1000, 1000 + 5 * h), 19 * h);
  assert.equal(cloneCooldownLeft(1000, 1000 + 30 * h), 0);
});
