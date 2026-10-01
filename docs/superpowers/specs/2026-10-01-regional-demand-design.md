# Regional demand: steady demand, thin supply

## Goal

For one item, show which regions buy it steadily but have little of it listed, so a trader can
import it (buy at a hub, haul, list sell orders there). Ranking first; click a region to drill in.

## Data

**Demand (history).** `GET /api/demand/{typeId}` returns the last 90 days of ESI market history for
every known-space region: `{typeId, regions: {regionId: [[date, average, volume, orders], …]}, at: {regionId: ms}, pending}`.

- Stored per item, one gzipped JSON file: `.cache/demand/{typeId}.json.gz` locally, R2 bucket
  `HISTORY` (key `demand/{typeId}.json.gz`) on Cloudflare.
- A region's copy is stale once ESI's daily history update has passed (11:30 UTC is used, with
  margin) since it was fetched. Only stale regions are re-fetched; empty regions are stored as `[]`.
- Only the server/Worker calls ESI, so the store only ever holds CCP data.
- A typeId ESI doesn't know (404 on the first region) is rejected before any other call, so bogus
  IDs can't burn ESI's error budget.
- The Worker fetches at most 12 regions per request (50-subrequest limit, 10 ms CPU on the free
  plan) and answers with `pending > 0`; the page asks again until it's 0. The local server fetches
  all regions at once.
- Shared logic (staleness, compaction, merge, fetch loop) lives in `public/js/demand-store.js`, used
  by both `server.js` and `worker/index.js`.

**Supply and prices.** EVE Tycoon's per-item orders (`/api/tycoon/v1/market/orders/{typeId}`, one
call, every region incl. structures), via the existing proxy. The buy hub's price is its station's
lowest sell order.

## Analysis (`public/js/demand.js`, pure, tested)

Per region, over a 30-day window ending at the newest day in the data (missing days count as 0):

| Metric | Definition |
|---|---|
| Daily volume | median units traded per day |
| Active days | share of days with any trade |
| Swing | coefficient of variation of daily volume |
| Price | volume-weighted average over the last 7 days (30 if no trades in 7) |
| Stock | units in sell orders in the region now (structures optional) |
| Days of stock | stock ÷ daily volume (∞ when nothing trades) |
| Margin/unit | price × (1 − sales tax − broker fee) − buy-hub price |
| ISK/day | daily volume × margin (0 if margin ≤ 0); an upper bound if you supplied it all |
| Score | ISK/day × active days ÷ (1 + swing) ÷ (1 + days of stock ÷ 7) |

**Rank by:** ISK/day (default), shortage (fewest days of stock), score.
**Filters:** min daily volume, min active days %, max days of stock, skip hub regions (default on).

## Page (`regional-demand.html`, Market watch → *Regional demand*, key 4)

- Controls: item (name search over `types.json`), buy at (hub), home system, route, sales tax,
  broker fee, filters, player structures.
- Ranking table: region, jumps from home (nearest system in the region), daily volume, active days,
  stock, days of stock, price, markup vs hub, ISK/day, score.
- Click a region: 90-day chart (volume bars, average price line), KPIs, and its stations selling the
  item (units, lowest ask, best bid placed there, jumps from home).
- Settings mirrored in the URL (`url-state.js`), saved in `localStorage`; the item is `?type=`.

## Out of scope

Discovering items across the whole market (needs every item's history); ghost-order filtering
for supply (needs 67 ESI order calls per item).
