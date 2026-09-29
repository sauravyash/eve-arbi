// Whole-market scan: pulls every order in the five hub regions from ESI's bulk endpoint
// (GET /markets/{region}/orders/, ~900 pages total), keeps only orders that matter at each
// hub station, and finds every item that can be bought at one hub and sold into buy orders at
// another for a profit. Runs on demand only; results are reused until ESI's cache expires.

// Runs in node (server.js) or a browser Web Worker (scan-worker.js): it only needs
//   fetchUpstream(name, url) → {status, body, pages, expiresAt, …}  (see server.js)
//   data(name)  → parsed public/data/{name}.json ('types', 'universe', 'stations')
//   store       → {get(key), put(key, value)} for results that survive restarts

import { HUBS, buyOrderReachesHub, levels, matchSteps } from '../arbitrage.js';

const ESI = 'https://esi.evetech.net/latest/';
export const MIN_PROFIT = 100_000;   // ISK, before tax/caps — drops noise, client filters further
export const MAX_STEPS = 60;         // fill steps kept per candidate
const RETRIES = 3;

const RANGE = { station: 'STATION', solarsystem: 'SOLARSYSTEM', region: 'REGION' };

export const STORE_KEY = 'market-scan';

export function createScanner({ fetchUpstream, data, store, log = console.log }) {
  let status = { state: 'idle', done: 0, total: 0, warnings: [] };
  let result = null;
  let running = null;

  const ready = Promise.resolve(store.get(STORE_KEY))
    .then(r => { if (!r) return; result = r; log(`Market scan: loaded cached result from ${new Date(result.finishedAt).toLocaleString()}`); })
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

  async function scan() {
    await ready;
    const startedAt = Date.now();
    status = { state: 'running', done: 0, total: 0, warnings: [], startedAt };
    // books[hubId]: Map typeId → { a: Map price→volume (asks), b: Map price→volume (bids) }
    const books = Object.fromEntries(HUBS.map(h => [h.id, new Map()]));
    let expiresAt = Infinity;

    const ingest = (hub, body) => {
      for (const o of JSON.parse(body)) {
        const isAsk = !o.is_buy_order && o.location_id === hub.stationId;
        const isBid = o.is_buy_order && buyOrderReachesHub({
          minVolume: o.min_volume, locationId: o.location_id, systemId: o.system_id, regionId: hub.regionId,
          range: RANGE[o.range] || `_${o.range}`,
        }, hub);
        if (!isAsk && !isBid) continue;
        let entry = books[hub.id].get(o.type_id);
        if (!entry) books[hub.id].set(o.type_id, entry = { a: new Map(), b: new Map() });
        const side = isAsk ? entry.a : entry.b;
        side.set(o.price, (side.get(o.price) || 0) + o.volume_remain);
      }
    };
    const noteExpiry = (r) => { if (r.expiresAt) expiresAt = Math.min(expiresAt, r.expiresAt); };

    await Promise.all(HUBS.map(async hub => {
      let first;
      try { first = await fetchPage(hub.regionId, 1); }
      catch (e) { status.warnings.push(`${hub.region}: could not fetch orders (${e.message}) — ${hub.name} excluded`); return; }
      const pages = Number(first.pages) || 1;
      status.total += pages;
      status.done++;
      noteExpiry(first);
      ingest(hub, first.body);
      const rest = [];
      for (let p = 2; p <= pages; p++) {
        rest.push(fetchPage(hub.regionId, p)
          .then(r => { noteExpiry(r); ingest(hub, r.body); })
          .catch(e => status.warnings.push(`${hub.region} page ${p}/${pages} failed (${e.message}) — results for ${hub.name} may be incomplete`))
          .finally(() => { status.done++; }));
      }
      await Promise.all(rest);
    }));

    status.state = 'computing';
    const types = await data('types').catch(() => ({}));
    const typeIds = new Set(HUBS.flatMap(h => [...books[h.id].keys()]));
    const candidates = hubCandidates(books);

    const usedTypes = {};
    for (const c of candidates) usedTypes[c.t] ||= types[c.t] || [`Type ${c.t}`, 0];
    const finishedAt = Date.now();
    result = {
      startedAt, finishedAt,
      expiresAt: Number.isFinite(expiresAt) ? Math.max(expiresAt, finishedAt + 120_000) : finishedAt + 5 * 60_000,
      pages: status.total, warnings: status.warnings, minProfit: MIN_PROFIT,
      candidates, types: usedTypes,
    };
    status = { state: 'done', done: status.total, total: status.total, warnings: status.warnings, startedAt, finishedAt };
    log(`Market scan: ${result.pages} pages, ${typeIds.size} items seen, ${candidates.length} profitable routes in ${((finishedAt - startedAt) / 1000).toFixed(0)}s`);
    await Promise.resolve(store.put(STORE_KEY, result)).catch(e => log(`Market scan: couldn't write cache (${e.message})`));
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
    /** Settles once the scan in progress (if any) has finished and saved its result. */
    idle: () => running || Promise.resolve(),
    async start({ force = false } = {}) {
      await ready;
      if (running) return { started: false, reason: 'running' };
      if (!force && result && result.expiresAt > Date.now()) return { started: false, reason: 'fresh' };
      status = { state: 'running', done: 0, total: 0, warnings: [], startedAt: Date.now() }; // before the first await, so a poll right after start() sees it
      running = scan()
        .catch(e => { status = { ...status, state: 'error', error: e.message }; log(`Market scan failed: ${e.message}`); })
        .finally(() => { running = null; });
      return { started: true };
    },
  };
}

/**
 * Every profitable hub-to-hub haul. books[hubId]: Map typeId → {a: Map price→volume (sell orders at
 * the hub station), b: Map price→volume (buy orders a seller docked there can fill)}.
 * Also used by the universe scan, which builds these books from its own (see universe-scanner.js).
 */
export function hubCandidates(books) {
  const candidates = [];
  const typeIds = new Set(HUBS.flatMap(h => [...(books[h.id]?.keys() || [])]));
  for (const t of typeIds) {
    const perHub = HUBS.map(h => {
      const e = books[h.id]?.get(t);
      return e ? { hub: h, asks: levels(toOrders(e.a), false), bids: levels(toOrders(e.b), true) } : null;
    }).filter(Boolean);
    for (const A of perHub) {
      if (!A.asks.length) continue;
      for (const B of perHub) {
        if (A === B || !B.bids.length || B.bids[0].price <= A.asks[0].price) continue;
        const steps = matchSteps(A.asks, B.bids, 0, MAX_STEPS);
        const profit = steps.reduce((s, [n, buy, sell]) => s + n * (sell - buy), 0);
        if (profit >= MIN_PROFIT) candidates.push({ t, f: A.hub.id, d: B.hub.id, s: steps });
      }
    }
  }
  return candidates;
}

function toOrders(priceMap) {
  return [...priceMap].map(([price, volumeRemain]) => ({ price, volumeRemain }));
}
