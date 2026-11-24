import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findPreset, normalizeProfile, sameBehaviour } from '../src/profiles.js';
import { BalanceReader } from '../src/reader.js';
import { SimulatedBalance } from '../src/simulator.js';

class FakeTransport {
  kind = 'serial';
  label = 'fake';
  written = [];
  async open() {}
  async close() {}
  async write(bytes) {
    this.written.push(String.fromCharCode(...bytes));
  }
  feed(text) {
    this.onData(text);
  }
}

function setup(profileId = 'bel-lg3202i', interval = 0) {
  let now = 0;
  const profile = normalizeProfile(findPreset(profileId));
  const reader = new BalanceReader({ getProfile: () => profile, getSampleInterval: () => interval, now: () => now, clock: () => 1000 + now });
  const t = new FakeTransport();
  const samples = [];
  const rx = [];
  reader.on('reading', ({ sample }) => sample && samples.push(sample));
  reader.on('rx', (e) => rx.push(e));
  return { reader, t, samples, rx, profile, advance: (ms) => (now += ms) };
}

test('first line after connecting is shown but never recorded', async () => {
  const { reader, t, samples, rx } = setup();
  await reader.connect(t);
  reader.start();
  t.feed('9[2] g S\r\n    22.9[3] g S\r\n');
  assert.equal(rx[0].skipped, true);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].value, 22.93);
});

test('readings are only recorded while running, with elapsed time', async () => {
  const { reader, t, samples, advance } = setup();
  await reader.connect(t);
  t.feed('x\r\n 1.0[0] g S\r\n');
  assert.equal(samples.length, 0);
  reader.start();
  advance(1500);
  t.feed(' 2.0[0] g S\r\n');
  assert.equal(samples.length, 1);
  assert.equal(samples[0].t, 1.5);
  reader.stop();
  t.feed(' 3.0[0] g S\r\n');
  assert.equal(samples.length, 1);
  reader.start(10); // resume the time axis
  advance(500);
  t.feed(' 4.0[0] g S\r\n');
  assert.equal(samples[1].t, 10.5);
});

test('minimum interval thins out a fast stream', async () => {
  const { reader, t, samples, advance } = setup('bel-lg3202i', 1);
  await reader.connect(t);
  t.feed('skip\r\n');
  reader.start();
  for (let i = 0; i < 25; i++) {
    t.feed(` 1.0[${i % 10}] g S\r\n`);
    advance(200);
  }
  assert.equal(samples.length, 5); // 5 s of data at >= 1 s spacing
});

test('commands use the profile line ending and polling runs while connected', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setInterval'] });
  const { reader, t } = setup('mettler-sics');
  await reader.connect(t);
  await reader.send('T');
  assert.ok(t.written.includes('T\r\n'));
  assert.ok(t.written.includes('SI\r\n')); // polled immediately on connect
  const before = t.written.length;
  ctx.mock.timers.tick(1500);
  assert.equal(t.written.length - before, 3);
  await reader.disconnect();
  ctx.mock.timers.tick(5000);
  assert.equal(t.written.length - before, 3);
});

test('diagnose: silent, garbage and unparsed', async () => {
  const a = setup();
  await a.reader.connect(a.t);
  a.advance(9000);
  assert.equal(a.reader.diagnose(), 'silent');

  const b = setup();
  await b.reader.connect(b.t);
  b.t.feed('\x80\x91\x02\x9f\x03\x85\r\n\x86\x87\x01\x02\r\n');
  b.advance(9000);
  b.t.feed('\x80\x91\x02');
  assert.equal(b.reader.diagnose(), 'garbage');

  const c = setup();
  await c.reader.connect(c.t);
  c.advance(9000);
  c.t.feed('HELLO WORLD\r\nNO WEIGHT HERE\r\n');
  assert.equal(c.reader.diagnose(), 'unparsed');

  const d = setup();
  await d.reader.connect(d.t);
  d.advance(9000);
  d.t.feed('x\r\n  5.0[0] g S\r\n');
  assert.equal(d.reader.diagnose(), null);
});

test('lost connection stops recording and reports it', async () => {
  const { reader, t } = setup();
  let lost = null;
  reader.on('disconnected', (e) => (lost = e));
  await reader.connect(t);
  reader.start();
  t.onClose(new Error('unplugged'));
  assert.equal(reader.connected, false);
  assert.equal(reader.running, false);
  assert.equal(lost.message, 'unplugged');
});

test('simulator answers tare and poll commands', async () => {
  let now = 0;
  const profile = normalizeProfile(findPreset('mettler-sics'));
  const sim = new SimulatedBalance(() => profile, { seed: 1, now: () => now });
  const lines = [];
  sim.onData = (l) => lines.push(l);
  sim.isOpen = true;
  sim.tick();
  assert.equal(lines.length, 0, 'polled profile: no unsolicited output');
  await sim.write(new TextEncoder().encode('SI\r\n'));
  await new Promise((r) => setTimeout(r, 50));
  assert.match(lines[0], /^S [SD] +\d+\.\d\d g\r\n$/);
  await sim.write(new TextEncoder().encode('T\r\n'));
  now = 10000;
  assert.ok(Math.abs(sim.measure().value) < 0.1);
});

test('sameBehaviour ignores names but not parameters', () => {
  const a = normalizeProfile(findPreset('generic'));
  const b = { ...structuredClone(a), name: 'Outro' };
  assert.ok(sameBehaviour(a, b));
  b.serial.baudRate = 2400;
  assert.ok(!sameBehaviour(a, b));
});
