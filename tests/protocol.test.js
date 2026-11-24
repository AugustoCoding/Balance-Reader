import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PRESETS, findPreset } from '../src/profiles.js';
import { LineSplitter, ParseError, encodeCommand, garbageRatio, parseReading, tryParse } from '../src/protocol.js';
import { formatLine } from '../src/simulator.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

// ---- BEL LG3202i (validated on hardware) — same cases as the Python tests ----

test('on-demand block yields exactly one reading', () => {
  const block = ['--------------------', '16-09-26 13:16:27', '--------------------', 'Peso:       0.00 g  '];
  const parsed = block.map((l) => tryParse(l)).filter(Boolean);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].value, 0);
  assert.equal(parsed[0].unit, 'g');
  assert.equal(parsed[0].stable, true);
});

for (const [line, value] of [
  ['Peso:       0.00 g  ', 0],
  ['Peso:     100.02 g  ', 100.02],
  ['Peso:      -0.01 g', -0.01],
  ['Weight:     31.05 g', 31.05],
  [new TextEncoder().encode('Peso:      22.91 g  \r\n'), 22.91],
]) {
  test(`on-demand weight line ${JSON.stringify(String(line))}`, () => {
    const r = parseReading(line);
    close(r.value, value);
    assert.equal(r.unit, 'g');
    assert.equal(r.stable, true);
  });
}

for (const [line, value, stable] of [
  ['     0.0[0] g S\r\n', 0, true],
  ['     0.0[1] g  \r\n', 0.01, false],
  ['    22.9[2] g S', 22.92, true],
  ['   125.3[4] g', 125.34, false],
  ['  -  0.0[2] g  ', -0.02, false],
]) {
  test(`continuous line ${JSON.stringify(line)}`, () => {
    const r = parseReading(line);
    close(r.value, value);
    assert.equal(r.stable, stable);
    assert.equal(r.decimals, 2);
  });
}

for (const line of ['', '   ', '\r\n', '--------------------', '16-09-26 13:16:27', 'Pcs.:          10', 'Time = 20 Sec', 'total 12 gross']) {
  test(`line without a weight is rejected: ${JSON.stringify(line)}`, () => {
    assert.throws(() => parseReading(line), ParseError);
  });
}

test('other units and capitalisation', () => {
  assert.equal(parseReading('Peso:       1.25 kg').unit, 'kg');
  assert.equal(parseReading('Peso:      12.50 CT').unit, 'ct');
  assert.equal(parseReading('Perc.      100.0 %').unit, '%');
});

test('decimal comma is accepted', () => close(parseReading('Peso:       1,25 g').value, 1.25));
test('raw is preserved', () => assert.equal(parseReading('Peso:       0.00 g  \r\n').raw, 'Peso:       0.00 g  '));
test('negative zero is reported as 0', () => assert.ok(Object.is(parseReading('-0.00 g').value, 0)));

for (const [line, value, stable] of [
  ['     12.345 g  \r\n', 12.345, true],
  ['     12.345 g ?\r\n', 12.345, false],
  ['    -0.002 g ?', -0.002, false],
]) {
  test(`Ohaus "?" flags unstable: ${JSON.stringify(line)}`, () => {
    const r = parseReading(line);
    close(r.value, value);
    assert.equal(r.stable, stable);
  });
}

// ---- other presets (manufacturer formats, not hardware-validated) ----

test('Mettler Toledo MT-SICS', () => {
  const { parser } = findPreset('mettler-sics');
  const s = parseReading('S S      100.00 g', parser);
  close(s.value, 100);
  assert.equal(s.stable, true);
  assert.equal(parseReading('S D      100.03 g', parser).stable, false);
  assert.equal(tryParse('S I', parser), null);
  assert.equal(tryParse('S +', parser), null);
  assert.equal(tryParse('ES', parser), null);
});

test('A&D', () => {
  const { parser } = findPreset('and');
  const st = parseReading('ST,+00012.34  g', parser);
  close(st.value, 12.34);
  assert.equal(st.stable, true);
  const us = parseReading('US,-00000.05  g', parser);
  close(us.value, -0.05);
  assert.equal(us.stable, false);
  assert.equal(tryParse('OL,+9999999  g', parser), null);
});

test('Sartorius SBI', () => {
  const { parser } = findPreset('sartorius-sbi');
  close(parseReading('N     +    123.45 g  ', parser).value, 123.45);
  close(parseReading('N     -      0.10 g  ', parser).value, -0.1);
});

test('every preset reads its own simulator format', () => {
  for (const p of PRESETS) {
    for (const [value, stable] of [
      [22.92, true],
      [-3.5, true],
      [0, false],
    ]) {
      const line = formatLine(p.sim, value, stable);
      const r = tryParse(line, p.parser);
      if (p.sim === 'sbi' && !stable) {
        assert.equal(r, null, 'SBI prints unstable weights without a unit');
        continue;
      }
      assert.ok(r, `${p.id} did not parse ${JSON.stringify(line)}`);
      close(r.value, value);
      // the generic format has no stability marker: every reading counts as stable
      assert.equal(r.stable, p.sim === 'generic' ? true : stable, `${p.id} stability of ${JSON.stringify(line)}`);
    }
  }
});

// ---- custom regex mode and rules ----

test('regex mode with named groups', () => {
  const parser = { mode: 'regex', regex: String.raw`W=(?<valor>[+-]?\d+[.,]\d+);U=(?<unidade>\w+)` };
  const r = parseReading('W=-12,5;U=KG', parser);
  close(r.value, -12.5);
  assert.equal(r.unit, 'kg');
  assert.equal(r.decimals, 1);
});

test('regex mode with a plain group and default unit', () => {
  const r = parseReading('<0123.4>', { mode: 'regex', regex: String.raw`<(\d+\.\d+)>`, defaultUnit: 'mg' });
  close(r.value, 123.4);
  assert.equal(r.unit, 'mg');
});

test('regex mode with separate sign group', () => {
  const r = parseReading('- 00012.30', { mode: 'regex', regex: String.raw`(?<sinal>[+-])\s*(?<valor>\d+\.\d+)` });
  close(r.value, -12.3);
});

test('stable/unstable/ignore rules', () => {
  const parser = { stableRegex: 'OK$', unstableRegex: '^~', ignoreRegex: 'ERR' };
  assert.equal(parseReading('12.00 g OK', parser).stable, true);
  assert.equal(parseReading('12.00 g', parser).stable, false);
  assert.equal(parseReading('~12.00 g OK', parser).stable, false);
  assert.equal(tryParse('ERR 12.00 g', parser), null);
});

test('invalid regex raises a ParseError', () => {
  assert.throws(() => parseReading('1 g', { mode: 'regex', regex: '(' }), ParseError);
});

// ---- commands, splitter, diagnostics ----

test('encodeCommand', () => {
  const s = (bytes) => String.fromCharCode(...bytes);
  assert.equal(s(encodeCommand('T')), 'T\r\n');
  assert.equal(s(encodeCommand(' T ', 'lf')), 'T\n');
  assert.equal(s(encodeCommand('SI', 'cr')), 'SI\r');
  assert.equal(s(encodeCommand('\\eP', 'crlf')), '\x1bP\r\n');
  assert.equal(s(encodeCommand('\\x1BT', 'none')), '\x1bT');
});

test('LineSplitter handles CR LF, CR and LF across chunks', () => {
  const lines = [];
  const sp = new LineSplitter((l) => lines.push(l));
  sp.push('  1.0[0] g S\r');
  sp.push('\n  2.0');
  sp.push('[0] g S\r\n\r\nA\rB\nC');
  assert.deepEqual(lines, ['  1.0[0] g S', '  2.0[0] g S', 'A', 'B']);
  assert.equal(sp.pending, 'C');
});

test('garbageRatio separates text from noise', () => {
  assert.ok(garbageRatio('    22.9[2] g S\r\n') < 0.2);
  assert.ok(garbageRatio('\x80\x9f\x01\x02x\x03') > 0.5);
});
