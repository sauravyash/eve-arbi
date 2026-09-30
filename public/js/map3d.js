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
      uniforms: {
        uAlpha: { value: 1 }, uSoft: { value: 1 }, uScale: { value: 1 },
        uPixelRatio: { value: this.renderer.getPixelRatio() },
      },
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
    // Cull points just past the near plane: they project to huge coordinates and draw spikes.
    const minDepth = 0.05 * this.cam.distance;
    for (let i = 0; i < this.u.n; i++) if (proj.depth[i] < minDepth) { proj.sx[i] = NaN; proj.sy[i] = NaN; }
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
