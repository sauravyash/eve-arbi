// Pure arbitrage logic — no DOM, no fetch. Shared by the browser app and node tests.

// IDs verified against ESI /universe/systems, /constellations, /regions, /stations.
export const HUBS = [
  { id: 30000142, name: 'Jita',    region: 'The Forge',   regionId: 10000002, stationId: 60003760, station: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant' },
  { id: 30002187, name: 'Amarr',   region: 'Domain',      regionId: 10000043, stationId: 60008494, station: 'Amarr VIII (Oris) - Emperor Family Academy' },
  { id: 30002659, name: 'Dodixie', region: 'Sinq Laison', regionId: 10000032, stationId: 60011866, station: 'Dodixie IX - Moon 20 - Federation Navy Assembly Plant' },
  { id: 30002510, name: 'Rens',    region: 'Heimatar',    regionId: 10000030, stationId: 60004588, station: 'Rens VI - Moon 8 - Brutor Tribe Treasury' },
  { id: 30002053, name: 'Hek',     region: 'Metropolis',  regionId: 10000042, stationId: 60005686, station: 'Hek VIII - Moon 12 - Boundless Creation Factory' },
];

// EVE's base sales tax. The Accounting skill cuts it by 11% a level (3.375% at level V); every
// page's Sales tax % starts here and can be set to your own rate.
export const DEFAULT_TAX_PCT = 7.5;

export const pairKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

// Can a buy order be filled by someone standing in the hub station?
// Orders demanding a minimum quantity are skipped: they're a classic bait/scam pattern
// and can't be filled with a partial haul anyway.
export function buyOrderReachesHub(o, hub) {
  if (o.minVolume > 1) return false;
  if (o.locationId === hub.stationId) return true;
  if (o.range === 'STATION') return false;
  if (o.systemId === hub.id) return true; // SOLARSYSTEM or any _N range from inside the system
  return o.range === 'REGION' && o.regionId === hub.regionId;
}

// Collapse orders into price levels: [{price, volume}] sorted best-first.
export function levels(orders, descending) {
  const m = new Map();
  for (const o of orders) m.set(o.price, (m.get(o.price) || 0) + o.volumeRemain);
  return [...m].map(([price, volume]) => ({ price, volume }))
    .sort((a, b) => (descending ? b.price - a.price : a.price - b.price));
}

// From a Tycoon /v1/market/orders/{typeId} payload, build per-hub order books.
// asks = sell orders at the hub station (what you buy from).
// bids = buy orders you can sell into while docked at the hub station.
export function extractHubBooks(payload, hubs = HUBS) {
  const books = {};
  for (const hub of hubs) {
    const orders = payload.orders || [];
    const asks = orders.filter(o => !o.isBuyOrder && o.locationId === hub.stationId);
    const bids = orders.filter(o => o.isBuyOrder && buyOrderReachesHub(o, hub));
    books[hub.id] = { asks: levels(asks, false), bids: levels(bids, true) };
  }
  return books;
}

// Walk A's asks upward against B's bids downward while each unit is still profitable.
// Returns the fills as [units, buyPrice, sellPrice] steps, best margin first.
export function matchSteps(asks, bids, taxRate = 0, maxSteps = Infinity) {
  let i = 0, j = 0, aLeft = asks[0]?.volume, bLeft = bids[0]?.volume;
  const steps = [];
  while (i < asks.length && j < bids.length && steps.length < maxSteps) {
    if (bids[j].price * (1 - taxRate) - asks[i].price <= 0) break;
    const n = Math.min(aLeft, bLeft);
    steps.push([n, asks[i].price, bids[j].price]);
    aLeft -= n; bLeft -= n;
    if (aLeft === 0) aLeft = asks[++i]?.volume;
    if (bLeft === 0) bLeft = bids[++j]?.volume;
  }
  return steps;
}

export function matchDepth(asks, bids, taxRate = 0) {
  return summarizeSteps(matchSteps(asks, bids, taxRate), { taxRate });
}

/**
 * Apply tax and hauling limits to fill steps (margins only shrink along the steps, so we can
 * stop at the first unprofitable one).
 * @returns {{units, profit, cost, volume, buy, sell, worstBuy, worstSell}}
 */
export function summarizeSteps(steps, { taxRate = 0, unitVolume = 0, maxVolume = Infinity, maxCost = Infinity } = {}) {
  let units = 0, profit = 0, cost = 0;
  for (const [n, buy, sell] of steps) {
    const margin = sell * (1 - taxRate) - buy;
    if (margin <= 0) break;
    let take = n;
    if (unitVolume > 0) take = Math.min(take, Math.floor((maxVolume - units * unitVolume) / unitVolume + 1e-9));
    take = Math.min(take, Math.floor((maxCost - cost) / buy + 1e-9));
    if (take <= 0) break;
    units += take;
    profit += take * margin;
    cost += take * buy;
    if (take < n) break;
  }
  const first = steps[0], last = steps[Math.max(0, stepsUsed(steps, units) - 1)];
  return {
    units, profit, cost, volume: units * unitVolume,
    buy: first?.[1] ?? null, sell: first?.[2] ?? null,
    worstBuy: units ? last[1] : null, worstSell: units ? last[2] : null,
  };
}

function stepsUsed(steps, units) {
  let k = 0, acc = 0;
  while (k < steps.length && acc < units) acc += steps[k++][0];
  return k;
}

/**
 * Compute every directed hub→hub route for one item.
 * @param {object} p
 * @param {object} p.books      {hubId: {asks, bids}} or null when market data is unavailable
 * @param {object} p.overrides  {hubId: {buy?: number, sell?: number}}  buy = price paid at hub, sell = price received
 * @param {function} p.jumps    (fromId, toId) => number|null
 * @param {'instant'|'relist'} p.sellMode  instant = dump into buy orders at B; relist = match lowest sell at B
 * @param {number} p.taxRate    fraction deducted from sale revenue
 */
export function computeRoutes({ item, books, overrides = {}, jumps, sellMode = 'instant', taxRate = 0, hubs = HUBS }) {
  const routes = [];
  for (const from of hubs) {
    for (const to of hubs) {
      if (from.id === to.id) continue;
      const bookA = books?.[from.id], bookB = books?.[to.id];
      const oA = overrides[from.id] || {}, oB = overrides[to.id] || {};

      const liveBuy = bookA?.asks[0]?.price;
      const liveSell = sellMode === 'instant' ? bookB?.bids[0]?.price : bookB?.asks[0]?.price;
      const buy = num(oA.buy) ?? liveBuy ?? null;
      const sell = num(oB.sell) ?? liveSell ?? null;
      const overridden = num(oA.buy) != null || num(oB.sell) != null;
      const j = jumps(from.id, to.id);

      const r = { item, from, to, buy, sell, jumps: j, overridden, spread: null, iskPerJump: null,
                  units: null, depthProfit: null, depthPerJump: null, status: 'ok' };

      if (buy == null || sell == null) {
        // Books loaded but a side is empty → no market; no books at all → unknown.
        r.status = books ? 'nomarket' : 'unknown';
      } else {
        r.spread = sell * (1 - taxRate) - buy;
        if (sellMode === 'instant' && !overridden && bookA && bookB) {
          const d = matchDepth(bookA.asks, bookB.bids, taxRate);
          r.units = d.units; r.depthProfit = d.profit;
        }
        if (j == null) r.status = 'unknown';
        else {
          r.iskPerJump = r.spread / j;
          if (r.depthProfit != null) r.depthPerJump = r.depthProfit / j;
        }
      }
      routes.push(r);
    }
  }
  return routes;
}

function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function formatIsk(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v), sign = v < 0 ? '−' : '';
  const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
  for (const [n, s] of units) if (abs >= n) return `${sign}${(abs / n).toFixed(digits)}${s}`;
  return `${sign}${abs.toFixed(abs < 100 ? 2 : 0)}`;
}
