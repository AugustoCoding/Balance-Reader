// Lightweight canvas line chart for weight vs. time, with hover readout.

import { niceAxis } from './xlsx.js';

function ticks(lo, hi, count) {
  const { step, min, max } = niceAxis(lo, hi, count);
  const out = [];
  for (let v = min; v <= max + step / 2; v += step) out.push(Math.round(v / step) * step);
  return { step, min, max, values: out };
}

function decimalsFor(step) {
  if (step >= 1) return 0;
  return Math.min(6, Math.ceil(-Math.log10(step) - 1e-9));
}

const fmt = (v, d) => v.toFixed(d).replace('.', ',').replace(/^-(0,?0*)$/, '$1');

function fmtTime(s) {
  if (s < 120) return `${fmt(s, s < 10 && s % 1 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  if (m < 60) return `${m}:${String(sec).padStart(2, '0')}`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

export class WeightChart {
  constructor(canvas, tooltip) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tooltip = tooltip;
    this.data = { t: [], v: [], stable: [] };
    this.unit = 'g';
    this.decimals = 2;
    this.mean = null;
    this.hover = null;
    this.frame = 0;
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener('pointermove', (e) => this.onHover(e));
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.tooltip.hidden = true;
      this.draw();
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.draw());
  }

  set({ t, v, stable, unit, decimals, mean }) {
    this.data = { t, v, stable };
    this.unit = unit;
    this.decimals = decimals;
    this.mean = mean;
    this.draw();
  }

  draw() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.paint());
  }

  colors() {
    const css = getComputedStyle(this.canvas);
    const get = (name) => css.getPropertyValue(name).trim();
    return {
      line: get('--chart-line'),
      fill: get('--chart-fill'),
      grid: get('--chart-grid'),
      text: get('--text-muted'),
      unstable: get('--warn'),
      mean: get('--chart-mean'),
      surface: get('--surface'),
    };
  }

  layout() {
    const rect = this.canvas.getBoundingClientRect();
    return { w: rect.width, h: rect.height, left: 64, right: 18, top: 16, bottom: 30 };
  }

  paint() {
    const { canvas, ctx } = this;
    const L = this.layout();
    if (!L.w || !L.h) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(L.w * dpr) || canvas.height !== Math.round(L.h * dpr)) {
      canvas.width = Math.round(L.w * dpr);
      canvas.height = Math.round(L.h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, L.w, L.h);
    const c = this.colors();
    const { t, v, stable } = this.data;
    const pw = L.w - L.left - L.right;
    const ph = L.h - L.top - L.bottom;
    ctx.font = '12px Inter, system-ui, sans-serif';

    if (t.length === 0) {
      ctx.fillStyle = c.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('As leituras gravadas aparecem aqui', L.w / 2, L.h / 2);
      return;
    }

    let vmin = Infinity;
    let vmax = -Infinity;
    for (const x of v) {
      if (x < vmin) vmin = x;
      if (x > vmax) vmax = x;
    }
    const tmin = t[0];
    const tmax = Math.max(t.at(-1), tmin + 1);
    const ySpan = vmax - vmin;
    const minSpan = 10 ** -this.decimals * 4;
    if (ySpan < minSpan) {
      vmin -= (minSpan - ySpan) / 2;
      vmax += (minSpan - ySpan) / 2;
    }
    const yt = ticks(vmin, vmax, Math.max(3, Math.round(ph / 48)));
    const xt = ticks(tmin, tmax, Math.max(3, Math.round(pw / 110)));
    const x0 = Math.max(xt.min, tmin);
    const x1 = tmax;
    const X = (s) => L.left + ((s - x0) / (x1 - x0 || 1)) * pw;
    const Y = (w) => L.top + ph - ((w - yt.min) / (yt.max - yt.min || 1)) * ph;
    this.scale = { X, Y, L, x0, x1 };

    // grid + y labels
    const yd = decimalsFor(yt.step);
    ctx.strokeStyle = c.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = c.text;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const val of yt.values) {
      const y = Math.round(Y(val)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(L.left, y);
      ctx.lineTo(L.w - L.right, y);
      ctx.stroke();
      ctx.fillText(fmt(val, yd), L.left - 10, y);
    }
    // x labels
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const s of xt.values) {
      if (s < x0 - 1e-9 || s > x1 + 1e-9) continue;
      ctx.fillText(fmtTime(s), X(s), L.h - L.bottom + 10);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(L.left, L.top - 4, pw + 4, ph + 8);
    ctx.clip();

    // decimate to roughly one point per pixel column
    const step = Math.max(1, Math.floor(t.length / (pw * 1.5)));
    const idx = [];
    for (let i = 0; i < t.length; i += step) idx.push(i);
    if (idx.at(-1) !== t.length - 1) idx.push(t.length - 1);

    // area
    const grad = ctx.createLinearGradient(0, L.top, 0, L.top + ph);
    grad.addColorStop(0, c.fill);
    grad.addColorStop(1, 'transparent');
    ctx.beginPath();
    ctx.moveTo(X(t[idx[0]]), L.top + ph);
    for (const i of idx) ctx.lineTo(X(t[i]), Y(v[i]));
    ctx.lineTo(X(t[idx.at(-1)]), L.top + ph);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // mean
    if (this.mean !== null && t.length > 1) {
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = c.mean;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(L.left, Y(this.mean));
      ctx.lineTo(L.w - L.right, Y(this.mean));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // line
    ctx.strokeStyle = c.line;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    idx.forEach((i, k) => (k ? ctx.lineTo(X(t[i]), Y(v[i])) : ctx.moveTo(X(t[i]), Y(v[i]))));
    ctx.stroke();

    // unstable readings
    if (idx.length < pw / 3) {
      for (const i of idx) {
        if (stable[i]) continue;
        ctx.fillStyle = c.unstable;
        ctx.beginPath();
        ctx.arc(X(t[i]), Y(v[i]), 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // last point
    const li = t.length - 1;
    ctx.fillStyle = c.line;
    ctx.globalAlpha = 0.2;
    ctx.beginPath();
    ctx.arc(X(t[li]), Y(v[li]), 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(X(t[li]), Y(v[li]), 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (this.mean !== null && t.length > 1) {
      const label = `média ${fmt(this.mean, this.decimals + 1)}`;
      ctx.font = '600 11px Inter, system-ui, sans-serif';
      const w = ctx.measureText(label).width + 12;
      const y = Math.min(Math.max(Y(this.mean), L.top + 9), L.top + ph - 9);
      ctx.fillStyle = c.surface;
      ctx.fillRect(L.w - L.right - w, y - 9, w, 18);
      ctx.fillStyle = c.mean;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, L.w - L.right - 6, y);
    }

    this.paintHover(c);
  }

  paintHover(c) {
    if (!this.hover || !this.scale || !this.data.t.length) return;
    const { t, v, stable } = this.data;
    const { X, Y, L } = this.scale;
    // nearest sample by x (binary search)
    const target = this.hover.time;
    let lo = 0;
    let hi = t.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (t[mid] < target) lo = mid;
      else hi = mid;
    }
    const i = Math.abs(t[lo] - target) < Math.abs(t[hi] - target) ? lo : hi;
    const x = X(t[i]);
    const y = Y(v[i]);
    const { ctx } = this;
    ctx.strokeStyle = c.text;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, L.top);
    ctx.lineTo(Math.round(x) + 0.5, L.h - L.bottom);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = c.surface;
    ctx.strokeStyle = c.line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    const tip = this.tooltip;
    tip.hidden = false;
    tip.innerHTML = `<strong>${fmt(v[i], this.decimals)} ${this.unit}</strong><span>${fmtTime(t[i])} · ${stable[i] ? 'estável' : 'instável'}</span>`;
    const box = tip.getBoundingClientRect();
    const left = Math.min(Math.max(x - box.width / 2, 4), L.w - box.width - 4);
    const top = y - box.height - 14 < 0 ? y + 14 : y - box.height - 14;
    tip.style.transform = `translate(${left}px, ${top}px)`;
  }

  onHover(e) {
    if (!this.scale) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const { L, x0, x1 } = this.scale;
    const pw = L.w - L.left - L.right;
    this.hover = { time: x0 + ((px - L.left) / pw) * (x1 - x0) };
    this.draw();
  }
}
