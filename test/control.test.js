import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addKillmail, newDay, mergeDays, addZkillStats, snapshotSystems, controlOf, controlBySide, decay, score, WEIGHTS, SOV_WEIGHT,
} from '../public/js/control.js';

const A = { alliance_id: 1, corporation_id: 10 }, B = { alliance_id: 2, corporation_id: 20 }, C = { corporation_id: 30 };
const pilot = (p) => ({ character_id: 9, ...p });
const km = (sys, victim, attackers, ship = 587) => ({ solar_system_id: sys, victim: { ...victim, ship_type_id: ship }, attackers });
const everywhere = () => true;

test('addKillmail: kills, losses, resident losses and structures', () => {
  const d = newDay('2026-10-14');
  addKillmail(d, km(100, B, [pilot(A), pilot(A), pilot(C)]), everywhere);           // A and C kill B
  addKillmail(d, km(100, A, [{ faction_id: 500010 }]), everywhere);                   // rats kill A: resident
  addKillmail(d, km(100, B, [pilot(A)], 17478), everywhere);                          // A kills B's Retriever
  addKillmail(d, km(100, B, [pilot(A)], 35832), everywhere);                          // A kills B's Astrahus
  addKillmail(d, km(100, A, [pilot(A)]), everywhere);                                 // awox: a loss, no kill
  assert.equal(addKillmail(d, km(200, A, [pilot(B)]), (s) => s !== 200), false, 'outside the space');
  assert.equal(d.kills, 5);
  const s = d.systems[100];
  //                 k  l  r  s  x  z
  assert.deepEqual(s['a:1'], [3, 2, 1, 0, 1, 0]);
  assert.deepEqual(s['a:2'], [0, 3, 1, 1, 0, 0]);
  assert.deepEqual(s['c:30'], [1, 0, 0, 0, 0, 0]);
  assert.equal(d.systems[200], undefined);
});

test('mergeDays: older days count less; a day counts from its middle', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const merged = mergeDays([
    { date: '2026-10-15', systems: { 5: { 'a:1': [4, 0, 0, 0, 0, 0] } } },
    { date: '2026-10-12', systems: { 5: { 'a:1': [4, 0, 0, 0, 0, 0], 'a:2': [2, 0, 0, 0, 0, 0] } } },
  ], now, 3);
  assert.equal(merged.get(5).get('a:1')[0], 4 + 2);
  assert.equal(merged.get(5).get('a:2')[0], 1);
  assert.equal(decay(0), 1);
  assert.equal(decay(-2), 1, 'no boost for the future');
});

test('addZkillStats and snapshotSystems: strongest sides first, rounded', () => {
  const merged = mergeDays([{ date: '2026-10-15', systems: { 5: { 'a:1': [1, 1, 0, 0, 0, 0], 'c:30': [0, 1, 0, 0, 0, 0] } } }], Date.parse('2026-10-15T12:00:00Z'));
  addZkillStats(merged, { 5: { alliances: [[2, 20], [1, 2], [3, 0]] }, 6: { alliances: [[4, 3]] } });
  const snap = snapshotSystems(merged, 2);
  assert.deepEqual(snap[5].map(r => r[0]), ['a:2', 'a:1']);
  assert.equal(snap[5][0][1], 20 * WEIGHTS.z);
  assert.equal(snap[5][1][1], WEIGHTS.k + WEIGHTS.l + 2 * WEIGHTS.z);
  assert.deepEqual(snap[6][0], ['a:4', 3 * WEIGHTS.z, 0, 0, 0, 0, 0, 3]);
  assert.equal(score([1, 1, 1, 1, 1, 1]), Object.values(WEIGHTS).reduce((a, b) => a + b));
});

test('controlOf: sov claim by ADM, share, contested and confidence', () => {
  const rows = [['a:2', 30, 10, 0, 0, 0, 0, 0], ['a:1', 10, 0, 10, 0, 0, 0, 0]];
  const c = controlOf(rows);
  assert.equal(c.side, 'a:2');
  assert.equal(c.share, 0.75);
  assert.equal(c.contested, false);
  assert.equal(c.evidence, 30 / 40);
  assert.ok(Math.abs(c.confidence - 0.75 * 30 / 40) < 1e-9);
  const withSov = controlOf(rows, { alliance: 1, adm: 6 });
  assert.equal(withSov.side, 'a:1', 'a well-used sov system outweighs a little roaming');
  assert.equal(withSov.score, 10 + SOV_WEIGHT * 6);
  const sovOnly = controlOf(undefined, { alliance: 7, adm: 2 });
  assert.equal(sovOnly.side, 'a:7');
  assert.equal(sovOnly.sides[0].sovOnly, true);
  assert.equal(controlOf(undefined), null);
  assert.equal(controlOf([['a:1', 5], ['a:2', 5], ['a:3', 5]]).contested, true);
});

test('controlBySide: held and contested systems per side', () => {
  const m = new Map([[1, controlOf([['a:1', 10]])], [2, controlOf([['a:1', 10]])], [3, controlOf([['a:2', 5], ['a:1', 5], ['a:3', 5]])], [4, null]]);
  const by = controlBySide(m);
  assert.equal(by[0].side, 'a:1');
  assert.deepEqual(by[0].held, [1, 2]);
  assert.deepEqual(by[1].contested, [3]);
});
