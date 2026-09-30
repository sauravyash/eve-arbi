# 3D galaxy map (in-game style) — design

Date: 2026-09-30
Status: approved in chat, awaiting spec review

## Goal

Make the star map on the route pages (`best-items`, `multi-stop`, `single-route`, `watchlist-routes`) rotatable in
3D and looking like the EVE in-game map: real 3D system positions, glowing security-coloured stars, faint gates,
depth, orbit camera. The look is the priority. The arbitrage overlays (routes, hubs, trips, pills, tooltips) must
keep working exactly as they do today.

## Decisions

- **Renderer:** three.js (WebGL) for stars and gates, plus a transparent 2D overlay canvas that reuses the existing
  route/hub/trip painters. Alternatives rejected: fake 3D in Canvas2D (no glow, stutters at 8k systems) and
  off-the-shelf graph libraries (heavy, hard to style, fight the overlays).
- **Default:** the 3D map becomes the default layout. The flat views stay as layout options and as the fallback.
- **Light theme:** gets its own 3D style (darker star colours, normal blending, no glow). It doesn't stay dark.

## Data

`scripts/build-universe.js` writes a new `systems.z3` array: SDE `y` (the vertical axis) in light years, rounded with
`r2` like the others. Regenerate `public/data/universe.json` with `npm run build:map` (about 40 KB more).

If an older `universe.json` has no `z3`, the 3D map treats every height as 0 (a flat plane). It must not throw.

## Coordinates

SDE `(x, y, z)` → world `(x, y, −z)` in light years. EVE's frame is left-handed and three.js is right-handed. Viewed
from straight above (yaw 0, pitch −90°, camera up vector = world −Z, which is SDE +z = north), the projected layout
must equal today's top-down
`(sys.x, sys.y)` = `(x, −z)`: north up, same handedness. A unit test asserts this.

## Camera and controls

- A perspective camera with our own state `{ target: [x,y,z], distance, yaw, pitch }`, not `OrbitControls`.
- Pitch is clamped to about ±89° so the view never flips.
- Distance is clamped from about one region's width to the whole cluster.
  As built: `MIN_DIST = 2` ly and `MAX_DIST = 800` ly (`map3d-math.js`).
- **Drag:** orbit. **Right-drag or shift-drag:** pan the target in the screen plane. **Wheel:** zoom towards the cursor.
- **Touch:** one-finger drag orbits, two-finger drag pans, pinch zooms.
- **Double-click on a system:** animate the target to it (about 400 ms, ease-out). Double-click on empty space zooms in
  (shift zooms out), as today.
- **Click and hover:** same behaviour as today (hub select/deselect, tooltips).
- **`fitIndices` / `fitPath` / `fitHubs` / `fitAll`:** keep yaw/pitch, animate the target to the points' bounding-sphere
  centre and the distance to fit the sphere with the existing padding values.
- **First load:** pitch about 55° down, fit to hubs (as today).
- The camera isn't persisted.
- `zoomBy(factor)` (the +/− buttons) scales the distance around the screen centre.

## Rendering

- **Loading:** three.js, pinned version, is loaded with a dynamic `import()` of its ES-module build from cdnjs (or
  jsdelivr if cdnjs lacks the module build). It's imported only when the 3D layout is first activated. The site has no
  bundler or import map, so it uses a full URL.
  As built: it comes from jsdelivr (`three@0.170.0`), because cdnjs has no ES-module build of r170. The load is raced
  against a 15 s timeout; a hang counts as unavailable (fallback below).
- **Stars:** one `THREE.Points` with a small `ShaderMaterial`: a soft radial sprite per system, colour per system from
  `SEC_COLORS` (or the flat `plain` colour when security colours are off). Sprite size is attenuated by distance and
  clamped in pixels (never vanish, never balloon).
  - **Dark theme:** additive blending, background `#05080c` with a subtle vignette.
  - **Light theme:** normal blending, harder dots in `SEC_COLORS_LIGHT`, background `#eaeff4`.
- **Gates:** one `LineSegments` in the palette gate colour at low opacity, with distance fade (fog on this material
  only).
- **Dimming:** when a hub is selected or a top route shows, star opacity drops to `dotAlpha[0]`, as on the flat map.
- **Frame loop:** render on demand only (camera, data, theme, security colours, size change, or an animation running).
  Renderer pixel ratio `min(devicePixelRatio, 2)`.
- Theme changes (`themechange` event) swap the materials and colours and re-render.

## Overlays, labels, picking

- The WebGL canvas and a 2D overlay canvas are stacked in the map container. The overlay is on top and receives
  pointer events.
- After each WebGL render, all systems are projected to `sx`, `sy`, `depth` (typed arrays) using the camera's
  view-projection matrix. Points behind the camera are marked off-screen (NaN).
- **Shared painters:** `paintRoutes`, `paintHubs`, `paintTrip`, `routePoints`, the hover ring and the palette move out of
  `GalaxyMap` into exported functions in `public/js/map.js`, taking `(ctx, state, sx, sy, P)`. Both renderers call
  them, so route/trip/hub visuals are identical. Routes are drawn as 2D polylines over the stars (always visible, not
  depth-occluded).
- **Labels:**
  - When more than 220 systems are on screen, region names are drawn at each region's 3D centroid, projected, with
    `drawSpaced`, alpha fading with depth.
  - Otherwise, system names are drawn nearest-first, skipping any label whose box overlaps one already drawn.
- **Picking:** screen-space, with the existing radii (8 px systems, 16 px hubs). Ties go to the smallest depth. Tooltip
  HTML and `onSelectHub` behaviour are unchanged (the tooltip builder is shared too).

## Layout setting, switching, fallback

- The `mapLayout` values are `'space' | '3d' | '2d'`, and the default is `'space'`. The select options in all four pages
  read: **In-game 3D** (`space`), **Top-down** (`3d`, formerly "True positions"), **In-game 2D map** (`2d`).
- **Migration:** a stored `mapLayout: '3d'` from before this change becomes `'space'` once (tracked with a settings
  flag so a later deliberate choice of Top-down sticks).
- **Switching:** a small controller in `app.js` (or a `map-switch.js` module) holds the flat `GalaxyMap` and the lazily
  created `GalaxyMap3D`. It forwards `setUniverse`, `update`, `setTrip`, `fit*`, `zoomBy`, `setSecurityColors` to the
  active one and toggles canvas visibility. Model, trip and universe are passed to both, so switching is instant.
- **Fallback:** if WebGL context creation or the three.js import fails, use Top-down. The "In-game 3D" option is then
  disabled with a title explaining why. The schematic view is unaffected.

## Files

- `scripts/build-universe.js`: add `z3`.
- `public/data/universe.json`: regenerated.
- `public/js/map3d-math.js` (new, pure, no DOM or three.js): coordinate mapping, camera → view/projection matrices,
  projection of typed arrays, pitch/distance clamps, fit-sphere → distance, depth-ordered nearest pick, label overlap
  test.
- `public/js/map3d.js` (new): `GalaxyMap3D` with the same public API as `GalaxyMap`.
- `public/js/map.js`: extract the shared painters and the tooltip builder; `GalaxyMap` uses them (no visual change).
- `public/js/app.js`: layout controller, new default and migration.
- `public/{best-items,multi-stop,single-route,watchlist-routes}.html`: the layout select options, and a second canvas
  in the map container. The canvas aria-label mentions rotation.
- `public/styles.css`: stack the canvases.

## Testing

Test-first with `node --test`:

- `map3d-math`: SDE → world mapping; the straight-down view equals top-down positions (up to scale and translation);
  a known point projects to the expected pixel; points behind the camera are culled; pitch clamp; fit distance
  contains all points; nearest pick prefers smaller depth; label overlap.
- The build output contains `z3` with the same length as `id` (extend `test/map.test.js`).
- Settings migration `'3d'` → `'space'` happens once.
- Manual check in the browser preview: orbit, pan, zoom, double-click fly-to, fit buttons, hover tooltip, hub click,
  multi-stop trip overlay, both themes, security-colour toggle, layout switching, and forced fallback (WebGL disabled).

## Out of scope

Skybox or nebula backgrounds, constellation lines, wormhole space, jump-drive ranges, saving the camera, and a 3D
schematic view.
