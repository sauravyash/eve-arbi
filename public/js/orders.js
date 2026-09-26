// Your market orders vs the competition — pure, no DOM, no fetch.
//
// Sell order: undercut when another seller at the same station is cheaper (buyers there see the
// lowest price first). Buy order: outbid when a higher buy order can also be filled by someone
// selling at your station (ranges count: same station, same system, N jumps, or the region).
// Your own and your corporation's orders are never counted as competition.

import { rangeCodeOf } from './ranges.js';

const ESI_RANGE = { station: 'STATION', solarsystem: 'SOLARSYSTEM', region: 'REGION' };

// ESI /characters/{id}/orders/ and /corporations/{id}/orders/ → the shape the rest of the app uses.
// is_buy_order is omitted for sell orders; system_id is not included at all.
export function normalizeMyOrder(o, systemOf = () => null) {
  return {
    orderId: o.order_id, typeId: o.type_id, isBuyOrder: !!o.is_buy_order, price: o.price,
    volumeRemain: o.volume_remain, volumeTotal: o.volume_total, minVolume: o.min_volume ?? 1,
    locationId: o.location_id, systemId: systemOf(o.location_id), regionId: o.region_id,
    range: ESI_RANGE[o.range] || `_${o.range}`, issued: Date.parse(o.issued), duration: o.duration,
    escrow: o.escrow ?? 0, owner: o.owner || 'character',
  };
}

/**
 * Where one of your orders stands.
 * @param {object} mine            normalised order (normalizeMyOrder)
 * @param {object[]} market        normalised orders for the same item (market-merge shape)
 * @param {object} o
 * @param {Set<number>} o.ownIds   your and your corporation's order IDs
 * @param {object|null} o.ctx      ranges.js context, for buy-order reach; null = same station only
 * @returns {{status: 'best'|'undercut'|'outbid'|'alone', best: number|null, rival: object|null, diff: number|null, pct: number|null, rivals: number}}
 */
export function orderStanding(mine, market, { ownIds = new Set(), ctx = null } = {}) {
  const rivals = market.filter(x => !ownIds.has(x.orderId) && x.isBuyOrder === mine.isBuyOrder && !(x.isBuyOrder && x.minVolume > 1));
  let pool;
  if (!mine.isBuyOrder) pool = rivals.filter(x => x.locationId === mine.locationId);
  else {
    pool = rivals.filter(x => {
      if (x.locationId === mine.locationId) return true;
      if (!ctx || mine.systemId == null) return false;
      return ctx.reaches({ l: x.locationId, s: x.systemId, r: rangeCodeOf(x.range), g: x.regionId }, mine.locationId, mine.systemId);
    });
  }
  if (!pool.length) return { status: 'alone', best: null, rival: null, diff: null, pct: null, rivals: 0 };
  const rival = pool.reduce((a, b) => (mine.isBuyOrder ? (b.price > a.price ? b : a) : (b.price < a.price ? b : a)));
  const beaten = mine.isBuyOrder ? rival.price > mine.price : rival.price < mine.price;
  const diff = beaten ? Math.abs(rival.price - mine.price) : null;
  return {
    status: beaten ? (mine.isBuyOrder ? 'outbid' : 'undercut') : 'best',
    best: rival.price, rival, diff, pct: diff != null ? diff / mine.price * 100 : null, rivals: pool.length,
  };
}

// When an order runs out: issued + duration days.
export const expiresAt = (o) => o.issued + o.duration * 86_400_000;
