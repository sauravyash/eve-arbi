// Canvas star map of New Eden: every known-space system and stargate, with trade routes overlaid.
// Coordinates are light years (screen y already flipped so north is up).

import { formatIsk } from './arbitrage.js';

// Security colours indexed by band + 10: null-sec -1.0 → -0.1 (crimson fading to purple), then in-game 0.0 → 1.0.
const SEC_COLORS = [
  '#6e1f9e', '#7a1d95', '#861b8b', '#921981', '#9e1777', '#aa146b', '#b6115f', '#c20e52', '#ce0a44', '#da0636',
  '#f00000', '#d73000', '#f04800', '#f06000', '#d77700', '#efef00', '#8fef2f', '#00f000', '#00ef47', '#48f0c0', '#2fefef',
];
// Band is security × 10 rounded, -10…10; 0 < sec < 0.05 displays as 0.1 in-game.
export const secBand = (s) => (s > 0 && s < 0.05 ? 1 : Math.max(-10, Math.min(10, Math.round(s * 10) || 0)));
export const secLabel = (s) => (secBand(s) / 10).toFixed(1);
export const secColor = (s) => SEC_COLORS[secBand(s) + 10];

const TEAL = '#2dd4bf', EDGE = '#9fb3c8', AMBER = '#e0a74a', VIOLET = '#a78bfa';
const MIN_SCALE = 0.5, MAX_SCALE = 400; // px per light year

export class GalaxyMap {
  constructor(canvas, { tooltip, onSelectHub }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tooltip = tooltip;
    this.onSelectHub = onSelectHub;
    this.layout = '3d';
    this.secColors = true;
    this.view = { cx: 0, cy: 0, scale: 10 };
    this.u = null;
    this.model = null;
    this.hover = -1;
    this.fitted = false;
    this._raf = 0;

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.bindInput();
  }

  // --- data ------------------------------------------------------------------
  setUniverse(u) {
    const s = u.systems, n = s.id.length;
    this.u = {
      n, id: s.id, name: s.name, sec: s.sec, region: s.region, regions: u.regions,
      pos: { '3d': [Float32Array.from(s.x), Float32Array.from(s.y)], '2d': [Float32Array.from(s.x2), Float32Array.from(s.y2)] },
      jumps: Uint16Array.from(u.jumps),
      indexOf: new Map(s.id.map((id, i) => [id, i])),
      band: Uint8Array.from(s.sec, (v) => secBand(v) + 10),
    };
    this.computeRegionCentres();
    this.fitted = false;
    this.resize();
  }

  computeRegionCentres() {
    const { n, region, regions } = this.u;
    this.u.regionCentre = {};
    for (const key of ['3d', '2d']) {
      const [xs, ys] = this.u.pos[key];
      const acc = regions.map(() => [0, 0, 0]);
      for (let i = 0; i < n; i++) { const a = acc[region[i]]; a[0] += xs[i]; a[1] += ys[i]; a[2]++; }
      this.u.regionCentre[key] = acc.map(([x, y, c]) => (c ? [x / c, y / c] : null));
    }
  }

  setLayout(layout) {
    if (layout === this.layout) return;
    this.layout = layout;
    this.fitted = false;
    this.draw();
  }

  setSecurityColors(on) { this.secColors = on; this.draw(); }

  /**
   * model: { shown: [{route, faded, a, b}], top, maxV, sel, hubs, pathFor(route) → [systemId] | null }
   */
  update(model) { this.model = model; this.draw(); }

  /**
   * A multi-stop trip drawn over everything else, or null to clear it.
   * trip: { path: [systemId, …] gate by gate, stops: [{systemId, n, label}] }
   */
  setTrip(trip) { this.trip = trip; this.draw(); }

  // --- view ------------------------------------------------------------------
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (!w || !h) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.dpr = dpr;
    this.draw();
  }

  xy(i) { const [xs, ys] = this.u.pos[this.layout]; return [xs[i], ys[i]]; }

  toScreen(x, y) {
    const { cx, cy, scale } = this.view;
    return [(x - cx) * scale + this.canvas.clientWidth / 2, (y - cy) * scale + this.canvas.clientHeight / 2];
  }

  toWorld(px, py) {
    const { cx, cy, scale } = this.view;
    return [(px - this.canvas.clientWidth / 2) / scale + cx, (py - this.canvas.clientHeight / 2) / scale + cy];
  }

  fitIndices(indices, pad = 0.12) {
    if (!this.u || !indices.length || !this.canvas.clientWidth) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of indices) {
      const [x, y] = this.xy(i);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const spanX = Math.max(x1 - x0, 2), spanY = Math.max(y1 - y0, 2);
    this.view = {
      cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
      scale: clamp(Math.min(w / (spanX * (1 + 2 * pad)), h / (spanY * (1 + 2 * pad))), MIN_SCALE, MAX_SCALE),
    };
    this.fitted = true;
    this.draw();
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
    const [wx, wy] = this.toWorld(px, py);
    this.view.scale = clamp(this.view.scale * factor, MIN_SCALE, MAX_SCALE);
    const [nx, ny] = this.toWorld(px, py);
    this.view.cx += wx - nx; this.view.cy += wy - ny;
    this.draw();
  }

  // --- input -----------------------------------------------------------------
  bindInput() {
    const c = this.canvas;
    const pointers = new Map();
    let drag = null, pinch = null;

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      this.zoomBy(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, cx: this.view.cx, cy: this.view.cy, moved: false };
      else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), scale: this.view.scale };
        drag = null;
      }
    });

    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        this.zoomBy((pinch.scale * d / pinch.d) / this.view.scale, (a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top);
        return;
      }
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.hypot(dx, dy) > 4) drag.moved = true;
        if (drag.moved) {
          this.view.cx = drag.cx - dx / this.view.scale;
          this.view.cy = drag.cy - dy / this.view.scale;
          c.style.cursor = 'grabbing';
          this.hideTooltip();
          this.draw();
        }
        return;
      }
      this.onHover(e.clientX - r.left, e.clientY - r.top);
    });

    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (drag && !drag.moved && e.type === 'pointerup') {
        const r = c.getBoundingClientRect();
        this.onClick(e.clientX - r.left, e.clientY - r.top);
      }
      drag = null;
      c.style.cursor = '';
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { if (!drag) { this.hover = -1; this.hideTooltip(); this.draw(); } });
    c.addEventListener('dblclick', (e) => {
      const r = c.getBoundingClientRect();
      this.zoomBy(e.shiftKey ? 0.5 : 2, e.clientX - r.left, e.clientY - r.top);
    });
  }

  nearest(px, py, maxPx) {
    if (!this.u) return -1;
    const [xs, ys] = this.u.pos[this.layout];
    const [wx, wy] = this.toWorld(px, py);
    const lim = (maxPx / this.view.scale) ** 2;
    let best = -1, bd = lim;
    for (let i = 0; i < this.u.n; i++) {
      const d = (xs[i] - wx) ** 2 + (ys[i] - wy) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  hubAt(px, py) {
    if (!this.model || !this.u) return null;
    let best = null, bd = 16 ** 2;
    for (const h of this.model.hubs) {
      const i = this.u.indexOf.get(h.id);
      if (i == null) continue;
      const [sx, sy] = this.toScreen(...this.xy(i));
      const d = (sx - px) ** 2 + (sy - py) ** 2;
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
    const hub = this.hubAt(px, py);
    const i = hub ? this.u.indexOf.get(hub.id) : this.nearest(px, py, 8);
    this.canvas.style.cursor = hub ? 'pointer' : '';
    if (i !== this.hover) { this.hover = i; this.draw(); }
    if (i < 0) return this.hideTooltip();
    const { name, sec, region, regions } = this.u;
    const onRoutes = this.routesThrough(this.u.id[i]);
    const t = this.tooltip;
    t.innerHTML = `<b>${esc(name[i])}</b> <span class="sec" style="color:${secColor(sec[i])}">${secLabel(sec[i])}</span>
      <div class="reg">${esc(regions[region[i]].name)}</div>
      ${hub ? '<div class="hint">Click to show best outgoing route</div>' : ''}
      ${onRoutes.length ? `<div class="on">${onRoutes.map(esc).join('<br>')}</div>` : ''}`;
    t.hidden = false;
    const w = this.canvas.clientWidth;
    t.style.left = `${Math.min(px + 14, w - t.offsetWidth - 4)}px`;
    t.style.top = `${py + 14}px`;
  }

  routesThrough(systemId) {
    if (!this.model) return [];
    return this.model.shown
      .filter(s => !s.faded && s.route?.metric > 0 && this.model.pathFor(s.route)?.includes(systemId))
      .map(s => `${s === this.model.top ? '★ ' : ''}${s.route.from.name} → ${s.route.to.name}: ${formatIsk(s.route.metric)}/j`);
  }

  hideTooltip() { this.tooltip.hidden = true; }

  // --- drawing ---------------------------------------------------------------
  draw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.paint(); });
  }

  paint() {
    const { ctx, canvas } = this;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#05080c';
    ctx.fillRect(0, 0, w, h);
    if (!this.u) return;
    if (!this.fitted && this.model) this.fitHubs();

    const { n } = this.u;
    const [xs, ys] = this.u.pos[this.layout];
    const { cx, cy, scale } = this.view;
    const ox = w / 2 - cx * scale, oy = h / 2 - cy * scale;
    const sx = new Float32Array(n), sy = new Float32Array(n);
    for (let i = 0; i < n; i++) { sx[i] = xs[i] * scale + ox; sy[i] = ys[i] * scale + oy; }
    const onScreen = (i, m = 40) => sx[i] > -m && sx[i] < w + m && sy[i] > -m && sy[i] < h + m;

    // Gates
    const j = this.u.jumps;
    ctx.beginPath();
    for (let k = 0; k < j.length; k += 2) {
      const a = j[k], b = j[k + 1];
      if (!onScreen(a, 200) && !onScreen(b, 200)) continue;
      ctx.moveTo(sx[a], sy[a]); ctx.lineTo(sx[b], sy[b]);
    }
    ctx.strokeStyle = `rgba(110, 135, 160, ${clamp(0.1 + scale / 120, 0.12, 0.35)})`;
    ctx.lineWidth = 0.7;
    ctx.stroke();

    // Systems, batched by security band
    const r = clamp(scale * 0.06, 0.9, 3.2);
    const buckets = Array.from({ length: SEC_COLORS.length }, () => []);
    for (let i = 0; i < n; i++) if (onScreen(i, 4)) buckets[this.secColors ? this.u.band[i] : 0].push(i);
    ctx.globalAlpha = this.model?.sel || this.model?.top ? 0.55 : 0.8;
    buckets.forEach((idx, band) => {
      if (!idx.length) return;
      ctx.fillStyle = this.secColors ? SEC_COLORS[band] : '#7f93a8';
      ctx.beginPath();
      for (const i of idx) { ctx.moveTo(sx[i] + r, sy[i]); ctx.arc(sx[i], sy[i], r, 0, Math.PI * 2); }
      ctx.fill();
    });
    ctx.globalAlpha = 1;

    // Region labels (zoomed out) / system names (zoomed in)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let visible = 0;
    for (let i = 0; i < n; i++) if (onScreen(i, 0)) visible++;
    if (visible > 220) {
      ctx.font = '600 10px "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = `rgba(160, 180, 200, ${scale < 3 ? 0.4 : 0.55})`;
      this.u.regionCentre[this.layout].forEach((c, ri) => {
        if (!c) return;
        const px = c[0] * scale + ox, py = c[1] * scale + oy;
        if (px < -50 || px > w + 50 || py < -20 || py > h + 20) return;
        drawSpaced(ctx, this.u.regions[ri].name.toUpperCase(), px, py);
      });
    } else {
      ctx.font = '10px "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = 'rgba(170, 186, 204, 0.75)';
      for (let i = 0; i < n; i++) if (onScreen(i, 0)) ctx.fillText(this.u.name[i], sx[i], sy[i] + r + 7);
    }

    this.paintRoutes(ctx, sx, sy);
    this.paintHubs(ctx, sx, sy);
    this.paintTrip(ctx, sx, sy);

    if (this.hover >= 0) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sx[this.hover], sy[this.hover], r + 4, 0, Math.PI * 2); ctx.stroke();
    }
  }

  routePoints(route, sx, sy) {
    const path = this.model.pathFor(route);
    if (!path) return null;
    const pts = [];
    for (const id of path) {
      const i = this.u.indexOf.get(id);
      if (i != null) pts.push([sx[i], sy[i]]);
    }
    return pts.length > 1 ? pts : null;
  }

  paintRoutes(ctx, sx, sy) {
    const m = this.model;
    if (!m) return;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const drawn = [];
    const fade = this.trip ? 0.15 : 1; // with a trip on screen, the per-hub routes step back
    // Non-best first, best last so it sits on top.
    const order = [...m.shown].filter(s => !s.faded && s.route && (s.route.metric > 0))
      .sort((a, b) => (a === m.top) - (b === m.top) || a.route.metric - b.route.metric);

    for (const s of order) {
      const pts = this.routePoints(s.route, sx, sy);
      if (!pts) continue;
      const isTop = s === m.top;
      const ratio = m.maxV > 0 ? Math.sqrt(s.route.metric / m.maxV) : 0;
      const color = s.route.stale ? AMBER : isTop ? TEAL : EDGE;
      ctx.setLineDash(s.route.stale ? [8, 6] : []);
      if (isTop) {
        ctx.save();
        ctx.shadowColor = TEAL; ctx.shadowBlur = 14;
        stroke(ctx, pts, 'rgba(45,212,191,0.35)', 9, fade);
        ctx.restore();
      }
      stroke(ctx, pts, color, isTop ? 3.2 : 1.4 + ratio * 2.6, (isTop ? 1 : 0.35 + 0.5 * ratio) * fade);
      ctx.setLineDash([]);
      ctx.globalAlpha = fade;
      arrows(ctx, pts, color, isTop ? 90 : 140, isTop ? 6 : 4.5);
      ctx.globalAlpha = 1;
      drawn.push({ s, pts, isTop });
    }

    // Labels: best route always; every shown route when a hub is selected.
    for (const { s, pts, isTop } of drawn) {
      if (this.trip || (!isTop && !m.sel)) continue;
      const [lx, ly] = pts[Math.floor(pts.length / 2)];
      const text = `${formatIsk(s.route.metric, s.route.metric >= 1e6 ? 2 : 1)}/j · ${s.route.jumps}j`;
      pill(ctx, text, lx, ly - 16, isTop ? TEAL : EDGE, isTop);
    }
  }

  paintTrip(ctx, sx, sy) {
    const t = this.trip;
    if (!t) return;
    const pts = [];
    for (const id of t.path) {
      const i = this.u.indexOf.get(id);
      if (i != null) pts.push([sx[i], sy[i]]);
    }
    if (pts.length > 1) {
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.save();
      ctx.shadowColor = VIOLET; ctx.shadowBlur = 12;
      stroke(ctx, pts, 'rgba(167,139,250,0.35)', 9);
      ctx.restore();
      stroke(ctx, pts, VIOLET, 3);
      arrows(ctx, pts, VIOLET, 80, 5.5);
    }
    // Numbered waypoints; several stops in one system share a marker.
    const bySystem = new Map();
    for (const st of t.stops) {
      const list = bySystem.get(st.systemId) || [];
      list.push(st);
      bySystem.set(st.systemId, list);
    }
    ctx.textBaseline = 'middle';
    for (const [id, list] of bySystem) {
      const i = this.u.indexOf.get(id);
      if (i == null) continue;
      const x = sx[i], y = sy[i];
      const label = list.map(st => st.n).join(',');
      ctx.font = '700 11px "Segoe UI", system-ui, sans-serif';
      const r = Math.max(10, ctx.measureText(label).width / 2 + 6);
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = VIOLET; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#05080c'; ctx.stroke();
      ctx.fillStyle = '#140d2b'; ctx.textAlign = 'center';
      ctx.fillText(label, x, y + 0.5);
      const text = list.map(st => st.label).join(' · ');
      ctx.font = '600 11.5px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(5,8,12,0.92)';
      ctx.strokeText(text, x + r + 5, y);
      ctx.fillStyle = '#e9e3ff';
      ctx.fillText(text, x + r + 5, y);
    }
  }

  paintHubs(ctx, sx, sy) {
    const m = this.model;
    if (!m) return;
    const topR = m.top?.route;
    for (const h of m.hubs) {
      const i = this.u.indexOf.get(h.id);
      if (i == null) continue;
      const x = sx[i], y = sy[i];
      const isSrc = m.sel ? h.id === m.sel : topR?.from.id === h.id;
      const isDst = topR && (!m.sel || topR.from.id === m.sel) && topR.to.id === h.id;
      ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fillStyle = isSrc ? TEAL : '#0b1117';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = isSrc || isDst ? TEAL : '#dbe4ee';
      ctx.stroke();
      ctx.font = '600 13px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(5,8,12,0.9)';
      ctx.strokeText(h.name, x + 12, y);
      ctx.fillStyle = isSrc || isDst ? TEAL : '#eef3f8';
      ctx.fillText(h.name, x + 12, y);
    }
  }
}

function stroke(ctx, pts, color, width, alpha = 1) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// Chevrons along a polyline every `spacing` px showing travel direction.
function arrows(ctx, pts, color, spacing, size) {
  let carry = spacing / 2;
  ctx.fillStyle = color;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (!len) continue;
    const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
    let d = carry;
    while (d < len) {
      const x = x0 + ux * d, y = y0 + uy * d;
      ctx.beginPath();
      ctx.moveTo(x + ux * size, y + uy * size);
      ctx.lineTo(x - ux * size - uy * size * 0.8, y - uy * size + ux * size * 0.8);
      ctx.lineTo(x - ux * size + uy * size * 0.8, y - uy * size - ux * size * 0.8);
      ctx.closePath();
      ctx.fill();
      d += spacing;
    }
    carry = d - len;
  }
}

function pill(ctx, text, x, y, color, strong) {
  ctx.font = '600 11px ui-monospace, "Cascadia Mono", Consolas, monospace';
  const w = ctx.measureText(text).width + 14, h = 20;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h / 2, w, h, 10);
  ctx.fillStyle = strong ? 'rgba(6,37,34,0.95)' : 'rgba(11,15,20,0.92)';
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
}

function drawSpaced(ctx, text, x, y) {
  if ('letterSpacing' in ctx) { ctx.letterSpacing = '1.5px'; ctx.fillText(text, x, y); ctx.letterSpacing = '0px'; }
  else ctx.fillText(text, x, y);
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
