import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hotspots, nearestOf, localMarket, stapleRow, FW_STAPLES, factionName } from '../public/js/fw.js';

const sys = (id, contested, vp, threshold = 1000) => ({
  solar_system_id: id, contested, victory_points: vp, victory_points_threshold: threshold,
  owner_faction_id: 500001, occupier_faction_id: 500004,
});

test('hotspots: kills plus how contested, hottest first', () => {
  const rows = hotspots(
    [sys(1, 'uncontested', 0), sys(2, 'contested', 500), sys(3, 'vulnerable', 1200)],
    [{ system_id: 1, ship_kills: 30, pod_kills: 4, npc_kills: 9 }, { system_id: 2, ship_kills: 2 }],
  );
  assert.deepEqual(rows.map(r => r.systemId), [1, 3, 2]);
  assert.equal(rows[0].heat, 32);
  assert.equal(rows[0].npcs, 9);
  assert.equal(rows[1].contest, 1, 'capped at 100%');
  assert.equal(rows[1].heat, 30);
  assert.equal(rows[2].heat, 12);
  assert.deepEqual(hotspots(null, null), []);
});

test('nearestOf: fewest jumps to any source', () => {
  const out = nearestOf([Int16Array.from([0, 1, -1, 4]), Int16Array.from([3, -1, -1, 1])], 4);
  assert.deepEqual([...out], [0, 1, -1, 1]);
});

test('localMarket: stock and best prices within the radius', () => {
  const jumps = (s) => ({ 10: 0, 11: 3, 12: 9 }[s] ?? null);
  const o = (systemId, isBuyOrder, price, volumeRemain = 5, extra = {}) => ({ systemId, isBuyOrder, price, volumeRemain, locationId: 60000000 + systemId, ...extra });
  const m = localMarket([
    o(10, false, 120), o(11, false, 100, 2), o(12, false, 50), o(99, false, 1),
    o(10, true, 80), o(11, true, 90), o(11, false, 10, 99, { ghost: true }),
  ], jumps, 5);
  assert.deepEqual(m, { units: 7, orders: 2, ask: 100, askJumps: 3, bid: 90, bidJumps: 3 });
  const npcOnly = localMarket([o(10, false, 120, 5, { locationId: 1e12 })], jumps, 5, { structures: false, isNpc: id => id < 1e9 });
  assert.equal(npcOnly.units, 0);
});

test('stapleRow: warzone demand against local stock, priced at the local ask', () => {
  const rows = [
    { regionId: 1, daily: 10, price: 100 },
    { regionId: 2, daily: 30, price: 120 },
    { regionId: 3, daily: 999, price: 1 },
  ];
  const r = stapleRow({ rows, regions: new Set([1, 2]), local: { units: 80, ask: 110, bid: 95 }, cost: 80, taxRate: 0.05, brokerRate: 0.05 });
  assert.equal(r.daily, 40);
  assert.equal(r.price, 115);
  assert.equal(r.daysOfStock, 2);
  assert.ok(Math.abs(r.margin - (110 * 0.9 - 80)) < 1e-9);
  assert.ok(Math.abs(r.iskDay - 40 * r.margin) < 1e-9);
  assert.ok(Math.abs(r.flip - (95 * 0.95 - 80)) < 1e-9);
  const none = stapleRow({ rows, regions: new Set([1]), local: { units: 0, ask: null, bid: null }, cost: 200 });
  assert.equal(none.margin, -100, 'no local ask: the warzone price');
  assert.equal(none.iskDay, 0);
  assert.equal(none.flip, null);
});

test('FW staples are unique and factions have names', () => {
  assert.equal(new Set(FW_STAPLES.map(s => s.typeId)).size, FW_STAPLES.length);
  assert.equal(factionName(500002, true), 'Minmatar');
  assert.equal(factionName(1), 'Faction 1');
});
