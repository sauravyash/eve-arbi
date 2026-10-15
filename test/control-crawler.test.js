import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createControlCrawler, utcDate } from '../control-crawler.js';

const archive = readFileSync(new URL('./fixtures/everef-day.tar.bz2', import.meta.url));
// System 1 is null-sec, 2 low-sec, 3 high-sec (not tallied).
const universe = { systems: { id: [1, 2, 3], sec: [-0.5, 0.3, 0.9] } };
const NOW = Date.parse('2026-10-15T12:00:00Z');

test('control crawler: archives, live killmails and the snapshot', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'control-'));
  try {
    const asked = [];
    const fetchUpstream = async (name, url) => {
      asked.push(url);
      if (url.endsWith('killmails-2026-10-14.tar.bz2')) return { status: 200, body: archive };
      return { status: 404, body: Buffer.from('') };
    };
    const c = createControlCrawler({ fetchUpstream, data: async () => universe, dir, days: 2, log: () => {}, now: () => NOW });
    await c.init();
    await c.syncArchives();
    assert.deepEqual(asked, [
      'https://data.everef.net/killmails/2026/killmails-2026-10-14.tar.bz2',
      'https://data.everef.net/killmails/2026/killmails-2026-10-13.tar.bz2',
    ]);
    const live = (id, date, sys, alliance) => ({
      killmail_id: id,
      esi: { killmail_time: `${date}T08:00:00Z`, solar_system_id: sys, victim: { alliance_id: 1, ship_type_id: 587 },
        attackers: [{ alliance_id: alliance, character_id: 7 }] },
    });
    c.addLive(live(21, '2026-10-15', 2, 3));
    c.addLive(live(21, '2026-10-15', 2, 3));    // the same killmail again
    c.addLive(live(22, '2026-10-14', 1, 3));    // that day's archive is already in
    const snap = c.build();
    assert.deepEqual(snap.days.map(d => [d.date, d.source, d.kills]), [['2026-10-15', 'live', 1], ['2026-10-14', 'archive', 2]]);
    const s1 = snap.systems[1];
    assert.equal(s1[0][0], 'a:1', 'killed a ship and a structure there');
    assert.deepEqual(s1[0].slice(2), [2, 0, 0, 0, 1, 0].map(v => Math.round(v * 2 ** (-1 / 3) * 10) / 10));
    assert.equal(snap.systems[2][0][0], 'a:3');
    assert.equal(snap.systems[3], undefined, 'high-sec is left out');
    assert.equal(snap.live.kills, 1);

    // A restart picks the archive back up from disk instead of downloading it again.
    asked.length = 0;
    const again = createControlCrawler({ fetchUpstream, data: async () => universe, dir, days: 2, log: () => {}, now: () => NOW });
    await again.init();
    await again.syncArchives();
    assert.ok(!asked.some(u => u.includes('2026-10-14')));
    assert.equal(again.build().systems[1][0][0], 'a:1');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('utcDate', () => assert.equal(utcDate(Date.parse('2026-10-15T23:59:59Z')), '2026-10-15'));
