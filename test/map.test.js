import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseCsv, OUT_FILE, buildUniverse } from '../scripts/build-universe.js';
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
  assert.equal(secBand(-0.4), -4);
  assert.equal(secLabel(-0.4), '-0.4');
  assert.equal(secLabel(-0.99), '-1.0');
  assert.equal(secLabel(-0.02), '0.0'); // no "-0.0"
});

test('built universe contains every hub, gate-connected to Jita', async (t) => {
  let u;
  try { u = JSON.parse(await readFile(OUT_FILE, 'utf8')); } catch { return t.skip('universe.json not built'); }
  const { id } = u.systems;
  assert.equal(u.systems.z3?.length, id.length, 'z3 present for every system');
  const adj = id.map(() => []);
  for (let i = 0; i < u.jumps.length; i += 2) { adj[u.jumps[i]].push(u.jumps[i + 1]); adj[u.jumps[i + 1]].push(u.jumps[i]); }
  const seen = new Set([id.indexOf(30000142)]), stack = [...seen];
  while (stack.length) for (const w of adj[stack.pop()]) if (!seen.has(w)) { seen.add(w); stack.push(w); }
  for (const hub of HUBS) assert.ok(seen.has(id.indexOf(hub.id)), `${hub.name} reachable`);
});

test('buildUniverse writes the vertical position z3 in light years', async () => {
  const LY = 9460730472580800;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sde-'));
  try {
    await writeFile(path.join(dir, 'mapSolarSystems.csv'),
      'regionID,solarSystemID,solarSystemName,x,y,z,position2Dx,position2Dy,security\n' +
      `10000002,30000142,Jita,${-1 * LY},${2.5 * LY},${3 * LY},0,0,0.9459\n` +
      `10000002,30000144,Perimeter,${2 * LY},${-0.25 * LY},${0.5 * LY},0,0,0.9\n`);
    await writeFile(path.join(dir, 'mapSolarSystemJumps.csv'),
      'fromSolarSystemID,toSolarSystemID\n30000142,30000144\n30000144,30000142\n');
    await writeFile(path.join(dir, 'mapRegions.csv'), 'regionID,regionName\n10000002,The Forge\n');
    const u = await buildUniverse({ fromDir: dir, outFile: path.join(dir, 'u.json'), log: () => {} });
    assert.deepEqual(u.systems.z3, [2.5, -0.25]);
    assert.deepEqual(u.systems.x, [-1, 2]);
    assert.deepEqual(u.systems.y, [-3, -0.5]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
