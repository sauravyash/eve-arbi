// Corp buyback maths for the mining page: what a load is worth at Jita 4-4 (buy, sell or the split
// between them), what the corporation pays at its buyback rate, and the details of the in-game
// item exchange contract that hands the load over. Pure: no DOM, no fetch.

export const BASES = { buy: 'Jita buy', split: 'Jita split', sell: 'Jita sell' };

// Contract expiration choices in the game's Create Contract window (days).
export const EXPIRATIONS = [[1, '1 Day'], [3, '3 Days'], [7, '1 Week'], [14, '2 Weeks'], [28, '4 Weeks']];

/**
 * Unit price on a basis. Split is halfway between the best buy and the best sell order; with only
 * one side on the market it falls back to that side.
 * @param {{buy: number|null, sell: number|null}|null|undefined} p
 * @param {'buy'|'split'|'sell'} basis
 */
export function unitPrice(p, basis) {
  if (!p) return null;
  const { buy, sell } = p;
  if (basis === 'buy') return buy ?? null;
  if (basis === 'sell') return sell ?? null;
  if (buy != null && sell != null) return (buy + sell) / 2;
  return buy ?? sell ?? null;
}

/**
 * Values a list of items.
 * @param {{typeId: number, qty: number, volume?: number}[]} items
 * @param {Record<number, {buy, sell}|null>} prices   Jita 4-4 best buy / sell per type
 * @param {{basis?: string, rate?: number}} o         rate: buyback %, 0–100+
 * @returns {{lines, buy, split, sell, value, payout, m3, missing: number[]}}
 *   lines: {typeId, qty, m3, buy, sell, split, unit, value, payout}; totals are qty × unit price.
 */
export function appraise(items, prices, { basis = 'split', rate = 100 } = {}) {
  const k = (Number(rate) || 0) / 100;
  const tot = { buy: 0, split: 0, sell: 0, value: 0, payout: 0, m3: 0 };
  const missing = [];
  const lines = items.filter(it => it.qty > 0).map(it => {
    const p = prices[it.typeId];
    const u = { buy: unitPrice(p, 'buy'), split: unitPrice(p, 'split'), sell: unitPrice(p, 'sell') };
    const unit = unitPrice(p, basis);
    const m3 = it.qty * (it.volume || 0);
    const value = unit == null ? 0 : unit * it.qty;
    for (const b of ['buy', 'split', 'sell']) tot[b] += (u[b] ?? 0) * it.qty;
    tot.value += value; tot.m3 += m3;
    if (unit == null && p !== undefined) missing.push(it.typeId);
    return { typeId: it.typeId, qty: it.qty, m3, ...u, unit, value, payout: value * k };
  });
  tot.payout = tot.value * k;
  return { lines, ...tot, missing };
}

/**
 * Contract broker's fee: 10,000 ISK for private and corporation item exchanges; public ones pay
 * 0.4% of the price, at least 10,000 and at most 10,000,000 ISK.
 */
export function brokerFee(availability, price = 0) {
  if (availability !== 'public') return 10_000;
  return Math.min(10_000_000, Math.max(10_000, (Number(price) || 0) * 0.004));
}

// "2026.10.28 12:40": EVE time (UTC), as the contract window shows it.
export function eveDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// ISK the way the game writes it in contracts: "1,234,567 ISK", or "1,234,567.50 ISK" with cents.
export function contractIsk(v) {
  const n = Math.round((Number(v) || 0) * 100) / 100;
  const whole = Number.isInteger(n);
  return `${n.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })} ISK`;
}

// What to type in "I will receive": whole ISK, rounded down so the corp never pays over the rate.
export const receiveAmount = (payout) => Math.max(0, Math.floor(Number(payout) || 0));

/**
 * Items grouped by where they are: a contract can only hand over items from one station.
 * Items without a known location share one group (key 0).
 * @param {{locationId?: number}[]} items
 * @returns {Map<number, object[]>}
 */
export function byLocation(items) {
  const out = new Map();
  for (const it of items) {
    const l = it.locationId || 0;
    (out.get(l) || out.set(l, []).get(l)).push(it);
  }
  return out;
}

/** "Veldspar\t12345" lines: pastes back into EVE's multibuy and into this page, Janice and others. */
export const itemsText = (lines, name) => lines.map(l => `${name(l.typeId)}\t${l.qty}`).join('\n');

/** The contract window's "Items For Sale" list: "Veldspar x 12,345". */
export const contractItems = (lines, name) => lines.map(l => `${name(l.typeId)} x ${l.qty.toLocaleString('en-US')}`);

/** A plain-text appraisal to post in corp chat or a contract description. */
export function summaryText(a, { name, basis, rate, corp }) {
  const isk = (v) => contractIsk(v);
  return [
    `Buyback${corp ? ` for ${corp}` : ''}: ${rate}% of ${BASES[basis]}`,
    ...a.lines.map(l => `${name(l.typeId)} x ${l.qty.toLocaleString('en-US')} = ${isk(l.value)}`),
    `Volume: ${Math.round(a.m3).toLocaleString('en-US')} m3`,
    `${BASES[basis]}: ${isk(a.value)}`,
    `Payout (${rate}%): ${isk(receiveAmount(a.payout))}`,
  ].join('\n');
}

/**
 * Ores, ice, gas and the like that you own, from /api/me/assets items and types.json
 * (index 4 = mining kind).
 * @returns {{typeId, qty, locationId, locationType}[]}
 */
export function harvestable(assetItems, types) {
  return (assetItems || []).filter(a => typeof types?.[a.typeId]?.[4] === 'string' && a.qty > 0);
}

/**
 * Types in your mining ledger with what you mined of each over the ledger's 30 days, most first.
 * @param {{typeId, qty}[]} ledger
 */
export function minedTypes(ledger) {
  const sum = new Map();
  for (const r of ledger || []) sum.set(r.typeId, (sum.get(r.typeId) || 0) + (r.qty || 0));
  return [...sum].map(([typeId, qty]) => ({ typeId, qty })).sort((a, b) => b.qty - a.qty);
}
