// Balance profiles: serial parameters, line format and remote commands.
//
// Only the BEL LG3202i preset was validated on real hardware. The others
// follow the manufacturers' published defaults and are a starting point:
// check the balance's menu/manual and adjust in Settings when needed.

import { DEFAULT_PARSER } from './protocol.js';

export const BAUD_RATES = [300, 600, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];
export const DATA_BITS = [7, 8];
export const PARITIES = [
  ['none', 'Nenhuma (N)'],
  ['even', 'Par (E)'],
  ['odd', 'Ímpar (O)'],
];
export const STOP_BITS = [1, 2];
export const FLOW_CONTROLS = [
  ['none', 'Nenhum'],
  ['hardware', 'Hardware (RTS/CTS)'],
];
export const LINE_ENDING_OPTIONS = [
  ['crlf', 'CR LF (\\r\\n)'],
  ['cr', 'CR (\\r)'],
  ['lf', 'LF (\\n)'],
  ['none', 'Nenhum'],
];
export const SIM_FORMATS = [
  ['bel', 'BEL contínuo — "  22.9[2] g S"'],
  ['mtsics', 'MT-SICS — "S S     22.92 g"'],
  ['and', 'A&D — "ST,+00022.92  g"'],
  ['ohaus', 'Ohaus — "   22.92 g ?"'],
  ['sbi', 'Sartorius SBI — "N     +    22.92 g"'],
  ['generic', 'Genérico — "22.92 g"'],
];

const base = {
  serial: { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none' },
  parser: { ...DEFAULT_PARSER },
  commands: { lineEnding: 'crlf', tare: '', zero: '', print: '' },
  poll: { command: '', intervalS: 0 },
  sim: 'generic',
  notes: '',
};

function preset(p) {
  return {
    ...base,
    ...p,
    serial: { ...base.serial, ...p.serial },
    parser: { ...base.parser, ...p.parser },
    commands: { ...base.commands, ...p.commands },
    poll: { ...base.poll, ...p.poll },
    builtin: true,
  };
}

export const PRESETS = [
  preset({
    id: 'bel-lg3202i',
    name: 'BEL LG3202i',
    brand: 'BEL Engineering',
    validated: true,
    serial: { baudRate: 1200 },
    commands: { tare: 'T' },
    sim: 'bel',
    notes:
      'Na balança: segure MENU, escolha Serial output → Continuous e confirme com PRINT. ' +
      'Em "On demand", cada toque em PRINT envia uma leitura. A velocidade padrão é 1200 bps.',
  }),
  preset({
    id: 'mettler-sics',
    name: 'Mettler Toledo (MT-SICS)',
    brand: 'Mettler Toledo',
    serial: { baudRate: 9600 },
    parser: {
      stableRegex: String.raw`^S\s+S`,
      unstableRegex: String.raw`^S\s+D`,
      ignoreRegex: String.raw`^(S\s+[I+-]\b|E[SLT]\b)`,
    },
    commands: { tare: 'T', zero: 'Z', print: 'SI' },
    poll: { command: 'SI', intervalS: 0.5 },
    sim: 'mtsics',
    notes:
      'Protocolo MT-SICS. O navegador não suporta handshake Xon/Xoff: deixe o handshake da balança em ' +
      '"None". O programa pede o peso com "SI" a cada 0,5 s; para envio contínuo use o comando SIR.',
  }),
  preset({
    id: 'and',
    name: 'A&D (FX, GX, GF, EK…)',
    brand: 'A&D',
    serial: { baudRate: 2400, dataBits: 7, parity: 'even' },
    parser: {
      stableRegex: String.raw`^(ST|QT)`,
      unstableRegex: String.raw`^US`,
      ignoreRegex: String.raw`^OL`,
    },
    commands: { tare: 'T', zero: 'Z', print: 'Q' },
    sim: 'and',
    notes:
      'Formato A&D padrão: "ST" estável, "US" instável, "OL" sobrecarga. Padrão de fábrica 2400 bps, 7 bits, ' +
      'paridade par. Configure o modo de saída (stream ou tecla PRINT) no menu da balança.',
  }),
  preset({
    id: 'ohaus',
    name: 'Ohaus (Adventurer, Pioneer, Explorer)',
    brand: 'Ohaus',
    serial: { baudRate: 9600 },
    commands: { tare: 'T', zero: 'Z', print: 'IP' },
    sim: 'ohaus',
    notes:
      'Um "?" no fim da linha indica peso ainda instável. "IP" pede o peso imediatamente; ' +
      'para envio contínuo ative Auto Print / Continuous no menu de comunicação.',
  }),
  preset({
    id: 'sartorius-sbi',
    name: 'Sartorius (SBI)',
    brand: 'Sartorius',
    serial: { baudRate: 1200, dataBits: 7, parity: 'odd' },
    commands: { tare: '\\eT', print: '\\eP' },
    sim: 'sbi',
    notes:
      'Protocolo SBI: comandos começam com ESC (escrito "\\e"). Em muitos modelos o peso instável sai sem ' +
      'unidade e por isso não é registrado. Confira velocidade e paridade no menu da balança.',
  }),
  preset({
    id: 'generic',
    name: 'Genérica',
    brand: 'Qualquer balança',
    serial: { baudRate: 9600 },
    notes:
      'Ponto de partida para qualquer balança que envie o peso como texto ("123.45 g"). Ajuste a ' +
      'velocidade e use "Detectar velocidade" ou o console serial para ver o que a balança envia.',
  }),
];

export const DEFAULT_PROFILE_ID = 'bel-lg3202i';

/** Deep copy of a profile with every field present (old/partial objects are completed). */
export function normalizeProfile(p) {
  const src = p ?? {};
  return {
    id: String(src.id ?? `custom-${Date.now()}`),
    name: String(src.name ?? 'Perfil sem nome'),
    brand: String(src.brand ?? ''),
    validated: Boolean(src.validated),
    builtin: Boolean(src.builtin),
    serial: { ...base.serial, ...src.serial },
    parser: { ...base.parser, ...src.parser },
    commands: { ...base.commands, ...src.commands },
    poll: { ...base.poll, ...src.poll },
    sim: SIM_FORMATS.some(([k]) => k === src.sim) ? src.sim : 'generic',
    notes: String(src.notes ?? ''),
  };
}

export function findPreset(id) {
  return PRESETS.find((p) => p.id === id);
}

/** "1200 8N1" style summary. */
export function serialSummary(serial) {
  const parity = { none: 'N', even: 'E', odd: 'O' }[serial.parity] ?? '?';
  return `${serial.baudRate} ${serial.dataBits}${parity}${serial.stopBits}`;
}

/** Compare the parts of two profiles that change behaviour (ignores id, name, notes). */
export function sameBehaviour(a, b) {
  const pick = (p) => JSON.stringify([p.serial, p.parser, p.commands, p.poll, p.sim]);
  return pick(normalizeProfile(a)) === pick(normalizeProfile(b));
}
