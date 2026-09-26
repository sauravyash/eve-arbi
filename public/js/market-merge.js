// Pure multi-source market collation — no DOM, no fetch. Shared by the market watch page and node tests.
//
// Every source describes the same underlying market, so the job is to (1) put everything in one shape,
// (2) collapse duplicates, and (3) say how much the sources agree:
//   - Orders: ESI and EVE Tycoon both expose raw orders with CCP's order_id, so they're merged by ID.
//     The copy with the later `issued` (or, if equal, the lower remaining volume, since volume only
//     falls) wins. ESI is live, so an NPC-station order that only Tycoon still lists has almost
//     certainly been filled or cancelled; it's flagged as a ghost and hidden by default.
//   - History: ESI and Tycoon daily rows are merged by UTC date; ESI wins where both have a day.
//   - Aggregates (Fuzzwork, Goonmetrics, Tycoon stats) can't be deduped at order level, so they're
//     shown side by side and compared against the merged book.

import { HUBS, buyOrderReachesHub, levels } from './arbitrage.js';

const ESI_RANGE = { station: 'STATION', solarsystem: 'SOLARSYSTEM', region: 'REGION' };

// NPC stations are 60,000,000–63,999,999; player structures have 13-digit IDs.
export const isNpcStation = (locationId) => locationId >= 60_000_000 && locationId < 64_000_000;

export function normalizeEsiOrder(o, regionId) {
  return {
    orderId: o.order_id, typeId: o.type_id, isBuyOrder: o.is_buy_order, price: o.price,
    volumeRemain: o.volume_remain, volumeTotal: o.volume_total, minVolume: o.min_volume,
    locationId: o.location_id, systemId: o.system_id, regionId,
    range: ESI_RANGE[o.range] || `_${o.range}`, issued: Date.parse(o.issued), duration: o.duration,
  };
}

export function normalizeTycoonOrder(o) {
  return {
    orderId: o.orderId, typeId: o.typeId, isBuyOrder: o.isBuyOrder, price: o.price,
    volumeRemain: o.volumeRemain, volumeTotal: o.volumeTotal, minVolume: o.minVolume,
    locationId: o.locationId, systemId: o.systemId, regionId: o.regionId,
    range: o.range, issued: o.issued, duration: o.duration,
  };
}

const newer = (a, b) => (a.issued !== b.issued ? (a.issued > b.issued ? a : b) : (a.volumeRemain <= b.volumeRemain ? a : b));

/**
 * Merge order lists from several sources by order ID.
 * @param {Array<{id: string, orders: object[], live?: boolean, regions?: number[]}>} sources
 *   `live` sources are treated as the truth for the NPC-station orders of the `regions` they fetched.
 * @returns {{orders: object[], stats: object}} each order gets `sources: string[]` and `ghost: boolean`
 */
export function mergeOrders(sources) {
  const byId = new Map();
  const stats = { raw: 0, unique: 0, duplicates: 0, conflicts: 0, ghosts: 0, bySource: {}, only: {} };
  for (const src of sources) {
    stats.bySource[src.id] = src.orders.length;
    stats.only[src.id] = 0;
    for (const o of src.orders) {
      stats.raw++;
      const prev = byId.get(o.orderId);
      if (!prev) { byId.set(o.orderId, { ...o, sources: [src.id] }); continue; }
      stats.duplicates++;
      if (prev.sources.includes(src.id)) continue; // same order twice within one source (page overlap)
      if (prev.price !== o.price || prev.volumeRemain !== o.volumeRemain) stats.conflicts++;
      const win = newer(prev, o);
      byId.set(o.orderId, { ...win, sources: [...prev.sources, src.id] });
    }
  }
  const live = sources.filter(s => s.live).map(s => ({ id: s.id, regions: new Set(s.regions || []) }));
  const orders = [...byId.values()];
  for (const o of orders) {
    if (o.sources.length === 1) stats.only[o.sources[0]]++;
    o.ghost = isNpcStation(o.locationId)
      && live.some(l => l.regions.has(o.regionId) && !o.sources.includes(l.id));
    if (o.ghost) stats.ghosts++;
  }
  stats.unique = orders.length;
  return { orders, stats };
}

/**
 * The order book as seen by someone docked at a hub's main station.
 * asks = sell orders in the station; bids = buy orders they can sell into from there.
 */
export function hubBook(orders, hub, { includeGhosts = false } = {}) {
  const live = includeGhosts ? orders : orders.filter(o => !o.ghost);
  const askOrders = live.filter(o => !o.isBuyOrder && o.locationId === hub.stationId).sort((a, b) => a.price - b.price);
  const bidOrders = live.filter(o => o.isBuyOrder && buyOrderReachesHub(o, hub)).sort((a, b) => b.price - a.price);
  return { askOrders, bidOrders, asks: levels(askOrders, false), bids: levels(bidOrders, true) };
}

export function bookQuote(book) {
  const sum = (xs) => xs.reduce((s, o) => s + o.volumeRemain, 0);
  return {
    sell: book.askOrders[0]?.price ?? null, buy: book.bidOrders[0]?.price ?? null,
    sellVolume: sum(book.askOrders), buyVolume: sum(book.bidOrders),
    sellOrders: book.askOrders.length, buyOrders: book.bidOrders.length,
  };
}

// Average price of the cheapest `pct` of sell volume (or dearest buy volume): what a
// meaningful-size trade actually pays, and much harder to game than the top order.
export function volumeWeightedTop(orders, pct = 0.05) {
  const total = orders.reduce((s, o) => s + o.volumeRemain, 0);
  if (!total) return null;
  let want = Math.max(1, total * pct), isk = 0, got = 0;
  for (const o of orders) {
    const n = Math.min(o.volumeRemain, want - got);
    isk += n * o.price; got += n;
    if (got >= want) break;
  }
  return isk / got;
}

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Merge daily history rows. ESI rows win on shared days; Tycoon extends further back.
 * A shared day whose averages differ by more than 0.5% counts as a conflict.
 */
export function mergeHistory(esiRows = [], tycoonRows = []) {
  const days = new Map();
  for (const r of tycoonRows) {
    days.set(utcDay(r.date), { date: utcDay(r.date), average: r.average, highest: r.highest, lowest: r.lowest,
      volume: r.volume, orderCount: r.orderCount, src: 'tycoon' });
  }
  let shared = 0, conflicts = 0;
  for (const r of esiRows) {
    const prev = days.get(r.date);
    if (prev) {
      shared++;
      if (Math.abs(prev.average - r.average) > 0.005 * r.average) conflicts++;
    }
    days.set(r.date, { date: r.date, average: r.average, highest: r.highest, lowest: r.lowest,
      volume: r.volume, orderCount: r.order_count, src: prev ? 'both' : 'esi' });
  }
  const list = [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  return {
    days: list,
    stats: { esi: esiRows.length, tycoon: tycoonRows.length, shared, conflicts,
             onlyTycoon: list.filter(d => d.src === 'tycoon').length, total: list.length },
  };
}

// % change of the daily average between the last day and `n` days before it.
export function historyChange(days, n = 1) {
  if (days.length <= n) return null;
  const last = days[days.length - 1].average, prev = days[days.length - 1 - n].average;
  return prev ? (last - prev) / prev * 100 : null;
}

export function parseFuzzwork(json) {
  const out = {};
  const f = (v) => (v == null ? null : Number(v));
  for (const [id, a] of Object.entries(json || {})) {
    const n = (side) => Number(a[side]?.orderCount) || 0;
    out[id] = {
      buy: n('buy') ? f(a.buy.max) : null, sell: n('sell') ? f(a.sell.min) : null,
      buyVolume: f(a.buy?.volume), sellVolume: f(a.sell?.volume),
      buyOrders: n('buy'), sellOrders: n('sell'),
      buyPercentile: n('buy') ? f(a.buy.percentile) : null, sellPercentile: n('sell') ? f(a.sell.percentile) : null,
    };
  }
  return out;
}

// Goonmetrics answers in XML; a regex keeps this usable in node without a DOM parser.
export function parseGoonXml(xml) {
  const out = {};
  const pick = (block, rx) => { const m = block.match(rx); return m ? Number(m[1]) : null; };
  for (const m of String(xml).matchAll(/<type id="(\d+)">([\s\S]*?)<\/type>/g)) {
    const b = m[2];
    const buy = b.match(/<buy>([\s\S]*?)<\/buy>/)?.[1] || '';
    const sell = b.match(/<sell>([\s\S]*?)<\/sell>/)?.[1] || '';
    out[m[1]] = {
      updated: Date.parse(b.match(/<updated>([^<]+)<\/updated>/)?.[1] || '') || null,
      weeklyMovement: pick(b, /<weekly_movement>([^<]+)</),
      buy: pick(buy, /<max>([^<]+)</) || null, buyVolume: pick(buy, /<listed>([^<]+)</),
      sell: pick(sell, /<min>([^<]+)</) || null, sellVolume: pick(sell, /<listed>([^<]+)</),
    };
  }
  return out;
}

/**
 * How well a set of independent quotes agree.
 * @param {Array<{id: string, value: number|null}>} quotes
 * @returns {{median, n, spreadPct, outliers: string[]}} outliers are more than `tolPct` off the median
 */
export function consensus(quotes, tolPct = 2) {
  const vals = quotes.filter(q => q.value != null && Number.isFinite(q.value) && q.value > 0);
  if (!vals.length) return { median: null, n: 0, spreadPct: null, outliers: [] };
  const s = vals.map(q => q.value).sort((a, b) => a - b);
  const mid = s.length >> 1;
  const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return {
    median, n: vals.length,
    spreadPct: (s[s.length - 1] - s[0]) / median * 100,
    outliers: vals.filter(q => Math.abs(q.value - median) / median * 100 > tolPct).map(q => q.id),
  };
}

// ---------------------------------------------------------------------------
// Beyond the hubs: every station's book, and station-to-station hauls
// ---------------------------------------------------------------------------

// The five hub systems plus Perimeter (the Tranquility Trading Tower next to Jita): the markets
// everyone already watches, where spreads are thinnest.
export const MAJOR_HUB_SYSTEMS = new Set([...HUBS.map(h => h.id), 30000144]);

/**
 * Group the merged book by location. Only sell orders at a station and buy orders placed at
 * that station are counted, so each entry is what you can do while docked there without
 * relying on buy-order ranges.
 * @returns {Map<number, {locationId, systemId, regionId, asks, bids, bestAsk, bestBid, askVolume, bidVolume}>}
 */
export function stationQuotes(orders, { includeGhosts = false } = {}) {
  const m = new Map();
  for (const o of orders) {
    if (o.ghost && !includeGhosts) continue;
    if (o.isBuyOrder && o.minVolume > 1) continue; // bait orders
    let q = m.get(o.locationId);
    if (!q) m.set(o.locationId, q = { locationId: o.locationId, systemId: o.systemId, regionId: o.regionId, asks: [], bids: [] });
    (o.isBuyOrder ? q.bids : q.asks).push(o);
  }
  for (const q of m.values()) {
    q.asks.sort((a, b) => a.price - b.price);
    q.bids.sort((a, b) => b.price - a.price);
    q.bestAsk = q.asks[0]?.price ?? null;
    q.bestBid = q.bids[0]?.price ?? null;
    q.askVolume = q.asks.reduce((s, o) => s + o.volumeRemain, 0);
    q.bidVolume = q.bids.reduce((s, o) => s + o.volumeRemain, 0);
  }
  return m;
}

// --- parsers for the community APIs ------------------------------------------------

// Adam4EVE /v1/market_prices + /v1/market_percentiles (region level; strings → numbers).
export function parseAdam(prices = {}, percentiles = {}) {
  const out = {};
  const n = (v) => (v == null || v === '' ? null : Number(v));
  for (const id of new Set([...Object.keys(prices || {}), ...Object.keys(percentiles || {})])) {
    const p = prices?.[id] || {}, q = percentiles?.[id] || {};
    out[id] = {
      sell: n(p.sell_price) || null, buy: n(p.buy_price) || null,
      sellVolume: n(p.sell_volume), buyVolume: n(p.buy_volume),
      sellPct: n(q.percentile_sell) || null, buyPct: n(q.percentile_buy) || null,
      at: Date.parse(`${(p.lupdate || q.lupdate || '').replace(' ', 'T')}Z`) || null,
    };
  }
  return out;
}

// Evepraisal /item/{typeId}.json → { jita: {...}, amarr: {...}, universe: {...}, … }
export function parseEvepraisal(json) {
  const out = {};
  for (const s of json?.summaries || []) {
    const { buy = {}, sell = {} } = s.prices || {};
    out[s.market_name] = {
      sell: sell.order_count ? sell.min : null, buy: buy.order_count ? buy.max : null,
      sellVolume: sell.volume ?? null, buyVolume: buy.volume ?? null,
      sellOrders: sell.order_count ?? 0, buyOrders: buy.order_count ?? 0,
      at: Date.parse(s.prices?.updated) || null,
    };
  }
  return out;
}

// zKillboard /prices/{typeId}/ → daily valuation series (ISK), oldest first.
export function parseZkill(json) {
  const days = Object.entries(json || {})
    .filter(([k, v]) => /^\d{4}-\d{2}-\d{2}$/.test(k) && Number(v) > 0)
    .map(([date, v]) => ({ date, price: Number(v) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const current = Number(json?.currentPrice);
  return { days, current: Number.isFinite(current) && current > 0 ? current : days.at(-1)?.price ?? null };
}
