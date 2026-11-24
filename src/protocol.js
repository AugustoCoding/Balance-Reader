// Parsing of the text lines a balance sends over its serial link.
//
// The default ("auto") parser looks for a signed decimal number immediately
// followed by a unit anywhere in the line. That covers most lab balances:
//
//   BEL, on demand (PRINT):  "Peso:       0.00 g"
//   BEL, continuous:         "     0.0[0] g S"   (bracketed last digit, S = stable)
//   Mettler Toledo MT-SICS:  "S S      100.00 g" (S D = dynamic / unstable)
//   A&D:                     "ST,+00012.34  g"   (US = unstable, OL = overload)
//   Ohaus:                   "     12.345 g ?"   (? = still settling)
//
// Balances that need something different can use a custom regular
// expression and stability rules from their profile (see profiles.js).

export const UNITS = ['mg', 'kg', 'g', 'ct', 'oz', 'lb', 'dwt', 'ozt', 'gn', 'tl', 'mom', '%'];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const UNIT_ALT = [...UNITS].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
const NUMBER = String.raw`(?<sign>[+-])?\s*(?<number>\d+(?:[.,]\d+)?|[.,]\d+)`;
const READING_RE = new RegExp(String.raw`${NUMBER}\s*(?<unit>${UNIT_ALT})(?![A-Za-z])(?<suffix>.*)$`, 'i');

export class ParseError extends Error {}

/** Default parser settings; profiles override any of these. */
export const DEFAULT_PARSER = Object.freeze({
  mode: 'auto', // 'auto' | 'regex'
  regex: '', // regex mode: named groups (?<valor>…) and optionally (?<unidade>…)
  defaultUnit: 'g',
  stableRegex: '', // when set, a line is stable only if it matches
  unstableRegex: '', // when it matches, the line is unstable
  ignoreRegex: '', // lines matching this are never readings (overload, errors…)
});

const regexCache = new Map();
function compile(source, flags = 'i') {
  if (!source) return null;
  const key = flags + '\u0000' + source;
  if (!regexCache.has(key)) {
    let re = null;
    try {
      re = new RegExp(source, flags);
    } catch {
      re = undefined; // invalid: remembered so we do not retry on every line
    }
    regexCache.set(key, re);
  }
  const re = regexCache.get(key);
  if (re === undefined) throw new ParseError(`expressão regular inválida: ${source}`);
  return re;
}

/** Throws ParseError with a readable message when a user regex is invalid. */
export function validateRegex(source) {
  if (!source) return null;
  try {
    new RegExp(source, 'i');
    return null;
  } catch (e) {
    return e.message;
  }
}

function canonicalUnit(unit, fallback) {
  if (!unit) return fallback;
  const u = unit.trim();
  return UNITS.find((k) => k.toLowerCase() === u.toLowerCase()) ?? u;
}

function toNumber(text) {
  // "- 0.02", "+00012.34", "1,25" -> number
  const clean = text.replace(/\s+/g, '').replace(',', '.');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(clean)) return null;
  return Number(clean);
}

function decimalsOf(numberText) {
  const m = /[.,](\d+)/.exec(numberText);
  return m ? m[1].length : 0;
}

/**
 * Parse one line into a reading: { value, unit, stable, decimals, raw }.
 * Throws ParseError when the line carries no weight.
 */
export function parseReading(line, parser = DEFAULT_PARSER) {
  const p = { ...DEFAULT_PARSER, ...parser };
  if (line instanceof Uint8Array) line = new TextDecoder('latin1').decode(line);
  const raw = String(line).replace(/^[\r\n\0]+|[\r\n\0]+$/g, '');
  let text = raw.trim();
  if (!text) throw new ParseError('linha vazia');

  const ignore = compile(p.ignoreRegex);
  if (ignore && ignore.test(text)) throw new ParseError('linha ignorada pelo perfil');

  // BEL continuous mode brackets the last digit: "0.0[0]" -> "0.00". Only
  // that layout flags stability with "S"; on demand the balance refuses to
  // print an unstable weight, so a printed block is stable by definition.
  const bracketed = /\d\[\d+\]/.test(text);
  text = text.replace(/\[(\d+)\]/g, '$1');

  let value;
  let unit;
  let decimals;
  let stable;

  if (p.mode === 'regex' && p.regex) {
    const re = compile(p.regex);
    const m = re.exec(text);
    if (!m) throw new ParseError(`o formato do perfil não reconhece ${JSON.stringify(raw)}`);
    const g = m.groups ?? {};
    const numText = g.valor ?? g.value ?? g.peso ?? m[1];
    if (numText == null) throw new ParseError('a expressão precisa de um grupo (?<valor>…)');
    const sign = g.sinal ?? g.sign ?? '';
    value = toNumber(sign + numText);
    if (value === null) throw new ParseError(`número inválido em ${JSON.stringify(raw)}`);
    unit = canonicalUnit(g.unidade ?? g.unit, p.defaultUnit);
    decimals = decimalsOf(numText);
    stable = true;
  } else {
    const m = READING_RE.exec(text);
    if (!m) throw new ParseError(`nenhum peso em ${JSON.stringify(raw)}`);
    const { sign, number, suffix } = m.groups;
    value = Number(number.replace(',', '.'));
    if (sign === '-') value = -value;
    unit = canonicalUnit(m.groups.unit, p.defaultUnit);
    decimals = decimalsOf(number);
    if (bracketed) stable = /S/i.test(suffix);
    else stable = !suffix.includes('?'); // Ohaus: "?" = still settling
  }

  if (Object.is(value, -0)) value = 0;

  const unstable = compile(p.unstableRegex);
  const stableRe = compile(p.stableRegex);
  const trimmed = raw.trim();
  if (stableRe) stable = stableRe.test(trimmed);
  if (unstable && unstable.test(trimmed)) stable = false;

  return { value, unit, stable, decimals, raw };
}

/** Parse, returning null instead of throwing. */
export function tryParse(line, parser) {
  try {
    return parseReading(line, parser);
  } catch (e) {
    if (e instanceof ParseError) return null;
    throw e;
  }
}

export const LINE_ENDINGS = { crlf: '\r\n', cr: '\r', lf: '\n', none: '' };

/**
 * Turn a command as typed in the settings into the bytes to send.
 * Escapes: \r \n \t \e (ESC) \xHH \\ — e.g. Sartorius "\eP" prints.
 */
export function encodeCommand(command, lineEnding = 'crlf') {
  const body = String(command ?? '')
    .trim()
    .replace(/\\(x[0-9a-fA-F]{2}|[rnte\\])/g, (_, esc) => {
      if (esc[0] === 'x') return String.fromCharCode(parseInt(esc.slice(1), 16));
      return { r: '\r', n: '\n', t: '\t', e: '\x1b', '\\': '\\' }[esc];
    });
  const text = body + (LINE_ENDINGS[lineEnding] ?? lineEnding ?? '');
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

/** Make control characters visible in the serial console. */
export function visible(text) {
  return text.replace(/[\x00-\x1f\x7f]/g, (c) => {
    const names = { '\r': '␍', '\n': '␊', '\t': '␉', '\x1b': '␛' };
    return names[c] ?? `‹${c.charCodeAt(0).toString(16).padStart(2, '0')}›`;
  });
}

/** Share of characters that are not printable — high values mean a wrong baud rate. */
export function garbageRatio(text) {
  if (!text) return 0;
  let bad = 0;
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if ((c < 0x20 && c !== 9) || c === 0x7f || (c >= 0x80 && c < 0xa0) || c === 0xfffd) bad++;
  }
  return bad / text.length;
}

/** Splits a stream of decoded chunks into lines on CR, LF or CR LF. */
export class LineSplitter {
  constructor(onLine) {
    this.onLine = onLine;
    this.buffer = '';
    this.lastWasCR = false;
  }

  push(chunk) {
    for (const ch of chunk) {
      if (ch === '\n' && this.lastWasCR) {
        this.lastWasCR = false;
        continue; // second half of CR LF
      }
      this.lastWasCR = ch === '\r';
      if (ch === '\r' || ch === '\n') {
        const line = this.buffer;
        this.buffer = '';
        if (line.trim()) this.onLine(line);
      } else {
        this.buffer += ch;
        if (this.buffer.length > 4096) this.buffer = this.buffer.slice(-1024); // no terminator at all
      }
    }
  }

  get pending() {
    return this.buffer;
  }

  reset() {
    this.buffer = '';
    this.lastWasCR = false;
  }
}
