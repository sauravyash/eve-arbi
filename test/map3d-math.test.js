import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  worldPositions, cameraBasis, focalPx, projectAll, projectPoint,
  orbit, pan, zoomAt, fitSphere, lerpCamera, clampDistance, PITCH_MAX, MIN_DIST, MAX_DIST,
  pickNearest, placeLabels, regionCentres,
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

test('fitSphere frames every point in portrait (375×700) viewport at any angle', () => {
  const pts = [0, 0, 0, 30, 5, -10, -12, -4, 22, 8, 9, 3];
  const pos = Float32Array.from(pts);
  const Wp = 375, Hp = 700;
  for (const [yaw, pitch] of [[0, 1.2], [2.1, 0.2]]) {
    const fit = fitSphere(pos, [0, 1, 2, 3], 0.1, Wp, Hp);
    const { sx, sy } = projectAll(pos, { ...fit, yaw, pitch }, Wp, Hp);
    for (let i = 0; i < 4; i++) assert.ok(sx[i] >= 0 && sx[i] <= Wp && sy[i] >= 0 && sy[i] <= Hp, `point ${i} on screen`);
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

test('pickNearest: 1 px apart, nearer-camera wins despite being farther from cursor', () => {
  const sx = Float32Array.of(100.5, 101.5), sy = Float32Array.of(100, 100), d = Float32Array.of(20, 3);
  assert.equal(pickNearest(sx, sy, d, 100, 100, 2), 1); // point 1 is 1.5 px away but has depth 3
});

test('pickNearest: closer-to-cursor wins within tie band even though farther from camera', () => {
  const sx = Float32Array.of(102, 105), sy = Float32Array.of(100, 100), d = Float32Array.of(9, 1);
  assert.equal(pickNearest(sx, sy, d, 100, 100, 8), 0); // point 0 is 2 px away (best), point 1 is 5 px (outside 3.5 px tie band)
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
