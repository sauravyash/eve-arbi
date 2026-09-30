import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseList, parseDetail, shortLeads } from '../scripts/build-wormholes.js';
import { whCode, whInfo, whSummary, parseWanderer } from '../public/js/wormholes.js';

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
