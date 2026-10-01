// Tracked hauls: one item on one pickup → drop-off route, re-priced on its own every 10 minutes
// for an hour, instead of rescanning the whole market. When the hour is up it stops; *Track
// another hour* starts it again. Pure: no DOM, no fetch (the page fetches the orders).

import { levels, matchSteps, summarizeSteps } from './arbitrage.js';
import { rangeCodeOf, REGION } from './ranges.js';

export const CHECK_EVERY = 10 * 60_000;
export const TRACK_FOR = 60 * 60_000;
export const MAX_TRACKED = 25;
const MAX_POINTS = 60;   // price history kept per haul (10 hours of checks)

export const trackKey = (typeId, fromLoc, toLoc) => `${typeId}:${fromLoc}:${toLoc}`;

/**
 * A new tracked haul, due for its first check right away.
 * @param {{typeId, name, vol, from: {loc, sys, regionId?, name, station}, to: {…}}} haul
 */
export function newTracked(haul, now) {
  const end = (e) => ({ loc: e.loc, sys: e.sys, regionId: e.regionId ?? null, name: e.name, station: e.station });
  return {
    key: trackKey(haul.typeId, haul.from.loc, haul.to.loc), typeId: haul.typeId, name: haul.name, vol: haul.vol || 0,
    from: end(haul.from), to: end(haul.to), since: now, until: now + TRACK_FOR, checkedAt: null, points: [], error: null,
  };
}

export const isActive = (t, now) => now < t.until;

/** When the next check is due, or null once the tracking hour is over. */
export function nextCheckAt(t) {
  const at = t.checkedAt == null ? t.since : t.checkedAt + CHECK_EVERY;
  return at < t.until ? at : null;
}

// Missed checks (no page open) don't pile up: one check when you're back, if the hour isn't over.
export function isDue(t, now) {
  const at = nextCheckAt(t);
  return at != null && now >= at && now < t.until;
}

/** Checks still to come in this tracking hour (including one that's due now). */
export function checksLeft(t, now) {
  const at = nextCheckAt(t);
  if (at == null || now >= t.until) return 0;
  return Math.max(0, Math.ceil((t.until - Math.max(at, now)) / CHECK_EVERY));
}

/** Another hour of checks, starting now. History is kept. */
export const resubscribe = (t, now) => ({ ...t, since: now, until: now + TRACK_FOR, checkedAt: null, error: null });

/** Records a check's result (a quote, or an error message). */
export function withCheck(t, now, quote, error = null) {
  const points = quote ? [...t.points, { at: now, ...quote }].slice(-MAX_POINTS) : t.points;
  return { ...t, checkedAt: now, points, error };
}

/**
 * Can a buy order be filled by someone docked at `to`? Same rules as the scans: station, system,
 * N jumps (never across a region border) or the whole region. Bait orders (min quantity) are skipped.
 * @param {(a: number, b: number) => number|null} jumps  shortest-path jumps between systems
 */
export function bidReaches(o, to, jumps) {
  if (o.minVolume > 1) return false;
  if (o.locationId === to.loc) return true;
  const range = rangeCodeOf(o.range);
  if (range < 0) return false;
  if (o.systemId === to.sys) return true;
  if (to.regionId == null || o.regionId !== to.regionId) return false;
  if (range >= REGION) return true;
  if (range === 0) return false;
  const d = jumps?.(o.systemId, to.sys);
  return d != null && d <= range;
}

/**
 * Prices a tracked haul from the item's orders (EVE Tycoon's /v1/market/orders/{typeId}, every region).
 * @returns {{buy, sell, units, profit, cost, volume, margin, depth}} buy/sell are the best prices
 *   (null when there's no order on that side); units/profit are within the cargo and budget limits.
 */
export function quoteTracked(orders, t, { taxRate = 0, maxVolume = Infinity, maxCost = Infinity, jumps } = {}) {
  // A drop-off's region from any order in its system, when it wasn't known at tracking time.
  const to = t.to.regionId != null ? t.to : { ...t.to, regionId: orders.find(o => o.systemId === t.to.sys)?.regionId ?? null };
  const asks = levels(orders.filter(o => !o.isBuyOrder && o.locationId === t.from.loc), false);
  const bids = levels(orders.filter(o => o.isBuyOrder && bidReaches(o, to, jumps)), true);
  const steps = matchSteps(asks, bids, taxRate);
  const sum = summarizeSteps(steps, { taxRate, unitVolume: t.vol, maxVolume, maxCost });
  const depth = steps.reduce((n, s) => n + s[0], 0);
  const buy = asks[0]?.price ?? null, sell = bids[0]?.price ?? null;
  return {
    buy, sell, units: sum.units, profit: sum.profit, cost: sum.cost, volume: sum.volume, depth,
    margin: buy && sell ? (sell * (1 - taxRate) / buy - 1) * 100 : null,
  };
}

/** Keeps a stored list sane: known shape, no duplicates, capped. */
export function cleanTracked(list) {
  const out = [], seen = new Set();
  for (const t of Array.isArray(list) ? list : []) {
    if (!t || !Number.isSafeInteger(t.typeId) || !t.from?.loc || !t.to?.loc || seen.has(t.key)) continue;
    if (!Number.isFinite(t.since) || !Number.isFinite(t.until)) continue;
    seen.add(t.key);
    out.push({ ...t, points: Array.isArray(t.points) ? t.points.slice(-MAX_POINTS) : [] });
    if (out.length >= MAX_TRACKED) break;
  }
  return out;
}
