# Handoff: EVE Hub Arbitrage — Home page redesign

## Overview
A new home page for the Hub Arbitrage trade-tools site. It's a dark, sci-fi feel with a modern look: soft glass surfaces, monospace readouts, and a colour accent for each category. It replaces the current card grid with hairline-divided tool rows and adds no new features.

## About the design files
`Home v4.dc.html` is a **design reference built in HTML**. It is not production code. Rebuild it in the existing codebase, using that codebase's framework, components and routing. To view the reference, open it in a browser (`support.js` must sit next to it). All styles are inline, so you can read exact values straight from the markup.

## Fidelity
**High-fidelity.** Match colours, type, spacing and hover states exactly.

## Page structure (top → bottom)
The page background is `oklch(0.15 0.012 240)`, with a radial glow at top-right: `radial-gradient(1000px 520px at 75% -10%, oklch(0.28 0.05 210 / 0.5), transparent 68%)`.

### 1. Header (sticky)
- Padding `0 32px`. Background `oklch(0.15 0.012 240 / 0.78)` with `backdrop-filter: blur(14px)`. Bottom border `1px oklch(1 0 0 / 0.07)`. Flex layout that wraps, gap 24px.
- **Brand:** a 28px square with 7px radius and a 1.5px teal border, holding a 9px teal diamond. Next to it, "Hub Arbitrage" in Manrope 15/700. Below that, "TRADE TOOLS · READ-ONLY" in JetBrains Mono 10.5px, uppercase, tracking 0.08em, muted colour.
- **Nav:** Home, Hub arbitrage, Market watch, Contracts, Mining. Manrope 13.5px, padding `0 14px`, full header height.
  - Active item: weight 600, white text, `inset 0 -2px 0` teal underline.
  - Idle item: weight 500, `oklch(0.74 0.01 230)`.
  - Hover: white text with an underline at `oklch(1 0 0 / 0.18)`.
- **EVE time:** a live UTC clock, `HH:MM:SS`, updated every second. The label "EVE TIME" is Mono 10px; the time is Mono 13px.
- **Pilot chip:** 8px radius, background `oklch(1 0 0 / 0.04)`, 1px border at `oklch(1 0 0 / 0.08)`.
  - Portrait: 32px, 6px radius, with a green online dot at bottom-right.
  - Name: Manrope 13.5/600.
  - Subline: Mono 10.5px, "Ship · docked · ", then the wallet amount in amber.
- **Theme toggle:** a 34px button with 8px radius. Hover turns the border teal.

### 2. Hero panel
- Page container: `max-width 1280px`, padding `48px 32px 88px`, vertical gap between blocks 56px.
- Panel: 16px radius, 1px border at `oklch(1 0 0 / 0.08)`, background `linear-gradient(125deg, oklch(0.21 0.03 205 / .9), oklch(0.17 0.014 238 / .9) 60%)`, padding `44px 48px`.
- Corner brackets: 14px L-shapes in teal at the top-left and bottom-right, inset 12px.
- **Left column** (flex basis 460px):
  - Eyebrow: "MARKET INTELLIGENCE", Mono 11.5px, tracking 0.14em, teal, with a glowing dot.
  - H1: "Find the ISK the hubs don't show", Manrope 600, `clamp(36px, 4.6vw, 58px)`, line-height 1.04, tracking -0.03em.
  - Body: 17px, line-height 1.55, `oklch(0.75 0.012 230)`, max-width 600px.
- **Scan chips:** Mono 11.5px, 6px radius, 1px border.
  - Colour dot: amber means scanned; a hollow grey dot with a dashed border means not scanned yet.
  - Content: "HUB SCAN 2h ago", "UNIVERSE SCAN 2h ago", "CONTRACT SCAN not yet".
- **Right column** (basis 320px): a 2×2 stats grid with a 1px divider on its left.
  - Numbers: Mono 36px/500 in `oklch(0.86 0.09 195)`.
  - Labels: 12.5px, uppercase, tracking 0.06em.
  - Stats: 5 Trade hubs · 67 Regions · 9 Price sources · 11 Tools.

### 3. Tool sections (×4)
Each section is a flex row that wraps, gap 32px.

- **Label column** (basis 220px, max 270px):
  - Top border: 1px in the section accent at 60% alpha, with 16px padding above the content.
  - Index: "01 — 4 TOOLS", Mono 11px, tracking 0.14em, in the accent colour.
  - H2: Manrope 22/600, tracking -0.015em.
  - Description: 15px, line-height 1.55, muted colour.
- **Tool list** (basis 540px): a vertical list with **no card or background**, and a 1px top border at `oklch(1 0 0 / 0.08)`.
- **Each row:**
  - Grid columns `40px | 1fr | auto | 20px`, gap 18px, padding `18px 4px`, bottom border 1px at `oklch(1 0 0 / 0.06)`.
  - Code chip: Mono 11px, 5px radius, accent text on the accent at 12% alpha. Codes: BI, SR, MR, WR, US, MO, WL, IC, CR, LP, WS.
  - Title: Manrope 16.5/600.
  - Description: 14.5px, line-height 1.5, `oklch(0.7 0.012 230)`.
  - Status (optional): Mono 11px. "SCANNED · 2H AGO" is amber; "NEEDS A SCAN" is grey `oklch(0.7 0.01 230)`.
  - Arrow: "→" in the accent colour.
  - Hover: background `linear-gradient(90deg, accent / 0.07, transparent 80%)`, 150ms transition. The whole row is a link.

| # | Section | Accent | Tools |
|---|---|---|---|
| 01 | Hub arbitrage | teal `oklch(0.82 0.1 195)` | Best items, Single route, Multi-stop routes, Watchlist routes |
| 02 | Market watch | blue `oklch(0.78 0.11 255)` | Universe scan, My orders, Watchlist |
| 03 | Contracts | amber `oklch(0.85 0.1 80)` | Item contracts, Courier, LP stores |
| 04 | Mining | pink `oklch(0.78 0.12 350)` | Where to sell |

Copy all text exactly as it appears in the HTML file.

### 4. Footer
- Top border 1px at `oklch(1 0 0 / 0.06)`, padding `20px 32px`.
- Mono 11px, uppercase: "PUBLIC MARKET DATA · READ-ONLY" on the left and "NOT AFFILIATED WITH THE GAME'S PUBLISHER" on the right.

## Interactions & state
- **Clock:** EVE time is UTC, updated with a 1-second interval.
- **Scan status:** each scan status (hub, universe, contract) should come from real scan timestamps. Map them to "scanned · Xh ago" (amber) or "needs a scan" (grey).
- **Pilot chip:** shows only when the user is signed in. Otherwise, show a sign-in button in the same slot.
- **Optional toggles in the prototype:**
  - `showStatus` hides or shows the status labels on rows.
  - `scanlines` adds a subtle CRT overlay: `repeating-linear-gradient(0deg, oklch(1 0 0/.016) 0 1px, transparent 1px 3px)`. It is off by default.
- **Responsive:** the label column and the tool list wrap into a stack on narrow screens, and the hero columns stack too. Nothing uses a fixed height.

## Design tokens
**Colours (oklch):**

| Token | Value |
|---|---|
| bg | `0.15 0.012 240` |
| text | `0.94 0.006 230` |
| body text | `0.75 0.012 230` |
| muted | `0.70 0.012 230` |
| subtle | `0.66 0.012 230` |
| hairlines | `oklch(1 0 0 / 0.06–0.08)` |
| online | `0.8 0.14 150` |

Accent colours are listed in the section table above.

**Other tokens:**
- **Type:** Manrope (400–700) for the UI; JetBrains Mono (400–500) for data, labels and codes. Both are on Google Fonts.
- **Radii:** 5 (chips), 6–8 (small controls), 16 (hero panel).
- **Spacing:** 4, 8, 12, 14, 18, 24, 28, 32, 48, 56.

## Assets
- There are no image assets. The pilot portrait is a striped placeholder; swap in the character portrait from the game's image server.
- The icons are text code chips, not icon glyphs.

## Files
- `Home v4.dc.html`: the design reference.
- `support.js`: the runtime needed to open the reference in a browser.
