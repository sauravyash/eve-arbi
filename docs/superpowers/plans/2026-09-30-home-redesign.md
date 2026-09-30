# Home Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `public/index.html` (the home page) to match the "Home v4" design handoff: a sticky glass header with a live EVE clock and pilot chip, a hero panel with scan chips and stats, hairline-divided tool rows with one accent colour per section, and a mono footer.

**Architecture:** This stays a static page with no build step: plain HTML, one page stylesheet (`public/home.css`), and ES modules. Pure logic (the clock format, "time ago", and mapping a scan status to its labels) moves into a new `public/js/home-status.js`, which is unit-tested with `node --test`. The shared `me.js` pilot chip gains a `line: 'ship'` option and an `.me-isk` span so the home page can match the design without changing other pages. Every new style is scoped to the home page: `home.css` loads only there, and its tokens are prefixed `--h-*` so they don't collide with the `styles.css` tokens.

**Tech Stack:** Vanilla JS (ES modules), CSS with `oklch()` and `color-mix()`, Google Fonts (Manrope, JetBrains Mono), `node:test`, and a Node dev server (`node server.js`, port 8000).

**Spec:** `docs/superpowers/specs/home-redesign/README.md`. The design reference is `docs/superpowers/specs/home-redesign/Home v4.dc.html`. Open it in a browser with `support.js` beside it; all styles are inline, so read exact values from the markup.

## Global Constraints

- The design is **high fidelity**: match colours, type, spacing and hover states exactly (dark theme).
- Copy all text exactly as it appears in `Home v4.dc.html`.
- Add no new features. The prototype's `scanlines` and `showStatus` toggles are **not** built: scanlines is off by default and status is always shown.
- Fonts: Manrope 400–700 for the UI and JetBrains Mono 400–500 for data, labels and codes, both from Google Fonts.
- Page background: `oklch(0.15 0.012 240)` with `radial-gradient(1000px 520px at 75% -10%, oklch(0.28 0.05 210 / 0.5), transparent 68%)`.
- Section accents: teal `oklch(0.82 0.1 195)`, blue `oklch(0.78 0.11 255)`, amber `oklch(0.85 0.1 80)`, pink `oklch(0.78 0.12 350)`.
- EVE time is UTC, `HH:MM:SS`, updated every second.
- Scan status comes from real scan timestamps. Scanned shows as amber "scanned · Xh ago"; not scanned shows as grey "needs a scan".
- The pilot chip shows only when the user is signed in; otherwise a sign-in button sits in the same slot. The portrait is the real character portrait from `images.evetech.net`.
- Responsive: the label column and tool list stack on narrow screens, and so do the hero columns. Nothing uses a fixed height. At phone width, keep a 16px side gutter and no horizontal page scroll.
- **Not in the handoff; decided here:** the existing light/dark toggle must keep working, so every colour goes through a `--h-*` token with a light-theme value. The rest of the site (other pages' headers) is out of scope for this plan.
- Keep the existing IDs and behaviour: `#me`, `#themeBtn`, `body[data-page=home]`, and the `?tab=` redirect script in `<head>`.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `public/js/home-status.js` | Create | Pure helpers: `eveTime(date)`, `ago(ms, now)`, `describeScan(status, now)` |
| `test/home-status.test.js` | Create | Unit tests for the above |
| `public/js/me.js` | Modify | Export `meLine()`; add a `line` option to `createMe`; wrap the wallet in `.me-isk` |
| `test/me.test.js` | Create | Unit tests for `meLine()` |
| `public/index.html` | Rewrite `<body>`, add fonts to `<head>` | New markup: header, hero, 4 sections, footer |
| `public/home.css` | Rewrite | Tokens (dark and light), layout, states, responsive |
| `public/js/home.js` | Modify | Clock, scan chips and row labels via `home-status.js`, and `line: 'ship'` |

---

### Task 1: Pure status helpers

**Files:**
- Create: `public/js/home-status.js`
- Test: `test/home-status.test.js`

**Interfaces:**
- Produces:
  - `eveTime(date: Date): string` returns `"HH:MM:SS"` in UTC.
  - `ago(ms: number, now?: number): string` returns `"just now"`, `"45m ago"`, `"2h ago"` or `"3d ago"`.
  - `describeScan(status: object|null, now?: number): { state: 'scanned'|'running'|'none'|'error', chip: string, row: string }`. Here `status` is what `scanClient(kind).status()` returns: `{ state: 'idle'|'running'|'computing'|'done'|'error', result?: { finishedAt, expiresAt } }`.

- [ ] **Step 1: Write the failing tests**

`test/home-status.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eveTime, ago, describeScan } from '../public/js/home-status.js';

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const MIN = 60_000;

test('eveTime is the UTC clock, zero-padded', () => {
  assert.equal(eveTime(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))), '03:04:05');
  assert.equal(eveTime(new Date(Date.UTC(2026, 0, 2, 23, 59, 59))), '23:59:59');
});

test('ago rounds to minutes, then hours, then days', () => {
  assert.equal(ago(NOW - 20_000, NOW), 'just now');
  assert.equal(ago(NOW - 45 * MIN, NOW), '45m ago');
  assert.equal(ago(NOW - 125 * MIN, NOW), '2h ago');
  assert.equal(ago(NOW - 47 * 60 * MIN, NOW), '47h ago');
  assert.equal(ago(NOW - 72 * 60 * MIN, NOW), '3d ago');
});

test('describeScan: a finished scan reads as scanned, however old', () => {
  const st = { state: 'done', result: { finishedAt: NOW - 120 * MIN, expiresAt: NOW - 60 * MIN } };
  assert.deepEqual(describeScan(st, NOW), { state: 'scanned', chip: '2h ago', row: 'Scanned · 2h ago' });
});

test('describeScan: running or computing, even with an older result', () => {
  const want = { state: 'running', chip: 'scanning now', row: 'Scanning now' };
  assert.deepEqual(describeScan({ state: 'running' }, NOW), want);
  assert.deepEqual(describeScan({ state: 'computing', result: { finishedAt: NOW - MIN } }, NOW), want);
});

test('describeScan: never scanned, or the only scan failed, needs a scan', () => {
  assert.deepEqual(describeScan({ state: 'idle' }, NOW), { state: 'none', chip: 'not yet', row: 'Needs a scan' });
  assert.deepEqual(describeScan({ state: 'error' }, NOW), { state: 'none', chip: 'last scan failed', row: 'Needs a scan' });
});

test('describeScan: an unreadable status shows no row label', () => {
  assert.deepEqual(describeScan(null, NOW), { state: 'error', chip: 'unavailable', row: '' });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/home-status.test.js`
Expected: FAIL with `Cannot find module '…/public/js/home-status.js'`.

- [ ] **Step 3: Implement**

`public/js/home-status.js`:

```js
// Home page readouts: EVE time and how fresh each market scan is. No DOM, so tests can run them.

const pad = (n) => String(n).padStart(2, '0');

/** EVE time is UTC: "HH:MM:SS". */
export function eveTime(date) {
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/** "just now", "45m ago", "2h ago", "3d ago". */
export function ago(ms, now = Date.now()) {
  const min = Math.round((now - ms) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/**
 * A scan's status (scanClient(kind).status(), or null if it couldn't be read), as the home page shows it.
 * state: scanned | running | none | error. chip: the hero chip's note. row: a tool row's label ('' hides it).
 */
export function describeScan(st, now = Date.now()) {
  if (!st) return { state: 'error', chip: 'unavailable', row: '' };
  if (st.state === 'running' || st.state === 'computing') return { state: 'running', chip: 'scanning now', row: 'Scanning now' };
  const at = st.result?.finishedAt;
  if (!at) return { state: 'none', chip: st.state === 'error' ? 'last scan failed' : 'not yet', row: 'Needs a scan' };
  return { state: 'scanned', chip: ago(at, now), row: `Scanned · ${ago(at, now)}` };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test test/home-status.test.js`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add public/js/home-status.js test/home-status.test.js docs/superpowers
git commit -m "Home: pure EVE-time and scan-status helpers, with the redesign spec"
```

---

### Task 2: Pilot chip line option in `me.js`

The design's chip subline reads `Ship · docked · <amber>168.17M ISK</amber>`. The current chip reads `System · docked · 168.17M ISK`, with no span around the ISK. This task adds an opt-in option, so other pages don't change.

**Files:**
- Modify: `public/js/me.js`. Add `meLine` near the top, after `setPref`. Add a `line` option to the `createMe` signature. Change the `<small>` in `draw()`, currently `me.js:154`.
- Test: `test/me.test.js`

**Interfaces:**
- Produces:
  - `meLine({ line?: 'system'|'ship', where?: string, docked?: string, shipName?: string, wallet?: number|null, isk: (n) => string }): string`. Returns HTML-escaped text; the wallet is wrapped in `<span class="me-isk">…</span>`.
  - `createMe({ …, line?: 'system'|'ship' })` defaults to `'system'`.

- [ ] **Step 1: Write the failing tests**

`test/me.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meLine } from '../public/js/me.js';

const isk = (v) => `${(v / 1e6).toFixed(2)}M`;

test('meLine: system first by default, wallet in an .me-isk span', () => {
  assert.equal(meLine({ where: 'Rens', docked: 'docked', wallet: 168.17e6, isk }),
    'Rens · docked · <span class="me-isk">168.17M ISK</span>');
});

test('meLine: line "ship" puts the ship name first, falling back to the system', () => {
  assert.equal(meLine({ line: 'ship', where: 'Rens', docked: 'docked', shipName: 'Hulmate', wallet: null, isk }), 'Hulmate · docked');
  assert.equal(meLine({ line: 'ship', where: 'Rens', docked: 'in space', isk }), 'Rens · in space');
});

test('meLine: escapes names and leaves out missing parts', () => {
  assert.equal(meLine({ line: 'ship', shipName: '<b>&', isk }), '&lt;b&gt;&amp;');
  assert.equal(meLine({ wallet: 0, isk }), '<span class="me-isk">0.00M ISK</span>');
  assert.equal(meLine({ isk }), '');
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/me.test.js`
Expected: FAIL with `does not provide an export named 'meLine'`.

- [ ] **Step 3: Implement**

In `public/js/me.js`, after `function setPref(...)`, add:

```js
/** The chip's second line: "Rens · docked · 1.2b ISK", or with line 'ship', "Hulmate · docked · …". */
export function meLine({ line = 'system', where, docked, shipName, wallet, isk }) {
  const place = line === 'ship' && shipName ? shipName : where;
  return [
    place && `${esc(place)}${docked ? ` · ${docked}` : ''}`,
    wallet != null && `<span class="me-isk">${esc(isk(wallet))} ISK</span>`,
  ].filter(Boolean).join(' · ');
}
```

Add `line = 'system'` to the destructured `createMe` options, just after `onStatus = () => {}`. Add a matching JSDoc line:

```js
 * @param {'system'|'ship'} [o.line]               what leads the chip's second line (default: your system)
```

In `draw()`, replace this:

```js
<span class="me-who"><b>${esc(s.name)}</b><small>${[where && `${esc(where)} · ${docked}`, me.wallet != null && `${isk(me.wallet)} ISK`].filter(Boolean).join(' · ')}</small></span>
```

with this:

```js
<span class="me-who"><b>${esc(s.name)}</b><small>${meLine({ line, where, docked, shipName: me.ship?.name, wallet: me.wallet, isk })}</small></span>
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: every test passes, old and new.

- [ ] **Step 5: Commit**

```bash
git add public/js/me.js test/me.test.js
git commit -m "Pilot chip: optional ship-first line, wallet in its own span"
```

---

### Task 3: Home markup and stylesheet

This task replaces the card grid with the design's layout, in both themes. HTML and CSS ship together because neither can be reviewed without the other.

**Files:**
- Modify: `public/index.html`. Add the font links to `<head>`. Replace everything from `<body data-page="home">` up to and including `</body>`.
- Rewrite: `public/home.css`

**Interfaces:**
- Consumes (from Task 2): `me.js` renders `.me-menu > summary > .me-face > img + .me-dot`, `.me-who > b + small > .me-isk`, a `.btn` sign-in link, or `.me-off`.
- Produces (for Task 4): the elements below.
  - `#eveTime`, a `<time>` element.
  - `[data-scan="scan|uscan|cscan"]` chips, each containing `<small>`.
  - `.status[data-live="scan|uscan|cscan"]` row labels.
  - The CSS reads `data-state="scanned|running|none|error"` on chips and labels.

- [ ] **Step 1: Add fonts to `<head>`**

In `public/index.html`, directly before `<link rel="stylesheet" href="styles.css">`, add:

```html
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
```

Leave `<title>`, the favicon, the `?tab=` redirect script, `js/theme.js`, `styles.css` and `home.css` in place.

- [ ] **Step 2: Replace the body**

```html
<body data-page="home">
  <header class="home-bar">
    <div class="home-brand">
      <span class="home-mark" aria-hidden="true"></span>
      <div><b>Hub Arbitrage</b><small>Trade tools · read-only</small></div>
    </div>
    <nav class="home-nav" aria-label="Tools">
      <a href="index.html" aria-current="page">Home</a>
      <a href="best-items.html">Hub arbitrage</a>
      <a href="universe-scan.html">Market watch</a>
      <a href="item-contracts.html">Contracts</a>
      <a href="mining.html">Mining</a>
    </nav>
    <div class="home-tray">
      <div class="eve-time"><span>EVE TIME</span><time id="eveTime">--:--:--</time></div>
      <div id="me" class="me" aria-label="EVE character"></div>
      <button id="themeBtn" class="theme-btn" type="button" aria-label="Switch to light theme" title="Switch to light theme">
        <span class="theme-glyph" aria-hidden="true"></span>
      </button>
    </div>
  </header>

  <main class="home">
    <section class="hero" aria-labelledby="heroTitle">
      <div class="hero-text">
        <div class="eyebrow">Market intelligence</div>
        <h1 id="heroTitle">Find the ISK the hubs don't show</h1>
        <p>Hauling arbitrage, universe-wide market scans, contracts, LP stores and ore prices — all from public market data. Nothing here touches the client or places an order. Signing in is optional and only reads your location, ship, wallet and orders.</p>
        <ul class="scans" aria-label="Market scans">
          <li data-scan="scan"><i></i><span>Hub scan</span><small>…</small></li>
          <li data-scan="uscan"><i></i><span>Universe scan</span><small>…</small></li>
          <li data-scan="cscan"><i></i><span>Contract scan</span><small>…</small></li>
        </ul>
      </div>
      <ul class="stats" aria-label="At a glance">
        <li><b>5</b><span>Trade hubs</span></li>
        <li><b>67</b><span>Regions</span></li>
        <li><b>9</b><span>Price sources</span></li>
        <li><b>11</b><span>Tools</span></li>
      </ul>
    </section>

    <section class="tool arbi" aria-labelledby="t-arbi">
      <div class="tool-head">
        <div class="tool-index">01 — 4 TOOLS</div>
        <h2 id="t-arbi">Hub arbitrage</h2>
        <p>Buy low at one market, haul, sell high at another. Every route is drawn on a live star map of New Eden.</p>
      </div>
      <div class="rows">
        <a class="row" href="best-items.html">
          <span class="code" aria-hidden="true">BI</span>
          <span class="row-text"><b>Best items</b><span>Rank every item worth hauling between the five hubs, or between any two stations, by profit per jump.</span></span>
          <small class="status" data-live="scan"></small>
          <span class="arrow" aria-hidden="true">→</span>
        </a>
        <a class="row" href="single-route.html">
          <span class="code" aria-hidden="true">SR</span>
          <span class="row-text"><b>Single route</b><span>One pickup, one drop-off: the most profitable mix of items for one hold and one budget, with a multibuy list.</span></span>
          <small class="status" data-live="scan"></small>
          <span class="arrow" aria-hidden="true">→</span>
        </a>
        <a class="row" href="multi-stop.html">
          <span class="code" aria-hidden="true">MR</span>
          <span class="row-text"><b>Multi-stop routes</b><span>Chain hauls into one trip: sell a cargo, buy the next one nearby, and copy the waypoints into the game.</span></span>
          <small class="status" data-live="uscan"></small>
          <span class="arrow" aria-hidden="true">→</span>
        </a>
        <a class="row" href="watchlist-routes.html">
          <span class="code" aria-hidden="true">WR</span>
          <span class="row-text"><b>Watchlist routes</b><span>Your own items between Jita, Amarr, Dodixie, Rens and Hek — sortable, with manual price and jump overrides.</span></span>
          <span class="arrow" aria-hidden="true">→</span>
        </a>
      </div>
    </section>

    <section class="tool market" aria-labelledby="t-market">
      <div class="tool-head">
        <div class="tool-index">02 — 3 TOOLS</div>
        <h2 id="t-market">Market watch</h2>
        <p>Every station in New Eden, not just the hubs, with prices cross-checked between sources.</p>
      </div>
      <div class="rows">
        <a class="row" href="universe-scan.html">
          <span class="code" aria-hidden="true">US</span>
          <span class="row-text"><b>Universe scan</b><span>Every buy and sell order in all 67 known-space regions, matched station to station into the best hauls.</span></span>
          <small class="status" data-live="uscan"></small>
          <span class="arrow" aria-hidden="true">→</span>
        </a>
        <a class="row" href="my-orders.html">
          <span class="code" aria-hidden="true">MO</span>
          <span class="row-text"><b>My orders</b><span>Sign in to see which of your orders are undercut or outbid, and the price to set to lead again.</span></span>
          <span class="arrow" aria-hidden="true">→</span>
        </a>
        <a class="row" href="watchlist.html">
          <span class="code" aria-hidden="true">WL</span>
          <span class="row-text"><b>Watchlist</b><span>Items you follow: price history, merged order books, where to buy and sell, and the best hauls for each.</span></span>
          <span class="arrow" aria-hidden="true">→</span>
        </a>
      </div>
    </section>

    <section class="tool contracts" aria-labelledby="t-contracts">
      <div class="tool-head">
        <div class="tool-index">03 — 3 TOOLS</div>
        <h2 id="t-contracts">Contracts</h2>
        <p>Public contracts and loyalty point stores, priced against the live hub markets.</p>
      </div>
      <div class="rows">
        <a class="row" href="item-contracts.html">
          <span class="code" aria-hidden="true">IC</span>
          <span class="row-text"><b>Item contracts</b><span>Item exchanges and auction buyouts whose contents are worth more at a hub than the asking price.</span></span>
          <small class="status" data-live="cscan"></small>
          <span class="arrow" aria-hidden="true">→</span>
        </a>
        <a class="row" href="courier.html">
          <span class="code" aria-hidden="true">CR</span>
          <span class="row-text"><b>Courier</b><span>Courier contracts by ISK per jump, each paired with a market haul back from the drop-off.</span></span>
          <small class="status" data-live="cscan"></small>
          <span class="arrow" aria-hidden="true">→</span>
        </a>
        <a class="row" href="lp-stores.html">
          <span class="code" aria-hidden="true">LP</span>
          <span class="row-text"><b>LP stores</b><span>Every NPC corporation's loyalty point store, ranked by ISK per LP with the hub's daily volume.</span></span>
          <span class="arrow" aria-hidden="true">→</span>
        </a>
      </div>
    </section>

    <section class="tool mining" aria-labelledby="t-mining">
      <div class="tool-head">
        <div class="tool-index">04 — 1 TOOL</div>
        <h2 id="t-mining">Mining</h2>
        <p>What your ore, gas and ice are worth, and where.</p>
      </div>
      <div class="rows">
        <a class="row" href="mining.html">
          <span class="code" aria-hidden="true">WS</span>
          <span class="row-text"><b>Where to sell</b><span>Paste what you mined and see every station's price, counting each buy order whose range reaches it.</span></span>
          <span class="arrow" aria-hidden="true">→</span>
        </a>
      </div>
    </section>
  </main>

  <footer class="home-foot"><span>PUBLIC MARKET DATA · READ-ONLY</span><span>NOT AFFILIATED WITH THE GAME'S PUBLISHER</span></footer>

  <script type="module" src="js/home.js"></script>
</body>
```

Rows without a status (WR, MO, WL, LP, WS) leave out the `.status` element. The arrow has an explicit grid column, so it still lands in the last column.

- [ ] **Step 3: Rewrite `public/home.css`**

```css
/* Home page (spec: docs/superpowers/specs/home-redesign). Dark is the design; the light values mirror it.
   Tokens are prefixed --h- so they don't collide with styles.css, which the header's .me popover still uses. */
:root {
  --h-bg: oklch(0.15 0.012 240);
  --h-glow: oklch(0.28 0.05 210 / 0.5);
  --h-bar: oklch(0.15 0.012 240 / 0.78);
  --h-hero: linear-gradient(125deg, oklch(0.21 0.03 205 / .9), oklch(0.17 0.014 238 / .9) 60%);
  --h-chip-bg: oklch(0.15 0.012 240 / 0.6);
  --h-text: oklch(0.94 0.006 230);
  --h-strong: oklch(0.96 0.006 230);
  --h-body: oklch(0.75 0.012 230);
  --h-nav: oklch(0.74 0.01 230);
  --h-muted: oklch(0.70 0.012 230);
  --h-idle: oklch(0.7 0.01 230);
  --h-stat-label: oklch(0.68 0.012 230);
  --h-subtle: oklch(0.66 0.012 230);
  --h-label: oklch(0.62 0.012 230);
  --h-foot: oklch(0.6 0.01 230);
  --h-hollow: oklch(0.6 0.01 230);
  --h-btn-fg: oklch(0.8 0.01 230);
  --h-stat: oklch(0.86 0.09 195);
  --h-line: oklch(1 0 0 / 0.08);
  --h-line-bar: oklch(1 0 0 / 0.07);
  --h-line-soft: oklch(1 0 0 / 0.06);
  --h-line-dash: oklch(1 0 0 / 0.14);
  --h-nav-hover: oklch(1 0 0 / 0.18);
  --h-fill: oklch(1 0 0 / 0.04);
  --h-fill-btn: oklch(1 0 0 / 0.03);
  --h-teal: oklch(0.82 0.1 195);
  --h-blue: oklch(0.78 0.11 255);
  --h-amber: oklch(0.85 0.1 80);
  --h-pink: oklch(0.78 0.12 350);
  --h-online: oklch(0.8 0.14 150);
  --h-ring: oklch(0.17 0.012 240);
  --h-portrait: repeating-linear-gradient(135deg, oklch(0.3 0.02 230) 0 4px, oklch(0.25 0.016 230) 4px 8px);
  --h-sans: 'Manrope', system-ui, sans-serif;
  --h-mono: 'JetBrains Mono', ui-monospace, monospace;
}
:root[data-theme=light] {
  --h-bg: oklch(0.975 0.004 230);
  --h-glow: oklch(0.9 0.05 205 / 0.55);
  --h-bar: oklch(0.975 0.004 230 / 0.8);
  --h-hero: linear-gradient(125deg, oklch(0.94 0.035 200 / .9), oklch(0.99 0.004 230 / .9) 60%);
  --h-chip-bg: oklch(1 0 0 / 0.7);
  --h-text: oklch(0.22 0.015 240);
  --h-strong: oklch(0.18 0.015 240);
  --h-body: oklch(0.4 0.015 235);
  --h-nav: oklch(0.42 0.012 235);
  --h-muted: oklch(0.45 0.015 235);
  --h-idle: oklch(0.5 0.01 235);
  --h-stat-label: oklch(0.46 0.012 235);
  --h-subtle: oklch(0.5 0.012 235);
  --h-label: oklch(0.5 0.012 235);
  --h-foot: oklch(0.52 0.01 235);
  --h-hollow: oklch(0.55 0.01 235);
  --h-btn-fg: oklch(0.4 0.012 235);
  --h-stat: oklch(0.48 0.09 200);
  --h-line: oklch(0 0 0 / 0.1);
  --h-line-bar: oklch(0 0 0 / 0.08);
  --h-line-soft: oklch(0 0 0 / 0.07);
  --h-line-dash: oklch(0 0 0 / 0.2);
  --h-nav-hover: oklch(0 0 0 / 0.18);
  --h-fill: oklch(0 0 0 / 0.03);
  --h-fill-btn: oklch(0 0 0 / 0.02);
  --h-teal: oklch(0.52 0.1 195);
  --h-blue: oklch(0.5 0.15 255);
  --h-amber: oklch(0.58 0.13 70);
  --h-pink: oklch(0.55 0.17 350);
  --h-online: oklch(0.6 0.16 150);
  --h-ring: oklch(1 0 0);
  --h-portrait: repeating-linear-gradient(135deg, oklch(0.88 0.01 230) 0 4px, oklch(0.84 0.01 230) 4px 8px);
}

body[data-page=home] {
  display: flex; flex-direction: column; min-height: 100vh;
  background: radial-gradient(1000px 520px at 75% -10%, var(--h-glow), transparent 68%), var(--h-bg);
  color: var(--h-text); font: 400 14px/1.45 var(--h-sans); -webkit-font-smoothing: antialiased;
}

/* header */
.home-bar { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; flex-wrap: wrap; gap: 24px; padding: 0 32px;
  background: var(--h-bar); -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); border-bottom: 1px solid var(--h-line-bar); }
.home-brand { display: flex; align-items: center; gap: 12px; flex: 1 1 auto; min-width: 220px; padding: 12px 0; }
.home-mark { width: 28px; height: 28px; border-radius: 7px; border: 1.5px solid var(--h-teal); display: grid; place-items: center; }
.home-mark::after { content: ""; width: 9px; height: 9px; border-radius: 2px; background: var(--h-teal); transform: rotate(45deg); }
.home-brand b { display: block; font-size: 15px; font-weight: 700; letter-spacing: .02em; }
.home-brand small { display: block; margin-top: 2px; font: 10.5px var(--h-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--h-subtle); }
.home-nav { display: flex; flex-wrap: wrap; gap: 4px; align-self: stretch; }
.home-nav a { display: flex; align-items: center; min-height: 44px; padding: 0 14px; font-size: 13.5px; font-weight: 500; color: var(--h-nav); text-decoration: none; white-space: nowrap; }
.home-nav a:hover { color: var(--h-strong); box-shadow: inset 0 -2px 0 var(--h-nav-hover); }
.home-nav a[aria-current=page] { font-weight: 600; color: var(--h-strong); box-shadow: inset 0 -2px 0 var(--h-teal); }
.home-nav a:focus-visible { outline: 2px solid var(--h-teal); outline-offset: -2px; }
.home-tray { display: flex; align-items: center; gap: 14px; padding: 10px 0; }
.eve-time { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; font-family: var(--h-mono); }
.eve-time span { font-size: 10px; letter-spacing: .1em; color: var(--h-label); }
.eve-time time { font-size: 13px; color: var(--h-text); font-variant-numeric: tabular-nums; }

/* pilot chip (me.js markup) */
.home-tray .me { margin-left: 0; font-size: inherit; }
.home-tray .me-menu summary { gap: 10px; padding: 4px 12px 4px 4px; border-radius: 8px; background: var(--h-fill); border: 1px solid var(--h-line); }
.home-tray .me-menu[open] summary, .home-tray .me-menu summary:hover { border-color: var(--h-line-dash); }
.home-tray .me-menu summary:focus-visible { outline: 2px solid var(--h-teal); outline-offset: 1px; }
.home-tray .me-face { width: 32px; height: 32px; border-radius: 6px; background: var(--h-portrait); }
.home-tray .me-face img { width: 32px; height: 32px; border-radius: 6px; }
.home-tray .me-dot { right: -3px; bottom: -3px; width: 9px; height: 9px; border: 2px solid var(--h-ring); }
.home-tray .me-dot.on { background: var(--h-online); }
.home-tray .me-who { gap: 1px; min-width: 0; }
.home-tray .me-who b { font-size: 13.5px; font-weight: 600; }
.home-tray .me-who small { font: 10.5px var(--h-mono); color: var(--h-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.home-tray .me-isk { color: var(--h-amber); }
.home-tray .me .btn { display: inline-flex; align-items: center; height: 34px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--h-teal);
  background: transparent; color: var(--h-teal); font: 600 13px var(--h-sans); text-decoration: none; }
.home-tray .me .btn:hover { background: color-mix(in oklch, var(--h-teal) 12%, transparent); }
.home-tray .me-off { font: 11px var(--h-mono); }

/* theme toggle: a half-filled disc */
.home-bar .theme-btn { width: 34px; height: 34px; border-radius: 8px; border: 1px solid var(--h-line); background: var(--h-fill-btn); color: var(--h-btn-fg); }
.home-bar .theme-btn:hover { border-color: var(--h-teal); color: var(--h-btn-fg); }
.home-bar .theme-btn:focus-visible { outline: 2px solid var(--h-teal); }
.theme-glyph { width: 12px; height: 12px; border-radius: 50%; border: 1.5px solid currentColor; background: linear-gradient(90deg, currentColor 50%, transparent 50%); }

/* page */
.home { flex: 1; width: 100%; max-width: 1280px; margin: 0 auto; padding: 48px 32px 88px; display: flex; flex-direction: column; gap: 56px; box-sizing: border-box; }

/* hero */
.hero { position: relative; display: flex; flex-wrap: wrap; gap: 36px; padding: 44px 48px; border-radius: 16px; border: 1px solid var(--h-line); background: var(--h-hero); }
.hero::before, .hero::after { content: ""; position: absolute; width: 14px; height: 14px; }
.hero::before { top: 12px; left: 12px; border-top: 1.5px solid var(--h-teal); border-left: 1.5px solid var(--h-teal); border-top-left-radius: 4px; }
.hero::after { bottom: 12px; right: 12px; border-bottom: 1.5px solid var(--h-teal); border-right: 1.5px solid var(--h-teal); border-bottom-right-radius: 4px; }
.hero-text { flex: 1 1 460px; min-width: 0; display: flex; flex-direction: column; gap: 18px; }
.eyebrow { display: flex; align-items: center; gap: 8px; font: 11.5px var(--h-mono); letter-spacing: .14em; text-transform: uppercase; color: var(--h-teal); }
.eyebrow::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 10px currentColor; }
.hero h1 { margin: 0; font-size: clamp(36px, 4.6vw, 58px); line-height: 1.04; font-weight: 600; letter-spacing: -0.03em; text-wrap: balance; color: var(--h-text); }
.hero p { margin: 0; max-width: 600px; font-size: 17px; line-height: 1.55; color: var(--h-body); text-wrap: pretty; }

.scans { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.scans li { display: flex; align-items: center; gap: 8px; padding: 6px 11px; border-radius: 6px; border: 1px solid var(--h-line); background: var(--h-chip-bg); font: 11.5px var(--h-mono); }
.scans li > span { text-transform: uppercase; }
.scans small { font-size: inherit; color: var(--h-subtle); }
.scans i { width: 6px; height: 6px; border-radius: 50%; background: var(--h-amber); }
.scans li:is(:not([data-state]), [data-state=none], [data-state=error]) { background: transparent; border-style: dashed; border-color: var(--h-line-dash); }
.scans li:is(:not([data-state]), [data-state=none], [data-state=error]) i { background: transparent; border: 1px solid var(--h-hollow); }
.scans [data-state=running] i { background: var(--h-teal); animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .3; } }

.stats { flex: 0 1 320px; list-style: none; margin: 0; padding: 0 0 0 36px; display: grid; grid-template-columns: 1fr 1fr; gap: 24px 28px; align-content: center; border-left: 1px solid var(--h-line); }
.stats li { display: flex; flex-direction: column; gap: 6px; }
.stats b { font: 500 36px/1 var(--h-mono); color: var(--h-stat); }
.stats span { font-size: 12.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--h-stat-label); }

/* tool sections */
.tool { --accent: var(--h-teal); display: flex; flex-wrap: wrap; gap: 32px; }
.tool.market { --accent: var(--h-blue); }
.tool.contracts { --accent: var(--h-amber); }
.tool.mining { --accent: var(--h-pink); }
.tool-head { flex: 1 1 220px; max-width: 270px; display: flex; flex-direction: column; gap: 10px; padding-top: 16px; border-top: 1px solid color-mix(in oklch, var(--accent) 60%, transparent); }
.tool-index { font: 11px var(--h-mono); letter-spacing: .14em; color: var(--accent); }
.tool-head h2 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.015em; text-transform: none; color: var(--h-text); }
.tool-head p { margin: 0; font-size: 15px; line-height: 1.55; color: var(--h-muted); text-wrap: pretty; }
.rows { flex: 999 1 540px; min-width: 0; display: flex; flex-direction: column; border-top: 1px solid var(--h-line); }
.row { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto 20px; align-items: center; gap: 18px; padding: 18px 4px;
  border-bottom: 1px solid var(--h-line-soft); color: inherit; text-decoration: none; transition: background .15s; }
.row:hover { background: linear-gradient(90deg, color-mix(in oklch, var(--accent) 7%, transparent), transparent 80%); color: inherit; }
.row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.code { font: 11px var(--h-mono); padding: 4px 0; text-align: center; border-radius: 5px; color: var(--accent); background: color-mix(in oklch, var(--accent) 12%, transparent); }
.row-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.row-text b { font-size: 16.5px; font-weight: 600; }
.row-text span { font-size: 14.5px; line-height: 1.5; color: var(--h-muted); text-wrap: pretty; }
.status { font: 11px var(--h-mono); letter-spacing: .05em; white-space: nowrap; text-transform: uppercase; color: var(--h-idle); }
.status:empty { display: none; }
.status[data-state=scanned] { color: var(--h-amber); }
.status[data-state=running] { color: var(--h-teal); }
.arrow { grid-column: 4; color: var(--accent); }

/* footer */
.home-foot { border-top: 1px solid var(--h-line-soft); padding: 20px 32px; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px;
  font: 11px var(--h-mono); letter-spacing: .06em; color: var(--h-foot); }

/* hero columns stack: the stats move under the text */
@media (max-width: 940px) {
  .stats { flex-basis: 100%; padding: 24px 0 0; border-left: 0; border-top: 1px solid var(--h-line); grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
/* label column and list stack */
@media (max-width: 860px) {
  .tool { gap: 16px; }
  .tool-head { max-width: none; }
}
@media (max-width: 600px) {
  .home-bar, .home-foot { padding-left: 16px; padding-right: 16px; }
  .home-bar { gap: 0 16px; }
  .home-nav { flex-wrap: nowrap; overflow-x: auto; max-width: 100%; }
  .home-tray { width: 100%; }
  .home-tray .me { margin-left: auto; min-width: 0; }
  .eve-time { align-items: flex-start; }
  .home { padding: 28px 16px 56px; gap: 40px; }
  .hero { padding: 32px 22px; }
  .stats { grid-template-columns: 1fr 1fr; }
  .row { grid-template-columns: 40px minmax(0, 1fr) 20px; gap: 6px 14px; }
  .status { grid-column: 2; grid-row: 2; }
  .arrow { grid-column: 3; grid-row: 1 / span 2; }
}
@media (prefers-reduced-motion: reduce) { .row { transition: none; } .scans i { animation: none; } }
```

- [ ] **Step 4: Load the page and check the structure**

Start the dev server with the `preview_start` tool, name `eve-arbi` (from `.claude/launch.json`). It runs `node server.js` on port 8000. Open `http://localhost:8000/`. Run `read_console_messages` with `onlyErrors: true` and expect no errors. Run `read_page` and check the page shows the header nav (5 links), an H1 reading "Find the ISK the hubs don't show", 4 H2 sections, 11 row links, and the footer.

The clock shows `--:--:--` and the chips show `…` until Task 4. That's expected.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/home.css
git commit -m "Home: rebuild the page to the v4 design (glass header, hero, hairline tool rows)"
```

---

### Task 4: Wire the clock, scan status and pilot chip

**Files:**
- Modify: `public/js/home.js`. Replace the whole file.

**Interfaces:**
- Consumes (Task 1): `eveTime` and `describeScan` from `./home-status.js`.
- Consumes (Task 2): `createMe({ …, line: 'ship' })`.
- Consumes (Task 3): `#eveTime`, `[data-scan]`, `[data-live]`.

- [ ] **Step 1: Replace `public/js/home.js`**

```js
// Home page: the list of tools, your character, EVE time, and how fresh each market scan is.
import { createMe } from './me.js';
import { scanClient } from './scan-client.js';
import { buildGraph, systemInfo } from './galaxy.js';
import { formatIsk } from './arbitrage.js';
import { eveTime, describeScan } from './home-status.js';

let graph = null;
const me = createMe({
  el: document.getElementById('me'), returnTo: location.pathname, isk: formatIsk, onFollow: () => {}, line: 'ship',
  systemName: (id) => (graph ? systemInfo(graph, id)?.name : null) || `System ${id}`,
});
fetch('data/universe.json').then(r => r.json()).then(u => { graph = buildGraph(u); me.reapply(); }).catch(() => {});

const clock = document.getElementById('eveTime');
const tick = () => { const now = new Date(); clock.textContent = eveTime(now); clock.dateTime = now.toISOString(); };
tick();
setInterval(tick, 1000);

async function showScan(kind) {
  let st = null;
  try { st = await scanClient(kind).status(); } catch { /* shown as unavailable */ }
  const d = describeScan(st);
  const chip = document.querySelector(`[data-scan="${kind}"]`);
  chip.dataset.state = d.state;
  chip.querySelector('small').textContent = d.chip;
  for (const el of document.querySelectorAll(`[data-live="${kind}"]`)) {
    el.dataset.state = d.state;
    el.textContent = d.row;
  }
}
for (const kind of ['scan', 'uscan', 'cscan']) showScan(kind);
```

- [ ] **Step 2: Run the unit tests**

Run: `npm test`
Expected: every test passes.

- [ ] **Step 3: Check it in the browser**

Reload `http://localhost:8000/`, then check each of these:
1. Use `javascript_tool` to read `document.getElementById('eveTime').textContent` twice, about 2 s apart. It should match `/^\d\d:\d\d:\d\d$/`, change between the reads, and equal the UTC time.
2. Run `read_page` on the hero. Each chip should show "2h ago"-style text (with an amber dot) or "not yet" (dashed, hollow dot). No chip should be stuck on "…".
3. Rows BI, SR, MR, US, IC and CR should show "SCANNED · …" in amber or "NEEDS A SCAN" in grey. Rows WR, MO, WL, LP and WS should show no status.
4. When signed out, the sign-in button ("Log in with EVE") sits in the pilot slot. If `sso.config.json` is missing, the dashed "EVE login not set up" note shows there instead. Either is correct.

- [ ] **Step 4: Commit**

```bash
git add public/js/home.js
git commit -m "Home: live EVE clock, scan chips and row labels from real scan status"
```

---

### Task 5: Visual verification against the reference (both themes, phone width)

No code changes are expected in this task. Fix anything that fails by editing `public/home.css` or `public/index.html`, then re-check.

**Files:**
- Modify (only if a check fails): `public/home.css`, `public/index.html`

- [ ] **Step 1: Compare with the reference (dark theme, desktop)**

Open the reference `docs/superpowers/specs/home-redesign/Home v4.dc.html` in a second tab. Use `preview_start` with `url` set to the file's `file:///` path. Take a screenshot of each tab at the same width (1440 wide) and compare:
- the header: brand, nav underline, clock, chip and toggle;
- the hero: corner brackets, H1 size, chips, and the stats divider;
- each section's accent line, index, code chips, status colours and arrows;
- the footer.

With `javascript_tool`, spot-check computed values:
- `getComputedStyle(document.querySelector('.row')).gridTemplateColumns` should start with `40px` and end with `20px`.
- `.hero h1` should use the font family `Manrope`.
- `.stats b` should have a `font-size` of `36px`.

- [ ] **Step 2: Check hover and focus**

Hover a row with `computer` `hover` and take a screenshot. The row should show an accent-tinted gradient that fades to the right. Hover the nav link "Mining": it should turn white and get the faint underline. Press Tab through the header and one section: each nav link and row should show a visible focus outline.

- [ ] **Step 3: Check the light theme**

Click `#themeBtn` and take a screenshot. Every surface should switch, with no dark islands left: header, hero, chips, rows and footer. Text should stay readable. Check the amber status text and pink accent against the light background with `javascript_tool` or by eye. If any text fails 4.5:1 contrast, darken that `--h-*` token in the `:root[data-theme=light]` block. Click the toggle again to go back to dark.

- [ ] **Step 4: Check phone width**

Run `resize_window` with the `mobile` preset (375×812), reload, and take a screenshot. Check:
- `document.documentElement.scrollWidth <= innerWidth`, so there is no horizontal page scroll;
- the header wraps with a 16px gutter, and the nav scrolls sideways inside itself;
- the stats sit under the hero text in a 2×2 grid;
- each section's label sits above its rows;
- row status labels drop under the description.

Then run `resize_window` with the `desktop` preset to reset.

- [ ] **Step 5: Check the other pages didn't change**

Open `http://localhost:8000/best-items.html` and take a screenshot. Its header should look exactly as before; `home.css` is not loaded there. The pilot chip should still read `System · docked · … ISK`.

- [ ] **Step 6: Run the tests, then commit any fixes**

Run: `npm test`. Expected: every test passes.

```bash
git add public/home.css public/index.html
git commit -m "Home: polish from visual check against the v4 reference"
```

Skip the commit if nothing changed.

---

## Out of scope / follow-ups

- **Rolling the new header and tokens out to the tool pages.** Other pages keep the old `.topbar`. If the redesign should spread, write a separate plan: move the `--h-*` tokens into `styles.css`, share the header markup, and restyle `.subnav` and the controls.
- The prototype toggles (`scanlines`, `showStatus`).
- Self-hosting the fonts, if Google Fonts becomes a privacy or offline concern.
