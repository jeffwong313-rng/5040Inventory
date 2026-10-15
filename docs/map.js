// Draws one map tab from map.json as an SVG "picture" and makes it
// draggable / pinch-zoomable. Highlighted cells keep their real colour;
// everything else is muted.
import { hexToRgb } from "./zones.js";

const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};

const PAPER = [246, 247, 249];
function mute(hex) {
  const [r, g, b] = hexToRgb(hex);
  const grey = 0.3 * r + 0.59 * g + 0.11 * b;
  const mix = (v, w, t) => Math.round(v + (w - v) * t);
  const d = [r, g, b].map((v) => mix(v, grey, 0.65));
  const out = d.map((v, i) => mix(v, PAPER[i], 0.55));
  return `rgb(${out.join(",")})`;
}

export class MapView {
  constructor(host) {
    this.host = host;
    this.svg = el("svg", { class: "map-svg", role: "img" });
    this.world = el("g", {}, this.svg);
    host.appendChild(this.svg);
    this.view = { x: 0, y: 0, k: 1 };
    this.pointers = new Map();
    this.anim = null;
    this._bind();
    this.ro = new ResizeObserver(() => this._apply());
    this.ro.observe(host);
  }

  destroy() { this.ro.disconnect(); cancelAnimationFrame(this.anim); }

  /** tab: map.json tab; lit: Set of cell indexes (null = whole tab lit) */
  render(tab, lit) {
    this.tab = tab;
    this.world.replaceChildren();
    // frame = what's actually drawn as blocks/labels (stray borders can run long)
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const [x, y, w, h] of tab.cells) {
      x1 = Math.min(x1, x); y1 = Math.min(y1, y);
      x2 = Math.max(x2, x + w); y2 = Math.max(y2, y + h);
    }
    if (!isFinite(x1)) [x1, y1, x2, y2] = [tab.bounds[0], tab.bounds[1], tab.bounds[0] + tab.bounds[2], tab.bounds[1] + tab.bounds[3]];
    const [bx, by, bw, bh] = [x1 - 10, y1 - 10, x2 - x1 + 20, y2 - y1 + 20];
    this.bounds = { x: bx, y: by, w: bw, h: bh };
    const all = lit === null;
    const isLit = (i) => all || (lit && lit.has(i));

    el("rect", { x: bx - 40, y: by - 40, width: bw + 80, height: bh + 80, fill: `rgb(${PAPER.join(",")})` }, this.world);

    const gFill = el("g", {}, this.world);
    const gLines = el("g", { class: "map-lines" }, this.world);
    const gLit = el("g", {}, this.world);
    const gText = el("g", { class: "map-text" }, this.world);

    tab.cells.forEach((k, i) => {
      const [x, y, w, h, fill] = k;
      if (!fill) return;
      const on = isLit(i);
      el("rect", {
        x, y, width: w, height: h,
        fill: on ? fill : mute(fill),
        class: on && !all ? "cell lit" : "cell",
      }, on && !all ? gLit : gFill);
    });

    for (const [x1, y1, x2, y2, color, w] of tab.lines) {
      el("line", {
        x1, y1, x2, y2,
        stroke: all ? color : "#9aa0aa",
        "stroke-width": w,
        "stroke-linecap": "square",
      }, gLines);
    }

    // outline each lit block so it pops even when the colour is pale
    if (lit && !all) {
      tab.cells.forEach((k, i) => {
        if (!lit.has(i)) return;
        const [x, y, w, h] = k;
        el("rect", { x, y, width: w, height: h, class: "lit-outline" }, gLit);
      });
    }

    tab.cells.forEach((k, i) => {
      const [x, y, w, h, fill, text, fs, bold, color, align] = k;
      if (!text) return;
      const on = isLit(i);
      let size = Math.max(6, (fs || 13) * 0.95);
      const est = text.length * size * 0.56;
      if (fill && est > w - 4) size = Math.max(5, size * ((w - 4) / est));
      const anchor = align === "c" || fill ? "middle" : align === "r" ? "end" : "start";
      const tx = anchor === "middle" ? x + w / 2 : anchor === "end" ? x + w - 3 : x + 3;
      const t = el("text", {
        x: tx, y: y + h / 2,
        "font-size": size.toFixed(1),
        "font-weight": bold ? 700 : 400,
        "text-anchor": anchor,
        "dominant-baseline": "central",
        fill: on ? color || "#000" : "#8b919c",
      }, gText);
      t.textContent = text;
    });
  }

  litBox(lit) {
    if (!this.tab || !lit || !lit.size) return null;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const i of lit) {
      const [x, y, w, h] = this.tab.cells[i];
      x1 = Math.min(x1, x); y1 = Math.min(y1, y);
      x2 = Math.max(x2, x + w); y2 = Math.max(y2, y + h);
    }
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  /** zoom so box fills the view (with padding); animate */
  fit(box, { animate = true, pad = 0.18, maxK = 3 } = {}) {
    box = box || this.bounds;
    if (!box) return;
    const W = this.host.clientWidth || 1;
    const H = this.host.clientHeight || 1;
    const k = Math.min(maxK, Math.min(W / (box.w * (1 + pad * 2)), H / (box.h * (1 + pad * 2))));
    const target = { k, x: W / 2 - (box.x + box.w / 2) * k, y: H / 2 - (box.y + box.h / 2) * k };
    if (!animate) { this.view = target; this._apply(); return; }
    this._tween(target, 650);
  }

  fitWhole(animate = true) { this.fit(this.bounds, { animate, pad: 0.03, maxK: 3 }); }

  zoomBy(f, cx, cy) {
    const W = this.host.clientWidth;
    const H = this.host.clientHeight;
    cx = cx ?? W / 2; cy = cy ?? H / 2;
    const v = this.view;
    const k = Math.max(this._minK(), Math.min(10, v.k * f));
    const r = k / v.k;
    this.view = { k, x: cx - (cx - v.x) * r, y: cy - (cy - v.y) * r };
    this._apply();
  }

  _minK() {
    if (!this.bounds) return 0.05;
    const W = this.host.clientWidth || 1;
    const H = this.host.clientHeight || 1;
    return Math.min(W / this.bounds.w, H / this.bounds.h) * 0.6;
  }

  _tween(target, ms) {
    cancelAnimationFrame(this.anim);
    const from = { ...this.view };
    const t0 = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      const e = ease(t);
      this.view = {
        k: from.k + (target.k - from.k) * e,
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e,
      };
      this._apply();
      if (t < 1) this.anim = requestAnimationFrame(step);
    };
    this.anim = requestAnimationFrame(step);
  }

  _apply() {
    const { x, y, k } = this.view;
    this.world.setAttribute("transform", `translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${k.toFixed(5)})`);
    this.svg.style.setProperty("--k", k);
  }

  _bind() {
    const s = this.svg;
    s.addEventListener("pointerdown", (e) => {
      cancelAnimationFrame(this.anim);
      s.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this._gesture = null;
    });
    s.addEventListener("pointermove", (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const prev = this.pointers.get(e.pointerId);
      const cur = { x: e.clientX, y: e.clientY };
      if (this.pointers.size === 1) {
        this.view.x += cur.x - prev.x;
        this.view.y += cur.y - prev.y;
        this.pointers.set(e.pointerId, cur);
        this._apply();
        return;
      }
      const pts = [...this.pointers.values()];
      const before = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const midB = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      this.pointers.set(e.pointerId, cur);
      const pts2 = [...this.pointers.values()];
      const after = Math.hypot(pts2[0].x - pts2[1].x, pts2[0].y - pts2[1].y);
      const midA = { x: (pts2[0].x + pts2[1].x) / 2, y: (pts2[0].y + pts2[1].y) / 2 };
      const r = s.getBoundingClientRect();
      this.view.x += midA.x - midB.x;
      this.view.y += midA.y - midB.y;
      if (before > 0) this.zoomBy(after / before, midA.x - r.left, midA.y - r.top);
      else this._apply();
    });
    const end = (e) => this.pointers.delete(e.pointerId);
    s.addEventListener("pointerup", end);
    s.addEventListener("pointercancel", end);
    s.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = s.getBoundingClientRect();
      this.zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    s.addEventListener("dblclick", (e) => {
      const r = s.getBoundingClientRect();
      this.zoomBy(1.8, e.clientX - r.left, e.clientY - r.top);
    });
  }
}
