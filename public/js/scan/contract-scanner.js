// Public contract scan: every item-exchange, auction and courier contract in known space, with
// item-exchange and auction contracts valued against the live market at the five trade hubs.
//
// 1. Contract lists: GET /contracts/public/{region}/ for every region (~100 pages in total).
// 2. Contents: GET /contracts/public/items/{id}/ once per contract in scope (the chosen regions,
//    at least `minPrice` ISK paid or received). A contract's items never change, so they're kept
//    in the store (.cache/contract-items.json on the server, IndexedDB in the browser) and only new contracts are fetched on later scans.
//    ESI allows ~40 of these a second; the first scan of the hub regions takes a few minutes.
// 3. Market: every order in the five hub regions (/markets/{region}/orders/, ~900 pages), kept
//    only for item types that appear in a contract: the buy orders a seller at the hub station
//    can fill, and the lowest sell order there.
// 4. Each contract is valued at every hub (public/js/contract-value.js); the page applies tax and
//    picks the hub.

// Runs in node (server.js) or a browser Web Worker (scan-worker.js): it only needs
//   fetchUpstream(name, url) → {status, body, pages, expiresAt, …}  (see server.js)
//   data(name)  → parsed public/data/{name}.json ('types', 'universe', 'stations')
//   store       → {get(key), put(key, value)} for results that survive restarts

import { HUBS, buyOrderReachesHub } from '../arbitrage.js';
import { compactItems, valueAtHub } from '../contract-value.js';

const ESI = 'https://esi.evetech.net/latest/';
const RETRIES = 3;
const REGION_PARALLEL = 4;
const ITEM_PARALLEL = 16;
const MAX_BID_LEVELS = 40;       // buy-order price levels kept per item per hub
const MAX_ITEM_ROWS = 60;        // item rows sent to the page per contract (the value uses all)
const ERROR_FLOOR = 25;          // pause when ESI's error budget drops this low
const SHARED_BATCH = 50;         // contracts per shared-cache request (worker/index.js)
const SHARED_PARALLEL = 16;      // the Worker opens 6 ESI connections per request
const SHARED_ROUNDS = 8;         // re-asks for contracts the cache is still opening
const RANGE = { station: 'STATION', solarsystem: 'SOLARSYSTEM', region: 'REGION' };
export const SCOPES = { hubs: 'Hub regions', all: 'All known space' };
export const DEFAULT_MIN_PRICE = 20_000_000;

// A few contracts answer 200 with an empty body every time; treat them as having nothing to value.
const parseItems = (body) => { try { return JSON.parse(body); } catch { return []; } };

export const STORE_KEY = 'contract-scan';
const ITEMS_KEY = 'contract-items';

/**
 * @param {object} o
 * @param {(contracts: [number, number][]) => Promise<{items, pending, direct}>} [o.sharedItems]
 *   a shared contract-contents cache (worker/index.js /api/contract-items), tried before ESI
 */
export function createContractScanner({ fetchUpstream, data, store, sharedItems = null, log = console.log }) {
  let status = { state: 'idle', phase: null, done: 0, total: 0, warnings: [] };
  let result = null;
  let running = null;
  const items = new Map(); // contractId → compact rows (see contract-value.js), [] when gone/empty

  const ready = Promise.all([
    Promise.resolve(store.get(STORE_KEY)).then(r => { if (!r) return; result = r; log(`Contract scan: loaded cached result from ${new Date(result.finishedAt).toLocaleString()}`); }),
    Promise.resolve(store.get(ITEMS_KEY)).then(list => { for (const [id, rows] of list || []) items.set(id, rows); }),
  ].map(p => p.catch(() => {})));

  let errorPause = 0;
  async function get(url, upstream = 'esi') {
    let lastErr;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      if (errorPause > Date.now()) await new Promise(r => setTimeout(r, errorPause - Date.now()));
      try {
        const r = await fetchUpstream(upstream, url);
        // ESI blocks clients whose error budget runs out; wait for the window to reset first.
        if (r.errorRemain != null && r.errorRemain < ERROR_FLOOR) {
          errorPause = Math.max(errorPause, Date.now() + (r.errorReset || 30) * 1000);
          log(`Contract scan: ESI error budget low (${r.errorRemain}), pausing ${r.errorReset || 30}s`);
        }
        if (r.status === 200 || r.status === 204 || r.status === 404 || r.status === 403) return r;
        lastErr = new Error(`HTTP ${r.status}`);
        if (r.status < 500 && r.status !== 420 && r.status !== 429) break;
      } catch (e) { lastErr = e; }
      await new Promise(res => setTimeout(res, 1000 * 2 ** attempt));
    }
    throw lastErr;
  }

  // Every page of a paged ESI list; progress counts pages.
  async function getAll(url, onPage) {
    const sep = url.includes('?') ? '&' : '?';
    const first = await get(`${url}${sep}page=1`);
    if (first.status !== 200) {
      status.done++;
      if (first.status === 204) return 0;
      throw Object.assign(new Error(`HTTP ${first.status}`), { counted: true });
    }
    const pages = Number(first.pages) || 1;
    status.total += pages - 1;
    status.done++;
    onPage(JSON.parse(first.body), first);
    await Promise.all(Array.from({ length: pages - 1 }, (_, i) => get(`${url}${sep}page=${i + 2}`)
      .then(r => { if (r.status === 200) onPage(JSON.parse(r.body), r); })
      .catch(e => status.warnings.push(`${url.replace(ESI, '')} page ${i + 2}/${pages} failed (${e.message})`))
      .finally(() => { status.done++; })));
    return pages;
  }

  async function pool(list, n, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: n }, async () => { while (i < list.length) await fn(list[i++]); }));
  }

  async function scan({ scope, minPrice }) {
    await ready;
    const startedAt = Date.now();
    const universe = await data('universe');
    const stations = await data('stations').catch(() => ({}));
    const types = await data('types').catch(() => ({}));
    // Structures aren't in the SDE; their systems come from market orders seen in step 3.
    const structureSystems = new Map();
    const systemOf = (loc) => stations[loc]?.[1] ?? structureSystems.get(loc) ?? null;
    status = { state: 'running', phase: 'lists', done: 0, total: universe.regions.length, warnings: [], startedAt };

    // 1. Contract lists, every region (couriers are listed everywhere; item scans follow `scope`).
    const now = Date.now();
    const listed = []; // [contract, regionId]
    await pool(universe.regions, REGION_PARALLEL, async (region) => {
      try {
        await getAll(`${ESI}contracts/public/${region.id}/`, (page) => {
          for (const c of page) if (Date.parse(c.date_expired) > now) listed.push([c, region.id]);
        });
      } catch (e) { if (!e.counted) status.done++; status.warnings.push(`${region.name}: contract list failed (${e.message})`); }
    });

    // 2. Contents of the contracts in scope, newest cache misses first.
    const hubRegions = new Set(HUBS.map(h => h.regionId));
    const inScope = ([c, g]) => c.type !== 'courier' && (scope === 'all' || hubRegions.has(g))
      && Math.max(c.type === 'auction' ? (c.buyout || c.price) : c.price, c.reward) >= minPrice;
    const wanted = listed.filter(inScope);
    const missing = wanted.filter(([c]) => !items.has(c.contract_id));
    status = { ...status, phase: 'items', done: 0, total: missing.length };
    let fetched = 0, shared = 0, sinceSave = 0;
    const got = async (id, rows) => {
      items.set(id, rows); // [] for 204/403/404: accepted, deleted or not visible — nothing to value
      status.done++;
      if (++sinceSave >= 2000) { sinceSave = 0; await saveItems(new Set(listed.map(([x]) => x.contract_id))); }
    };
    const fetchOne = async ([c]) => {
      try {
        const rows = [];
        const r = await get(`${ESI}contracts/public/items/${c.contract_id}/`, 'esic');
        if (r.status === 200) {
          rows.push(...compactItems(parseItems(r.body)));
          for (let p = 2; p <= (Number(r.pages) || 1); p++) {
            const rp = await get(`${ESI}contracts/public/items/${c.contract_id}/?page=${p}`, 'esic');
            if (rp.status === 200) rows.push(...compactItems(parseItems(rp.body)));
          }
        }
        fetched++;
        await got(c.contract_id, rows);
      } catch (e) {
        status.done++;
        if (status.warnings.length < 50) status.warnings.push(`Contract ${c.contract_id}: items failed (${e.message})`);
      }
    };
    // With a shared cache (the hosted site's D1), ask it first, 100 contracts at a time; it opens the
    // ones nobody has yet. Whatever it can't supply is fetched from ESI directly.
    let direct = missing;
    if (sharedItems) {
      direct = [];
      const byId = new Map(missing.map(x => [x[0].contract_id, x]));
      const batches = [];
      for (let i = 0; i < missing.length; i += SHARED_BATCH) batches.push(missing.slice(i, i + SHARED_BATCH));
      await pool(batches, SHARED_PARALLEL, async (batch) => {
        let ask = batch.map(([c]) => [c.contract_id, Date.parse(c.date_expired)]);
        for (let round = 0; ask.length && round < SHARED_ROUNDS; round++) {
          let r;
          try { r = await sharedItems(ask); } catch { break; }
          for (const [id, rows] of Object.entries(r.items || {})) { shared++; await got(Number(id), rows); }
          for (const id of r.direct || []) if (byId.has(id)) direct.push(byId.get(id));
          const again = new Set(r.pending || []);
          ask = ask.filter(([id]) => again.has(id));
        }
        for (const [id] of ask) direct.push(byId.get(id)); // the cache kept failing: go direct
      });
    }
    await pool(direct, ITEM_PARALLEL, fetchOne);
    // Forget contracts that are no longer listed.
    const live = new Set(listed.map(([c]) => c.contract_id));
    for (const id of items.keys()) if (!live.has(id)) items.delete(id);
    await saveItems(live);

    // 3. Hub order books for every type in scope.
    const typeIds = new Set();
    for (const [c] of wanted) for (const [t] of items.get(c.contract_id) || []) typeIds.add(t);
    status = { ...status, phase: 'market', done: 0, total: HUBS.length };
    const books = Object.fromEntries(HUBS.map(h => [h.id, new Map()])); // typeId → {bm: Map price→vol, a}
    let expiresAt = Infinity;
    await Promise.all(HUBS.map(async (hub) => {
      try {
        await getAll(`${ESI}markets/${hub.regionId}/orders/?order_type=all`, (page, r) => {
          if (r.expiresAt) expiresAt = Math.min(expiresAt, r.expiresAt);
          for (const o of page) {
            if (o.location_id > 1e12) structureSystems.set(o.location_id, o.system_id);
            if (!typeIds.has(o.type_id)) continue;
            let e = books[hub.id].get(o.type_id);
            if (o.is_buy_order) {
              if (!buyOrderReachesHub({ minVolume: o.min_volume, locationId: o.location_id, systemId: o.system_id,
                regionId: hub.regionId, range: RANGE[o.range] || `_${o.range}` }, hub)) continue;
              if (!e) books[hub.id].set(o.type_id, e = { bm: new Map(), a: null });
              e.bm.set(o.price, (e.bm.get(o.price) || 0) + o.volume_remain);
            } else if (o.location_id === hub.stationId) {
              if (!e) books[hub.id].set(o.type_id, e = { bm: new Map(), a: null });
              if (e.a == null || o.price < e.a) e.a = o.price;
            }
          }
        });
      } catch (e) { if (!e.counted) status.done++; status.warnings.push(`${hub.region}: market orders failed (${e.message}) — ${hub.name} not valued`); }
    }));
    for (const b of Object.values(books)) {
      for (const e of b.values()) { e.b = [...e.bm].sort((x, y) => y[0] - x[0]).slice(0, MAX_BID_LEVELS); delete e.bm; }
    }

    // 4. Value each contract at every hub.
    status = { ...status, phase: 'computing' };
    const contracts = [], couriers = [], usedTypes = {}, prices = {};
    const useType = (t) => {
      if (usedTypes[t]) return;
      usedTypes[t] = types[t] || [`Type ${t}`, 0];
      prices[t] = Object.fromEntries(HUBS.map(h => { const e = books[h.id].get(t); return [h.id, [e?.b[0]?.[0] ?? null, e?.a ?? null]]; }));
    };
    for (const [c, g] of listed) {
      if (c.type === 'courier') {
        couriers.push({ id: c.contract_id, l: c.start_location_id, s: systemOf(c.start_location_id), d: c.end_location_id,
          ds: systemOf(c.end_location_id), g, r: c.reward, c: c.collateral, v: c.volume, days: c.days_to_complete,
          e: Date.parse(c.date_expired), ti: c.title || undefined });
        continue;
      }
      const rows = items.get(c.contract_id);
      if (!rows?.length || !inScope([c, g])) continue;
      const h = {};
      let best = -Infinity;
      const auction = c.type === 'auction';
      const pay = auction ? (c.buyout || c.price) : c.price;
      for (const hub of HUBS) {
        const v = valueAtHub(rows, (t) => books[hub.id].get(t));
        h[hub.id] = [Math.round(v.instant), Math.round(v.relist), Math.round(v.need), v.unpriced, v.thin];
        best = Math.max(best, Math.max(v.instant, v.relist) + c.reward - pay - v.need);
      }
      if (!(best > 0)) continue; // not worth it at any hub, even relisting
      const lines = rows.slice(0, MAX_ITEM_ROWS);
      for (const [t] of lines) useType(t);
      contracts.push({ id: c.contract_id, k: auction ? 'a' : 'x', l: c.start_location_id, s: systemOf(c.start_location_id), g,
        p: pay, r: c.reward, v: c.volume, e: Date.parse(c.date_expired), ti: c.title || undefined,
        bo: auction ? (c.buyout ? 1 : 0) : undefined, n: rows.length, it: lines, h });
    }

    const finishedAt = Date.now();
    result = {
      startedAt, finishedAt, scope, minPrice,
      expiresAt: Number.isFinite(expiresAt) ? Math.max(expiresAt, finishedAt + 120_000) : finishedAt + 5 * 60_000,
      listed: listed.length, scanned: wanted.length, fetched, shared, warnings: status.warnings,
      hubs: HUBS.map(h => h.id), contracts, couriers, types: usedTypes, prices,
    };
    status = { ...status, state: 'done', phase: null, finishedAt };
    log(`Contract scan: ${listed.length} contracts listed, ${wanted.length} in scope (${fetched} from ESI, ${shared} from the shared cache), `
      + `${contracts.length} worth taking at some hub, ${couriers.length} couriers in ${((finishedAt - startedAt) / 1000).toFixed(0)}s`);
    await Promise.resolve(store.put(STORE_KEY, result)).catch(e => log(`Contract scan: couldn't write cache (${e.message})`));
  }

  async function saveItems(live) {
    const keep = [...items].filter(([id]) => live.has(id));
    await Promise.resolve(store.put(ITEMS_KEY, keep)).catch(e => log(`Contract scan: couldn't save items (${e.message})`));
  }

  return {
    ready,
    status() {
      return {
        ...status,
        result: result && { finishedAt: result.finishedAt, expiresAt: result.expiresAt, scope: result.scope, minPrice: result.minPrice,
          contracts: result.contracts.length, couriers: result.couriers.length, warnings: result.warnings },
      };
    },
    result: () => result,
    async start({ force = false, scope = 'hubs', minPrice = DEFAULT_MIN_PRICE } = {}) {
      await ready;
      if (running) return { started: false, reason: 'running' };
      if (!SCOPES[scope]) scope = 'hubs';
      minPrice = Number.isFinite(minPrice) && minPrice >= 0 ? minPrice : DEFAULT_MIN_PRICE;
      const same = result && result.scope === scope && result.minPrice === minPrice;
      if (!force && same && result.expiresAt > Date.now()) return { started: false, reason: 'fresh' };
      status = { state: 'running', phase: 'lists', done: 0, total: 0, warnings: [], startedAt: Date.now() }; // before the first await, so a poll right after start() sees it
      running = scan({ scope, minPrice })
        .catch(e => { status = { ...status, state: 'error', phase: null, error: e.message }; log(`Contract scan failed: ${e.message}`); })
        .finally(() => { running = null; });
      return { started: true };
    },
  };
}
