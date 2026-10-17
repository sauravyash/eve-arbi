// Builds public/wormhole-statics.json: every wormhole system (J100040, Thera, …) →
// [class, region, effect, shattered, statics], where statics is [[type code, leads to], …]
// (e.g. [["J244", "ls"]]). Class is c1–c6, c13, thera or a drifter hole (sentinel, …); leads to is
// c1–c6, hs, ls or ns; effect is null when the system has none; shattered is 1 or 0.
// The data is PERISCOPE's search index (https://periscope.observance.app/search-index.json), the
// same file its Browse page filters by class, effect, statics and destination. A system's static is
// the hole that always reopens there, so the type codes look up in public/wormhole-types.json.
// The file is committed (like wormhole-types.json), so the site never has to fetch the fan site;
// rebuild it when CCP changes statics.
//
//   node scripts/build-wh-statics.js

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INDEX_URL = 'https://periscope.observance.app/search-index.json';

export const STATICS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'wormhole-statics.json');

const words = (s) => String(s || '').split(/\s+/).filter(Boolean);

/** The search index → {name: [class, region, effect, shattered, [[code, leadsTo], …]]}, by name */
export function parseIndex(rows) {
  const out = {};
  const systems = (Array.isArray(rows) ? rows : []).filter(r => r?.k === 's' && r.n);
  systems.sort((a, b) => String(a.n).localeCompare(String(b.n)));
  for (const r of systems) {
    const codes = words(r.s), dests = words(r.sd);
    if (codes.length !== dests.length) throw new Error(`${r.n}: ${codes.length} statics but ${dests.length} destinations`);
    out[r.n] = [r.c || null, r.r || null, r.e || null, r.x ? 1 : 0, codes.map((c, i) => [c, dests[i]])];
  }
  return out;
}

export async function buildStatics({ outFile = STATICS_FILE, log = console.log } = {}) {
  log(`Building wormhole statics from ${INDEX_URL}…`);
  const res = await fetch(INDEX_URL, { headers: { 'User-Agent': 'eve-arbi static data build (github.com/sauravyash/eve-arbi)' } });
  if (!res.ok) throw new Error(`${INDEX_URL}: HTTP ${res.status}`);
  const out = parseIndex(await res.json());
  const n = Object.keys(out).length;
  if (n < 2000) throw new Error(`only ${n} systems in the index; has its format changed?`);
  await mkdir(path.dirname(outFile), { recursive: true });
  const json = JSON.stringify(out);
  await writeFile(outFile, json);
  const links = Object.values(out).reduce((sum, s) => sum + s[4].length, 0);
  log(`Statics: ${n} systems, ${links} statics → ${path.relative(process.cwd(), outFile)} (${Math.round(json.length / 1024)} KB)`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildStatics().catch(e => {
    console.error(`Wormhole statics build failed: ${e.message}`);
    process.exit(1);
  });
}
