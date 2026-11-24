// A fake balance with the same interface as a serial transport.
//
// The load sits at a fixed mass and wanders only in the last decimals
// (noise plus slow drift), like a real balance at rest. place() changes the
// mass and flags the reading unstable for a moment. It speaks the line
// format of the active profile (BEL, MT-SICS, A&D, Ohaus, SBI or generic)
// and, when the profile polls, answers only when asked.

import { encodeCommand } from './protocol.js';

export const STREAM_INTERVAL_MS = 200; // ~5 lines per second, like the BEL in continuous mode

function gauss(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Seeded PRNG (mulberry32) so tests are reproducible. */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Format one value the way a balance of the given family prints it. */
export function formatLine(format, value, stable, unit = 'g') {
  const s = value.toFixed(2);
  const abs = Math.abs(value).toFixed(2);
  const sign = value < 0 ? '-' : '+';
  switch (format) {
    case 'bel':
      return `${(s.slice(0, -1) + '[' + s.at(-1) + ']').padStart(10)} ${unit} ${stable ? 'S' : ' '}`;
    case 'mtsics':
      return `S ${stable ? 'S' : 'D'} ${s.padStart(10)} ${unit}`;
    case 'and':
      return `${stable ? 'ST' : 'US'},${sign}${abs.padStart(8, '0')}  ${unit}`;
    case 'ohaus':
      return `${s.padStart(10)} ${unit} ${stable ? ' ' : '?'}`;
    case 'sbi':
      return `N     ${sign}${abs.padStart(10)} ${stable ? unit : ' '}  `;
    default:
      return `${s} ${unit}`;
  }
}

export class SimulatedBalance {
  kind = 'simulator';
  label = 'Simulador';

  /**
   * @param {() => object} getProfile current profile (format, commands, polling)
   */
  constructor(getProfile, { seed, now = () => performance.now(), initialLoad = 25 } = {}) {
    this.getProfile = getProfile;
    this.now = now;
    this.rng = seed === undefined ? Math.random : seeded(seed);
    this.load = initialLoad;
    this.tare = 0;
    this.drift = 0;
    this.unstableUntil = 0;
    this.timer = null;
    this.onData = () => {};
    this.onClose = () => {};
    this.isOpen = false;
  }

  async open() {
    this.isOpen = true;
    this.timer = setInterval(() => this.tick(), STREAM_INTERVAL_MS);
  }

  async close() {
    clearInterval(this.timer);
    this.timer = null;
    this.isOpen = false;
  }

  place(grams) {
    this.load = Math.max(0, this.load + grams);
    this.unstableUntil = this.now() + 800 + this.rng() * 1200;
  }

  clearPan() {
    this.place(-this.load);
  }

  measure() {
    this.drift = Math.max(-0.03, Math.min(0.03, this.drift + gauss(this.rng) * 0.003));
    const stable = this.now() >= this.unstableUntil;
    const noise = stable ? 0.006 : 0.2;
    const value = Math.round((this.load + this.drift - this.tare + gauss(this.rng) * noise) * 100) / 100;
    return { value: Object.is(value, -0) ? 0 : value, stable };
  }

  line() {
    const { value, stable } = this.measure();
    return formatLine(this.getProfile().sim, value, stable) + '\r\n';
  }

  /** Continuous output, unless the profile polls (then it only answers). */
  tick() {
    if (!this.isOpen) return;
    const p = this.getProfile();
    if (p.poll?.command && p.poll.intervalS > 0) return;
    this.onData(this.line());
  }

  async write(bytes) {
    const cmd = new TextDecoder('latin1').decode(bytes).trim().toUpperCase();
    const p = this.getProfile();
    const same = (c) => c && new TextDecoder('latin1').decode(encodeCommand(c, 'none')).trim().toUpperCase() === cmd;
    if (same(p.commands?.tare)) {
      this.tare = this.load;
      this.unstableUntil = this.now() + 500;
    } else if (same(p.commands?.zero)) {
      this.tare = this.load;
    } else if (same(p.commands?.print) || same(p.poll?.command)) {
      setTimeout(() => this.isOpen && this.onData(this.line()), 30);
    }
  }
}
