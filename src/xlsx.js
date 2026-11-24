// Minimal XLSX writer: one sheet with the readings, a summary below and a
// weight-vs-time scatter chart beside it. No dependencies — the workbook is
// a ZIP (stored, not compressed) of a handful of XML parts.

const enc = new TextEncoder();

// ---- ZIP ----------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a ZIP archive from [{ name, data: string|Uint8Array }]. */
export function zip(files, date = new Date()) {
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), name, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, dosTime, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);

    offset += 30 + name.length + data.length;
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);

  const parts = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

// ---- helpers ------------------------------------------------------------

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // characters XML 1.0 forbids
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const NS_XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';

function colName(i) {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

/** Round axis bounds: returns { step, min, max } covering [lo, hi]. */
export function niceAxis(lo, hi, ticks = 6) {
  let span = hi - lo;
  if (!(span > 0)) span = Math.max(Math.abs(hi) * 0.1, 0.01);
  const raw = span / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  let min = Math.floor(lo / step) * step;
  let max = Math.ceil(hi / step) * step;
  if (max - hi < step * 0.15) max += step;
  if (lo - min < step * 0.15 && lo !== 0) min -= step;
  const r = (x) => Math.round(x * 1e6) / 1e6;
  return { step: r(step), min: r(min), max: r(max) };
}

function formatForStep(step) {
  let digits = 0;
  while (step < 1 && digits < 6 && Math.abs(Number(step.toFixed(digits)) - step) > 1e-9) digits++;
  return digits === 0 ? '0' : '0.' + '0'.repeat(digits);
}

// ---- workbook parts -----------------------------------------------------

const STYLE = { normal: 0, num: 1, header: 2, label: 3, labelNum: 4, text: 5, num4: 6 };

function stylesXml() {
  return `${XML}<styleSheet xmlns="${NS_MAIN}">
<numFmts count="2"><numFmt numFmtId="164" formatCode="0.000"/><numFmt numFmtId="165" formatCode="0.0000"/></numFmts>
<fonts count="3">
<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
<font><b/><sz val="11"/><color rgb="FF1F3A5F"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
</fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FF9DB7D5"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="165" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function cell(ref, value, style) {
  const s = style ? ` s="${style}"` : '';
  if (value === null || value === undefined || value === '') return style ? `<c r="${ref}"${s}/>` : '';
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

function sheetXml(session, hasChart) {
  const header = session.header();
  const rows = session.rows();
  const out = [];
  out.push(`<row r="1">${header.map((h, i) => cell(`${colName(i)}1`, h, STYLE.header)).join('')}</row>`);
  rows.forEach(([t, v, u, clock, st], i) => {
    const r = i + 2;
    out.push(
      `<row r="${r}">${cell(`A${r}`, t, STYLE.num)}${cell(`B${r}`, v, STYLE.num)}${cell(`C${r}`, u, STYLE.num4)}` +
        `${cell(`D${r}`, clock, STYLE.text)}${cell(`E${r}`, st, STYLE.text)}</row>`,
    );
  });
  if (rows.length) {
    let r = rows.length + 3;
    const footer = session.footer();
    if (session.profileName) footer.push(['Balança', session.profileName]);
    for (const [label, value] of footer) {
      out.push(`<row r="${r}">${cell(`A${r}`, label, STYLE.label)}${cell(`B${r}`, value, typeof value === 'number' ? STYLE.labelNum : STYLE.label)}</row>`);
      r++;
    }
  }
  const last = Math.max(1, rows.length + 3 + session.footer().length);
  return `${XML}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">
<dimension ref="A1:E${last}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols><col min="1" max="1" width="30" customWidth="1"/><col min="2" max="2" width="14" customWidth="1"/><col min="3" max="3" width="16" customWidth="1"/><col min="4" max="4" width="11" customWidth="1"/><col min="5" max="5" width="9" customWidth="1"/></cols>
<sheetData>${out.join('')}</sheetData>
<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
${hasChart ? '<drawing r:id="rId1"/>' : ''}
</worksheet>`;
}

function richText(text, size, bold) {
  return `<c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}" b="${bold ? 1 : 0}"/></a:pPr><a:r><a:rPr lang="pt-BR" sz="${size}" b="${bold ? 1 : 0}"><a:solidFill><a:srgbClr val="404040"/></a:solidFill></a:rPr><a:t>${esc(text)}</a:t></a:r></a:p></c:rich></c:tx>`;
}

function axisXml({ id, cross, pos, title, axis, grid }) {
  const line = '<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="8C8C8C"/></a:solidFill></a:ln></c:spPr>';
  const gridXml = grid ? '<c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="E3E3E3"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>' : '';
  return `<c:valAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/><c:max val="${axis.max}"/><c:min val="${axis.min}"/></c:scaling>
<c:delete val="0"/><c:axPos val="${pos}"/>${gridXml}<c:title>${richText(title, 1000, false)}<c:overlay val="0"/></c:title>
<c:numFmt formatCode="${formatForStep(axis.step)}" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="low"/>${line}
<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"><a:solidFill><a:srgbClr val="595959"/></a:solidFill></a:defRPr></a:pPr><a:endParaRPr lang="pt-BR"/></a:p></c:txPr>
<c:crossAx val="${cross}"/><c:crosses val="min"/><c:crossBetween val="midCat"/><c:majorUnit val="${axis.step}"/></c:valAx>`;
}

function chartXml(session) {
  const n = session.length;
  const values = session.values;
  const maxOf = (a) => a.reduce((m, v) => (v > m ? v : m), -Infinity);
  const minOf = (a) => a.reduce((m, v) => (v < m ? v : m), Infinity);
  const x = niceAxis(0, maxOf(session.samples.map((s) => s.t)) || 1);
  const y = niceAxis(minOf(values), maxOf(values));
  const blue = '2563EB';
  return `${XML}<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_REL}">
<c:roundedCorners val="0"/>
<c:chart>
<c:title>${richText('Peso ao longo do tempo', 1400, true)}<c:overlay val="0"/></c:title>
<c:autoTitleDeleted val="0"/>
<c:plotArea><c:layout/>
<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>
<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>Leituras!$B$1</c:f></c:strRef></c:tx>
<c:spPr><a:ln w="19050" cap="rnd"><a:solidFill><a:srgbClr val="${blue}"/></a:solidFill><a:round/></a:ln></c:spPr>
<c:marker><c:symbol val="circle"/><c:size val="${n > 300 ? 2 : 4}"/><c:spPr><a:solidFill><a:srgbClr val="${blue}"/></a:solidFill><a:ln w="6350"><a:solidFill><a:srgbClr val="${blue}"/></a:solidFill></a:ln></c:spPr></c:marker>
<c:xVal><c:numRef><c:f>Leituras!$A$2:$A$${n + 1}</c:f></c:numRef></c:xVal>
<c:yVal><c:numRef><c:f>Leituras!$B$2:$B$${n + 1}</c:f></c:numRef></c:yVal>
<c:smooth val="0"/></c:ser>
<c:axId val="500100"/><c:axId val="500200"/></c:scatterChart>
${axisXml({ id: 500100, cross: 500200, pos: 'b', title: 'Tempo (s)', axis: x, grid: false })}
${axisXml({ id: 500200, cross: 500100, pos: 'l', title: `Peso (${session.unit})`, axis: y, grid: true })}
<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>
</c:plotArea>
<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/>
</c:chart>
<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr>
</c:chartSpace>`;
}

function drawingXml() {
  return `${XML}<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}">
<xdr:twoCellAnchor editAs="oneCell">
<xdr:from><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
<xdr:to><xdr:col>18</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>24</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Gráfico 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>
<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
<a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" xmlns:r="${NS_REL}" r:id="rId1"/></a:graphicData></a:graphic>
</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>
</xdr:wsDr>`;
}

const rels = (items) =>
  `${XML}<Relationships xmlns="${NS_PKG_REL}">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${NS_REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;

/** Build the .xlsx bytes for a session. */
export function buildXlsx(session, date = new Date()) {
  const hasChart = session.length >= 2;
  const ct = 'application/vnd.openxmlformats-officedocument';
  const overrides = [
    ['/xl/workbook.xml', `${ct}.spreadsheetml.sheet.main+xml`],
    ['/xl/worksheets/sheet1.xml', `${ct}.spreadsheetml.worksheet+xml`],
    ['/xl/styles.xml', `${ct}.spreadsheetml.styles+xml`],
    ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
  ];
  if (hasChart) {
    overrides.push(['/xl/drawings/drawing1.xml', `${ct}.drawing+xml`], ['/xl/charts/chart1.xml', `${ct}.drawingml.chart+xml`]);
  }
  const iso = date.toISOString().replace(/\.\d+Z$/, 'Z');
  const files = [
    {
      name: '[Content_Types].xml',
      data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.map(([p, t]) => `<Override PartName="${p}" ContentType="${t}"/>`).join('')}</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `${XML}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    },
    {
      name: 'docProps/core.xml',
      data: `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Leituras da balança</dc:title><dc:creator>Balance Reader</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created></cp:coreProperties>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `${XML}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><bookViews><workbookView/></bookViews><sheets><sheet name="Leituras" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: rels([
        ['rId1', 'worksheet', 'worksheets/sheet1.xml'],
        ['rId2', 'styles', 'styles.xml'],
      ]),
    },
    { name: 'xl/styles.xml', data: stylesXml() },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml(session, hasChart) },
  ];
  if (hasChart) {
    files.push(
      { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: rels([['rId1', 'drawing', '../drawings/drawing1.xml']]) },
      { name: 'xl/drawings/drawing1.xml', data: drawingXml() },
      { name: 'xl/drawings/_rels/drawing1.xml.rels', data: rels([['rId1', 'chart', '../charts/chart1.xml']]) },
      { name: 'xl/charts/chart1.xml', data: chartXml(session) },
    );
  }
  return zip(files, date);
}
