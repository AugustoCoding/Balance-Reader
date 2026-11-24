// In-memory log of one acquisition session, its statistics and CSV export.

import { DEFAULT_WINDOW, localUncertainty, meanUncertainty } from './stats.js';

export const CSV_FORMATS = {
  br: { delimiter: ';', decimal: ',', label: 'Brasil — ";" e vírgula decimal (Excel em português)' },
  intl: { delimiter: ',', decimal: '.', label: 'Internacional — "," e ponto decimal' },
};

export function fmtNumber(value, decimal = ',', digits = 3) {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  return value.toFixed(digits).replace('.', decimal);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function clockTime(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function stamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

export class Session {
  constructor({ window = DEFAULT_WINDOW } = {}) {
    this.window = window;
    this.container = 0; // weight of the container, subtracted from every reading
    this.samples = []; // { t: elapsed s, time: epoch ms, value: gross, unit, stable, decimals }
    this.unc = []; // local uncertainty of each sample (independent of the container)
    this.dirty = false; // samples not yet exported
    this.profileName = '';
  }

  get length() {
    return this.samples.length;
  }

  get last() {
    return this.samples.at(-1) ?? null;
  }

  get unit() {
    return this.last?.unit ?? 'g';
  }

  get startedAt() {
    return this.samples[0]?.time ?? null;
  }

  /** Decimal places the balance resolves (largest seen), used for display. */
  get decimals() {
    let d = 0;
    for (let i = Math.max(0, this.samples.length - 50); i < this.samples.length; i++) {
      d = Math.max(d, this.samples[i].decimals ?? 0);
    }
    return this.samples.length ? d : 2;
  }

  net(sample) {
    return sample.value - this.container;
  }

  get values() {
    return this.samples.map((s) => s.value - this.container);
  }

  add(sample) {
    this.samples.push(sample);
    const gross = this.samples.slice(-this.window).map((s) => s.value);
    this.unc.push(this.samples.length < 2 ? null : localUncertainty(gross, gross.length - 1, this.window));
    this.dirty = true;
  }

  setWindow(window) {
    this.window = window;
    this.recompute();
  }

  recompute() {
    const gross = this.samples.map((s) => s.value);
    this.unc = gross.map((_, i) => localUncertainty(gross, i, this.window));
  }

  clear() {
    this.samples = [];
    this.unc = [];
    this.dirty = false;
  }

  duration() {
    if (this.samples.length < 1) return 0;
    return this.samples.at(-1).t - this.samples[0].t;
  }

  lastUncertainty() {
    return this.unc.at(-1) ?? null;
  }

  mean() {
    if (!this.samples.length) return null;
    let sum = 0;
    for (const s of this.samples) sum += s.value;
    return sum / this.samples.length - this.container;
  }

  meanUncertainty() {
    return meanUncertainty(this.unc);
  }

  stats() {
    if (!this.samples.length) return null;
    let min = Infinity;
    let max = -Infinity;
    let stable = 0;
    for (const s of this.samples) {
      min = Math.min(min, s.value);
      max = Math.max(max, s.value);
      if (s.stable) stable++;
    }
    return {
      count: this.samples.length,
      min: min - this.container,
      max: max - this.container,
      range: max - min,
      mean: this.mean(),
      last: this.net(this.last),
      lastUncertainty: this.lastUncertainty(),
      meanUncertainty: this.meanUncertainty(),
      stableShare: stable / this.samples.length,
      duration: this.duration(),
    };
  }

  // ---- export ---------------------------------------------------------

  header() {
    const u = this.unit;
    return ['Tempo (s)', `Peso (${u})`, `Incerteza (${u})`, 'Horário', 'Estável'];
  }

  /** [elapsed, net weight, uncertainty, clock time, stable] per sample. */
  rows() {
    return this.samples.map((s, i) => [s.t, this.net(s), this.unc[i], clockTime(s.time), s.stable ? 'sim' : 'não']);
  }

  /** [label, value] lines written after the data. */
  footer() {
    const u = this.unit;
    const lines = [
      [`Média (${u})`, this.mean()],
      [`Incerteza média (${u})`, this.meanUncertainty()],
    ];
    if (this.container) lines.push([`Peso do recipiente descontado (${u})`, this.container]);
    return lines;
  }

  toCSV(format = 'br') {
    const { delimiter, decimal } = CSV_FORMATS[format] ?? CSV_FORMATS.br;
    const cell = (v) => {
      const s = String(v);
      return /["\n\r]/.test(s) || s.includes(delimiter) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const d = Math.max(3, this.decimals);
    const out = [this.header().map(cell).join(delimiter)];
    for (const [t, v, u, clock, st] of this.rows()) {
      out.push([fmtNumber(t, decimal), fmtNumber(v, decimal, d), fmtNumber(u, decimal, d + 1), clock, st].map(cell).join(delimiter));
    }
    if (this.samples.length) {
      out.push('');
      for (const [label, value] of this.footer()) out.push([cell(label), fmtNumber(value, decimal, d + 1)].join(delimiter));
      if (this.profileName) out.push([cell('Balança'), cell(this.profileName)].join(delimiter));
    }
    // BOM so Excel recognises UTF-8 (accents in "Média" etc.)
    return '﻿' + out.join('\r\n') + '\r\n';
  }

  suggestedFilename(ext = 'xlsx') {
    return `balanca_${stamp(this.startedAt ?? Date.now())}.${ext}`;
  }

  // ---- persistence (autosave) -----------------------------------------

  toJSON() {
    return {
      v: 1,
      container: this.container,
      window: this.window,
      profileName: this.profileName,
      dirty: this.dirty,
      samples: this.samples.map((s) => [s.t, s.time, s.value, s.unit, s.stable ? 1 : 0, s.decimals]),
    };
  }

  static fromJSON(data) {
    const s = new Session({ window: data?.window ?? DEFAULT_WINDOW });
    if (!data || data.v !== 1 || !Array.isArray(data.samples)) return s;
    s.container = Number(data.container) || 0;
    s.profileName = data.profileName ?? '';
    s.samples = data.samples.map(([t, time, value, unit, stable, decimals]) => ({
      t,
      time,
      value,
      unit,
      stable: Boolean(stable),
      decimals,
    }));
    s.recompute();
    s.dirty = Boolean(data.dirty);
    return s;
  }
}
