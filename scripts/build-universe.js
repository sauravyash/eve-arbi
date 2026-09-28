// Builds static data from CCP's Static Data Export (CSV mirror by Fuzzwork):
//  - public/data/universe.json: every known-space system (3D top-down position + CCP's 2D map
//    layout, security, region) and every stargate link, for the star map.
//  - public/data/types.json: every published market item → [name, packaged volume m³, category ID,
//    group ID, MINING_KIND?] for the market scans and the mining page; ships (category 6) have
//    their base cargo m³ instead of the group, and only mined and refined materials have a kind.
//  - public/data/stations.json: every NPC station → [name, solar system ID], for naming off-hub
//    stations in the universe-wide scan.
//
//   node scripts/build-universe.js [--from <dir with CSVs>]

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SDE_BASE = 'https://www.fuzzwork.co.uk/dump/latest/csv/';
const FILES = ['mapSolarSystems', 'mapSolarSystemJumps', 'mapRegions'];
const LY = 9460730472580800; // metres
// Jove regions: gate-isolated and unreachable by players.
const EXCLUDED_REGIONS = new Set([10000004, 10000017, 10000019]);
// 11xxxxxx wormholes, 12xxxxxx+ abyssal/void pockets: not on the gate network.
const isWormholeRegion = (id) => id >= 11000000;

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');
export const OUT_FILE = path.join(DATA_DIR, 'universe.json');
export const TYPES_FILE = path.join(DATA_DIR, 'types.json');
export const STATIONS_FILE = path.join(DATA_DIR, 'stations.json');

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter(r => r.length > 1 || r[0] !== '');
  return body.map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

async function loadCsv(name, fromDir) {
  if (fromDir) return parseCsv(await readFile(path.join(fromDir, `${name}.csv`), 'utf8'));
  const res = await fetch(`${SDE_BASE}${name}.csv`, { headers: { 'User-Agent': 'eve-arbi/1.0 (map build)' } });
  if (!res.ok) throw new Error(`${name}.csv: HTTP ${res.status}`);
  return parseCsv(await res.text());
}

const r2 = (v) => Math.round(v * 100) / 100;

export async function buildUniverse({ fromDir, outFile = OUT_FILE, log = console.log } = {}) {
  log(`Building star map from SDE${fromDir ? ` (${fromDir})` : ` (${SDE_BASE})`}…`);
  const [systemsCsv, jumpsCsv, regionsCsv] = await Promise.all(FILES.map(f => loadCsv(f, fromDir)));

  const keep = systemsCsv.filter(s => {
    const reg = Number(s.regionID);
    return !isWormholeRegion(reg) && !EXCLUDED_REGIONS.has(reg);
  });
  const index = new Map(keep.map((s, i) => [Number(s.solarSystemID), i]));

  const regionIds = [...new Set(keep.map(s => Number(s.regionID)))].sort((a, b) => a - b);
  const regionIdx = new Map(regionIds.map((id, i) => [id, i]));
  const regionName = new Map(regionsCsv.map(r => [Number(r.regionID), r.regionName]));

  const sys = { id: [], name: [], x: [], y: [], x2: [], y2: [], sec: [], region: [] };
  for (const s of keep) {
    sys.id.push(Number(s.solarSystemID));
    sys.name.push(s.solarSystemName);
    // Top-down view of the 3D galaxy: screen x = x, screen y = -z (north up).
    sys.x.push(r2(Number(s.x) / LY));
    sys.y.push(r2(-Number(s.z) / LY));
    // CCP's flattened 2D map layout (same orientation convention).
    sys.x2.push(r2(Number(s.position2Dx) / LY));
    sys.y2.push(r2(-Number(s.position2Dy) / LY));
    sys.sec.push(Math.round(Number(s.security) * 1000) / 1000);
    sys.region.push(regionIdx.get(Number(s.regionID)));
  }

  const seen = new Set(), jumps = [];
  for (const j of jumpsCsv) {
    const a = index.get(Number(j.fromSolarSystemID)), b = index.get(Number(j.toSolarSystemID));
    if (a == null || b == null) continue;
    const k = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(k)) continue;
    seen.add(k);
    jumps.push(Math.min(a, b), Math.max(a, b));
  }

  const out = {
    source: 'CCP Static Data Export via fuzzwork.co.uk',
    builtAt: new Date().toISOString(),
    units: 'light years',
    regions: regionIds.map(id => ({ id, name: regionName.get(id) || String(id) })),
    systems: sys,
    jumps,
  };
  await mkdir(path.dirname(outFile), { recursive: true });
  const json = JSON.stringify(out);
  await writeFile(outFile, json);
  log(`Star map: ${sys.id.length} systems, ${jumps.length / 2} gates, ${regionIds.length} regions → ${path.relative(process.cwd(), outFile)} (${Math.round(json.length / 1024)} KB)`);
  return out;
}

// Mining page (public/js/mining.js): what each harvestable or refined material is, by SDE group.
// Every other group in the Asteroid category (25) is ore.
const ASTEROID_CATEGORY = 25;
const KIND_BY_GROUP = {
  711: 'gas', 4168: 'gas',                                     // Harvestable Cloud, Compressed Gas
  465: 'ice',
  1884: 'moon', 1920: 'moon', 1921: 'moon', 1922: 'moon', 1923: 'moon',
  18: 'mineral', 423: 'mineral', 427: 'mineral',               // Mineral, Ice Product, Moon Materials
};
export const miningKind = (groupId, categoryId) =>
  KIND_BY_GROUP[groupId] ?? (categoryId === ASTEROID_CATEGORY ? 'ore' : null);

export async function buildTypes({ fromDir, outFile = TYPES_FILE, log = console.log } = {}) {
  log(`Building item list from SDE${fromDir ? ` (${fromDir})` : ` (${SDE_BASE})`}…`);
  const [types, groups] = await Promise.all([loadCsv('invTypes', fromDir), loadCsv('invGroups', fromDir)]);
  const categoryOf = new Map(groups.map(g => [g.groupID, Number(g.categoryID)]));
  const out = {};
  for (const t of types) {
    if (t.published !== '1' || !t.marketGroupID) continue;
    const vol = Number(t.packagedVolume) || Number(t.volume) || 0;
    const cat = categoryOf.get(t.groupID) ?? 0;
    // Ships: base cargo hold m³. Everything else: group, to match specialised holds (holds.js).
    out[t.typeID] = [t.typeName, vol, cat, cat === 6 ? Number(t.capacity) || 0 : Number(t.groupID)];
    const kind = miningKind(Number(t.groupID), cat);
    if (kind) out[t.typeID].push(kind);                            // ore, moon, ice, gas, mineral
  }
  await mkdir(path.dirname(outFile), { recursive: true });
  const json = JSON.stringify(out);
  await writeFile(outFile, json);
  log(`Items: ${Object.keys(out).length} market types → ${path.relative(process.cwd(), outFile)} (${Math.round(json.length / 1024)} KB)`);
  return out;
}

export async function buildStations({ fromDir, outFile = STATIONS_FILE, log = console.log } = {}) {
  log(`Building station list from SDE${fromDir ? ` (${fromDir})` : ` (${SDE_BASE})`}…`);
  const rows = await loadCsv('staStations', fromDir);
  const out = {};
  for (const r of rows) out[r.stationID] = [r.stationName, Number(r.solarSystemID)];
  await mkdir(path.dirname(outFile), { recursive: true });
  const json = JSON.stringify(out);
  await writeFile(outFile, json);
  log(`Stations: ${Object.keys(out).length} → ${path.relative(process.cwd(), outFile)} (${Math.round(json.length / 1024)} KB)`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--from');
  const fromDir = i > 0 ? process.argv[i + 1] : undefined;
  Promise.all([buildUniverse({ fromDir }), buildTypes({ fromDir }), buildStations({ fromDir })]).catch(e => {
    console.error(`Static data build failed: ${e.message}`);
    process.exit(1);
  });
}
