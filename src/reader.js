// Acquisition controller: owns a transport (Web Serial or simulator), splits
// its output into lines, parses readings and records samples while running.

import { LineSplitter, encodeCommand, garbageRatio, tryParse } from './protocol.js';

export class BalanceReader {
  /**
   * @param {object} opts
   * @param {() => object} opts.getProfile active profile
   * @param {() => number} opts.getSampleInterval minimum seconds between recorded samples (0 = all)
   */
  constructor({ getProfile, getSampleInterval = () => 0, now = () => performance.now(), clock = () => Date.now() }) {
    this.getProfile = getProfile;
    this.getSampleInterval = getSampleInterval;
    this.now = now;
    this.clock = clock;
    this.transport = null;
    this.running = false;
    this.startedAt = null;
    this.lastSampleAt = null;
    this.pollTimer = null;
    this.listeners = new Map();
    this.splitter = new LineSplitter((line) => this.handleLine(line));
    this.resetFlow();
  }

  // ---- events -----------------------------------------------------------

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type).delete(fn);
  }

  emit(type, detail) {
    for (const fn of this.listeners.get(type) ?? []) fn(detail);
  }

  // ---- connection -------------------------------------------------------

  get connected() {
    return this.transport !== null;
  }

  get isSimulator() {
    return this.transport?.kind === 'simulator';
  }

  resetFlow() {
    this.flow = {
      connectedAt: this.now(),
      lastRxAt: null,
      lastReadingAt: null,
      unparsedSinceReading: 0,
      recentText: '',
      framingErrors: 0,
    };
  }

  async connect(transport) {
    await this.disconnect();
    transport.onData = (text) => this.handleData(text);
    transport.onClose = (err) => this.handleClose(err);
    transport.onWarn = (name) => {
      this.flow.framingErrors++;
      this.emit('warn', name);
    };
    await transport.open();
    this.transport = transport;
    this.splitter.reset();
    // The first line may have been caught halfway ("2.9[2]" read as "9[2]"):
    // it is shown in the console but never recorded.
    this.skipFirst = transport.kind !== 'simulator';
    this.resetFlow();
    this.startPolling(); // balances that only answer when asked are polled while connected
    this.emit('state');
  }

  async disconnect() {
    this.stop();
    this.stopPolling();
    const t = this.transport;
    if (!t) return;
    this.transport = null;
    try {
      await t.close();
    } catch {
      /* closing must never throw into the UI */
    }
    this.emit('state');
  }

  handleClose(err) {
    if (!this.transport) return;
    this.stopPolling();
    this.running = false;
    this.transport = null;
    this.emit('disconnected', err);
    this.emit('state');
  }

  // ---- commands ---------------------------------------------------------

  async send(command) {
    if (!this.transport) throw new Error('Conecte a balança primeiro.');
    if (!command) return;
    const bytes = encodeCommand(command, this.getProfile().commands.lineEnding);
    await this.transport.write(bytes);
    this.emit('tx', command);
  }

  // ---- acquisition ------------------------------------------------------

  get elapsed() {
    return this.startedAt === null ? 0 : (this.now() - this.startedAt) / 1000;
  }

  /** Begin recording; resumeFrom continues the time axis after a pause (seconds). */
  start(resumeFrom = 0) {
    if (!this.transport) throw new Error('Conecte a balança antes de iniciar.');
    if (this.running) return;
    this.running = true;
    this.lastSampleAt = null;
    this.startedAt = this.now() - resumeFrom * 1000;
    this.flow.lastReadingAt = null;
    this.flow.connectedAt = this.now();
    this.emit('state');
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.emit('state');
  }

  /** (Re)start polling with the current profile; call after the profile changes. */
  startPolling() {
    this.stopPolling();
    const { command, intervalS } = this.getProfile().poll;
    if (!this.transport || !command || !(intervalS > 0)) return;
    const ask = () => this.send(command).catch((e) => this.emit('error', e));
    ask();
    this.pollTimer = setInterval(ask, Math.max(100, intervalS * 1000));
  }

  stopPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  handleData(text) {
    if (!text) return;
    this.flow.lastRxAt = this.now();
    this.flow.recentText = (this.flow.recentText + text).slice(-400);
    this.splitter.push(text);
  }

  handleLine(line) {
    const skipped = this.skipFirst;
    this.skipFirst = false;
    const reading = skipped ? null : tryParse(line, this.getProfile().parser);
    this.emit('rx', { line, reading, skipped });
    if (!reading) {
      if (!skipped) this.flow.unparsedSinceReading++;
      return;
    }
    const now = this.now();
    this.flow.lastReadingAt = now;
    this.flow.unparsedSinceReading = 0;

    let sample = null;
    if (this.running) {
      const gap = Math.max(0, this.getSampleInterval());
      const thin = gap > 0 && this.lastSampleAt !== null && (now - this.lastSampleAt) / 1000 < gap - 1e-6;
      if (!thin) {
        this.lastSampleAt = now;
        sample = {
          t: Math.round(((now - this.startedAt) / 1000) * 1000) / 1000,
          time: this.clock(),
          value: reading.value,
          unit: reading.unit,
          stable: reading.stable,
          decimals: reading.decimals,
        };
      }
    }
    this.emit('reading', { reading, sample });
  }

  /**
   * Why nothing usable is arriving, or null when all is well.
   * 'silent' — no bytes at all; 'garbage' — unreadable characters (wrong speed/parity);
   * 'unparsed' — readable lines that the profile does not recognise.
   */
  diagnose(afterS = 8) {
    if (!this.transport || this.isSimulator) return null;
    const now = this.now();
    const since = (t) => (t === null ? Infinity : (now - t) / 1000);
    if (since(this.flow.connectedAt) < afterS) return null;
    if (since(this.flow.lastReadingAt) < afterS) return null;
    if (since(this.flow.lastRxAt) >= afterS) return 'silent';
    if (this.flow.framingErrors > 0 || garbageRatio(this.flow.recentText) > 0.2) return 'garbage';
    return 'unparsed';
  }
}
