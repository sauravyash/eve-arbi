import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sideOf, sideId, sideKind, allianceColor, sovIndex, territories, campaignRows, structuresBySystem, fights, efficiency,
  hotRegions, idsToName, dominance, dominanceBySide, fwIndex,
} from '../public/js/war-data.js';

test('sideOf: alliance, then corporation, then faction', () => {
  assert.equal(sideOf({ alliance_id: 9, corporation_id: 5 }), 'a:9');
  assert.equal(sideOf({ corporation_id: 5, faction_id: 500001 }), 'c:5');
  assert.equal(sideOf({ faction_id: 500001 }), 'f:500001');
  assert.equal(sideOf({}), null);
  assert.equal(sideId('c:98000001'), 98000001);
  assert.equal(sideKind('f:1'), 'faction');
});

test('allianceColor: stable and distinct for neighbouring ids', () => {
  assert.equal(allianceColor(99000001), allianceColor(99000001));
  assert.notEqual(allianceColor(99000001), allianceColor(99000002));
  assert.match(allianceColor(1354830081, true), /^hsl\(\d+ \d+% \d+%\)$/);
});

const SOV = sovIndex([
  { system_id: 1, alliance_id: 10, corporation_id: 100 },
  { system_id: 2, alliance_id: 10, corporation_id: 100 },
  { system_id: 3, alliance_id: 20, corporation_id: 200 },
  { system_id: 4, faction_id: 500007 },
]);

test('territories: systems, kills, campaigns and ADM per sov holder', () => {
  const t = territories(SOV,
    [{ system_id: 1, ship_kills: 3, pod_kills: 1 }, { system_id: 3, ship_kills: 7 }, { system_id: 4, ship_kills: 50 }],
    [{ defender_id: 20 }, { defender_id: 20 }, { defender_id: 999 }],
    [{ alliance_id: 10, vulnerability_occupancy_level: 2 }, { alliance_id: 10, vulnerability_occupancy_level: 4 }, { alliance_id: 20 }]);
  assert.deepEqual(t.map(r => r.allianceId), [10, 20]);
  assert.equal(t[0].systems, 2);
  assert.equal(t[0].ships, 3);
  assert.equal(t[0].pods, 1);
  assert.equal(t[0].adm, 3);
  assert.deepEqual(t[0].systemIds, [1, 2]);
  assert.equal(t[1].campaigns, 2);
  assert.equal(t[1].adm, null, 'no ADM reported');
  assert.deepEqual(territories(new Map()), []);
});

test('campaignRows: running ones first, most lost first; upcoming ones by start', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const rows = campaignRows([
    { campaign_id: 1, event_type: 'tcu_defense', attackers_score: 0.2, start_time: '2026-10-15T10:00:00Z' },
    { campaign_id: 2, event_type: 'ihub_defense', attackers_score: 0.7, start_time: '2026-10-15T11:00:00Z' },
    { campaign_id: 3, event_type: 'ihub_defense', attackers_score: 0.4, start_time: '2026-10-15T18:00:00Z' },
    { campaign_id: 4, event_type: 'odd', attackers_score: 0.4, start_time: '2026-10-15T14:00:00Z' },
  ], now);
  assert.deepEqual(rows.map(r => r.id), [2, 1, 4, 3]);
  assert.equal(rows[0].label, 'IHub');
  assert.equal(rows[2].label, 'odd');
  assert.equal(rows[2].upcoming, true);
});

test('structuresBySystem: groups with ADM and window', () => {
  const m = structuresBySystem([
    { solar_system_id: 5, structure_type_id: 32458, alliance_id: 1, vulnerability_occupancy_level: 4.2, vulnerable_start_time: '2026-10-15T10:00:00Z', vulnerable_end_time: '2026-10-15T13:00:00Z' },
    { solar_system_id: 5, structure_type_id: 32226, alliance_id: 1 },
  ]);
  assert.equal(m.get(5).length, 2);
  assert.equal(m.get(5)[0].type, 'IHub');
  assert.equal(m.get(5)[1].type, 'TCU');
  assert.equal(m.get(5)[1].vulnStart, null);
});

const km = (id, sys, victim, attackers, value = 100, extra = {}) => ({
  killmail_id: id, killmail_time: `2026-10-15T1${id % 10}:00:00Z`, solar_system_id: sys,
  victim, attackers: attackers.map(a => ({ character_id: 1, ...a })), zkb: { totalValue: value, ...extra },
});

test('fights: pairs, sides and systems; a kill counts once per pair', () => {
  const A = { alliance_id: 1 }, B = { alliance_id: 2 }, C = { corporation_id: 30 };
  const f = fights([
    km(1, 100, B, [A, A, C], 1000),        // A and C kill B
    km(2, 100, A, [B], 300),
    km(2, 100, A, [B], 300),                // duplicate killmail
    km(3, 200, B, [A], 50),
    km(4, 200, A, [A], 999),                // awox: no other side
    km(5, 200, B, [{ faction_id: 500010, character_id: undefined }], 70), // NPC kill
    km(6, 200, B, [A], 80, { npc: true }),
  ]);
  assert.equal(f.kills, 3);
  assert.equal(f.isk, 1350);
  assert.equal(f.conflicts.length, 2);
  const ab = f.conflicts[0];
  assert.deepEqual([ab.a, ab.b], ['a:1', 'a:2']);
  assert.deepEqual(ab.kills, { 'a:1': 2, 'a:2': 1 });
  assert.deepEqual(ab.isk, { 'a:1': 1050, 'a:2': 300 });
  assert.equal(ab.total, 3);
  assert.equal(ab.systems.get(100), 2);
  const bc = f.conflicts[1];
  assert.deepEqual([bc.a, bc.b], ['a:2', 'c:30']);
  assert.equal(bc.kills['c:30'], 1);
  assert.equal(f.sides.get('a:1').kills, 2);
  assert.equal(f.sides.get('a:1').losses, 1);
  assert.equal(f.sides.get('a:2').iskLost, 1050);
  assert.equal(f.systems.get(100).kills, 2);
  assert.equal(f.systems.get(100).sides.get('a:1'), 2);
  assert.deepEqual(fights(null).conflicts, []);
});

test('efficiency: share of ISK destroyed', () => {
  assert.equal(efficiency(3, 1), 0.75);
  assert.equal(efficiency(0, 0), null);
});

test('hotRegions: most player kills first, NPC-only regions left out', () => {
  const region = { 1: 10, 2: 10, 3: 20, 4: 30 };
  const r = hotRegions([
    { system_id: 1, ship_kills: 2, pod_kills: 2 }, { system_id: 2, ship_kills: 1 },
    { system_id: 3, ship_kills: 9 }, { system_id: 4, npc_kills: 400 }, { system_id: 99, ship_kills: 5 },
  ], (id) => region[id] ?? null, 5);
  assert.deepEqual(r.map(x => x.regionId), [20, 10]);
  assert.equal(r[1].heat, 4);
});

test('idsToName: holders, defenders and fighters, once each', () => {
  const ids = idsToName({ sov: SOV, campaigns: [{ defender_id: 10 }, { defender_id: 77 }], fightSides: new Map([['c:30', {}], ['a:10', {}]]) });
  assert.deepEqual(ids.sort((a, b) => a - b), [10, 20, 30, 77, 500007]);
});

test('dominance: the side scoring most kills owns a system; thin or split ones are contested', () => {
  const A = { alliance_id: 1 }, B = { alliance_id: 2 }, C = { corporation_id: 30 };
  const f = fights([
    km(1, 100, B, [A]), km(2, 100, B, [A]), km(3, 100, A, [B]),   // A 2, B 1: A holds 100
    km(4, 200, A, [B]),                                             // one kill: contested
    km(5, 300, B, [A]), km(6, 300, B, [A]), km(7, 300, A, [C]), km(8, 300, A, [C]), // 2 v 2: contested
  ]);
  const d = dominance(f.systems);
  assert.equal(d.get(100).side, 'a:1');
  assert.equal(d.get(100).contested, false);
  assert.ok(Math.abs(d.get(100).share - 2 / 3) < 1e-9);
  assert.equal(d.get(200).contested, true);
  assert.equal(d.get(300).contested, false, 'half the kills is enough');
  assert.equal(dominance(f.systems, { minShare: 0.6 }).get(300).contested, true);
  assert.deepEqual(d.get(300).contenders.map(c => c[1]), [2, 2]);
  const by = dominanceBySide(d);
  assert.equal(by[0].side, 'a:1');
  assert.deepEqual(by[0].held.sort(), [100, 300]);
  assert.deepEqual(by.find(r => r.side === 'a:2').leading, [200]);
  assert.equal(dominance(null).size, 0);
});

test('fwIndex: occupier and how contested', () => {
  const m = fwIndex([{ solar_system_id: 7, occupier_faction_id: 500001, owner_faction_id: 500004, contested: 'contested', victory_points: 300, victory_points_threshold: 1200 }]);
  assert.deepEqual(m.get(7), { occupier: 500001, owner: 500004, status: 'contested', contest: 0.25 });
});
