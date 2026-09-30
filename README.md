# EVE Hub Arbitrage

A local web app that shows live hub-to-hub hauling arbitrage between Jita, Amarr, Dodixie,
Rens and Hek on a star map of New Eden. It can scan the whole market to rank the best items to
haul, and keeps a sortable route table for your watchlist.

It is read-only. It uses public market data, never touches the EVE client and places no orders.
Signing in with EVE is optional; it only lets the dashboards follow your character's location
(see [Signing in](#signing-in)).

## Run

Requires Node 18+ and has no dependencies.

```bash
npm start
```

Open http://localhost:8000. Set `PORT` to use a different port.

On first start the server builds three static data files from Fuzzwork's mirror of CCP's Static
Data Export (about 23 MB downloaded, once):
- `public/data/universe.json`: systems and gates for the star map (about 335 KB)
- `public/data/types.json`: item names, packaged volumes, categories and groups, plus what kind of ore, gas, ice or mineral an item is for the Mining page (about 1 MB)
- `public/data/stations.json`: NPC station names and systems (about 370 KB)

To rebuild them later (say, after new systems are added to the game):

```bash
npm run build:map
```

```bash
npm test
```

## Signing in

Optional. Once signed in, the header shows your character with an online dot, current system,
docked/in space and wallet balance. Click it for the ship you're flying and three options,
remembered per browser:

| Option | What it does |
|---|---|
| **Follow my location** | Your current system becomes the home system (Market watch) and the start of multi-stop routes (Hub arbitrage). |
| **Use my ship's cargo** | Your current ship's cargo hold fills *Cargo m³* on both pages. |
| **Use my wallet as max investment** | Your wallet balance fills *Max investment* / *Budget* on both pages. |
| **Record my wormhole jumps** | Keeps checking your location in background tabs, so jumps without a stargate become route shortcuts on every page (see [Wormholes](#wormholes)). |

- *Use my ship's cargo* uses the base hold from the SDE (`types.json` stores it for ships). It
  doesn't include skills or expanded cargoholds. On Hub arbitrage it also puts your ship in *Ship
  holds*, so its ore, fleet and other specialised holds count for the items that fit them.
- Location, online status and ship are checked every 20 s while the tab is visible, and the
  wallet every 2 minutes. A field filled from your character is locked and outlined in violet;
  turn the option off to edit it.

**Watchlists** (Hub arbitrage's item list and Market watch's watchlist) are saved to your character
while you're signed in, so they follow you to any browser (`public/js/watchlist.js`; stored in
`.cache/watchlists.json` locally, D1 on Cloudflare). Signed out, they last for the browser session
(`sessionStorage`: closing the tab clears them). The first time a character signs in, the list you built
while signed out is copied to it.
New lists start empty; each item has a Remove button, and its icon links to the item's EVE University
wiki page (the icon is hidden on narrow screens).

**My orders** (Market watch) lists your active orders, plus your corporation's if your role
allows it, and checks each one against the live market:
- **Sell orders** are *undercut* when another seller at the same station is cheaper.
- **Buy orders** are *outbid* when a higher buy order can also be filled at your station,
  ranges included (`public/js/orders.js`).
- Each problem row shows the price to set to lead again. Summary line: listed value, escrow,
  and how many orders need updating. Click a row to add the item to your watchlist.
- **Orders in player structures** are checked against that structure's own live market. That
  needs docking and market access there.
- **Corporation orders** need the Accountant or Trader role in game; without it the panel says
  so and shows your own orders only.
- ESI refreshes your order list about every 20 minutes. Rival prices are live.

EVE requires every app to be registered, so there's a one-time setup:

1. Sign in at https://developers.eveonline.com and create an application.
   - **Connection type:** *Authentication & API Access*
   - **Callback URL:** `http://localhost:8000/sso/callback` (use your port if you changed `PORT`)
   - **Scopes:** `esi-location.read_location.v1`, `esi-location.read_online.v1`,
     `esi-location.read_ship_type.v1`, `esi-wallet.read_character_wallet.v1`,
     `esi-markets.read_character_orders.v1`, `esi-markets.read_corporation_orders.v1`,
     `esi-markets.structure_markets.v1`. `publicData` doesn't hurt but isn't used.
2. Copy `sso.config.example.json` to `sso.config.json` and put its **Client ID** in it, then restart the server:
   ```json
   { "clientId": "your-client-id" }
   ```
   - Or set `EVE_CLIENT_ID` instead.
   - `EVE_CALLBACK_URL` (or `callbackUrl` in the file) overrides the callback if you registered a
     different one.
   - To request fewer scopes, list them as `"scopes": [...]`. Features whose scope you leave out
     are disabled with a note rather than breaking.
3. Click **Log in with EVE** in the page header and pick your character.

If you signed in before adding scopes, sign out and in again so CCP grants the new ones.

How it's kept safe (`sso.js`):
- **No secret needed.** The login uses OAuth with PKCE, so the app's Secret Key is never used.
  Don't paste it anywhere.
- **Read-only.** Every scope only reads. Nothing can move ISK, change orders or act in game.
- **Tokens stay on the server.** They're saved in `.cache/sso.json` and never sent to the
  browser. The page only gets results (name, location, ship, balance, orders) from `/api/me/*`.
- **Your data stays on this machine.** The sign-in and `/api/me/*` endpoints answer only
  requests addressed to `localhost`/`127.0.0.1`. Signing out needs a header that other websites
  can't send.
- **ESI caching.** Answers are cached until ESI's own expiry, so reloading pages doesn't hammer
  the API.
- **Signing out** (in the character menu) deletes the saved tokens and asks CCP to revoke them.
- **Expired logins.** An expired or revoked login signs you out cleanly, and you can sign in again.

## How it works

- **`server.js`** serves `public/`, forwards `/api/wanderer/connections` to a Wanderer mapper (see [Wormholes](#wormholes)), and proxies `/api/tycoon/*` → `https://evetycoon.com/api/`,
  `/api/fuzzwork/*`, `/api/goon/*`, `/api/evepraisal/*`, `/api/adam4eve/*`, `/api/mokaam/*`, `/api/zkill/*` (see Market watch),
  and `/api/esi/*` → `https://esi.evetech.net/latest/`. A proxy is required because EVE
  Tycoon sends no CORS headers. The proxy:
  - caches each GET until the upstream `Expires` time (at least 60 s)
  - dedupes identical in-flight requests
  - caps concurrency per upstream
  - backs off on 429/420 using `Retry-After`
  - serves the last good copy (`X-Cache: STALE`) if the upstream fails
  - saves that cache to `.cache/proxy-cache.json.gz` (30 s after a change, and on Ctrl+C), so a
    restart doesn't re-fetch what the pages had already loaded
  - lets the browser keep each fresh answer until that same expiry (`Cache-Control: max-age`), so
    reloads, other tabs and repeat lookups don't reach the proxy at all. Stale copies aren't kept.
- **Prices** come from `GET /v1/market/orders/{typeId}`. One call returns every region's book,
  so each item needs one request no matter how many hubs there are. Prices are pinned to each
  hub's main station rather than region-wide stats, which can include orders 15 jumps away.
  - **Buy at A** = lowest sell order at A's station.
  - **Sell at B** = best buy order a seller docked at B's station can fill: orders in that
    station, non-`STATION`-range orders in the system, or `REGION`-range orders in the region.
    In *relist* mode it's the lowest sell order at B instead.
- **Whole-market scan** (`public/js/scan/hub-scanner.js`, `POST /api/scan`) pulls every order in the five hub regions
  from ESI's bulk `/markets/{region}/orders/` endpoint. That's about 900 pages (~1 minute),
  well inside ESI's market-order rate limit of 12,000 requests per 15 minutes. EVE Tycoon's
  per-item endpoint would need ~19,500 requests for the same coverage.
  - For every item and each of the 20 hub→hub directions, it walks the hub station's sell
    orders against the destination's reachable buy orders. It keeps every haul with at least
    100k ISK profit, along with its fill steps.
  - The browser then applies sales tax, cargo m³ (packaged volumes) and budget limits, and ranks
    by profit/jump, total profit, ISK/m³ or margin.
  - Scans are manual and reused until ESI's cache expires (about 5 minutes). The result is cached
    in `.cache/market-scan.json` so it survives restarts.
  - **On the server** (`npm start`), this scan is worked out from the [universe scan](#universe-scan)
    instead of fetched separately (`hubView` in `universe-scanner.js`): the hub regions are part of
    it, and it keeps 60 price levels at stations in hub systems, as deep as a hub haul goes. *Scan
    market* runs the universe scan (~1,600 pages), and both results come from one set of ESI pages
    rather than ~2,500. Checked against this scan on the same data: identical hauls and fill steps.
    The browser build (Cloudflare without a scan server) still runs this scan on its own, since
    it's smaller.
  - Buy orders with a minimum quantity above 1 are ignored everywhere; that's a common bait-order
    pattern.
- **Star map** (`scripts/build-universe.js`, `public/js/map.js`): every known-space system and
  stargate from the SDE (5,255 systems, 6,973 gates). Wormhole, abyssal and Jove regions are
  left out. Two layouts are available:
  - *True positions*: a top-down view of the real 3D coordinates.
  - *In-game 2D map*: CCP's flattened layout.

  Routes are drawn system by system along the actual paths ESI returns.
- **Jumps** come from ESI `GET /route/{a}/{b}/?flag=secure|shortest|insecure`. The full system path is cached in
  `localStorage` for 24 h (or longer if ESI's `Expires` says so). Only 10 pair lookups are
  needed, since routes are symmetric.
- **Metrics**
  - `spread = sell_B × (1 − tax) − buy_A`
  - `isk_per_jump = spread / jumps` (per unit, as specified)
  - *Depth profit* walks A's asks against B's bids and sums every still-profitable unit.
    *Profit/jump* is that total divided by jumps. It's more useful when comparing cheap bulk
    items with expensive ones.

## Market watch (`/market.html`)

A second page built for finding deals **away from the trade hubs**, where spreads are wider
because fewer traders are watching. For each watched item it looks at every station and
structure in New Eden, not just Jita/Amarr/Dodixie/Rens/Hek, and ranks station-to-station hauls.

The page has three tabs under the settings: **Universe scan**, **My orders** and **Watchlist** (the
watched items and the selected item's detail). The open tab is remembered and kept in the link
(`?tab=`). Clicking an item in the scan or in your orders adds it to the watchlist and opens it there.

- **Best hauls:** buy from sell orders at station A, then sell at station B into every buy order
  that can be filled there.
  - Buy-order ranges count, using the same logic as the universe scan (`public/js/ranges.js`):
    B can be the nearest station in range of a ranged order, not just the order's own station.
    Rows that rely on this say *sells into ranged buy orders*.
  - Both books are walked, so profit is for the whole fillable depth, after tax and within your
    cargo m³ and max investment.
  - Ranked by ISK per jump (the trip from your home system plus the haul), total profit or
    margin.
- **Cheapest sellers / best buy orders:** the top stations anywhere, with system security, region
  and jumps from home.
  - *Best buy orders* counts ranges. Each buy order is listed at its own station and at the
    station nearest your home that its range reaches. Each station shows the best price among
    every order that can be filled there.
  - Rows made possible by a ranged order say *ranged order placed in …*.
- **Skip trade hubs** (on by default) leaves out the five hub systems and Perimeter. *Player
  structures* can be toggled off, because many don't grant docking or market access.
- **Jumps** are computed locally with a BFS over the SDE gate graph (`public/js/galaxy.js`), so any
  pair can be priced without an ESI route call. *High-sec only* also drops stations you can't
  reach through high-sec. From a low- or null-sec home it first leaves by the fewest jumps to the
  nearest high-sec systems, like the in-game *prefer safer* autopilot, then stays in high-sec.
- The board still shows the reference hub's price, so every deal reads as "x% below Jita".

### Universe scan

The *Universe scan* tab (`public/js/scan/universe-scanner.js`, `POST /api/uscan`) finds hauls for **every item**,
not just your watchlist.
- **Coverage:** it pulls every order in all 67 known-space regions from ESI's bulk
  `/markets/{region}/orders/` endpoint. That's ~1,600 pages; a full scan took 98 s in testing,
  well inside ESI's market rate limit.
- **Memory:** each region's orders are collapsed to the best 30 price levels per station per side
  once they're in, so memory peaks at ~450 MB (The Forge alone is ~400k orders).
- **Buy-order ranges count.** A buy order can be filled from any station within its range: the
  same station, the same system, N jumps, or the whole region. Jumps are counted on the shortest
  path, as the game does, and a range never crosses a region border.
  - For each station you could buy from, the scan finds the nearest NPC station where in-range
    orders can be filled.
  - Selling there fills every order that reaches it, best price first.
  - This often means stopping short of a hub, e.g. selling Strontium at Niyabainen into a
    1-jump-range buy order placed in Perimeter. It also means "sell where you buy" flips, with
    0 jumps and no undocking.
  - Rows that rely on orders placed elsewhere say *sells into ranged buy orders*.
- **Matching:** for every item, the 25 cheapest selling stations are tried against the 60 best
  buy-order groups (station × range), with up to 40 sell points each. Both books are walked,
  and hauls with at least 250k ISK raw profit are kept per item:
  - the 8 most profitable with neither end at a trade hub
  - the 8 best per jump, so short hops aren't crowded out
  - the 4 best that touch a hub
- **Your settings:** the browser applies tax, cargo, max investment, route safety and jumps from
  your home system (computed locally), plus min profit, max margin and max total jumps. It then
  ranks by ISK per jump, total profit, profit per m³ or margin.
  - *Hide ships* leaves out every item in the Ship category (from the SDE, in `types.json`).
  - *Near system* keeps hauls close to any system you pick. Distance is measured, with your
    route setting, to the pickup, the drop-off or either end. *Within jumps* caps it, and *Rank by
    → Closest to location* sorts nearest first, breaking ties by ISK per jump.
  - *Max investment* caps the ISK spent on one haul; bigger hauls are cut down to fit. It's the
    same setting as the one in the top controls, and it applies to the watchlist's hauls too.
- **Caching:** scans are manual and reused until ESI's cache expires. The result is cached in
  `.cache/universe-scan.json`.
- **Station names** come from `public/data/stations.json`, built from the SDE on first start.
  Structure names aren't public, so structures show as "Structure" plus their system.

Click a row to add that item to the watchlist and open its detail, which re-checks the deal
against all nine sources.

### Sources

| Source | What it adds | Proxy route |
|---|---|---|
| ESI | Live orders (authoritative), ~13 months of history, CCP average/adjusted prices | `/api/esi/*` |
| EVE Tycoon | Orders in every region including player structures (one call per item), history back to 2019, region 5% stats | `/api/tycoon/*` |
| Fuzzwork | Station aggregates and 5th percentiles, batched for the whole watchlist | `/api/fuzzwork/*` |
| Goonmetrics | Jita 4-4 quotes and weekly movement (Jita only) | `/api/goon/*` |
| Evepraisal | Per-item summaries for each hub and the whole universe | `/api/evepraisal/*` |
| Adam4EVE | Region-wide best prices and 5% percentiles; limited to 1 request per 5 s, which the proxy enforces | `/api/adam4eve/*` |
| Mokaam | Region trend stats: weekly/monthly/yearly averages, VWAP, 52-week range (major regions only) | `/api/mokaam/*` |
| zKillboard | Daily item valuation back to 2007, drawn as a dashed line on the history chart | `/api/zkill/*` |

Adam4EVE and Evepraisal ask clients to identify themselves, so the User-Agent carries a contact
(default: the maintainer's email in `server.js`). Override it with `CONTACT` (e.g. an in-game
name: `CONTACT="EVE: Your Name" npm start`), or send none with `CONTACT=""`.

Checked and not usable: EVEMarketer (returns 503; the service is gone), Janice (needs an API key),
EVE Appraisal's market watcher (needs an EVE SSO login), EVE-KILL (mirrors zKillboard's prices).
Adam4EVE and EVE Ref also publish bulk CSV dumps (`static.adam4eve.eu`, `data.everef.net`) that
could feed a future universe-wide scanner.

### How it collates

(`public/js/market-merge.js`, tested in `test/market-merge.test.js` and `test/offhub.test.js`)
- **Orders** from ESI and Tycoon are merged by order ID. When both have an order, the later
  `issued` wins, then the lower remaining volume (volume only falls). The page shows how many
  duplicates were collapsed and how many copies conflicted.
- **Ghosts:** an NPC-station order that only Tycoon lists, in a region ESI just returned, has
  been filled or cancelled. It's hidden unless *Ghost orders* is on. Structure orders are
  kept, because ESI's region endpoint can't see them.
- **History** from both sources is merged by UTC day; ESI wins on overlapping days, and Tycoon
  fills in the years before ESI's window.
- **Aggregates** (Fuzzwork, Goonmetrics, Evepraisal, Adam4EVE, Tycoon stats) can't be deduped at
  order level, so they appear side by side, grouped by scope (hub station, whole region, all of
  New Eden). Any quote more than 2% off the median of the independent sources at the same scope
  is flagged amber.

The watchlist and settings are stored in `localStorage`. *Auto 5 min* re-polls on a timer. Every
call still goes through the caching proxy, and the slow-moving sources have longer cache floors
(Adam4EVE 10 min, zKillboard and Mokaam 1 h), so auto-refresh never exceeds their limits.

## Contracts & opportunities (`/contracts.html`)

A third page that prices public contracts and NPC LP stores against the live hub markets. The
controls at the top (home, route, tax, cargo, max investment, *Sell at* hub, *Value items by*)
apply to all three tabs, and follow your character like the other pages.

- **Item contracts** (`public/js/scan/contract-scanner.js`, `POST /api/cscan`): public item-exchange contracts (and
  auction buyouts, if ticked) whose contents are worth more than the asking price.
  - *Scan contracts* lists every public contract in every region (~100 ESI pages), then opens
    each one in the chosen regions (*Hub regions* or *All known space*) that pays or asks at
    least *Min price*. That's one ESI call per contract (~40/s), so the first scan of the hub
    regions at 20m takes around 10 minutes. Contents never change, so they're cached in
    `.cache/contract-items.json` and later scans only open new contracts.
  - Items are valued at each of the five hubs from ESI's live orders (the hub regions' bulk
    order books): *Instant sell* walks the buy orders a seller at the hub station can fill;
    *Relist* uses the lowest sell order there.
  - `profit = item value × (1 − tax) + ISK the contract pays you − its price − cost of the items it asks for`
    (`public/js/contract-value.js`). *Best hub per contract* picks the most profitable hub.
  - Jumps = home → contract station → hub. Blueprint copies and items with no market at the hub
    can't be priced; *Fully priced only* (on by default) hides contracts that contain them.
  - Click a row for its items with per-unit prices.
- **Courier**: every public courier contract, ranked by reward per jump (home → pickup →
  drop-off), reward per m³ or reward. *Backhaul* links each delivery to the market: the best
  haul from the Market watch *Universe scan* that starts within *Backhaul within* jumps of the
  drop-off, with your tax, cargo and budget applied. *ISK per jump incl. backhaul* ranks by the
  whole round trip.
- **LP stores (missions)**: pick an NPC corporation to price its whole LP store. ISK/LP =
  (product value after tax − ISK cost − required items at the lowest sell order) ÷ LP. Prices
  are Fuzzwork station aggregates at the selling hub (Jita when *Best hub* is selected); the
  daily volume column (ESI history, last 7 days in the hub's region) shows whether the market
  can absorb what you redeem. LP-store blueprints are copies and are left unpriced.
- **Not available:** ESI has no public data for agent missions or the in-game *Opportunities*
  window (Corporation projects, Freelance jobs), so those can't be scanned.

## Mining (`/mining.html`)

A fourth page that answers "where should I sell this?" for ore, moon ore, ice, gas and minerals.

- **Your load:** add items by name (the *Show* filter narrows the list to ore, moon ore, ice, gas or
  minerals), or open *Paste from EVE*, select items in your ore hold or cargo, press Ctrl+C and paste.
  Lines like `Veldspar 12,000` or `500 x Blue Ice` work too. The load is kept in this browser.
- **Prices:** EVE Tycoon's orders for each item in every region, player structures included (one call
  per item through the caching proxy). Only buy orders are used, since selling to them is instant.
- **Best places to sell everything:** every station that buys any of the load. Each one's value
  (`public/js/mining-value.js`) fills every buy order that reaches it, best price first, using the
  same range rules as the universe scan: orders placed at the station, in its system, N jumps away or
  region-wide. Bait orders with a minimum quantity are skipped. The table shows jumps from you, how
  much of the load (by m³) sells there, ISK after tax, and the difference from your own system and
  from Jita 4-4. Click a row to see each item's units, average price and ISK. Rank it by total ISK,
  ISK per jump (jumps + 1) or distance. Filter it with *Max jumps* and *Min % of load sold*.
- **Best place per item:** where each item sells best within your limits and anywhere you can reach.
  *Split by item* adds these up, in case a few stops beat one.

### Wormholes

Wormhole shortcuts count in **every jump total on every page**:
- Hub arbitrage: hub-to-hub routes and multi-stop trips
- Market watch: hauls, jumps from home and *Near system*
- Contracts: pickup, delivery and backhaul distances
- Mining: jumps to each station

They're managed in the Mining page's *Wormhole shortcuts* panel. Each page's settings bar has a
**Wormholes (n)** switch that turns them on or off everywhere, with a link to that panel.
Everything is kept in `localStorage` (`wh.*`), so every page and tab shares it
(`public/js/shortcuts.js`).

Sources:

| Source | What it adds | How |
|---|---|---|
| **Your characters' jumps** | Wormholes you or your alts took | Recorded from now on while signed in (below) |
| **EVE Scout** | Thera and Turnur connections | Public API, `api.eve-scout.com`, called from the browser |
| **Wanderer map** | Every connection on your group's map | Its API with the map's token, through `/api/wanderer/connections` |
| **By hand** | Any pair of systems (J-codes work) | Resolved through ESI, forgotten after *Forget after* hours |

- **Your jumps.** ESI has no travel history, so there's no way to look back at jumps made before.
  Instead, while you're signed in, the location check every page already makes (every 20 s)
  records each system change in this browser. It's kept per character (`me.trail.<character>`,
  last 48 h), and every character that signs in on the browser counts. *Record my wormhole jumps*
  in the character menu (on by default) keeps checking your location in background tabs too.
  Two readings in a row in systems with **no stargate between them** count as a shortcut
  (`public/js/wormholes.js`):
  - Either end in wormhole space: a wormhole.
  - Two known-space systems: a K-space wormhole, jump bridge or cyno, marked *no gate*. Untick it if
    you can't fly it again.
  - Skipped: gaps over 90 s (the path in between is unknown), docked-to-docked changes (jump clones)
    and abyssal filaments.
- **Wanderer** ([wanderer.ltd](https://wanderer.ltd) or a self-hosted copy): enter the site, the map's
  slug and its API token (map settings). Wanderer sends no CORS headers, so the request goes through
  the app's server (`wanderer.js`). It forwards the token and never stores it; locally it answers only
  pages on `localhost`. Only public `https://` hosts and Wanderer's two connections paths can be
  reached, and redirects aren't followed. Connections refresh every 2 minutes; Wanderer drops them
  when they collapse.
- Other mappers: Pathfinder and Tripwire are no longer maintained and have no public API. Nexum
  doesn't document one.

Shortcuts are added to the gate graph for travel. Wormhole systems become nodes, so jumps work while
you're sitting in a wormhole. Jump counts whose route uses one show ⤳ (Mining, and every Hub arbitrage
table and summary). On Hub arbitrage, each hub pair uses ESI's gate route or the path through shortcuts,
whichever is shorter; route strips draw systems reached through a wormhole as round dots, and a
multi-stop route can start in a wormhole system (type its J-code, or follow your character there).
Wormhole space is used by *Shortest* and *Prefer low/null* routes only; *Safest (high-sec)* avoids it. The star map
skips wormhole systems when drawing a route. Wormhole space never counts as high-sec. Buy-order
ranges still follow stargates only, as they do in game.

## Hosting on Cloudflare

The same pages also run as a Cloudflare Worker (`wrangler.jsonc`, `worker/index.js`), on the free
plan. Differences from `npm start`:

- **Scans run in your browser**, unless you [run them on your own server](#scans-on-your-own-server).
  Workers can't hold a scan (128 MB memory, 10 ms CPU on the free plan; the universe scan's order
  book alone is ~250 MB), so `public/js/scan-client.js` runs the same scanners in a Web Worker,
  calling ESI directly (it allows CORS). Results are kept in IndexedDB. A scan stops if you close or
  reload its tab; contract contents already opened are kept, so the next scan picks up where it
  left off.
  Open tabs share scans: only one tab scans a kind at a time (a Web Lock), the others show its
  progress ("running in another tab") over a `BroadcastChannel` and load its result from IndexedDB
  when it's done.
- **The proxy** (`/api/{tycoon,esi,…}`) is the Worker: EVE Tycoon, Goonmetrics, Adam4EVE and
  Mokaam send no CORS headers. It caches in the isolate's memory and, on a custom domain, in
  Cloudflare's cache (the Cache API does nothing on `workers.dev`). Browsers keep fresh answers
  until the upstream expiry too, so repeat visits don't count against the Worker's request quota.
- **Watchlists of signed-in characters** are in D1 (`USERS_DB`), one row per character and list.
- **Contract contents are shared** (D1, `/api/contract-items`). A contract's items never change, so
  once anyone's scan has opened a contract, everyone else gets it from the database: after the
  first visitor, opening ~2,000 contracts takes seconds instead of minutes. The Worker fetches
  missing contracts from ESI itself, so the database only ever holds CCP's data. Free-plan use: one
  row per contract (tens of MB), a few thousand writes a day, ~50 row reads per 50 contracts.
  Expired contracts are pruned as it goes. The first deploy creates the database automatically.
- **Sign-in is per browser.** Each browser gets an HttpOnly session cookie and its own `Session`
  Durable Object that holds its EVE tokens; the page only sees results, as locally.

Setup, in the Cloudflare dashboard (Workers → Create → Import a repository):
1. **Build command:** `npm run build:map` (builds `public/data/` from the SDE).
   **Deploy command:** `npx wrangler deploy`.
2. After the first deploy, under *Settings → Variables and secrets*, add:
   - `EVE_CLIENT_ID`: the Client ID of an EVE application whose callback URL is
     `https://<your worker>.workers.dev/sso/callback` (register a separate app from your local one).
     Without it the site works, just without sign-in.
   - `CONTACT` (optional): contact for the User-Agent sent to community APIs.
   - `EVE_CALLBACK_URL` (optional): only if the callback differs from this site's `/sso/callback`.
   `keep_vars` in `wrangler.jsonc` keeps them across deploys.

Try it locally with `npm run cf:dev` (put `EVE_CLIENT_ID=…` in `.dev.vars` to test sign-in).

### Scans on your own server

The hosted site can hand its scans to `server.js` running on a machine of yours (a homelab LXC, a
small VPS), reached through a Cloudflare Tunnel. The server scans once for every visitor, so ESI
sees one universe scan per ~5 minutes however many people are on the site, and nobody has to keep
a tab open. Everything else (pages, proxy, sign-in, watchlists, shared contracts) stays on
Cloudflare.

- The Worker forwards `/api/scan`, `/api/uscan` and `/api/cscan` (and their `/result`) to
  `SCAN_ORIGIN`, sending `SCAN_SECRET` in an `X-Scan-Secret` header.
- `/api/config` checks the server (every 30 s at most). While it's down or refuses the secret,
  pages scan in the browser as before; a page that loses the server mid-visit shows an error and
  scans in the browser after a reload.
- With `SCAN_SECRET` set, the server answers only requests addressed to itself (`localhost`) or
  carrying the secret, so the rest of it (sign-in, the proxy) isn't reachable through the tunnel.
  Requests relayed by Cloudflare (`CF-Ray`, `CF-Connecting-IP`, `CF-Worker`) always need the secret.
- Visitors can't force back-to-back rescans: a forced scan through the Worker waits 5 minutes after
  the last one. Unforced scans are reused until ESI's data expires anyway.
- The server keeps its own contract cache (`.cache/contract-items.json`); the D1 shared-contracts
  table is only used by browser scans.

Setup:
1. **The machine:** Node 18+, ~1 GB RAM (the universe scan peaks around 450–600 MB) and a few hundred
   MB of disk for `.cache`. Clone the repo to `/opt/eve-arbi` and install the service from `deploy/`,
   with a long random secret:
   ```bash
   git clone https://github.com/sauravyash/eve-arbi /opt/eve-arbi
   echo "SCAN_SECRET=$(openssl rand -hex 32)" > /etc/eve-arbi.env && chmod 600 /etc/eve-arbi.env
   cp /opt/eve-arbi/deploy/eve-arbi*.service /opt/eve-arbi/deploy/eve-arbi-update.timer /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now eve-arbi               # the server
   systemctl enable --now eve-arbi-update.timer  # optional: keep it up to date
   ```
   It listens on `127.0.0.1:8000` (set `PORT`/`HOST` in `/etc/eve-arbi.env` to change it). The first
   start builds `public/data/` from the SDE.
   - **Updates** (`eve-arbi-update.timer`, optional): every 15 minutes `deploy/update.sh` runs
     `git pull --ff-only` and, only if that brought new commits, restarts the server. It waits for a
     running universe or contract scan to finish first (up to 10 minutes). If the branch can't be
     fast-forwarded (history rewritten), it changes nothing and the run fails: see
     `journalctl -u eve-arbi-update`. Run it by hand with `systemctl start eve-arbi-update`.
2. **The tunnel:** install `cloudflared` on the same machine and create a tunnel (Zero Trust →
   Networks → Tunnels) with a public hostname, e.g. `scan.example.com`, pointing at
   `http://localhost:8000`. No ports need opening.
3. **The Worker:** under *Settings → Variables and secrets*, add `SCAN_ORIGIN` =
   `https://scan.example.com` and `SCAN_SECRET` (type *Secret*) with the same value as the server's
   (`cat /etc/eve-arbi.env`).
   `keep_vars` keeps them across deploys.

To check it, open `/api/config` on the site: `"serverScans": true` means the pages are using it.

## Using it

- **Sections:** the tab bar under the map switches between *Best items*, *Single route*, *Multi-stop
  routes* and *Watchlist routes*, each with its row count. Keys 1–4 (outside text fields) and the
  arrow keys also switch. The bar stays pinned while you scroll, and the open tab is remembered and kept
  in the URL. The map and item list stay visible on every tab.
- **Refresh** is manual. After the first load, repeated clicks within the upstream cache window
  return cached data, so you can't hammer the APIs.
- **Star map:** drag to pan, scroll or double-click to zoom. Hover a system for its security,
  region, and any routes passing through it.
  - Profitable routes are drawn along their real gate paths; the best one is teal, with arrows
    showing the direction of travel.
  - Click a hub to show only its outgoing routes. Click it again, press Esc, or click empty space
    to clear.
  - Clicking a table row selects that route and zooms the map to it.
  - The *Best route* / *Hubs* / *All* buttons reframe the view.
- **Best arbitrage items:** click *Scan market*. The first visit scans automatically.
  - Set *Cargo m³* and *Budget* to match your hauler, e.g. `60000` and `1b`. Amounts accept
    k/m/b suffixes.
  - *Hide margin above %* (default 100) filters out suspicious outliers.
  - Click a row to draw that haul on the map; the graph switches to *Whole market (scan)*, the
    best item per hub pair. ☆ adds an item to the watchlist.
  - *Hide ships* leaves out every item in the Ship category.
  - **Markets:** *Trade hubs* ranks the hub scan. *All stations* ranks the universe scan instead (the
    same one Multi-stop routes use; *Scan universe* runs it). It covers every NPC station and, with
    *Player structures* ticked, structures too. Jumps are computed locally with your *Route* setting.
  - **Buy at / Sell at:** a hub, *Anywhere*, *Trade hubs* or *Away from hubs* (All stations only), or
    *Near me*. Near me means within *Jumps from me* of your location: the multi-stop *Start system*,
    which follows your character when you're signed in with *Follow* on. When buying near you,
    the Jumps column shows `to pickup + haul`, and profit per jump counts both.
  - **Ship holds:** pick a ship, or turn on *Use my ship's cargo* to use the one you're flying. Items
    that fit its special holds can use them on top of *Cargo m³* (`public/js/holds.js`): mining hold
    (ore, ice, gas), ice, gas, mineral, salvage, ammo, planetary commodities, command center, fuel
    bay (ice products, fuel blocks), booster, subsystem and mobile depot holds, and the fleet hangar
    (anything). Hold sizes come from ESI's dogma attributes, are cached per ship, and are base sizes
    (no skills). Ship-only bays are left out, because market ships are packaged. Picking a ship by hand
    also fills *Cargo m³* with its base hold. Rows that needed the extra room say which holds they used.
- **Single route, many items** (`public/js/manifest.js`) fills one hold on one trip. For each pickup →
  drop-off pair in *Best arbitrage items* (same scan and filters), it packs the most profitable mix
  of items into your *Cargo m³*, ship holds and *Budget*.
  - It walks every item's order books and takes the best ISK per m³ (or per ISK, or a mix of both
    when cargo and budget are both limited) until the hold or the wallet runs out.
  - Items that fit a special hold fill it before the shared cargo hold.
  - *Min profit* applies to the whole load, and routes are ranked with the same *Rank by*.
  - Click a route for its shopping list: units, m³, first and last prices, profit per item, and
    which hold each goes in. *Copy for multibuy* puts it on the clipboard as one `name quantity` line
    per item, the format EVE's Multibuy window takes. The route is drawn on the map.
  - With *All stations* most routes carry one or two items, because the universe scan keeps only a
    handful of hauls per item.
- **Multi-stop routes** (`public/js/trips.js`) chain hauls from the universe scan into one trip:
  buy item 1, sell it, buy item 2 where you sold (or after a few empty jumps), and so on.
  - Each haul sells its whole cargo before the next purchase, so *Cargo m³* and *Budget* apply
    per haul.
  - Jumps include the flight from your start system and use the page's *Route* setting.
  - A beam search keeps the best partial trips at each stop and ranks finished ones by ISK per
    jump or total profit.
  - An item never appears twice in one trip, since it would compete for the same orders. A
    single haul can headline at most two listed trips, so one lucrative trade doesn't crowd out
    everything else.
  - Filters: hauls per trip (2–5), empty jumps between hauls, min profit per haul, hide ships,
    skip trade hubs and player structures.
  - Searches are kept for the browser session (`sessionStorage`, last 12), so going back to earlier
    settings or reloading the page doesn't plan them again. A new universe scan starts fresh.
  - Click a route to draw it on the star map as numbered waypoints along the real gate path;
    the per-hub routes fade out while it's shown.
  - The *Waypoints* panel lists each stop's station, what to sell and buy there, and the jumps
    from the previous stop. *Copy waypoints* puts that plan on the clipboard, followed by the
    system names in flying order.
- **Schematic:** the original five-hub diagram. Distances aren't to scale; each line stands for
  a whole route.
- **Items:** type to search market groups, then click a group to list its items. Or type an exact
  item name and press Enter, which resolves it through ESI `/universe/ids/`.
- **Manual overrides:** enter prices per hub/item or jump counts. Blank fields use live values,
  which appear as placeholders. Overrides persist in `localStorage` and keep the tool usable
  offline or when one fetch fails.
- **Stale data:** if an item's fetch fails, its last good order books stay in use and are marked
  STALE (amber, dashed edges) rather than blanking the graph.

## Caveats

- PLEX isn't in the starter set because it trades on the global PLEX market with no regional
  orders, so there's nothing to haul. The defaults are Large Skill Injector, Isogen and Rifter.
- Watchlist depth ignores cargo capacity; the market ranking applies your cargo and budget
  limits. Neither accounts for collateral, gank risk, or orders changing while you haul, so
  re-check big hauls in-game before buying.
- Buy orders placed outside the hub system with a jump range that reaches it are ignored. This
  is conservative: it may miss some sell opportunities but never invents them.
- Sales tax defaults to 7.5%, EVE's base rate. Set your own: Accounting cuts it by 11% per level
  (3.375% at level V). Broker fees for relisting aren't counted.
- Hub IDs in `public/js/arbitrage.js` were verified against ESI on 2026-09-17.
