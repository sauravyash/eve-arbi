// Pure contract and LP-store valuation — no DOM, no fetch. Shared by contract-scanner.js, the
// Contracts page and node tests.
//
// A public item-exchange contract can do four things at once: you pay `price`, you receive
// `reward`, you receive its included items, and you must hand over its "wanted" items. So
//   profit = value(included items) × (1 − tax) + reward − price − cost(wanted items)
// Included items are valued at one hub, either sold instantly into the buy orders reachable from
// its main station (walking the book, so big stacks don't count at the top price) or relisted at
// the lowest sell order there. Wanted items are costed at the lowest sell order (you'd buy them).

export const BLUEPRINT_CATEGORY = 9;

// Sell `qty` units into bids ([[price, volume]…], best first). Returns ISK received and units filled.
export function walkBids(bids, qty) {
  let isk = 0, filled = 0;
  for (const [price, volume] of bids || []) {
    if (filled >= qty) break;
    const n = Math.min(volume, qty - filled);
    isk += n * price; filled += n;
  }
  return { isk, filled };
}

// Contract items from ESI → compact rows [typeId, quantity, included 1|0, blueprint copy 1|0].
export function compactItems(esiItems) {
  return (esiItems || []).map(i => [i.type_id, i.quantity, i.is_included ? 1 : 0, i.is_blueprint_copy ? 1 : 0]);
}

/**
 * Value compact item rows at one hub.
 * @param {Array<[number, number, 0|1, 0|1]>} items
 * @param {(typeId: number) => ({b?: [number, number][], a?: number|null}|undefined)} bookOf
 *   b = buy orders a seller at the hub station can fill, best first; a = lowest sell order there
 * @returns {{instant: number, relist: number, need: number, unpriced: number, thin: number, lines: number}}
 *   unpriced = lines with no market value at this hub (BPCs, included items with no orders at
 *   all, wanted items with no sell order to buy from); thin = included lines the buy orders can
 *   only partly absorb, so the instant value is understated
 */
export function valueAtHub(items, bookOf) {
  const give = new Map(), want = new Map();
  let unpriced = 0, lines = 0;
  for (const [t, q, inc, bpc] of items) {
    if (bpc) { lines++; unpriced++; continue; } // BPCs have no market
    const m = inc ? give : want;
    if (!m.has(t)) lines++;
    m.set(t, (m.get(t) || 0) + q);
  }
  let instant = 0, relist = 0, need = 0;
  let thin = 0;
  for (const [t, q] of give) {
    const e = bookOf(t);
    const w = walkBids(e?.b, q);
    instant += w.isk;
    // Relist at the lowest sell order; with none listed, fall back to what the buy orders pay.
    relist += e?.a != null ? q * e.a : w.isk;
    if (w.filled === 0 && e?.a == null) unpriced++;
    else if (w.filled < q) thin++;
  }
  for (const [t, q] of want) {
    const a = bookOf(t)?.a;
    if (a == null) unpriced++;
    else need += q * a;
  }
  return { instant, relist, need, unpriced, thin, lines };
}

/**
 * Profit of taking a contract, given its valuation at one hub.
 * @param {{p: number, r: number}} c   p = ISK you pay, r = ISK you receive
 * @param {{instant, relist, need}} v
 * @param {{mode?: 'instant'|'relist', taxRate?: number}} opts
 */
export function contractProfit(c, v, { mode = 'instant', taxRate = 0 } = {}) {
  const value = (mode === 'relist' ? v.relist : v.instant) * (1 - taxRate);
  const cost = c.p + v.need;
  return { value, cost, profit: value + c.r - cost };
}

/**
 * ISK per loyalty point for one LP-store offer.
 * @param {{type_id, quantity, lp_cost, isk_cost, required_items: {type_id, quantity}[]}} offer
 * @param {(typeId) => ({buy: number|null, sell: number|null}|undefined)} priceOf  hub quotes
 * @param {{mode?: 'instant'|'relist', taxRate?: number}} opts
 *   instant sells the product into the best buy order; relist lists it at the lowest sell order.
 *   Required items are always bought at the lowest sell order.
 */
export function lpOfferValue(offer, priceOf, { mode = 'instant', taxRate = 0 } = {}) {
  const p = priceOf(offer.type_id) || {};
  const unit = mode === 'relist' ? (p.sell ?? p.buy) : p.buy;
  let reqCost = 0, reqMissing = 0;
  for (const r of offer.required_items || []) {
    const s = priceOf(r.type_id)?.sell;
    if (s == null) reqMissing++; else reqCost += s * r.quantity;
  }
  if (unit == null) return { revenue: null, reqCost, reqMissing, profit: null, perLp: null };
  const revenue = unit * offer.quantity * (1 - taxRate);
  const profit = revenue - offer.isk_cost - reqCost;
  return { revenue, reqCost, reqMissing, profit, perLp: offer.lp_cost > 0 ? profit / offer.lp_cost : null };
}
