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
