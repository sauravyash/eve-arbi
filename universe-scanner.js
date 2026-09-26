// Universe-wide scan: pulls every order in every known-space region from ESI's bulk
// /markets/{region}/orders/ endpoint (~1,600 pages), keeps the best price levels at every
// station, and finds hauls for every item, with no hub restriction.
//
// Buy-order ranges count; the matching lives in public/js/ranges.js (shared with the browser).
//
// Memory: The Forge alone is ~400k orders. Each region is ingested into its own scratch map and,
// once its pages are in, collapsed to the best TOP_LEVELS price levels per station (and, for buy
// orders, per range) before it joins the universe-wide book. Only that trimmed book is kept.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { buildGraph } from './public/js/galaxy.js';
import { buildRangeContext, pairsForType, rangeCode, REGION, MIN_PROFIT } from './public/js/ranges.js';

export { pairsForType, rangeCode, REGION, MIN_PROFIT };
export const buildScanContext = (universe, stations) => buildRangeContext(buildGraph(universe), stations);

const ESI = 'https://esi.evetech.net/latest/';
export const TOP_LEVELS = 30;          // price levels kept per station (per range, for bids)
const REGION_PARALLEL = 3;
const RETRIES = 3;

// region scratch: Map typeId → {a: Map loc → {s, m: Map price→vol}, b: Map "loc|range" → {l, s, r, g, m}}
export function ingestOrders(scratch, orders, regionId) {
  for (const o of orders) {
    if (o.is_buy_order && o.min_volume > 1) continue; // bait
    let t = scratch.get(o.type_id);
    if (!t) scratch.set(o.type_id, t = { a: new Map(), b: new Map() });
    let slot;
    if (o.is_buy_order) {
      const r = rangeCode(o.range), key = `${o.location_id}|${r}`;
      slot = t.b.get(key);
      if (!slot) t.b.set(key, slot = { l: o.location_id, s: o.system_id, r, g: regionId, m: new Map() });
    } else {
      slot = t.a.get(o.location_id);
      if (!slot) t.a.set(o.location_id, slot = { l: o.location_id, s: o.system_id, m: new Map() });
    }
    slot.m.set(o.price, (slot.m.get(o.price) || 0) + o.volume_remain);
  }
}

const topLevels = (m, desc) => [...m].sort((x, y) => (desc ? y[0] - x[0] : x[0] - y[0])).slice(0, TOP_LEVELS);

// Collapse a region's scratch map into the universe book:
// Map typeId → {asks: [{l, s, a: [[p, v]…]}], bids: [{l, s, r, g, lv: [[p, v]…]}]}
export function mergeRegion(book, scratch) {
  for (const [typeId, t] of scratch) {
    let e = book.get(typeId);
    if (!e) book.set(typeId, e = { asks: [], bids: [] });
    for (const x of t.a.values()) e.asks.push({ l: x.l, s: x.s, a: topLevels(x.m, false) });
    for (const x of t.b.values()) e.bids.push({ l: x.l, s: x.s, r: x.r, g: x.g, lv: topLevels(x.m, true) });
  }
}

export function createUniverseScanner({ fetchUpstream, typesFile, universeFile, stationsFile, cacheFile, log = console.log }) {
  let status = { state: 'idle', done: 0, total: 0, regions: 0, regionsDone: 0, warnings: [] };
  let result = null;
  let running = null;

  const ready = readFile(cacheFile, 'utf8')
    .then(txt => { result = JSON.parse(txt); log(`Universe scan: loaded cached result from ${new Date(result.finishedAt).toLocaleString()}`); })
    .catch(() => {});

  async function fetchPage(regionId, page) {
    const url = `${ESI}markets/${regionId}/orders/?order_type=all&page=${page}`;
    let lastErr;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      try {
        const r = await fetchUpstream('esi', url);
        if (r.status === 200) return r;
        lastErr = new Error(`HTTP ${r.status}`);
        if (r.status < 500 && r.status !== 420 && r.status !== 429) break;
      } catch (e) { lastErr = e; }
      await new Promise(res => setTimeout(res, 1000 * 2 ** attempt));
    }
    throw lastErr;
  }

  async function scanRegion(region, book, noteExpiry) {
    const scratch = new Map();
    let first;
    try { first = await fetchPage(region.id, 1); }
    catch (e) { status.warnings.push(`${region.name}: could not fetch orders (${e.message}) — region skipped`); return; }
    const pages = Number(first.pages) || 1;
    status.total += pages - 1;
    status.done++;
    noteExpiry(first);
    ingestOrders(scratch, JSON.parse(first.body), region.id);
    await Promise.all(Array.from({ length: pages - 1 }, (_, i) => fetchPage(region.id, i + 2)
      .then(r => { noteExpiry(r); ingestOrders(scratch, JSON.parse(r.body), region.id); })
      .catch(e => status.warnings.push(`${region.name} page ${i + 2}/${pages} failed (${e.message})`))
      .finally(() => { status.done++; })));
    mergeRegion(book, scratch);
    status.regionsDone++;
  }

  async function scan() {
    await ready;
    const startedAt = Date.now();
    const universe = JSON.parse(await readFile(universeFile, 'utf8'));
    const stations = JSON.parse(await readFile(stationsFile, 'utf8').catch(() => '{}'));
    const ctx = buildScanContext(universe, stations);
    const regions = universe.regions;
    // One page-1 request per region is counted up front; the rest are added as X-Pages arrive.
    status = { state: 'running', done: 0, total: regions.length, regions: regions.length, regionsDone: 0, warnings: [], startedAt };
    const book = new Map();
    let expiresAt = Infinity;
    const noteExpiry = (r) => { if (r.expiresAt) expiresAt = Math.min(expiresAt, r.expiresAt); };

    const queue = [...regions];
    await Promise.all(Array.from({ length: REGION_PARALLEL }, async () => {
      while (queue.length) await scanRegion(queue.shift(), book, noteExpiry);
    }));

    status.state = 'computing';
    const computeStart = Date.now();
    const types = JSON.parse(await readFile(typesFile, 'utf8').catch(() => '{}'));
    const candidates = [];
    let locations = 0, k = 0;
    for (const [typeId, entry] of book) {
      locations += entry.asks.length + entry.bids.length;
      candidates.push(...pairsForType(typeId, entry, ctx));
      if (++k % 500 === 0) await new Promise(r => setImmediate(r)); // keep the server responsive
    }
    const usedTypes = {};
    for (const c of candidates) usedTypes[c.t] ||= types[c.t] || [`Type ${c.t}`, 0];
    const finishedAt = Date.now();
    result = {
      startedAt, finishedAt,
      expiresAt: Number.isFinite(expiresAt) ? Math.max(expiresAt, finishedAt + 120_000) : finishedAt + 5 * 60_000,
      pages: status.total, regions: status.regionsDone, warnings: status.warnings, minProfit: MIN_PROFIT,
      items: book.size, locations, rangeAware: true, candidates, types: usedTypes,
    };
    status = { ...status, state: 'done', done: status.total, finishedAt };
    log(`Universe scan: ${result.pages} pages, ${result.regions} regions, ${book.size} items, ${candidates.length} hauls `
      + `(${candidates.filter(c => c.x).length} via ranged buy orders) in ${((finishedAt - startedAt) / 1000).toFixed(0)}s `
      + `(matching ${((finishedAt - computeStart) / 1000).toFixed(1)}s)`);
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(result)).catch(e => log(`Universe scan: couldn't write cache (${e.message})`));
  }

  return {
    status() {
      return {
        ...status,
        result: result && { finishedAt: result.finishedAt, expiresAt: result.expiresAt, candidates: result.candidates.length, warnings: result.warnings },
      };
    },
    result: () => result,
    async start({ force = false } = {}) {
      await ready;
      if (running) return { started: false, reason: 'running' };
      // A cached result from before range matching is treated as stale.
      if (!force && result?.rangeAware && result.expiresAt > Date.now()) return { started: false, reason: 'fresh' };
      running = scan()
        .catch(e => { status = { ...status, state: 'error', error: e.message }; log(`Universe scan failed: ${e.message}`); })
        .finally(() => { running = null; });
      return { started: true };
    },
  };
}
