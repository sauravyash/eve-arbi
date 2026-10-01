// Regional demand: which regions buy an item steadily but have little of it listed. Pure: no DOM,
// no fetch. History rows come from demand-store.js ([date, average, volume, orders], oldest first);
// orders are market-merge.js normalized orders.

const DAY = 86_400_000;
export const WINDOW = 30;      // days the demand metrics look at
export const PRICE_DAYS = 7;   // recent days the price is averaged over
const SHORTAGE_DAYS = 7;       // days of stock at which the score's shortage factor halves

const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** The newest day in any region's history (every region shares ESI's daily cut-off). */
export function lastDay(history) {
  let last = null;
  for (const rows of Object.values(history || {})) {
    const d = rows?.at(-1)?.[0];
    if (d && (!last || d > last)) last = d;
  }
  return last;
}

/** `days` daily rows ending on `end`, missing days filled with zero volume: [{date, average, volume, orders}]. */
export function dailySeries(rows, end, days = WINDOW) {
  const byDate = new Map((rows || []).map(r => [r[0], r]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = addDays(end, -i), r = byDate.get(date);
    out.push(r ? { date, average: r[1], volume: r[2], orders: r[3] } : { date, average: null, volume: 0, orders: 0 });
  }
  return out;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0;
};
const vwap = (days) => {
  const v = days.reduce((s, d) => s + d.volume, 0);
  return v ? days.reduce((s, d) => s + d.volume * (d.average || 0), 0) / v : null;
};

/** Demand metrics for one region's history over the WINDOW days ending on `end`. */
export function regionDemand(rows, end, window = WINDOW) {
  const days = dailySeries(rows, end, window);
  const vols = days.map(d => d.volume);
  const mean = vols.reduce((s, v) => s + v, 0) / window;
  const sd = Math.sqrt(vols.reduce((s, v) => s + (v - mean) ** 2, 0) / window);
  return {
    daily: median(vols),
    mean,
    active: days.filter(d => d.volume > 0).length / window,
    swing: mean ? sd / mean : null,
    price: vwap(days.slice(-PRICE_DAYS)) ?? vwap(days),
  };
}

/** Sell orders listed in each region (bait-free, structures optional): Map regionId → {units, orders, lowest}. */
export function regionSupply(orders, { structures = true, isNpc = () => true, includeGhosts = false } = {}) {
  const m = new Map();
  for (const o of orders || []) {
    if (o.isBuyOrder || (o.ghost && !includeGhosts) || (!structures && !isNpc(o.locationId))) continue;
    let s = m.get(o.regionId);
    if (!s) m.set(o.regionId, s = { units: 0, orders: 0, lowest: null });
    s.units += o.volumeRemain;
    s.orders++;
    if (s.lowest == null || o.price < s.lowest) s.lowest = o.price;
  }
  return m;
}

/**
 * One row per region with history: demand, supply, and what importing from the buy hub would earn.
 * @param {object} o
 * @param {object} o.history    {regionId: rows} from /api/demand/{typeId}
 * @param {Map} o.supply        regionSupply()
 * @param {number|null} o.cost  price per unit at the buy hub (its lowest sell order)
 * @param {number} o.taxRate    sales tax, 0–1
 * @param {number} o.brokerRate broker fee for the sell order you list, 0–1
 */
export function analyse({ history, supply, cost, taxRate = 0, brokerRate = 0, window = WINDOW }) {
  const end = lastDay(history);
  if (!end) return [];
  const rows = [];
  for (const [id, h] of Object.entries(history)) {
    const regionId = Number(id);
    const d = regionDemand(h, end, window);
    const s = supply.get(regionId) || { units: 0, orders: 0, lowest: null };
    const margin = d.price != null && cost != null ? d.price * (1 - taxRate - brokerRate) - cost : null;
    const iskDay = margin != null && margin > 0 ? d.daily * margin : 0;
    const daysOfStock = d.daily > 0 ? s.units / d.daily : Infinity;
    const steadiness = d.active / (1 + (d.swing ?? 0));
    rows.push({
      regionId, ...d, stock: s.units, sellOrders: s.orders, lowest: s.lowest, daysOfStock,
      margin, markup: d.price != null && cost ? d.price / cost - 1 : null, iskDay,
      score: iskDay * steadiness / (1 + (Number.isFinite(daysOfStock) ? daysOfStock : 1e9) / SHORTAGE_DAYS),
    });
  }
  return rows;
}

export const RANKS = {
  isk: (a, b) => b.iskDay - a.iskDay || b.daily - a.daily,
  shortage: (a, b) => a.daysOfStock - b.daysOfStock || b.daily - a.daily,
  score: (a, b) => b.score - a.score || b.iskDay - a.iskDay,
};

/** Filtered and sorted rows. `skip` is a Set of regionIds to leave out (the hub regions). */
export function rankRegions(rows, { rank = 'isk', minDaily = 0, minActive = 0, maxDays = Infinity, skip = new Set() } = {}) {
  return rows
    .filter(r => r.daily > 0 && r.daily >= minDaily && r.active >= minActive && r.daysOfStock <= maxDays && !skip.has(r.regionId))
    .sort(RANKS[rank] || RANKS.isk);
}
