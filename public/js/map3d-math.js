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
  if (!out || out.sx.length !== n) {
    out = { sx: new Float32Array(n), sy: new Float32Array(n), depth: new Float32Array(n) };
  }
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

// Zoom by factor toward world point p, keeping p fixed on screen: the eye slides along the ray from p, and the target
// moves to p's depth so later orbits and zooms pivot at the anchor. Falls back to zoomAt about the centre if p is
// behind the camera. Zooming in never pulls the eye back past where it was, even inside MIN_DIST.
export function zoomToward(cam, factor, p, w, h) {
  const { eye, fwd } = cameraBasis(cam);
  const dz = (p[0] - eye[0]) * fwd[0] + (p[1] - eye[1]) * fwd[1] + (p[2] - eye[2]) * fwd[2];
  if (!(dz > NEAR)) return zoomAt(cam, factor, w / 2, h / 2, w, h);
  let distance = clampDistance(dz / factor);
  if (factor > 1) distance = Math.min(distance, dz);
  const k = distance / dz;
  const e = p.map((v, i) => v + (eye[i] - v) * k);
  return { ...cam, distance, target: e.map((v, i) => v + fwd[i] * distance) };
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
    const dx = pos[i * 3] - target[0], dy = pos[i * 3 + 1] - target[1], dz = pos[i * 3 + 2] - target[2];
    r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
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

// System under the cursor: nearest on screen within maxPx; near-ties go to the one nearer the camera.
export function pickNearest(sx, sy, depth, px, py, maxPx) {
  // Pass 1: find minimum on-screen distance in pixels.
  let bestDist = Infinity;
  for (let i = 0; i < sx.length; i++) {
    const dx = sx[i] - px, dy = sy[i] - py;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= maxPx) bestDist = Math.min(bestDist, d);
  }
  if (bestDist === Infinity) return -1;

  // Pass 2: among points within bestDist + 1.5 px, pick the one with smallest depth.
  let best = -1, bestDepth = Infinity;
  const threshold = bestDist + 1.5;
  for (let i = 0; i < sx.length; i++) {
    const dx = sx[i] - px, dy = sy[i] - py;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (!(d <= threshold)) continue; // NaN fails the comparison too
    if (depth[i] < bestDepth) { best = i; bestDepth = depth[i]; }
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
