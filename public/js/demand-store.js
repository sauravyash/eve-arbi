// Market history for the Regional demand page: the last KEEP_DAYS days of ESI's daily history for
// one item in every known-space region, kept so each region is fetched at most once a day.
//
// Shared by server.js (.cache/demand/{typeId}.json.gz) and worker/index.js (R2). Both inject:
//   fetchHistory(regionId, typeId) → {status, rows}   ESI /markets/{region}/history/?type_id=
//   load(typeId) → entry | undefined,  save(typeId, entry)
//   regionIds() → [regionId…]
// Only the server ever calls ESI and writes, so what's stored is always CCP's data.
//
// Stored entry: {v: 1, typeId, regions: {regionId: {at, rows: [[date, average, volume, orders]…]}}}

export const KEEP_DAYS = 90;
// ESI publishes the previous day's history once a day, around 11:05 UTC; 11:30 leaves a margin.
const ROLLOVER_MIN = 11 * 60 + 30;
const DAY = 86_400_000;
const VERSION = 1;
// A type ESI doesn't know: no market anywhere. 400/422 come back for malformed or non-market IDs.
const NO_MARKET = new Set([400, 404, 422]);

/** The most recent daily history update at or before `now`. */
export function lastRollover(now) {
  const midnight = Math.floor(now / DAY) * DAY;
  const today = midnight + ROLLOVER_MIN * 60_000;
  return now >= today ? today : today - DAY;
}

/** ESI history rows → [[date, average, volume, orders]] for the last `keep` days before `now`, oldest first. */
export function compactRows(esiRows, now, keep = KEEP_DAYS) {
  const from = new Date(now - keep * DAY).toISOString().slice(0, 10);
  return (Array.isArray(esiRows) ? esiRows : [])
    .filter(r => r && typeof r.date === 'string' && r.date >= from)
    .map(r => [r.date, Number(r.average) || 0, Number(r.volume) || 0, Number(r.order_count) || 0])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Regions whose stored copy predates the last history update (or that have none). */
export function staleRegions(entry, regionIds, now) {
  const cut = lastRollover(now);
  return regionIds.filter(id => !(entry?.regions?.[id]?.at >= cut));
}

const blank = (typeId) => ({ v: VERSION, typeId, regions: {} });

/** The page's view of an entry: rows per region, when each was fetched, and how many still need fetching. */
export function view(entry, pending = 0) {
  const regions = {}, at = {};
  for (const [id, r] of Object.entries(entry.regions)) { regions[id] = r.rows; at[id] = r.at; }
  return { typeId: entry.typeId, regions, at, pending };
}

/**
 * @param {object} o
 * @param {number} [o.maxFetch]   ESI calls per get() (the Worker's subrequest budget); the rest are `pending`
 * @param {string} [o.probeRegion] fetched first: a type ESI rejects there is rejected before any other call
 */
export function createDemandStore({ fetchHistory, load, save, regionIds, maxFetch = Infinity, concurrency = 6,
  probeRegion = 10000002, now = Date.now }) {
  const inflight = new Map();

  async function refresh(typeId) {
    const t = now();
    const ids = await regionIds();
    const stored = await Promise.resolve(load(typeId)).catch(() => undefined);
    const entry = stored?.v === VERSION ? stored : blank(typeId);
    const stale = staleRegions(entry, ids, t);
    if (!stale.length) return view(entry);

    // The probe goes first so an unknown type costs one ESI error, not one per region.
    const order = stale.includes(probeRegion) ? [probeRegion, ...stale.filter(id => id !== probeRegion)] : stale;
    const todo = order.slice(0, maxFetch);
    let changed = false;
    // A failed call leaves the region stale, so it's still pending and the page asks again.
    const one = async (id) => {
      try {
        const r = await fetchHistory(id, typeId);
        if (r.status === 200 || NO_MARKET.has(r.status)) {
          entry.regions[id] = { at: t, rows: r.status === 200 ? compactRows(r.rows, t) : [] };
          changed = true;
        }
        return r.status;
      } catch { return null; }
    };
    if (todo[0] === probeRegion && !stored) {
      if (NO_MARKET.has(await one(todo.shift()))) { const e = new Error('Unknown item'); e.status = 404; throw e; }
    }
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, async () => {
      while (next < todo.length) await one(todo[next++]);
    }));
    if (changed) await save(typeId, entry);
    return view(entry, staleRegions(entry, ids, t).length);
  }

  return {
    /** Refreshes what's stale (up to maxFetch regions) and returns the item's history. */
    get(typeId) {
      let p = inflight.get(typeId);
      if (!p) {
        p = refresh(typeId).finally(() => inflight.delete(typeId));
        inflight.set(typeId, p);
      }
      return p;
    },
  };
}
