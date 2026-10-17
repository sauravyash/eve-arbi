// The Warfare page's star map: the flat map (map.js) with each system painted by who owns it (the
// sov holder, or the side dominating it on zKillboard), and the last hour's kills, active sov
// campaigns and zKillboard fights drawn over it. Only the painting and hover differ; panning,
// zooming and layouts are GalaxyMap's.

import { GalaxyMap, palette, placeTooltip, drawSpaced, clamp, isLightTheme } from './map.js';

export class WarMap extends GalaxyMap {
  constructor(canvas, opts) {
    super(canvas, opts);
    this.layout = '3d';
    /**
     * war: {
     *   owner(systemId) → {key, color, strength 0–1} | null: what colours the system,
     *   kills: Map(systemId → {ship, pod}), campaigns: Map(systemId → {label, attackers}),
     *   fights: Map(systemId → {kills, isk}), focus: Set(systemId) | null, picked: systemId | null,
     *   layers: {owner, kills, campaigns, fights}, tooltip(systemId) → html
     * }
     */
    this.war = null;
    // Until you pan or zoom, the map keeps the whole of New Eden in view as the page settles.
    this.userMoved = false;
    canvas.addEventListener('pointerdown', () => { this.userMoved = true; });
    canvas.addEventListener('wheel', () => { this.userMoved = true; }, { passive: true });
  }

  resize() {
    if (!this.userMoved) this.fitted = false;
    super.resize();
  }

  fitAll() { this.userMoved = false; super.fitAll(); }
  zoomBy(...args) { this.userMoved = true; super.zoomBy(...args); }

  setWar(war) { this.war = war; this.draw(); }

  fitSystems(ids) { this.userMoved = true; this.fitPath(ids); }

  onClick(px, py) {
    const i = this.nearest(px, py, 10);
    this.onPickSystem?.(i >= 0 ? this.u.id[i] : null);
  }

  onHover(px, py) {
    const i = this.nearest(px, py, 8);
    if (i !== this.hover) { this.hover = i; this.draw(); }
    if (i < 0 || !this.war) return this.hideTooltip();
    placeTooltip(this.tooltip, this.war.tooltip(this.u.id[i]), px, py, this.canvas.clientWidth);
  }

  paint() {
    const { ctx, canvas } = this;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const P = palette();
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, w, h);
    if (!this.u) return;
    if (!this.fitted) this.fitAll();

    const { n, id } = this.u;
    const [xs, ys] = this.u.pos[this.layout];
    const { cx, cy, scale } = this.view;
    const ox = w / 2 - cx * scale, oy = h / 2 - cy * scale;
    const sx = new Float32Array(n), sy = new Float32Array(n);
    for (let i = 0; i < n; i++) { sx[i] = xs[i] * scale + ox; sy[i] = ys[i] * scale + oy; }
    const onScreen = (i, m = 40) => sx[i] > -m && sx[i] < w + m && sy[i] > -m && sy[i] < h + m;
    const war = this.war;
    const L = war?.layers || {};
    const focus = war?.focus || null;
    const light = isLightTheme();

    // Gates
    const j = this.u.jumps;
    ctx.beginPath();
    for (let k = 0; k < j.length; k += 2) {
      const a = j[k], b = j[k + 1];
      if (!onScreen(a, 200) && !onScreen(b, 200)) continue;
      ctx.moveTo(sx[a], sy[a]); ctx.lineTo(sx[b], sy[b]);
    }
    ctx.strokeStyle = `rgba(${P.gate}, ${clamp(0.08 + scale / 150, ...P.gateAlpha)})`;
    ctx.lineWidth = 0.7;
    ctx.stroke();

    // Owners: each one's systems as a soft blob of its colour, then the system dots in it.
    // A weak hold (a contested system) is drawn fainter.
    const r = clamp(scale * 0.06, 0.9, 3.2) * P.dotScale;
    const held = new Map();   // key → {color, idx: [i], strength: [s]}
    const plain = [];
    for (let i = 0; i < n; i++) {
      if (!onScreen(i, 30)) continue;
      const o = L.owner && war.owner(id[i]);
      if (!o) { plain.push(i); continue; }
      let g = held.get(o.key);
      if (!g) held.set(o.key, g = { color: o.color, idx: [], strength: [] });
      g.idx.push(i); g.strength.push(o.strength ?? 1);
    }
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = P.plain;
    ctx.beginPath();
    for (const i of plain) { ctx.moveTo(sx[i] + r * 0.8, sy[i]); ctx.arc(sx[i], sy[i], r * 0.8, 0, Math.PI * 2); }
    ctx.fill();
    const blob = clamp(scale * 0.9, 2.5, 22);
    for (const g of held.values()) {
      const dim = focus && !g.idx.some(i => focus.has(id[i])) ? 0.35 : 1;
      ctx.fillStyle = g.color;
      for (const strong of [true, false]) {
        const idx = g.idx.filter((_, k) => (g.strength[k] >= 0.5) === strong);
        if (!idx.length) continue;
        const f = (strong ? 1 : 0.45) * dim;
        ctx.globalAlpha = (light ? 0.2 : 0.16) * f;
        ctx.beginPath();
        for (const i of idx) { ctx.moveTo(sx[i] + blob, sy[i]); ctx.arc(sx[i], sy[i], blob, 0, Math.PI * 2); }
        ctx.fill();
        ctx.globalAlpha = dim < 1 ? 0.3 : strong ? 0.95 : 0.6;
        ctx.beginPath();
        for (const i of idx) { ctx.moveTo(sx[i] + r, sy[i]); ctx.arc(sx[i], sy[i], r, 0, Math.PI * 2); }
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // Focused systems (a picked alliance's space or a conflict's battlefields) get a ring.
    if (focus) {
      ctx.strokeStyle = P.hover;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const sid of focus) {
        const i = this.u.indexOf.get(sid);
        if (i == null || !onScreen(i, 10)) continue;
        ctx.moveTo(sx[i] + r + 2.5, sy[i]); ctx.arc(sx[i], sy[i], r + 2.5, 0, Math.PI * 2);
      }
      ctx.stroke();
    }

    // Region labels (zoomed out) / system names (zoomed in)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let visible = 0;
    for (let i = 0; i < n; i++) if (onScreen(i, 0)) visible++;
    if (visible > 220) {
      ctx.font = '600 10px "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = P.region.replace('ALPHA', scale < 3 ? 0.45 : 0.6);
      this.u.regionCentre[this.layout].forEach((c, ri) => {
        if (!c) return;
        const px = c[0] * scale + ox, py = c[1] * scale + oy;
        if (px < -50 || px > w + 50 || py < -20 || py > h + 20) return;
        drawSpaced(ctx, this.u.regions[ri].name.toUpperCase(), px, py);
      });
    } else {
      ctx.font = '10px "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = P.name;
      for (let i = 0; i < n; i++) if (onScreen(i, 0)) ctx.fillText(this.u.name[i], sx[i], sy[i] + r + 7);
    }

    if (war) {
      // Overlay marks are smaller with the whole map in view, so the territory colours still read.
      const zoom = visible > 1500 ? 0.6 : visible > 220 ? 0.8 : 1;
      // Kills in the last hour (ESI): red discs by ship + pod kills.
      if (L.kills) {
        ctx.fillStyle = P.red;
        ctx.strokeStyle = P.red;
        ctx.lineWidth = 1;
        for (const [sid, k] of war.kills) {
          const v = k.ship + k.pod / 2;
          if (v < 1) continue;
          const i = this.u.indexOf.get(sid);
          if (i == null || !onScreen(i)) continue;
          const rr = (1.5 + Math.sqrt(v) * 1.3) * zoom;
          ctx.globalAlpha = 0.2;
          ctx.beginPath(); ctx.arc(sx[i], sy[i], rr, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 0.55;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      // zKillboard fights: amber rings by killmails.
      if (L.fights) {
        ctx.strokeStyle = P.amber;
        for (const [sid, f] of war.fights) {
          const i = this.u.indexOf.get(sid);
          if (i == null || !onScreen(i)) continue;
          const rr = (3 + Math.sqrt(f.kills) * 1.6) * zoom;
          ctx.lineWidth = f.kills >= 10 ? 1.8 : 1.1;
          ctx.globalAlpha = 0.8;
          ctx.beginPath(); ctx.arc(sx[i], sy[i], rr, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      // Sov campaigns: a diamond and the attackers' score.
      if (L.campaigns) {
        ctx.font = '600 10.5px ui-monospace, "Cascadia Mono", Consolas, monospace';
        ctx.textAlign = 'left';
        for (const [sid, c] of war.campaigns) {
          const i = this.u.indexOf.get(sid);
          if (i == null || !onScreen(i)) continue;
          const x = sx[i], y = sy[i], d = 6;
          ctx.beginPath();
          ctx.moveTo(x, y - d); ctx.lineTo(x + d, y); ctx.lineTo(x, y + d); ctx.lineTo(x - d, y); ctx.closePath();
          ctx.lineWidth = 2;
          ctx.strokeStyle = P.violet;
          ctx.stroke();
          const text = `${c.label} ${Math.round(c.attackers * 100)}%`;
          ctx.lineWidth = 3;
          ctx.strokeStyle = P.halo;
          ctx.strokeText(text, x + d + 4, y);
          ctx.fillStyle = P.violet;
          ctx.fillText(text, x + d + 4, y);
        }
        ctx.textAlign = 'center';
      }
      if (war.picked != null) {
        const i = this.u.indexOf.get(war.picked);
        if (i != null) {
          ctx.strokeStyle = P.teal;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(sx[i], sy[i], r + 7, 0, Math.PI * 2); ctx.stroke();
        }
      }
    }

    if (this.hover >= 0) {
      ctx.strokeStyle = P.hover;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sx[this.hover], sy[this.hover], r + 4, 0, Math.PI * 2); ctx.stroke();
    }
  }
}
