import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseList, parseDetail, shortLeads } from '../scripts/build-wormholes.js';
import { whCode, whInfo, whSummary, parseWanderer, parseBookmarks, bookmarkLinks, cleanBookmarkLinks, BOOKMARK_MAX_HOURS, MAX_BOOKMARK_LINKS } from '../public/js/wormholes.js';

test('parseList reads code, destination and lifetime from the ellatha list page', () => {
  const html = `<tr bgcolor="#F8FBFF"><td><a href="wormholelist.asp?order=name"><b>Name</b></a></td><td>Type</td><td>Max</td></tr>
<tr bgcolor="#F5F5F5">
<td><a href="wormholelistview.asp?key=Wormhole+A009">Wormhole A009</a>&nbsp;</td>
<td>
Leads into w-space system | Class 13&nbsp;</td>
<td align="center">4.5&nbsp;h</td>
</tr>
<tr bgcolor="#FFFFFF">
<td><a href="wormholelistview.asp?key=Wormhole+Q063">Wormhole Q063</a>&nbsp;</td>
<td>
Leads into hi-sec system&nbsp;</td>
<td align="center">16&nbsp;h</td>
</tr>`;
  assert.deepEqual(parseList(html), [
    { code: 'A009', leads: 'Leads into w-space system | Class 13', hours: 4.5 },
    { code: 'Q063', leads: 'Leads into hi-sec system', hours: 16 },
  ]);
});

test('parseDetail reads lifetime and masses', () => {
  const html = `<td bgcolor="#F5F5F5"><img src="x.png"><b>Max Stable Time</b>: 16&nbsp;h<br>The maximum</td>
<td><b>Max Stable Mass</b>: 500,000,000&nbsp;kg<br>…</td><td><b>Max Mass Regeneration</b>: 0&nbsp;<br>…</td>
<td><b>Max Jump Mass</b>: 62,000,000&nbsp;kg<br>…</td>`;
  assert.deepEqual(parseDetail(html), { hours: 16, mass: 500_000_000, jump: 62_000_000, regen: 0 });
  assert.deepEqual(parseDetail('nothing here'), { hours: null, mass: null, jump: null, regen: null });
});

test('shortLeads shortens the destination', () => {
  assert.equal(shortLeads('Leads into hi-sec system'), 'high-sec');
  assert.equal(shortLeads('Leads into low-sec system'), 'low-sec');
  assert.equal(shortLeads('Leads into 0.0 system'), 'null-sec');
  assert.equal(shortLeads('Leads into deadly w-space system | Class 6'), 'C6');
  assert.equal(shortLeads('Leads into drifter w-space system | Sentinel'), 'Drifter (Sentinel)');
  assert.equal(shortLeads('Leads to Thera'), 'Thera');
  assert.equal(shortLeads('Leads into Triglavian system'), 'Pochven');
});

test('whCode, whInfo and whSummary look up a type', () => {
  const types = { Q063: ['high-sec', 16, 500e6, 62e6], C414: ['null-sec', 16, 1e9, 375e6] };
  assert.equal(whCode(' q063 '), 'Q063');
  assert.equal(whCode('Wormhole Q063'), 'Q063');
  for (const bad of ['', null, 'Q06', 'QQ063', 'Jita']) assert.equal(whCode(bad), null, String(bad));
  assert.deepEqual(whInfo(types, 'q063'), { code: 'Q063', leads: 'high-sec', hours: 16, mass: 500e6, jump: 62e6, ships: 'medium' });
  assert.equal(whInfo(types, 'C414').ships, 'large');
  assert.equal(whInfo(types, 'K162'), null);
  assert.equal(whInfo(null, 'Q063'), null);
  assert.equal(whSummary(whInfo(types, 'Q063')), 'Q063: to high-sec, lives up to 16 h, 500,000 t in all, 62,000 t per jump (medium ships)');
  assert.equal(whSummary(null), '');
  assert.equal(parseWanderer([{ solar_system_source: 1, solar_system_target: 2, wormhole_type: 'N110' }])[0].type, 'N110');
});

test('parseBookmarks reads Locations window rows and where each hole goes', () => {
  const text = [
    'Our Shared Folder',
    'ABC-123 &gt; Gelhan\tCoordinate\t0\tJ100001\tA-C00001\tA-R00001\t2026.10.16 20:38\t2026.10.18 20:38\tPilot One',
    'DEF-456 Keikaken LARGE EOL\tCoordinate\tNo gate-to-gate route\tJ100002\tB-C00002\tB-R00002\t2026.10.17 05:19\t2026.10.17 09:19\tPilot Two',
    'GHI-789 > Seshala (LS Khanid) LARGE\tCoordinate\t3\tJ100003\tB-C00003\tB-R00003\t2026.10.17 04:32\t-\tPilot Two',
    'UNKNOWN SIG > J222104Toward Misaba\tCoordinate\t0\tD9D-GD\tT-L301\tStain\t2026.10.17 05:44\t2026.10.18 05:44\tPilot Two',
    'JKL-012 > AY-24l\tCoordinate\t0\tKinakka\tInolari\tBlack Rise\t2026.10.15 07:36\t2026.10.17 07:36\tPilot One',
    'safe\tCoordinate\t0\tVard\tHed\tHeimatar\t2026.09.26 03:35\t-\tPilot One',
    'MNO-345 \tCoordinate\t0\tHulmate\tBalrille\tEssence\t2026.10.15 22:52\t2026.10.17 22:52\tPilot One',
  ].join('\r\n');
  const rows = parseBookmarks(text);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows[0], { label: 'ABC-123 > Gelhan', sig: 'ABC-123', dest: ['Gelhan'], flags: [], system: 'J100001',
    created: Date.UTC(2026, 9, 16, 20, 38), expires: Date.UTC(2026, 9, 18, 20, 38), by: 'Pilot One' });
  assert.deepEqual([rows[1].dest, rows[1].flags], [['Keikaken'], ['large', 'EOL']]);
  assert.deepEqual([rows[2].dest, rows[2].expires], [['Seshala'], null]);
  assert.deepEqual([rows[3].sig, rows[3].dest], [null, ['J222104']]);
  assert.deepEqual(rows[4].dest, ['AY-24l', 'AY-24I']);
  assert.deepEqual([rows[5].dest, rows[6].dest], [[], []]);
});

test('bookmarkLinks pairs bookmarks into shortcuts, newest per pair, skipping expired and unnamed ones', () => {
  const ids = { j100001: 31000001, gelhan: 30002000, keikaken: 30000150, j100002: 31000002, 'ay-24i': 30004000, kinakka: 30003000 };
  const idOf = (n) => ids[String(n).toLowerCase()] ?? null;
  const row = (o) => ({ sig: null, flags: [], created: Date.UTC(2026, 9, 17, 0, 0), expires: Date.UTC(2026, 9, 18, 0, 0), by: 'P', ...o });
  const now = Date.UTC(2026, 9, 17, 6, 0);
  const got = bookmarkLinks([
    row({ system: 'J100001', dest: ['Gelhan'], sig: 'ABC-123' }),
    row({ system: 'Gelhan', dest: ['J100001'], created: Date.UTC(2026, 9, 17, 1, 0) }),          // same hole, other end, newer
    row({ system: 'J100002', dest: ['Keikaken'], flags: ['large', 'EOL'], expires: Date.UTC(2026, 9, 17, 5, 0) }),   // expired
    row({ system: 'Kinakka', dest: ['AY-24l', 'AY-24I'], expires: null }),                     // expires `hours` after it was made
    row({ system: 'Nowhere', dest: ['Gelhan'] }),
    row({ system: 'J100001', dest: ['LOWSEC'] }),
    row({ system: 'Vard', dest: [] }),
  ], idOf, { now, hours: 16 });
  assert.deepEqual(got.links.map(l => [l.a, l.b, l.expiresAt]), [
    [30002000, 31000001, Date.UTC(2026, 9, 18, 0, 0)],
    [30003000, 30004000, Date.UTC(2026, 9, 17, 16, 0)],
  ]);
  assert.equal(got.links[0].src, 'bookmark');
  assert.deepEqual([got.noDest, got.unknown, got.expired], [2, ['Nowhere'], 1]);
  assert.equal(bookmarkLinks([row({ system: 'J100001', dest: ['Gelhan'], sig: 'ABC-123', flags: ['large'] })], idOf, { now }).links[0].note, 'ABC-123 · large');
});

test('bookmarkLinks trusts a bookmark for at most 24 h after it was made, however long it is set to last', () => {
  const idOf = (n) => ({ a: 30000001, b: 30000002 })[n] ?? null;
  const made = Date.UTC(2026, 9, 16, 20, 0);
  const row = (expires) => ({ sig: null, flags: [], system: 'a', dest: ['b'], created: made, expires, by: null });
  const at = (expires, now = made + 3_600_000) => bookmarkLinks([row(expires)], idOf, { now }).links[0]?.expiresAt;
  assert.equal(at(made + 48 * 3_600_000), made + 24 * 3_600_000);   // a 48 h bookmark
  assert.equal(at(made + 4 * 3_600_000), made + 4 * 3_600_000);     // EOL: its own 4 h
  assert.equal(at(made + 48 * 3_600_000, made + 25 * 3_600_000), undefined);   // past 24 h: dropped
  assert.equal(BOOKMARK_MAX_HOURS, 24);
});

test('cleanBookmarkLinks deletes expired and malformed links and keeps the newest per pair', () => {
  const now = Date.UTC(2026, 9, 17, 12, 0), H = 3_600_000;
  const l = (o) => ({ a: 30000001, b: 30000002, at: now - H, expiresAt: now + H, note: 'ABC-123', by: 'P', ...o });
  const out = cleanBookmarkLinks([
    l({}),
    l({ a: 30000002, b: 30000001, at: now - 2 * H }),           // same pair, older
    l({ a: 30000003, expiresAt: now - 1 }),                      // expired
    l({ a: 30000004, at: now - 30 * H, expiresAt: now + H }),    // made over 24 h ago
    l({ a: 'x' }), l({ b: 30000001 }), null,
    l({ a: 30000005, note: 'n'.repeat(200), by: undefined }),
  ], now);
  assert.deepEqual(out.map(x => [x.a, x.b]), [[30000001, 30000002], [30000005, 30000002]]);
  assert.deepEqual([out[0].src, out[0].kind, out[0].by, out[1].note.length, out[1].by], ['bookmark', 'wormhole', 'P', 80, null]);
  assert.equal(cleanBookmarkLinks(Array.from({ length: 600 }, (_, i) => l({ a: 31000000 + i })), now).length, MAX_BOOKMARK_LINKS);
  assert.deepEqual(cleanBookmarkLinks('nope', now), []);
});
