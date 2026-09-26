import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseCsv, OUT_FILE } from '../scripts/build-universe.js';
import { secBand, secLabel } from '../public/js/map.js';
import { HUBS } from '../public/js/arbitrage.js';

test('parseCsv handles BOM, quotes, embedded commas and CRLF', () => {
  const rows = parseCsv('\uFEFF"id","name"\r\n"1","Jita, The Forge"\r\n"2","say ""hi"""\n');
  assert.deepEqual(rows, [{ id: '1', name: 'Jita, The Forge' }, { id: '2', name: 'say "hi"' }]);
});

test('security bands follow in-game rounding', () => {
  assert.equal(secLabel(0.9459), '0.9');
  assert.equal(secLabel(0.45), '0.5');
  assert.equal(secLabel(0.01), '0.1'); // 0 < sec < 0.05 displays as 0.1
  assert.equal(secBand(-0.4), 0);
});

test('built universe contains every hub, gate-connected to Jita', async (t) => {
  let u;
  try { u = JSON.parse(await readFile(OUT_FILE, 'utf8')); } catch { return t.skip('universe.json not built'); }
  const { id } = u.systems;
  const adj = id.map(() => []);
  for (let i = 0; i < u.jumps.length; i += 2) { adj[u.jumps[i]].push(u.jumps[i + 1]); adj[u.jumps[i + 1]].push(u.jumps[i]); }
  const seen = new Set([id.indexOf(30000142)]), stack = [...seen];
  while (stack.length) for (const w of adj[stack.pop()]) if (!seen.has(w)) { seen.add(w); stack.push(w); }
  for (const hub of HUBS) assert.ok(seen.has(id.indexOf(hub.id)), `${hub.name} reachable`);
});
