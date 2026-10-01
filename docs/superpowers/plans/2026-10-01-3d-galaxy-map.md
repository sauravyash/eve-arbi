# 3D Galaxy Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-game style 3D star map ("In-game 3D") as the default layout of the route-page star map: real 3D positions, glowing security-coloured stars, faint gates, and an orbit camera. The existing route/hub/trip overlays keep working unchanged.

**Architecture:** three.js (WebGL, loaded lazily from a CDN) draws the stars and gates on one canvas. A transparent 2D canvas on top reuses the flat map's overlay painters, which are extracted from `GalaxyMap` into shared functions, fed with screen positions projected by a pure maths module. A small controller (`map-switch.js`) holds the flat `GalaxyMap` and the 3D `GalaxyMap3D`, forwards every call to both, and falls back to the flat map when WebGL or the CDN fails.

**Tech Stack:** Vanilla JS ES modules (no bundler), three.js r170 ES module from jsdelivr, Canvas 2D, `node:test`, and a Node dev server (`node server.js`, port 8000; `.claude/launch.json` entry `eve-arbi`).

**Spec:** `docs/superpowers/specs/2026-09-30-3d-galaxy-map-design.md`

## Global Constraints

- **Coordinates:** SDE `(x, y, z)` → world `(x, y, −z)` in light years. Given `universe.json` fields, world = `(systems.x, systems.z3, systems.y)`.
- **Straight-down view:** yaw 0, pitch π/2, camera up = world −Z. This must reproduce the current top-down layout (north up, same handedness).
- **three.js:** pinned to `https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js`. It's imported only when the 3D layout is first activated. There's no import map; `map3d.js` receives `THREE` as a parameter and never imports it.
- **`mapLayout` values:** `'space' | '3d' | '2d'`, default `'space'`. The select labels are **In-game 3D** (`space`), **Top-down** (`3d`), **In-game 2D map** (`2d`).
- **Migration:** a stored `mapLayout: '3d'` without the `mapV` flag becomes the default once. `mapV: 1` is then saved.
- **Rendering:** render on demand only, no continuous loop. Renderer pixel ratio `min(devicePixelRatio, 2)`.
- **Dark theme:** additive blending, soft glow sprites, and a vignette. **Light theme:** normal blending, hard dots in `SEC_COLORS_LIGHT`, no vignette.
- **Overlays:** route/hub/trip visuals must be identical to the flat map (shared painters). Routes are drawn on top of the stars, never depth-occluded.
- **Picking:** screen-space, 8 px for systems and 16 px for hubs. Near-ties go to the smaller depth.
- **Labels:** more than 220 systems on screen → region names; otherwise system names, placed nearest-first with overlapping labels skipped.
- **Fallback:** if WebGL or three.js fails, use Top-down and disable the "In-game 3D" option with a title explaining why.
- A `universe.json` without `z3` must not throw: height 0 everywhere.
- Match the code style: 2-space indent, single quotes, semicolons, terse comments, `Float32Array` for per-system data, lines ≤ 120 chars.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `scripts/build-universe.js` | modify | Also write `systems.z3` (SDE `y`, light years). |
| `public/data/universe.json` | regenerate | Adds `z3`. |
| `public/js/map3d-math.js` | create | Pure maths: world positions, camera basis, projection, orbit/pan/zoom, fit, easing, picking, label placement, region centres. No DOM, no three.js. |
| `public/js/map.js` | modify | Export the palette helpers and the shared overlay painters (`paintRoutes`, `paintHubs`, `paintTrip`, `routePoints`, `tooltipHtml`, `placeTooltip`, `drawSpaced`); `GalaxyMap` uses them. |
| `public/js/map3d.js` | create | `GalaxyMap3D`: three.js scene, camera sync, input, overlay painting. The same public API as `GalaxyMap`. |
| `public/js/map-switch.js` | create | `createMapSwitch` controller, `loadThree`, `migrateMapLayout`. |
| `public/js/app.js` | modify | Defaults, migration, URL field values, and building the map through `createMapSwitch`. |
| `public/{best-items,multi-stop,single-route,watchlist-routes}.html` | modify | Layout options and two new canvases. |
| `public/styles.css` | modify | Stack the map canvases and honour `[hidden]`. |
| `test/map.test.js` | modify | Build `z3` test, shared-painter tests. |
| `test/map3d-math.test.js` | create | Maths tests. |
| `test/map-switch.test.js` | create | Controller and migration tests. |

Run all tests with `npm test` (`node --test`). A single file: `node --test test/map3d-math.test.js`.

---

### Task 1: Vertical coordinate in the universe data

**Files:**
- Modify: `scripts/build-universe.js:1-4` (header comment), `:72` (`sys` object), `:84` (after the `y2` push)
- Modify: `test/map.test.js`
- Regenerate: `public/data/universe.json`

**Interfaces:**
- Produces: `universe.json` → `systems.z3: number[]`, the same length as `systems.id`, in light years, rounded to 0.01, positive = SDE +y.

- [ ] **Step 1: Write the failing test.** Add these imports at the top of `test/map.test.js` (the existing `readFile` import stays):

```js
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
```

Change the existing build import to `import { parseCsv, OUT_FILE, buildUniverse } from '../scripts/build-universe.js';`. Then append:

```js
test('buildUniverse writes the vertical position z3 in light years', async () => {
  const LY = 9460730472580800;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sde-'));
  try {
    await writeFile(path.join(dir, 'mapSolarSystems.csv'),
      'regionID,solarSystemID,solarSystemName,x,y,z,position2Dx,position2Dy,security\n' +
      `10000002,30000142,Jita,${-1 * LY},${2.5 * LY},${3 * LY},0,0,0.9459\n` +
      `10000002,30000144,Perimeter,${2 * LY},${-0.25 * LY},${0.5 * LY},0,0,0.9\n`);
    await writeFile(path.join(dir, 'mapSolarSystemJumps.csv'),
      'fromSolarSystemID,toSolarSystemID\n30000142,30000144\n30000144,30000142\n');
    await writeFile(path.join(dir, 'mapRegions.csv'), 'regionID,regionName\n10000002,The Forge\n');
    const u = await buildUniverse({ fromDir: dir, outFile: path.join(dir, 'u.json'), log: () => {} });
    assert.deepEqual(u.systems.z3, [2.5, -0.25]);
    assert.deepEqual(u.systems.x, [-1, 2]);
    assert.deepEqual(u.systems.y, [-3, -0.5]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test and check it fails.** Run `node --test test/map.test.js`. Expected: FAIL, `z3` is `undefined`.

- [ ] **Step 3: Implement it.** In `scripts/build-universe.js`:
  - Change the header bullet to: `//  - public/data/universe.json: every known-space system (3D position as top-down x/y plus height z3, CCP's 2D map`. The next line continues: `//    layout, security, region) and every stargate link, for the star map.`
  - Change the `sys` initialiser to `const sys = { id: [], name: [], x: [], y: [], z3: [], x2: [], y2: [], sec: [], region: [] };`
  - After `sys.y.push(r2(-Number(s.z) / LY));` add:

```js
    // Height above the galactic plane, for the 3D map (map3d-math.js): world = (x, z3, y).
    sys.z3.push(r2(Number(s.y) / LY));
```

- [ ] **Step 4: Run the test and check it passes.** Run `node --test test/map.test.js`. Expected: PASS.

- [ ] **Step 5: Regenerate the committed data.** This fetches from fuzzwork.co.uk and rebuilds only `universe.json`:

```bash
node --input-type=module -e "import('./scripts/build-universe.js').then(m => m.buildUniverse())"
```

Expected log: `Star map: 5255 systems, … gates, … regions → public/data/universe.json (~385 KB)`. The count may differ slightly if CCP changed the map.

- [ ] **Step 6: Make the real data test strict.** In the existing test `built universe contains every hub, gate-connected to Jita`, after `const { id } = u.systems;` add:

```js
  assert.equal(u.systems.z3?.length, id.length, 'z3 present for every system');
```

Run `npm test`. Expected: all pass.

- [ ] **Step 7: Commit.**

```bash
git add scripts/build-universe.js test/map.test.js public/data/universe.json
git commit -m "Star map data: add each system's height (z3) for the 3D map

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Pure 3D maths: world positions, camera basis, projection

**Files:**
- Create: `public/js/map3d-math.js`
- Create: `test/map3d-math.test.js`

**Interfaces:**
- Produces:
  - Constants: `FOV_Y` (radians), `NEAR`, `PITCH_MAX`, `MIN_DIST`, `MAX_DIST`.
  - `worldPositions(systems) → Float32Array(3n)`, interleaved `[X, Y, Z]`.
  - Camera object: `{ target: [x, y, z], distance, yaw, pitch }`, radians. Pitch is the camera's elevation above the target (π/2 = straight down).
  - `cameraBasis(cam) → { eye, fwd, right, up }`, each `[x, y, z]`.
  - `focalPx(h) → number`, pixels per unit of camera-space x/depth.
  - `projectAll(pos, cam, w, h, out?) → { sx, sy, depth }` (`Float32Array`s). Behind-camera points get `NaN` sx/sy. `out` is reused when its length matches.
  - `projectPoint([x, y, z], cam, w, h) → [sx, sy, depth]`.

- [ ] **Step 1: Write the failing tests.** Create `test/map3d-math.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  worldPositions, cameraBasis, focalPx, projectAll, projectPoint,
} from '../public/js/map3d-math.js';

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const W = 800, H = 600;

test('worldPositions maps universe fields to (x, z3, y)', () => {
  const p = worldPositions({ id: [1, 2], x: [1, -2], y: [3, 4], z3: [5, -6] });
  assert.deepEqual([...p], [1, 5, 3, -2, -6, 4]);
});

test('worldPositions treats a missing z3 as height 0', () => {
  const p = worldPositions({ id: [1], x: [1], y: [2] });
  assert.deepEqual([...p], [1, 0, 2]);
});

test('the straight-down camera reproduces the flat top-down layout', () => {
  const systems = { id: [1, 2, 3], x: [0, 10, -4], y: [0, -7, 12], z3: [0, 0, 0] };
  const cam = { target: [0, 0, 0], distance: 100, yaw: 0, pitch: Math.PI / 2 };
  const { sx, sy } = projectAll(worldPositions(systems), cam, W, H);
  const s = focalPx(H) / 100;
  for (let i = 0; i < 3; i++) {
    near(sx[i], W / 2 + systems.x[i] * s);
    near(sy[i], H / 2 + systems.y[i] * s); // flat map: screen y = systems.y, north up
  }
});

test('camera basis: eye sits distance away and up is north when looking down', () => {
  const cam = { target: [5, 1, -3], distance: 40, yaw: 0.7, pitch: 0.4 };
  const { eye } = cameraBasis(cam);
  near(Math.hypot(eye[0] - 5, eye[1] - 1, eye[2] + 3), 40);
  const down = cameraBasis({ target: [0, 0, 0], distance: 1, yaw: 0, pitch: Math.PI / 2 });
  near(down.up[0], 0); near(down.up[1], 0); near(down.up[2], -1);
  near(down.right[0], 1);
});

test('the target projects to the centre at depth = distance', () => {
  const cam = { target: [3, 2, 1], distance: 50, yaw: 1.1, pitch: 0.6 };
  const [x, y, d] = projectPoint([3, 2, 1], cam, W, H);
  near(x, W / 2); near(y, H / 2); near(d, 50);
});

test('points behind the camera are culled as NaN', () => {
  const cam = { target: [0, 0, 0], distance: 10, yaw: 0, pitch: 0 }; // eye at +Z looking toward −Z
  const [x, y] = projectPoint([0, 0, 30], cam, W, H);
  assert.ok(Number.isNaN(x) && Number.isNaN(y));
});

test('projectAll reuses an output buffer of the right size', () => {
  const pos = worldPositions({ id: [1], x: [0], y: [0] });
  const cam = { target: [0, 0, 0], distance: 10, yaw: 0, pitch: 1 };
  const a = projectAll(pos, cam, W, H);
  assert.equal(projectAll(pos, cam, W, H, a), a);
});
```

- [ ] **Step 2: Run the tests and check they fail.** Run `node --test test/map3d-math.test.js`. Expected: FAIL, cannot find module `map3d-math.js`.

- [ ] **Step 3: Implement it.** Create `public/js/map3d-math.js`:

```js
// Pure maths for the in-game style 3D star map (map3d.js): no DOM, no three.js, so it runs under node --test.
// World space is three.js's right-handed frame in light years: X east, Y up, Z south. SDE (x, y, z) → (x, y, −z),
// and universe.json already stores x and −z as systems.x / systems.y for the flat map, so world = (x, z3, y).

export const FOV_Y = 50 * Math.PI / 180;
export const NEAR = 0.01;
export const PITCH_MAX = 89 * Math.PI / 180;
export const MIN_DIST = 2, MAX_DIST = 800; // light years from the camera to its target

export function worldPositions(systems) {
  const n = systems.id.length, out = new Float32Array(n * 3), z3 = systems.z3;
  for (let i = 0; i < n; i++) {
    out[i * 3] = systems.x[i];
    out[i * 3 + 1] = z3 ? z3[i] : 0;
    out[i * 3 + 2] = systems.y[i];
  }
  return out;
}

// Camera: { target: [x, y, z], distance, yaw, pitch }. pitch is the camera's elevation above the target (π/2 looks
// straight down with north up); yaw 0 looks north.
export function cameraBasis({ target: [tx, ty, tz], distance: d, yaw, pitch }) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw);
  const eye = [tx + d * cp * sy, ty + d * sp, tz + d * cp * cy];
  const fwd = [-cp * sy, -sp, -cp * cy];
  const right = [cy, 0, -sy];
  return { eye, fwd, right, up: cross(right, fwd) };
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// Pixels per unit of (camera-space x / depth) for a viewport h px tall.
export const focalPx = (h) => h / 2 / Math.tan(FOV_Y / 2);

// Screen position and depth of every point in pos (interleaved xyz); behind the camera → NaN.
export function projectAll(pos, cam, w, h, out) {
  const n = pos.length / 3;
  if (!out || out.sx.length !== n) out = { sx: new Float32Array(n), sy: new Float32Array(n), depth: new Float32Array(n) };
  const { eye: [ex, ey, ez], fwd: f, right: r, up: u } = cameraBasis(cam);
  const k = focalPx(h), cx = w / 2, cy = h / 2;
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3] - ex, y = pos[i * 3 + 1] - ey, z = pos[i * 3 + 2] - ez;
    const dz = x * f[0] + y * f[1] + z * f[2];
    out.depth[i] = dz;
    if (dz < NEAR) { out.sx[i] = NaN; out.sy[i] = NaN; continue; }
    out.sx[i] = cx + (x * r[0] + y * r[1] + z * r[2]) / dz * k;
    out.sy[i] = cy - (x * u[0] + y * u[1] + z * u[2]) / dz * k;
  }
  return out;
}

export function projectPoint(p, cam, w, h) {
  const { sx, sy, depth } = projectAll(Float32Array.from(p), cam, w, h);
  return [sx[0], sy[0], depth[0]];
}
```

- [ ] **Step 4: Run the tests and check they pass.** Run `node --test test/map3d-math.test.js`. Expected: PASS (7 tests).

- [ ] **Step 5: Commit.**

```bash
git add public/js/map3d-math.js test/map3d-math.test.js
git commit -m "3D map maths: world positions, camera basis, projection

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Camera operations: orbit, pan, zoom, fit, fly-to easing

**Files:**
- Modify: `public/js/map3d-math.js` (append)
- Modify: `test/map3d-math.test.js` (append, and extend the import)

**Interfaces:**
- Consumes: `cameraBasis`, `focalPx`, `projectAll`, `projectPoint`, and the constants from Task 2.
- Produces. Every operation returns a **new** camera and never mutates its input:
  - `clampPitch(p)`, `clampDistance(d)`
  - `orbit(cam, dx, dy, speed = 0.005)`
  - `pan(cam, dx, dy, h)`: the old target moves `(dx, dy)` px on screen.
  - `zoomAt(cam, factor, px, py, w, h)`: distance ÷ factor, keeping the point under (px, py) fixed.
  - `fitSphere(pos, indices, pad, w, h) → { target, distance }`
  - `lerpCamera(a, b, t)`: ease-out cubic; distance interpolated geometrically.

- [ ] **Step 1: Write the failing tests.** Extend the import in `test/map3d-math.test.js` with `orbit, pan, zoomAt, fitSphere, lerpCamera, clampDistance, PITCH_MAX, MIN_DIST, MAX_DIST`, then append:

```js
const CAM = { target: [10, 2, -5], distance: 60, yaw: 0.8, pitch: 0.5 };

test('orbit turns yaw and clamps pitch short of the poles', () => {
  const c = orbit(CAM, 100, 0);
  near(c.yaw, CAM.yaw - 0.5);
  assert.equal(orbit(CAM, 0, 1e6).pitch, PITCH_MAX);
  assert.equal(orbit(CAM, 0, -1e6).pitch, -PITCH_MAX);
  assert.equal(CAM.yaw, 0.8, 'input not mutated');
});

test('pan moves the old target by the drag in pixels', () => {
  const c = pan(CAM, 40, -25, H);
  const [x, y] = projectPoint(CAM.target, c, W, H);
  near(x, W / 2 + 40); near(y, H / 2 - 25);
  assert.equal(c.distance, CAM.distance);
});

test('zoomAt keeps the point under the cursor fixed', () => {
  const px = 620, py = 170;
  const c = zoomAt(CAM, 2, px, py, W, H);
  near(c.distance, 30);
  // A world point that was under the cursor at target depth stays under it.
  const q = pointUnder(CAM, px, py);
  const [x, y] = projectPoint(q, c, W, H);
  near(x, px); near(y, py);
});

test('zoomAt clamps distance', () => {
  assert.equal(zoomAt(CAM, 1e9, W / 2, H / 2, W, H).distance, MIN_DIST);
  assert.equal(zoomAt(CAM, 1e-9, W / 2, H / 2, W, H).distance, clampDistance(MAX_DIST * 10));
});

test('fitSphere frames every point on screen at any angle', () => {
  const pts = [0, 0, 0, 30, 5, -10, -12, -4, 22, 8, 9, 3];
  const pos = Float32Array.from(pts);
  for (const [yaw, pitch] of [[0, 1.2], [2.1, 0.2], [-1, -0.7]]) {
    const fit = fitSphere(pos, [0, 1, 2, 3], 0.1, W, H);
    const { sx, sy } = projectAll(pos, { ...fit, yaw, pitch }, W, H);
    for (let i = 0; i < 4; i++) assert.ok(sx[i] >= 0 && sx[i] <= W && sy[i] >= 0 && sy[i] <= H, `point ${i} on screen`);
  }
});

test('lerpCamera eases from a to b with geometric distance', () => {
  const a = { target: [0, 0, 0], distance: 10, yaw: 0, pitch: 0.2 };
  const b = { target: [10, 0, 0], distance: 1000, yaw: 1, pitch: 1 };
  assert.deepEqual(lerpCamera(a, b, 0), a);
  assert.deepEqual(lerpCamera(a, b, 1), b);
  const m = lerpCamera(a, b, 0.5); // eased 0.875
  near(m.target[0], 8.75);
  near(m.distance, 10 * 100 ** 0.875, 1e-6 * m.distance);
});

// World point at the target's depth under (px, py), via the same focal maths as the renderer.
function pointUnder(cam, px, py) {
  const { right: r, up: u } = cameraBasis(cam);
  const s = cam.distance / focalPx(H), a = (px - W / 2) * s, b = -(py - H / 2) * s;
  return cam.target.map((t, k) => t + r[k] * a + u[k] * b);
}
```

- [ ] **Step 2: Run the tests and check they fail.** Run `node --test test/map3d-math.test.js`. Expected: FAIL, `orbit` is not exported.

- [ ] **Step 3: Implement it.** Append to `public/js/map3d-math.js`:

```js
export const clampPitch = (p) => Math.max(-PITCH_MAX, Math.min(PITCH_MAX, p));
export const clampDistance = (d) => Math.max(MIN_DIST, Math.min(MAX_DIST, d));

// Drag to orbit around the target, like the in-game map.
export const orbit = (cam, dx, dy, speed = 0.005) =>
  ({ ...cam, yaw: cam.yaw - dx * speed, pitch: clampPitch(cam.pitch + dy * speed) });

// Target moved by (a, b) light years along the screen's right and up axes.
function shiftTarget(cam, a, b) {
  const { right: r, up: u } = cameraBasis(cam);
  return cam.target.map((t, k) => t + r[k] * a + u[k] * b);
}

// Drag the scene by (dx, dy) px in the plane through the target.
export function pan(cam, dx, dy, h) {
  const s = cam.distance / focalPx(h);
  return { ...cam, target: shiftTarget(cam, -dx * s, dy * s) };
}

// Zoom by factor toward screen point (px, py), keeping what's under it (at the target's depth) in place.
export function zoomAt(cam, factor, px, py, w, h) {
  const distance = clampDistance(cam.distance / factor);
  const s = cam.distance / focalPx(h);
  const q = shiftTarget(cam, (px - w / 2) * s, -(py - h / 2) * s);
  const keep = distance / cam.distance;
  return { ...cam, distance, target: q.map((v, k) => v + (cam.target[k] - v) * keep) };
}

// Target and distance that show every indexed point, with pad as a fraction of the span on each side.
export function fitSphere(pos, indices, pad, w, h) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const i of indices) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k], pos[i * 3 + k]); hi[k] = Math.max(hi[k], pos[i * 3 + k]);
  }
  const target = lo.map((v, k) => (v + hi[k]) / 2);
  let r2 = 1;
  for (const i of indices) {
    r2 = Math.max(r2, (pos[i * 3] - target[0]) ** 2 + (pos[i * 3 + 1] - target[1]) ** 2 + (pos[i * 3 + 2] - target[2]) ** 2);
  }
  const half = Math.min(FOV_Y / 2, Math.atan(Math.tan(FOV_Y / 2) * w / h));
  return { target, distance: clampDistance(Math.sqrt(r2) * (1 + 2 * pad) / Math.sin(half)) };
}

// Fly-to animation step: ease-out cubic, distance interpolated in log space so zooms feel even.
export function lerpCamera(a, b, t) {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const e = 1 - (1 - t) ** 3, mix = (x, y) => x + (y - x) * e;
  return {
    target: a.target.map((v, k) => mix(v, b.target[k])),
    distance: Math.exp(mix(Math.log(a.distance), Math.log(b.distance))),
    yaw: mix(a.yaw, b.yaw),
    pitch: mix(a.pitch, b.pitch),
  };
}
```

- [ ] **Step 4: Run the tests and check they pass.** Run `node --test test/map3d-math.test.js`. Expected: PASS (13 tests).

- [ ] **Step 5: Commit.**

```bash
git add public/js/map3d-math.js test/map3d-math.test.js
git commit -m "3D map maths: orbit, pan, zoom to cursor, fit and fly-to easing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Picking, label placement, region centres

**Files:**
- Modify: `public/js/map3d-math.js` (append)
- Modify: `test/map3d-math.test.js` (append, and extend the import)

**Interfaces:**
- Produces:
  - `pickNearest(sx, sy, depth, px, py, maxPx) → index | -1`. The nearest on screen wins; within 1 px² of the best, the smaller depth wins; NaN points are skipped.
  - `placeLabels(boxes) → number[]`: indices of `{x, y, w, h}` boxes kept greedily in the given (priority) order with no overlaps.
  - `regionCentres(pos, region, nRegions) → Array<[x, y, z] | null>`

- [ ] **Step 1: Write the failing tests.** Extend the import with `pickNearest, placeLabels, regionCentres`, then append:

```js
test('pickNearest takes the closest point within range', () => {
  const sx = Float32Array.of(100, 110, 300), sy = Float32Array.of(100, 100, 300), d = Float32Array.of(5, 9, 1);
  assert.equal(pickNearest(sx, sy, d, 108, 101, 8), 1);
  assert.equal(pickNearest(sx, sy, d, 200, 200, 8), -1);
});

test('pickNearest prefers the point nearer the camera when they overlap', () => {
  const sx = Float32Array.of(50, 50), sy = Float32Array.of(50, 50), d = Float32Array.of(20, 3);
  assert.equal(pickNearest(sx, sy, d, 51, 50, 8), 1);
});

test('pickNearest skips culled (NaN) points', () => {
  const sx = Float32Array.of(NaN, 60), sy = Float32Array.of(NaN, 60), d = Float32Array.of(-1, 4);
  assert.equal(pickNearest(sx, sy, d, 60, 61, 8), 1);
});

test('placeLabels keeps earlier boxes and drops later overlapping ones', () => {
  const boxes = [
    { x: 0, y: 0, w: 50, h: 12 },
    { x: 40, y: 5, w: 50, h: 12 },  // overlaps 0
    { x: 50, y: 0, w: 30, h: 12 },  // touches 0's edge only
    { x: 0, y: 20, w: 10, h: 10 },
  ];
  assert.deepEqual(placeLabels(boxes), [0, 2, 3]);
});

test('regionCentres averages each region and leaves empty ones null', () => {
  const pos = Float32Array.of(0, 0, 0, 2, 4, 6, 10, 10, 10);
  assert.deepEqual(regionCentres(pos, [0, 0, 2], 3), [[1, 2, 3], null, [10, 10, 10]]);
});
```

- [ ] **Step 2: Run the tests and check they fail.** Run `node --test test/map3d-math.test.js`. Expected: FAIL, `pickNearest` is not exported.

- [ ] **Step 3: Implement it.** Append to `public/js/map3d-math.js`:

```js
// System under the cursor: nearest on screen within maxPx; near-ties go to the one nearer the camera.
export function pickNearest(sx, sy, depth, px, py, maxPx) {
  const lim = maxPx * maxPx;
  let best = -1, bd = Infinity;
  for (let i = 0; i < sx.length; i++) {
    const d = (sx[i] - px) ** 2 + (sy[i] - py) ** 2;
    if (!(d <= lim)) continue; // NaN (culled) fails too
    if (best < 0 || d < bd - 1 || (d <= bd + 1 && depth[i] < depth[best])) { best = i; bd = d; }
  }
  return best;
}

// Greedy label layout: boxes in priority order, each kept unless it overlaps one already kept.
export function placeLabels(boxes) {
  const kept = [];
  for (let k = 0; k < boxes.length; k++) {
    const b = boxes[k];
    const clear = kept.every((j) => {
      const o = boxes[j];
      return b.x + b.w <= o.x || o.x + o.w <= b.x || b.y + b.h <= o.y || o.y + o.h <= b.y;
    });
    if (clear) kept.push(k);
  }
  return kept;
}

// Mean world position of each region's systems (region[i] indexes regions).
export function regionCentres(pos, region, nRegions) {
  const acc = Array.from({ length: nRegions }, () => [0, 0, 0, 0]);
  for (let i = 0; i < region.length; i++) {
    const a = acc[region[i]];
    a[0] += pos[i * 3]; a[1] += pos[i * 3 + 1]; a[2] += pos[i * 3 + 2]; a[3]++;
  }
  return acc.map(([x, y, z, c]) => (c ? [x / c, y / c, z / c] : null));
}
```

- [ ] **Step 4: Run the tests and check they pass.** Run `node --test test/map3d-math.test.js`. Expected: PASS (18 tests).

- [ ] **Step 5: Commit.**

```bash
git add public/js/map3d-math.js test/map3d-math.test.js
git commit -m "3D map maths: depth-aware picking, label placement, region centres

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Share the flat map's overlay painters

This is a refactor of `public/js/map.js` with no visual change. The flat map must look and behave exactly as before.

**Files:**
- Modify: `public/js/map.js`
- Modify: `test/map.test.js`

**Interfaces:**
- Produces (new exports from `public/js/map.js`). `state` is any object with `{ u, model, trip }` shaped like `GalaxyMap`'s fields (`u.indexOf`, `u.id`, `u.name`, `u.sec`, `u.region`, `u.regions`):
  - `isLightTheme() → boolean`, `palette() → P`, `SEC_COLORS`, `SEC_COLORS_LIGHT`
  - `routePoints(state, route, sx, sy) → [[x, y], …] | null`: skips systems with NaN screen positions.
  - `paintRoutes(ctx, state, sx, sy, P)`, `paintHubs(ctx, state, sx, sy, P)`, `paintTrip(ctx, state, sx, sy, P)`
  - `tooltipHtml(state, i, isHub) → string`
  - `placeTooltip(tip, html, px, py, w)`: sets `innerHTML`, shows it, positions it inside width `w`.
  - `drawSpaced(ctx, text, x, y)`, `clamp(v, a, b)`
- `GalaxyMap`'s public API is unchanged.

- [ ] **Step 1: Write the failing tests.** In `test/map.test.js`, change the map import to `import { secBand, secLabel, routePoints, tooltipHtml } from '../public/js/map.js';` and append:

```js
const U = {
  id: [1, 2, 3], name: ['Jita', 'Per<i>meter', 'Urlen'], sec: [0.95, 0.9, 0.85], region: [0, 0, 0],
  regions: [{ name: 'The Forge' }], indexOf: new Map([[1, 0], [2, 1], [3, 2]]),
};

test('routePoints follows the route path and skips culled systems', () => {
  const state = { u: U, model: { pathFor: () => [1, 2, 3] } };
  const sx = Float32Array.of(0, NaN, 20), sy = Float32Array.of(5, NaN, 25);
  assert.deepEqual(routePoints(state, {}, sx, sy), [[0, 5], [20, 25]]);
  assert.equal(routePoints({ u: U, model: { pathFor: () => [1, 2] } }, {}, sx, sy), null);
});

test('tooltipHtml escapes names and adds the hub hint', () => {
  const html = tooltipHtml({ u: U, model: null }, 1, false);
  assert.match(html, /Per&lt;i&gt;meter/);
  assert.match(html, /The Forge/);
  assert.doesNotMatch(html, /Click to show/);
  assert.match(tooltipHtml({ u: U, model: null }, 0, true), /Click to show best outgoing route/);
});
```

- [ ] **Step 2: Run the tests and check they fail.** Run `node --test test/map.test.js`. Expected: FAIL, `routePoints` is not exported.

- [ ] **Step 3: Refactor `public/js/map.js`.**

  1. Export the colours and palette. Change `const SEC_COLORS = [` to `export const SEC_COLORS = [` and `const SEC_COLORS_LIGHT =` to `export const SEC_COLORS_LIGHT =`. Replace the `palette` line with:

```js
export const isLightTheme = () => document.documentElement.dataset.theme === 'light';
export const palette = () => PALETTES[isLightTheme() ? 'light' : 'dark'];
```

  2. Delete the methods `routePoints`, `paintRoutes`, `paintTrip`, `paintHubs` and `routesThrough` from the class. Re-add them after the class as exported functions, making these exact substitutions in their bodies: `this.model` → `state.model`, `this.trip` → `state.trip`, `this.u` → `state.u`, `this.routePoints(` → `routePoints(state, `. The signatures become:

```js
export function routePoints(state, route, sx, sy) {
  const path = state.model.pathFor(route);
  if (!path) return null;
  const pts = [];
  for (const id of path) {
    const i = state.u.indexOf.get(id);
    if (i != null && !Number.isNaN(sx[i])) pts.push([sx[i], sy[i]]);
  }
  return pts.length > 1 ? pts : null;
}

export function paintRoutes(ctx, state, sx, sy, P) { /* former method body, with the substitutions above */ }
export function paintTrip(ctx, state, sx, sy, P) { /* former method body, with the substitutions above */ }
export function paintHubs(ctx, state, sx, sy, P) { /* former method body, with the substitutions above */ }

function routesThrough(state, systemId) {
  const m = state.model;
  if (!m) return [];
  return m.shown
    .filter(s => !s.faded && s.route?.metric > 0 && m.pathFor(s.route)?.includes(systemId))
    .map(s => `${s === m.top ? '★ ' : ''}${s.route.from.name} → ${s.route.to.name}: ${formatIsk(s.route.metric)}/j`);
}
```

  The `/* … */` bodies above mean *move the existing code verbatim* and apply only the listed substitutions. Also add NaN skipping, the same as `routePoints`:
  - In `paintTrip`'s path loop, use `if (i != null && !Number.isNaN(sx[i])) pts.push([sx[i], sy[i]]);`.
  - In `paintTrip`'s waypoint loop and `paintHubs`'s hub loop, change `if (i == null) continue;` to `if (i == null || Number.isNaN(sx[i])) continue;`.

  3. Add the tooltip helpers after `routesThrough`:

```js
export function tooltipHtml(state, i, isHub) {
  const { id, name, sec, region, regions } = state.u;
  const onRoutes = routesThrough(state, id[i]);
  return `<b>${esc(name[i])}</b> <span class="sec" style="--sec:${secColor(sec[i])}">${secLabel(sec[i])}</span>
      <div class="reg">${esc(regions[region[i]].name)}</div>
      ${isHub ? '<div class="hint">Click to show best outgoing route</div>' : ''}
      ${onRoutes.length ? `<div class="on">${onRoutes.map(esc).join('<br>')}</div>` : ''}`;
}

export function placeTooltip(tip, html, px, py, w) {
  tip.innerHTML = html;
  tip.hidden = false;
  tip.style.left = `${Math.min(px + 14, w - tip.offsetWidth - 4)}px`;
  tip.style.top = `${py + 14}px`;
}
```

  4. Export the helpers: change `function drawSpaced(` to `export function drawSpaced(` and `const clamp =` to `export const clamp =`.

  5. Update `GalaxyMap` to call them. At the end of `paint()`, replace the three calls with:

```js
    paintRoutes(ctx, this, sx, sy, P);
    paintHubs(ctx, this, sx, sy, P);
    paintTrip(ctx, this, sx, sy, P);
```

  Replace the body of `onHover` from `const { name, sec, region, regions } = this.u;` to the end of the method with:

```js
    placeTooltip(this.tooltip, tooltipHtml(this, i, !!hub), px, py, this.canvas.clientWidth);
```

  (The `if (i < 0) return this.hideTooltip();` line above it stays.)

- [ ] **Step 4: Run the tests and check they pass.** Run `npm test`. Expected: all pass. Also run `node -e "import('./public/js/map.js')"`; expected: no output. `document` is only touched inside functions, so the import succeeds.

- [ ] **Step 5: Check the flat map by hand.** Start the preview (`preview_start` name `eve-arbi`) and open `http://localhost:8000/best-items.html`:
  - The map draws.
  - Hovering a system shows the same tooltip.
  - Clicking a hub selects it, and route pills and arrows draw.
  - The "In-game 2D map" layout still works.
  - No console errors (`read_console_messages`).

- [ ] **Step 6: Commit.**

```bash
git add public/js/map.js test/map.test.js
git commit -m "Star map: share route, hub, trip and tooltip painters for the 3D map

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `GalaxyMap3D` renderer

**Files:**
- Create: `public/js/map3d.js`

**Interfaces:**
- Consumes:
  - From `map.js` (Task 5): `palette`, `isLightTheme`, `secBand`, `paintRoutes`, `paintHubs`, `paintTrip`, `tooltipHtml`, `placeTooltip`, `drawSpaced`.
  - From `map3d-math.js` (Tasks 2–4): `worldPositions`, `cameraBasis`, `projectAll`, `projectPoint`, `orbit`, `pan`, `zoomAt`, `fitSphere`, `lerpCamera`, `pickNearest`, `placeLabels`, `regionCentres`, `FOV_Y`, `NEAR`.
- Produces: `export class GalaxyMap3D`
  - Constructor: `new GalaxyMap3D(glCanvas, overlayCanvas, { THREE, tooltip, onSelectHub })`. It throws if WebGL is unavailable.
  - Methods: `setUniverse(u)`, `update(model)`, `setTrip(trip)`, `setSecurityColors(on)`, `fitHubs()`, `fitAll()`, `fitPath(systemIds)`, `zoomBy(factor, px?, py?)`. These are the same meanings as `GalaxyMap`.

There are no unit tests here: the maths is covered by Tasks 2–4 and this file is WebGL/DOM glue. It's verified in the browser in Task 8.

- [ ] **Step 1: Create `public/js/map3d.js`:**

```js
// In-game style 3D star map: WebGL stars and gates (three.js) under a 2D canvas that draws the same route, hub and
// trip overlays as the flat map (map.js). three.js is passed in, so this module loads nothing itself (map-switch.js).

import {
  palette, isLightTheme, secBand, paintRoutes, paintHubs, paintTrip, tooltipHtml, placeTooltip, drawSpaced,
} from './map.js';
import {
  worldPositions, cameraBasis, projectAll, projectPoint, orbit, pan, zoomAt, fitSphere, lerpCamera, pickNearest,
  placeLabels, regionCentres, FOV_Y, NEAR,
} from './map3d-math.js';

const FLY_MS = 400;
const START_PITCH = 55 * Math.PI / 180;

// Stars: soft glow sprites (dark theme, additive) or hard dots (light theme), sized by distance within pixel limits.
const STAR_VS = `
uniform float uScale;
uniform float uPixelRatio;
attribute vec3 color;
varying vec3 vColor;
void main() {
  vColor = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(90.0 / -mv.z, 3.0, 16.0) * uScale * uPixelRatio;
}`;
const STAR_FS = `
uniform float uAlpha;
uniform float uSoft;
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float glow = pow(1.0 - d, 2.2) + 0.6 * (1.0 - smoothstep(0.0, 0.25, d));
  float hard = 1.0 - smoothstep(0.55, 0.8, d);
  gl_FragColor = vec4(vColor, mix(hard, glow, uSoft) * uAlpha);
}`;

export class GalaxyMap3D {
  constructor(glCanvas, overlay, { THREE, tooltip, onSelectHub }) {
    this.T = THREE;
    THREE.ColorManagement.enabled = false; // palette hex values straight through, like the 2D canvas
    this.renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true }); // throws without WebGL
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x000000, 1, 2);
    this.camera = new THREE.PerspectiveCamera(FOV_Y * 180 / Math.PI, 1, NEAR, 2000);
    this.canvas = overlay;
    this.ctx = overlay.getContext('2d');
    this.tooltip = tooltip;
    this.onSelectHub = onSelectHub;
    this.cam = { target: [0, 0, 0], distance: 200, yaw: 0, pitch: START_PITCH };
    this.secColors = true;
    this.u = null;
    this.model = null;
    this.trip = null;
    this.proj = null;
    this.dpr = 1;
    this.hover = -1;
    this.fitted = false;
    this.anim = null;
    this._raf = 0;

    new ResizeObserver(() => this.resize()).observe(overlay);
    addEventListener('themechange', () => this.applyTheme());
    this.bindInput();
  }

  // --- data ------------------------------------------------------------------
  setUniverse(u) {
    const T = this.T, s = u.systems, n = s.id.length;
    this.u = {
      n, id: s.id, name: s.name, sec: s.sec, region: s.region, regions: u.regions,
      indexOf: new Map(s.id.map((id, i) => [id, i])),
      band: Uint8Array.from(s.sec, (v) => secBand(v) + 10),
    };
    this.pos = worldPositions(s);
    this.regionCentre = regionCentres(this.pos, s.region, u.regions.length);

    this.scene.clear();
    const position = new T.BufferAttribute(this.pos, 3);
    const starGeo = new T.BufferGeometry();
    starGeo.setAttribute('position', position);
    starGeo.setAttribute('color', new T.BufferAttribute(new Float32Array(n * 3), 3));
    this.stars = new T.Points(starGeo, new T.ShaderMaterial({
      uniforms: { uAlpha: { value: 1 }, uSoft: { value: 1 }, uScale: { value: 1 }, uPixelRatio: { value: 1 } },
      vertexShader: STAR_VS, fragmentShader: STAR_FS, transparent: true, depthWrite: false,
    }));
    const gateGeo = new T.BufferGeometry();
    gateGeo.setAttribute('position', position);
    gateGeo.setIndex(new T.BufferAttribute(Uint32Array.from(u.jumps), 1));
    this.gates = new T.LineSegments(gateGeo, new T.LineBasicMaterial({ transparent: true, depthWrite: false, fog: true }));
    this.scene.add(this.gates, this.stars);

    // Start on the whole cluster until hubs are known (paint() then fits them, like the flat map).
    const all = [...Array(n).keys()];
    if (this.canvas.clientWidth) this.cam = { ...this.cam, ...fitSphere(this.pos, all, 0.03, this.canvas.clientWidth, this.canvas.clientHeight) };
    this.fitted = false;
    this.applyTheme();
  }

  applyTheme() {
    if (!this.u) return this.draw();
    const T = this.T, P = palette(), light = isLightTheme();
    this.renderer.setClearColor(P.bg);
    this.scene.fog.color.set(P.bg);
    const m = this.stars.material;
    m.blending = light ? T.NormalBlending : T.AdditiveBlending;
    m.uniforms.uSoft.value = light ? 0 : 1;
    m.uniforms.uScale.value = P.dotScale;
    m.needsUpdate = true;
    this.gates.material.color.setRGB(...P.gate.map((v) => v / 255));
    this.gates.material.opacity = P.gateAlpha[1];
    this.colourStars();
  }

  colourStars() {
    const T = this.T, P = palette(), attr = this.stars.geometry.getAttribute('color');
    const plain = new T.Color(P.plain), bands = P.sec.map((hex) => new T.Color(hex));
    for (let i = 0; i < this.u.n; i++) {
      const c = this.secColors ? bands[this.u.band[i]] : plain;
      attr.setXYZ(i, c.r, c.g, c.b);
    }
    attr.needsUpdate = true;
    this.draw();
  }

  setSecurityColors(on) { this.secColors = on; if (this.u) this.colourStars(); }
  update(model) { this.model = model; this.draw(); }
  setTrip(trip) { this.trip = trip; this.draw(); }

  // --- view ------------------------------------------------------------------
  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    const glRatio = Math.min(this.dpr, 2);
    this.renderer.setPixelRatio(glRatio);
    this.renderer.setSize(w, h, false);
    if (this.stars) this.stars.material.uniforms.uPixelRatio.value = glRatio;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.draw();
  }

  syncCamera() {
    const { eye, up } = cameraBasis(this.cam), d = this.cam.distance;
    this.camera.position.set(...eye);
    this.camera.up.set(...up);
    this.camera.lookAt(...this.cam.target);
    this.camera.far = d * 4 + 400;
    this.camera.updateProjectionMatrix();
    this.scene.fog.near = d * 0.6;
    this.scene.fog.far = d * 2.5 + 60;
  }

  flyTo(to, instant = false) {
    if (instant) { this.cam = to; this.anim = null; } else this.anim = { from: this.cam, to, t0: performance.now() };
    this.draw();
  }

  fitIndices(indices, pad = 0.12) {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!this.u || !indices.length || !w) return;
    this.flyTo({ ...this.cam, ...fitSphere(this.pos, indices, pad, w, h) }, !this.fitted);
    this.fitted = true;
  }

  fitAll() { this.u && this.fitIndices([...Array(this.u.n).keys()], 0.03); }

  fitHubs() {
    if (!this.u || !this.model) return;
    this.fitIndices(this.model.hubs.map(h => this.u.indexOf.get(h.id)).filter(i => i != null), 0.35);
  }

  fitPath(systemIds) {
    if (!this.u || !systemIds?.length) return;
    this.fitIndices(systemIds.map(id => this.u.indexOf.get(id)).filter(i => i != null), 0.18);
  }

  zoomBy(factor, px = this.canvas.clientWidth / 2, py = this.canvas.clientHeight / 2) {
    this.anim = null;
    this.cam = zoomAt(this.cam, factor, px, py, this.canvas.clientWidth, this.canvas.clientHeight);
    this.draw();
  }

  // --- input -----------------------------------------------------------------
  bindInput() {
    const c = this.canvas, pointers = new Map();
    let drag = null, pinch = null;
    const local = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

    c.addEventListener('contextmenu', (e) => e.preventDefault()); // right-drag pans
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomBy(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), ...local(e));
    }, { passive: false });

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      this.anim = null;
      if (pointers.size === 1) {
        drag = { x: e.clientX, y: e.clientY, mode: e.button === 2 || e.shiftKey ? 'pan' : 'orbit', moved: false };
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2 };
        drag = null;
      }
    });

    c.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.clientX, e.clientY]);
      const w = c.clientWidth, h = c.clientHeight;
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]), mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        const r = c.getBoundingClientRect();
        this.cam = pan(this.cam, mx - pinch.mx, my - pinch.my, h);
        this.cam = zoomAt(this.cam, d / pinch.d, mx - r.left, my - r.top, w, h);
        pinch = { d, mx, my };
        this.draw();
        return;
      }
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) > 4) drag.moved = true;
        if (drag.moved) {
          this.cam = drag.mode === 'pan' ? pan(this.cam, dx, dy, h) : orbit(this.cam, dx, dy);
          drag.x = e.clientX; drag.y = e.clientY;
          c.style.cursor = 'grabbing';
          this.hideTooltip();
          this.draw();
        }
        return;
      }
      this.onHover(...local(e));
    });

    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (drag && !drag.moved && e.type === 'pointerup' && e.button === 0) this.onClick(...local(e));
      drag = null;
      c.style.cursor = '';
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { if (!drag) { this.hover = -1; this.hideTooltip(); this.draw(); } });
    c.addEventListener('dblclick', (e) => {
      const [px, py] = local(e);
      const p = this.proj, i = p ? pickNearest(p.sx, p.sy, p.depth, px, py, 8) : -1;
      if (i >= 0) this.flyTo({ ...this.cam, target: [this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]] });
      else this.zoomBy(e.shiftKey ? 0.5 : 2, px, py);
    });
  }

  hubAt(px, py) {
    if (!this.model || !this.proj) return null;
    const { sx, sy } = this.proj;
    let best = null, bd = 16 ** 2;
    for (const h of this.model.hubs) {
      const i = this.u.indexOf.get(h.id);
      if (i == null) continue;
      const d = (sx[i] - px) ** 2 + (sy[i] - py) ** 2;
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  }

  onClick(px, py) {
    const hub = this.hubAt(px, py);
    const sel = this.model?.sel;
    this.onSelectHub(hub ? (sel === hub.id ? null : hub.id) : null);
  }

  onHover(px, py) {
    if (!this.proj) return;
    const hub = this.hubAt(px, py);
    const i = hub ? this.u.indexOf.get(hub.id) : pickNearest(this.proj.sx, this.proj.sy, this.proj.depth, px, py, 8);
    this.canvas.style.cursor = hub ? 'pointer' : '';
    if (i !== this.hover) { this.hover = i; this.draw(); }
    if (i < 0) return this.hideTooltip();
    placeTooltip(this.tooltip, tooltipHtml(this, i, !!hub), px, py, this.canvas.clientWidth);
  }

  hideTooltip() { this.tooltip.hidden = true; }

  // --- drawing ---------------------------------------------------------------
  draw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.paint(); });
  }

  paint() {
    const { ctx, canvas } = this, w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.u) return;
    if (!this.fitted && this.model) this.fitHubs();
    if (this.anim) {
      const t = Math.min(1, (performance.now() - this.anim.t0) / FLY_MS);
      this.cam = lerpCamera(this.anim.from, this.anim.to, t);
      if (t < 1) this.draw(); else this.anim = null;
    }
    const P = palette();
    this.syncCamera();
    this.stars.material.uniforms.uAlpha.value = P.dotAlpha[this.model?.sel || this.model?.top ? 0 : 1];
    this.renderer.render(this.scene, this.camera);

    const proj = this.proj = projectAll(this.pos, this.cam, w, h, this.proj);
    if (!isLightTheme()) vignette(ctx, w, h);
    this.paintLabels(ctx, proj, w, h, P);
    paintRoutes(ctx, this, proj.sx, proj.sy, P);
    paintHubs(ctx, this, proj.sx, proj.sy, P);
    paintTrip(ctx, this, proj.sx, proj.sy, P);
    if (this.hover >= 0 && !Number.isNaN(proj.sx[this.hover])) {
      ctx.strokeStyle = P.hover;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(proj.sx[this.hover], proj.sy[this.hover], 7, 0, Math.PI * 2); ctx.stroke();
    }
  }

  // Region names when zoomed out, else system names nearest-first without overlaps.
  paintLabels(ctx, { sx, sy, depth }, w, h, P) {
    const on = (i) => sx[i] > 0 && sx[i] < w && sy[i] > 0 && sy[i] < h; // NaN → false
    const idx = [];
    for (let i = 0; i < this.u.n; i++) if (on(i)) idx.push(i);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (idx.length > 220) {
      ctx.font = '600 10px "Segoe UI", system-ui, sans-serif';
      this.regionCentre.forEach((c, ri) => {
        if (!c) return;
        const [px, py, dz] = projectPoint(c, this.cam, w, h);
        if (!(px > -50 && px < w + 50 && py > -20 && py < h + 20)) return;
        ctx.fillStyle = P.region.replace('ALPHA', (0.55 * Math.min(1, this.cam.distance / dz)).toFixed(2));
        drawSpaced(ctx, this.u.regions[ri].name.toUpperCase(), px, py);
      });
      return;
    }
    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = P.name;
    idx.sort((a, b) => depth[a] - depth[b]);
    const boxes = idx.map((i) => {
      const tw = ctx.measureText(this.u.name[i]).width;
      return { x: sx[i] - tw / 2, y: sy[i] + 3, w: tw, h: 12 };
    });
    for (const k of placeLabels(boxes)) { const i = idx[k]; ctx.fillText(this.u.name[i], sx[i], sy[i] + 9); }
  }
}

function vignette(ctx, w, h) {
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) / 2);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}
```

- [ ] **Step 2: Check it parses under Node.** Run `node -e "import('./public/js/map3d.js').then(m => console.log(typeof m.GalaxyMap3D))"`. Expected: `function`.

- [ ] **Step 3: Run the full suite.** Run `npm test`. Expected: all pass.

- [ ] **Step 4: Commit.**

```bash
git add public/js/map3d.js
git commit -m "3D star map renderer: three.js stars and gates under the shared 2D overlays

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Layout controller, three.js loader, settings migration

**Files:**
- Create: `public/js/map-switch.js`
- Create: `test/map-switch.test.js`

**Interfaces:**
- Consumes: any objects with the `GalaxyMap` API. Nothing is imported.
- Produces:
  - `THREE_URL`, `loadThree() → Promise<module>`
  - `migrateMapLayout(stored) → stored'`: a new object, `mapV: 1` set, and `mapLayout: '3d'` dropped when `mapV` was missing.
  - `createMapSwitch({ flat, create3d, flatEl, spaceEls, onUnavailable }) → map`, where:
    - `create3d: () => Promise<GalaxyMap3D>` (may reject);
    - `map.setLayout(layout) → Promise<actualLayout>`;
    - `map` also has `setUniverse`, `update`, `setTrip`, `setSecurityColors` (sent to both maps), and `zoomBy`, `fitHubs`, `fitAll`, `fitPath` (sent to the active map).

- [ ] **Step 1: Write the failing tests.** Create `test/map-switch.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMapSwitch, migrateMapLayout } from '../public/js/map-switch.js';

function stubMap() {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); };
  return {
    calls,
    setUniverse: rec('setUniverse'), update: rec('update'), setTrip: rec('setTrip'),
    setSecurityColors: rec('setSecurityColors'), setLayout: rec('setLayout'), zoomBy: rec('zoomBy'),
    fitHubs: rec('fitHubs'), fitAll: rec('fitAll'), fitPath: rec('fitPath'),
  };
}
const els = () => ({ flatEl: { hidden: false }, spaceEls: [{ hidden: true }, { hidden: true }] });

test('switching to space loads 3D once and replays current state into it', async () => {
  const flat = stubMap(), space = stubMap(), e = els();
  let created = 0;
  const map = createMapSwitch({ flat, create3d: async () => { created++; return space; }, ...e });
  map.setUniverse('U'); map.update('M'); map.setTrip('T'); map.setSecurityColors(false);
  assert.equal(await map.setLayout('space'), 'space');
  assert.deepEqual(space.calls, [['setSecurityColors', false], ['setUniverse', 'U'], ['update', 'M'], ['setTrip', 'T']]);
  assert.equal(e.flatEl.hidden, true);
  assert.ok(e.spaceEls.every((el) => !el.hidden));
  await map.setLayout('2d');
  await map.setLayout('space');
  assert.equal(created, 1);
});

test('both maps get data; view commands go to the active one', async () => {
  const flat = stubMap(), space = stubMap();
  const map = createMapSwitch({ flat, create3d: async () => space, ...els() });
  await map.setLayout('space');
  space.calls.length = 0;
  map.update('M2');
  map.zoomBy(2); map.fitPath([1, 2]); map.fitHubs(); map.fitAll();
  assert.deepEqual(space.calls, [['update', 'M2'], ['zoomBy', 2], ['fitPath', [1, 2]], ['fitHubs'], ['fitAll']]);
  assert.ok(flat.calls.some(([n, v]) => n === 'update' && v === 'M2'));
  assert.ok(!flat.calls.some(([n]) => n === 'zoomBy'));
  await map.setLayout('2d');
  map.zoomBy(3);
  assert.deepEqual(flat.calls.filter(([n]) => n === 'setLayout' || n === 'zoomBy'), [['setLayout', '2d'], ['zoomBy', 3]]);
});

test('if 3D cannot start the flat top-down map stays, and the failure is reported', async () => {
  const flat = stubMap(), e = els();
  let reported = null;
  const map = createMapSwitch({
    flat, create3d: async () => { throw new Error('no WebGL'); }, ...e, onUnavailable: (err) => { reported = err.message; },
  });
  assert.equal(await map.setLayout('space'), '3d');
  assert.equal(reported, 'no WebGL');
  assert.equal(e.flatEl.hidden, false);
  assert.ok(e.spaceEls.every((el) => el.hidden));
  assert.deepEqual(flat.calls.at(-1), ['setLayout', '3d']);
});

test('a layout change while 3D loads wins', async () => {
  const flat = stubMap(), space = stubMap(), e = els();
  let resolve;
  const map = createMapSwitch({ flat, create3d: () => new Promise((r) => { resolve = r; }), ...e });
  const pending = map.setLayout('space');
  await map.setLayout('2d');
  resolve(space);
  assert.equal(await pending, '2d');
  assert.equal(e.flatEl.hidden, false);
});

test('migrateMapLayout moves the old default to the new one, once', () => {
  assert.deepEqual(migrateMapLayout({ mapLayout: '3d', x: 1 }), { x: 1, mapV: 1 });
  assert.deepEqual(migrateMapLayout({ mapLayout: '2d' }), { mapLayout: '2d', mapV: 1 });
  assert.deepEqual(migrateMapLayout({ mapLayout: '3d', mapV: 1 }), { mapLayout: '3d', mapV: 1 });
  assert.deepEqual(migrateMapLayout({}), { mapV: 1 });
});
```

- [ ] **Step 2: Run the tests and check they fail.** Run `node --test test/map-switch.test.js`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement it.** Create `public/js/map-switch.js`:

```js
// Chooses between the flat star map (map.js) and the in-game style 3D one (map3d.js), which needs WebGL and three.js
// from a CDN. Both get every data update, so switching layouts is instant; if 3D can't start, the flat map stays.

export const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js';
export const loadThree = () => import(THREE_URL);

// Settings saved before the 3D map: '3d' (the old default, now "Top-down") becomes the new default, once (mapV).
export function migrateMapLayout(stored) {
  if (stored.mapV) return stored;
  const { mapLayout, ...rest } = stored;
  return mapLayout && mapLayout !== '3d' ? { ...rest, mapLayout, mapV: 1 } : { ...rest, mapV: 1 };
}

export function createMapSwitch({ flat, create3d, flatEl, spaceEls, onUnavailable }) {
  const state = { universe: null, model: null, trip: null, secColors: true };
  let space = null, loading = null, layout = null;

  const active = () => (layout === 'space' && space ? space : flat);
  const show = (isSpace) => {
    flatEl.hidden = isSpace;
    for (const el of spaceEls) el.hidden = !isSpace;
  };
  const start3d = () => (loading ??= create3d().then((m) => {
    m.setSecurityColors(state.secColors);
    if (state.universe) m.setUniverse(state.universe);
    if (state.model) m.update(state.model);
    if (state.trip) m.setTrip(state.trip);
    return (space = m);
  }, (err) => { onUnavailable?.(err); return null; }));

  return {
    async setLayout(next) {
      layout = next;
      if (next !== 'space') { show(false); flat.setLayout(next); return next; }
      const m = await start3d();
      if (layout !== 'space') return layout; // changed while three.js loaded
      if (!m) { layout = '3d'; show(false); flat.setLayout('3d'); return '3d'; }
      show(true);
      return 'space';
    },
    setUniverse(u) { state.universe = u; flat.setUniverse(u); space?.setUniverse(u); },
    update(model) { state.model = model; flat.update(model); space?.update(model); },
    setTrip(trip) { state.trip = trip; flat.setTrip(trip); space?.setTrip(trip); },
    setSecurityColors(on) { state.secColors = on; flat.setSecurityColors(on); space?.setSecurityColors(on); },
    zoomBy: (factor) => active().zoomBy(factor),
    fitHubs: () => active().fitHubs(),
    fitAll: () => active().fitAll(),
    fitPath: (ids) => active().fitPath(ids),
  };
}
```

  Note the replay order the first test expects: `setSecurityColors`, `setUniverse`, `update`, `setTrip`. `setTrip` is replayed only when a trip is set.

- [ ] **Step 4: Run the tests and check they pass.** Run `node --test test/map-switch.test.js`. Expected: PASS (5 tests). Then run `npm test`; expected: all pass.

- [ ] **Step 5: Commit.**

```bash
git add public/js/map-switch.js test/map-switch.test.js
git commit -m "Star map: layout switch between flat and 3D, with fallback and settings migration

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Wire it into the pages and verify in the browser

**Files:**
- Modify: `public/js/app.js:3` (imports), `:35` (defaults), `:40` (stored settings), `:50` (URL fields), `:1653-1655` (map construction)
- Modify: `public/best-items.html`, `public/multi-stop.html`, `public/single-route.html`, `public/watchlist-routes.html`: the `#mapLayout` select (about line 90) and `#mapView` (about line 105).
- Modify: `public/styles.css:350`

**Interfaces:**
- Consumes: `createMapSwitch`, `loadThree`, `migrateMapLayout` (Task 7), `GalaxyMap3D` (Task 6), `GalaxyMap` (unchanged API).

- [ ] **Step 1: Update `public/js/app.js`.**

  After the `map.js` import on line 3, add:

```js
import { createMapSwitch, loadThree, migrateMapLayout } from './map-switch.js';
```

  In `DEFAULTS`, change `view: 'map', mapLayout: '3d', secColors: true,` to:

```js
  view: 'map', mapLayout: 'space', mapV: 1, secColors: true,
```

  Change `const storedSettings = LS.get('arbi.settings', {});` to:

```js
const storedSettings = migrateMapLayout(LS.get('arbi.settings', {}));
```

  In `URL_FIELDS`, change `['mapLayout', ['3d', '2d']]` to `['mapLayout', ['space', '3d', '2d']]`.

  Replace these three lines:

```js
const galaxy = new GalaxyMap($('mapCanvas'), { tooltip: $('mapTip'), onSelectHub: (id) => selectHub(id) });
galaxy.layout = settings.mapLayout;
galaxy.secColors = settings.secColors;
```

  with:

```js
const galaxy = createMapSwitch({
  flat: new GalaxyMap($('mapCanvas'), { tooltip: $('mapTip'), onSelectHub: (id) => selectHub(id) }),
  create3d: async () => {
    const [THREE, { GalaxyMap3D }] = await Promise.all([loadThree(), import('./map3d.js')]);
    return new GalaxyMap3D($('mapGl'), $('mapOverlay'), { THREE, tooltip: $('mapTip'), onSelectHub: (id) => selectHub(id) });
  },
  flatEl: $('mapCanvas'),
  spaceEls: [$('mapGl'), $('mapOverlay')],
  // No WebGL or the CDN is unreachable: show Top-down without overwriting the saved choice.
  onUnavailable: (e) => {
    const opt = $('mapLayout').querySelector('option[value=space]');
    opt.disabled = true;
    opt.textContent = 'In-game 3D (unavailable)';
    opt.title = `The 3D map couldn't start: ${e.message}`;
    $('mapLayout').value = '3d';
  },
});
galaxy.setSecurityColors(settings.secColors);
galaxy.setLayout(settings.mapLayout);
```

  The later lines `bindSetting('mapLayout', …, { after: () => galaxy.setLayout(settings.mapLayout) })` and `bindSetting('secColors', …)` stay as they are; they now go through the switch.

- [ ] **Step 2: Update the four HTML pages.** In each of `public/best-items.html`, `public/multi-stop.html`, `public/single-route.html` and `public/watchlist-routes.html`, replace:

```html
            <select id="mapLayout">
              <option value="3d">True positions</option>
              <option value="2d">In-game 2D map</option>
            </select>
```

  with:

```html
            <select id="mapLayout">
              <option value="space">In-game 3D</option>
              <option value="3d">Top-down</option>
              <option value="2d">In-game 2D map</option>
            </select>
```

  Then, directly after the existing `<canvas id="mapCanvas" …></canvas>` line, add:

```html
        <canvas id="mapGl" hidden aria-hidden="true"></canvas>
        <canvas id="mapOverlay" hidden aria-label="3D star map of New Eden with trade routes. Drag to rotate, right-drag or shift-drag to pan, scroll to zoom, double-click a system to centre it, click a hub to select it."></canvas>
```

  Check with `grep -c 'id="mapOverlay"' public/*.html`: expect 1 in each of the four pages and none elsewhere.

- [ ] **Step 3: Update `public/styles.css`.** Replace line 350:

```css
.map-view canvas { display: block; width: 100%; height: 100%; touch-action: none; cursor: grab; }
```

  with:

```css
.map-view canvas { position: absolute; inset: 0; display: block; width: 100%; height: 100%; touch-action: none; cursor: grab; }
.map-view canvas[hidden] { display: none; }
#mapGl { pointer-events: none; }
```

- [ ] **Step 4: Run the suite.** Run `npm test`. Expected: all pass.

- [ ] **Step 5: Verify in the browser.** Run `preview_start` with name `eve-arbi`, open `http://localhost:8000/best-items.html`, and clear the saved settings first with `javascript_tool`: `localStorage.removeItem('arbi.settings'); location.reload()`. Then check each item and fix anything that fails before moving on:
  1. The layout select shows "In-game 3D". Stars glow over a dark vignette. Gates are faint. The map starts tilted (about 55°) and framed on the hubs.
  2. Drag rotates, and the view never flips at the poles. Right-drag and shift-drag pan. Scrolling zooms towards the cursor. Double-clicking a system flies to it (about 0.4 s). Double-clicking empty space zooms in.
     - **Orbit direction:** dragging right should turn the view as if grabbing the cluster. If it feels reversed, flip the sign of `dx` (or `dy`) inside `orbit` in `map3d-math.js` and update the orbit test to match.
  3. Hovering a system shows the tooltip. Clicking a hub selects it: routes, arrows and pills draw on top of the stars, and stars dim.
  4. The zoom +/−, "Hubs", "All" and "Best route" buttons animate the camera.
  5. Zoomed out shows region names. Zoomed in on one region shows system names without overlaps.
  6. The "Security colors" toggle recolours the stars.
  7. Switching the theme (the theme button) to light gives hard dots on a pale background with no vignette. Switching back restores the glow.
  8. Layout "Top-down" and "In-game 2D map" show the flat map exactly as before. Switching back to "In-game 3D" is instant.
  9. Open `http://localhost:8000/multi-stop.html`, build a trip, and check the violet trip path and numbered stops in 3D.
  10. **Fallback:** a patch applied with `javascript_tool` doesn't survive a reload, so the 3D map must not have started yet on the page you patch. Do it in this order:
      1. Pick "Top-down" in the layout select, then reload.
      2. In `javascript_tool`, run: `HTMLCanvasElement.prototype.getContext = ((g) => function (t, ...a) { return /webgl/.test(t) ? null : g.call(this, t, ...a); })(HTMLCanvasElement.prototype.getContext); const s = document.getElementById('mapLayout'); s.value = 'space'; s.dispatchEvent(new Event('change'));`
      3. Expected: the flat map stays, and the option reads "In-game 3D (unavailable)".
      4. Afterwards, reload and pick "In-game 3D" again so your saved setting is back.
  11. `read_console_messages` with `onlyErrors: true` returns nothing (ignore any three.js warning in the fallback test).
  12. `resize_window` preset `mobile`: the map fills the width with no horizontal scroll. Reset with preset `desktop`.

  Take a screenshot of the dark 3D view as proof.

- [ ] **Step 6: Commit.**

```bash
git add public/js/app.js public/best-items.html public/multi-stop.html public/single-route.html public/watchlist-routes.html public/styles.css
git commit -m "Route pages: in-game style 3D star map as the default layout

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
