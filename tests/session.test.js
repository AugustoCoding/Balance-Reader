import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Session } from '../src/session.js';
import { localUncertainties, meanUncertainty, stdDev } from '../src/stats.js';
import { buildXlsx, crc32, niceAxis } from '../src/xlsx.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

function sessionWith(values, opts) {
  const s = new Session(opts);
  values.forEach((v, i) => s.add({ t: i, time: Date.UTC(2026, 0, 1, 12, 0, i), value: v, unit: 'g', stable: i % 2 === 0, decimals: 2 }));
  return s;
}

test('stdDev and local uncertainty', () => {
  assert.equal(stdDev([]), 0);
  assert.equal(stdDev([5]), 0);
  close(stdDev([1, 2, 3, 4]), Math.sqrt(5 / 3));
  const u = localUncertainties([1, 2, 3, 4, 5, 6], 3);
  assert.equal(u[0], null);
  close(u[1], stdDev([1, 2]));
  close(u[5], stdDev([4, 5, 6]));
  close(meanUncertainty(u), (u[1] + u[2] + u[3] + u[4] + u[5]) / 5);
  assert.equal(meanUncertainty([null]), null);
});

test('incremental uncertainty equals the batch computation', () => {
  const values = [10, 10.02, 9.98, 10.01, 10.05, 9.97, 10];
  const s = sessionWith(values, { window: 4 });
  const batch = localUncertainties(values, 4);
  s.unc.forEach((u, i) => (u === null ? assert.equal(batch[i], null) : close(u, batch[i])));
});

test('container is subtracted everywhere but does not change uncertainty', () => {
  const s = sessionWith([12, 12.1, 12.2]);
  const before = s.meanUncertainty();
  s.container = 2;
  close(s.mean(), 10.1);
  const st = s.stats();
  close(st.min, 10);
  close(st.max, 10.2);
  close(st.last, 10.2);
  close(s.meanUncertainty(), before);
  assert.deepEqual(
    s.footer().map(([l]) => l),
    ['Média (g)', 'Incerteza média (g)', 'Peso do recipiente descontado (g)'],
  );
});

test('CSV in Brazilian format', () => {
  const s = sessionWith([1.5, 1.52]);
  const csv = s.toCSV('br');
  assert.ok(csv.startsWith('\ufeffTempo (s);Peso (g);Incerteza (g);Horário;Estável\r\n'));
  const lines = csv.slice(1).split('\r\n');
  assert.match(lines[1], /^0,000;1,500;;\d\d:\d\d:\d\d;sim$/);
  assert.match(lines[2], /^1,000;1,520;0,0141;/);
  assert.ok(lines.some((l) => l.startsWith('Média (g);1,5100')));
});

test('CSV in international format', () => {
  const csv = sessionWith([1.5, 1.52]).toCSV('intl');
  assert.ok(csv.includes('1.000,1.520,0.0141,'));
});

test('JSON round trip keeps samples, container and dirty flag', () => {
  const s = sessionWith([3, 3.01, 3.02], { window: 3 });
  s.container = 1;
  const back = Session.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
  assert.equal(back.length, 3);
  assert.equal(back.container, 1);
  assert.equal(back.window, 3);
  assert.equal(back.dirty, true);
  close(back.mean(), s.mean());
  close(back.meanUncertainty(), s.meanUncertainty());
  assert.equal(Session.fromJSON(null).length, 0);
  assert.equal(Session.fromJSON({ v: 99 }).length, 0);
});

test('niceAxis gives round bounds around the data', () => {
  const a = niceAxis(0, 47);
  assert.ok(a.min <= 0 && a.max >= 47);
  assert.ok([1, 2, 2.5, 5, 10].some((m) => Math.abs(a.step / 10 ** Math.floor(Math.log10(a.step)) - m) < 1e-9));
  const flat = niceAxis(5, 5);
  assert.ok(flat.max > flat.min);
});

test('crc32 known value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

/** Read back a stored ZIP and return { name: text }. */
function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = {};
  let pos = 0;
  const dec = new TextDecoder();
  while (dv.getUint32(pos, true) === 0x04034b50) {
    const crc = dv.getUint32(pos + 14, true);
    const size = dv.getUint32(pos + 18, true);
    const nameLen = dv.getUint16(pos + 26, true);
    const name = dec.decode(bytes.subarray(pos + 30, pos + 30 + nameLen));
    const data = bytes.subarray(pos + 30 + nameLen, pos + 30 + nameLen + size);
    assert.equal(crc32(data), crc, `bad CRC for ${name}`);
    out[name] = dec.decode(data);
    pos += 30 + nameLen + size;
  }
  assert.equal(dv.getUint32(bytes.length - 22, true), 0x06054b50, 'missing end of central directory');
  return out;
}

test('XLSX package has the expected parts and data', () => {
  const s = sessionWith([10, 10.5, 11]);
  s.container = 0.5;
  const files = unzip(buildXlsx(s, new Date(Date.UTC(2026, 0, 1))));
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/charts/chart1.xml', 'xl/drawings/drawing1.xml']) {
    assert.ok(part in files, `missing ${part}`);
  }
  const sheet = files['xl/worksheets/sheet1.xml'];
  assert.ok(sheet.includes('<c r="B2" s="1"><v>9.5</v></c>'));
  assert.ok(sheet.includes('Peso do recipiente descontado (g)'));
  assert.ok(files['xl/charts/chart1.xml'].includes('Leituras!$B$2:$B$4'));
});

test('XLSX without enough points has no chart', () => {
  const files = unzip(buildXlsx(sessionWith([1])));
  assert.ok(!('xl/charts/chart1.xml' in files));
  assert.ok(!files['xl/worksheets/sheet1.xml'].includes('<drawing'));
});
