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
