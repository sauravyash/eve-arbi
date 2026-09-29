// One route, many items: fill a single hold with the most profitable mix of items that can all
// be bought at one station and sold at another. Pure — no DOM, no fetch.
//
// Each item's order-book walk (fill steps [units, buy, sell], best first) is split into chunks.
// Later chunks of an item earn less and cost more, so taking chunks in order of value per unit of
// the scarce resource (cargo m³, ISK, or a mix) never skips a better chunk of the same item. With
// both cargo and budget limited, a few mixes are tried and the most profitable load wins.

/**
 * @param {object[]} items   [{key, t, name, vol, steps, pools}] — pools: the holds this item may use,
 *                            most specific first (e.g. ['1556', '912', 'cargo'])
 * @param {object} o
 * @param {object} o.pools    {poolId: m³} free room per hold (Infinity allowed)
 * @param {number} [o.taxRate=0]
 * @param {number} [o.maxCost=Infinity]
 * @returns {{profit, cost, volume, items: {key, t, name, vol, units, profit, cost, volume, buy, sell, worstBuy, worstSell, used}[]}}
 */
export function packRoute(items, { pools, taxRate = 0, maxCost = Infinity } = {}) {
  const chunks = [];
  for (const it of items) {
    for (let k = 0; k < it.steps.length; k++) {
      const [n, buy, sell] = it.steps[k];
      const margin = sell * (1 - taxRate) - buy;
      if (margin <= 0) break;
      chunks.push({ it, k, n, buy, sell, margin });
    }
  }
  if (!chunks.length) return { profit: 0, cost: 0, volume: 0, items: [] };

  const room = Object.values(pools).reduce((s, v) => s + v, 0);
  const volBound = Number.isFinite(room), costBound = Number.isFinite(maxCost);
  // Weight on cargo (vs ISK) in the scarce-resource score.
  const alphas = volBound && costBound ? [0, 0.25, 0.5, 0.75, 1] : [volBound ? 1 : 0];
  let best = null;
  for (const a of alphas) {
    const use = (c) => (volBound ? a * (c.it.vol || 0) / room : 0) + (costBound ? (1 - a) * c.buy / maxCost : 0);
    const order = chunks.map(c => ({ c, score: use(c) > 0 ? c.margin / use(c) : Infinity }))
      .sort((x, y) => y.score - x.score);   // stable: an item's equal-score chunks stay in step order
    const load = fill(order.map(o => o.c), pools, maxCost);
    if (!best || load.profit > best.profit) best = load;
  }
  return best;
}

function fill(chunks, pools, maxCost) {
  const free = { ...pools };
  let budget = maxCost;
  const byItem = new Map();
  const next = new Map();   // item → index of the next step it may take (steps are taken in order)
  for (const ch of chunks) {
    const { it } = ch;
    if ((next.get(it) ?? 0) !== ch.k) continue;   // an earlier step of this item didn't fit fully
    let take = Math.min(ch.n, Math.floor(budget / ch.buy + 1e-9));
    if (it.vol > 0) take = Math.min(take, Math.floor(it.pools.reduce((s, p) => s + (free[p] ?? 0), 0) / it.vol + 1e-9));
    if (take <= 0) { next.set(it, -1); continue; }
    next.set(it, take === ch.n ? ch.k + 1 : -1);
    budget -= take * ch.buy;
    let e = byItem.get(it);
    if (!e) byItem.set(it, e = { key: it.key, t: it.t, name: it.name, vol: it.vol, units: 0, profit: 0, cost: 0, volume: 0,
      buy: ch.buy, sell: ch.sell, worstBuy: ch.buy, worstSell: ch.sell, used: {} });
    e.units += take; e.profit += take * ch.margin; e.cost += take * ch.buy;
    e.worstBuy = ch.buy; e.worstSell = ch.sell;
    let need = take * (it.vol || 0);
    e.volume += need;
    for (const p of it.pools) {
      if (need <= 0) break;
      const put = Math.min(need, free[p] ?? 0);
      if (put <= 0) continue;
      free[p] -= put; need -= put;
      e.used[p] = (e.used[p] || 0) + put;
    }
  }
  const items = [...byItem.values()].sort((a, b) => b.profit - a.profit);
  return {
    items,
    profit: items.reduce((s, e) => s + e.profit, 0),
    cost: items.reduce((s, e) => s + e.cost, 0),
    volume: items.reduce((s, e) => s + e.volume, 0),
  };
}

/** EVE's multibuy format: one "name quantity" line per item. */
export const multibuyText = (items) => items.map(e => `${e.name} ${e.units}`).join('\n');
