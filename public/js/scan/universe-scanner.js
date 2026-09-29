// Universe-wide scan: pulls every order in every known-space region from ESI's bulk
// /markets/{region}/orders/ endpoint (~1,600 pages), keeps the best price levels at every
// station, and finds hauls for every item, with no hub restriction.
//
// Buy-order ranges count; the matching lives in public/js/ranges.js (shared with the browser).
//
// Memory: The Forge alone is ~400k orders. Each region is ingested into its own scratch map and,
// once its pages are in, collapsed to the best TOP_LEVELS price levels per station (and, for buy
// orders, per range) before it joins the universe-wide book. Only that trimmed book is kept.
//
// With `hubs: true` (server.js) the same book also gives the hub-to-hub result the whole-market
// scan would (hub-scanner.js), so one set of ESI pages serves both; see hubView().

// Runs in node (server.js) or a browser Web Worker (scan-worker.js): it only needs
//   fetchUpstream(name, url) → {status, body, pages, expiresAt, …}  (see server.js)
//   data(name)  → parsed public/data/{name}.json ('types', 'universe', 'stations')
//   store       → {get(key), put(key, value)} for results that survive restarts

import { buildGraph } from '../galaxy.js';
import { buildRangeContext, pairsForType, rangeCode, REGION, MIN_PROFIT } from '../ranges.js';
import { HUBS } from '../arbitrage.js';
import { hubCandidates, MAX_STEPS as HUB_STEPS, MIN_PROFIT as HUB_MIN_PROFIT, STORE_KEY as HUB_STORE_KEY } from './hub-scanner.js';

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

const HUB_SYSTEMS = new Set(HUBS.map(h => h.id));
// Orders in a hub system keep as many levels as a hub-to-hub haul can walk (hub-scanner.js).
const keep = (x) => (HUB_SYSTEMS.has(x.s) ? Math.max(TOP_LEVELS, HUB_STEPS) : TOP_LEVELS);
const topLevels = (m, desc, n) => [...m].sort((x, y) => (desc ? y[0] - x[0] : x[0] - y[0])).slice(0, n);

// Collapse a region's scratch map into the universe book:
// Map typeId → {asks: [{l, s, a: [[p, v]…]}], bids: [{l, s, r, g, lv: [[p, v]…]}]}
export function mergeRegion(book, scratch) {
  for (const [typeId, t] of scratch) {
    let e = book.get(typeId);
    if (!e) book.set(typeId, e = { asks: [], bids: [] });
    for (const x of t.a.values()) e.asks.push({ l: x.l, s: x.s, a: topLevels(x.m, false, keep(x)) });
    for (const x of t.b.values()) e.bids.push({ l: x.l, s: x.s, r: x.r, g: x.g, lv: topLevels(x.m, true, keep(x)) });
  }
}

// Can a seller docked at the hub station fill buy-order group G? Same rule as arbitrage.js
// buyOrderReachesHub (bait orders are already dropped).
const groupReachesHub = (G, hub) => G.l === hub.stationId
  || (G.r !== -1 && (G.s === hub.id || (G.r === REGION && G.g === hub.regionId)));

// The universe book as hub-scanner.js hubCandidates() books: per hub, Map typeId → {a, b} with
// a = sell orders at the hub station, b = buy orders that reach it, both Map price → volume.
export function hubBooks(book) {
  const books = Object.fromEntries(HUBS.map(h => [h.id, new Map()]));
  for (const [typeId, e] of book) {
    for (const hub of HUBS) {
      const ask = e.asks.find(x => x.l === hub.stationId);
      const groups = e.bids.filter(G => groupReachesHub(G, hub));
      if (!ask && !groups.length) continue;
      const b = new Map();
      for (const G of groups) for (const [p, v] of G.lv) b.set(p, (b.get(p) || 0) + v);
      books[hub.id].set(typeId, { a: new Map(ask?.a), b });
    }
  }
  return books;
}

export const STORE_KEY = 'universe-scan';

/** @param {object} o  @param {boolean} [o.hubs]  also produce the hub-to-hub result (see hubView) */
export function createUniverseScanner({ fetchUpstream, data, store, hubs = false, log = console.log }) {
  let status = { state: 'idle', done: 0, total: 0, regions: 0, regionsDone: 0, warnings: [] };
  let result = null, hubResult = null;
  let running = null;

  const ready = Promise.all([
    Promise.resolve(store.get(STORE_KEY))
      .then(r => { if (!r) return; result = r; log(`Universe scan: loaded cached result from ${new Date(result.finishedAt).toLocaleString()}`); }),
    hubs && Promise.resolve(store.get(HUB_STORE_KEY)).then(r => { if (r?.fromUniverse) hubResult = r; }),
  ].map(p => Promise.resolve(p).catch(() => {})));

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
    const universe = await data('universe');
    const stations = await data('stations').catch(() => ({}));
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
    const types = await data('types').catch(() => ({}));
    const candidates = [];
    let locations = 0, k = 0;
    for (const [typeId, entry] of book) {
      locations += entry.asks.length + entry.bids.length;
      candidates.push(...pairsForType(typeId, entry, ctx));
      if (++k % 500 === 0) await new Promise(r => setTimeout(r, 0)); // stay responsive
    }
    const namesOf = (list) => {
      const used = {};
      for (const c of list) used[c.t] ||= types[c.t] || [`Type ${c.t}`, 0];
      return used;
    };
    const hubList = hubs ? hubCandidates(hubBooks(book)) : null;
    const finishedAt = Date.now();
    result = {
      startedAt, finishedAt,
      expiresAt: Number.isFinite(expiresAt) ? Math.max(expiresAt, finishedAt + 120_000) : finishedAt + 5 * 60_000,
      pages: status.total, regions: status.regionsDone, warnings: status.warnings, minProfit: MIN_PROFIT,
      items: book.size, locations, rangeAware: true, candidates, types: namesOf(candidates),
    };
    if (hubList) {
      // Same shape as hub-scanner.js's result, so the page can't tell the difference.
      hubResult = { startedAt, finishedAt, expiresAt: result.expiresAt, pages: result.pages, warnings: result.warnings,
        minProfit: HUB_MIN_PROFIT, candidates: hubList, types: namesOf(hubList), fromUniverse: true };
      await Promise.resolve(store.put(HUB_STORE_KEY, hubResult)).catch(e => log(`Universe scan: couldn't write hub result (${e.message})`));
    }
    status = { ...status, state: 'done', done: status.total, finishedAt };
    log(`Universe scan: ${result.pages} pages, ${result.regions} regions, ${book.size} items, ${candidates.length} hauls `
      + `(${candidates.filter(c => c.x).length} via ranged buy orders${hubList ? `, ${hubList.length} hub-to-hub` : ''}) in ${((finishedAt - startedAt) / 1000).toFixed(0)}s `
      + `(matching ${((finishedAt - computeStart) / 1000).toFixed(1)}s)`);
    await Promise.resolve(store.put(STORE_KEY, result)).catch(e => log(`Universe scan: couldn't write cache (${e.message})`));
  }

  return {
    ready,
    status() {
      return {
        ...status,
        result: result && { finishedAt: result.finishedAt, expiresAt: result.expiresAt, candidates: result.candidates.length, warnings: result.warnings },
      };
    },
    result: () => result,
    hubResult: () => hubResult,
    async start({ force = false } = {}) {
      await ready;
      if (running) return { started: false, reason: 'running' };
      // A cached result from before range matching is treated as stale.
      if (!force && result?.rangeAware && result.expiresAt > Date.now()) return { started: false, reason: 'fresh' };
      status = { state: 'running', done: 0, total: 0, regions: 0, regionsDone: 0, warnings: [], startedAt: Date.now() }; // before the first await, so a poll right after start() sees it
      running = scan()
        .catch(e => { status = { ...status, state: 'error', error: e.message }; log(`Universe scan failed: ${e.message}`); })
        .finally(() => { running = null; });
      return { started: true };
    },
  };
}

// The hub-to-hub scan as a view of a universe scanner created with `hubs: true`: same interface as
// hub-scanner.js createScanner(), but scanning means scanning the universe (the hub regions are part
// of it), so the server fetches ESI's market pages once for both.
export function hubView(universe) {
  const summary = (r) => r && { finishedAt: r.finishedAt, expiresAt: r.expiresAt, candidates: r.candidates.length, warnings: r.warnings };
  return {
    ready: universe.ready,
    status: () => ({ ...universe.status(), result: summary(universe.hubResult()) }),
    result: () => universe.hubResult(),
    async start({ force = false } = {}) {
      await universe.ready;
      const r = universe.hubResult();
      // A universe result from before hub results were kept has none: scan again.
      const outcome = await universe.start({ force: force || !r });
      return outcome.reason === 'fresh' ? { ...outcome, result: summary(r) } : outcome;
    },
  };
}
