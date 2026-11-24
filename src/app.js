// Balance Reader — browser UI.

import { WeightChart } from './chart.js';
import {
  BAUD_RATES,
  DATA_BITS,
  FLOW_CONTROLS,
  LINE_ENDING_OPTIONS,
  PARITIES,
  PRESETS,
  SIM_FORMATS,
  STOP_BITS,
  findPreset,
  normalizeProfile,
  sameBehaviour,
  serialSummary,
} from './profiles.js';
import { encodeCommand, tryParse, validateRegex, visible } from './protocol.js';
import { BalanceReader } from './reader.js';
import { WebSerialTransport, portLabel, webSerialSupported } from './serial.js';
import { CSV_FORMATS, Session, clockTime } from './session.js';
import { clearSavedSession, loadSavedSession, loadSettings, saveSession, saveSettings } from './settings.js';
import { SimulatedBalance, formatLine } from './simulator.js';
import { buildXlsx } from './xlsx.js';

const $ = (id) => document.getElementById(id);
const icon = (name, cls = 'icon') => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---- state ------------------------------------------------------------------

const settings = loadSettings();
let session = Session.fromJSON(loadSavedSession());
session.setWindow(settings.uncertaintyWindow);
let pausedAt = session.length ? session.last.t : 0;
let currentPort = null; // SerialPort in use (null for the simulator)
let lastReading = null;
let lastReadingAt = 0;
let lostPort = null; // port that disappeared, to reconnect when it comes back

const reader = new BalanceReader({
  getProfile: () => settings.profile,
  getSampleInterval: () => settings.sampleInterval,
});
const chart = new WeightChart($('chart'), $('chartTip'));

const nf = new Map();
function fmt(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (!nf.has(digits)) nf.set(digits, new Intl.NumberFormat('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  const out = nf.get(digits).format(value);
  return out === '-0' || /^-0[,]0*$/.test(out) ? out.slice(1) : out;
}

function hms(secs) {
  const s = Math.max(0, Math.floor(secs));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/** "hh:mm:ss", "mm:ss" or seconds -> seconds; null when invalid. */
function parseDuration(text) {
  const t = String(text).trim().replace(',', '.');
  if (!t) return null;
  const parts = t.split(':').map(Number);
  if (parts.length > 3 || parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  const secs = parts.reduce((acc, p) => acc * 60 + p, 0);
  return secs > 0 ? secs : null;
}

const parseDecimal = (text) => {
  const t = String(text).trim().replace(/\s/g, '').replace(',', '.');
  if (t === '') return 0;
  return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : null;
};

// ---- toasts, banners, dialogs ------------------------------------------------

function toast(message, kind = 'ok', ms = 3200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === 'ok' ? 'check' : kind === 'info' ? 'info' : 'alert')}<span>${escapeHtml(message)}</span>`;
  $('toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, ms);
}

const banners = new Map();
function banner(id, { kind = 'warn', title, text, action, onAction, dismissible = true } = {}) {
  const old = banners.get(id);
  if (!title) {
    old?.remove();
    banners.delete(id);
    return;
  }
  const html = `${icon(kind === 'info' ? 'info' : 'alert')}<div><strong>${escapeHtml(title)}</strong>${text}</div>${
    action ? `<button class="btn btn-sm" data-act>${escapeHtml(action)}</button>` : ''
  }${dismissible ? `<button class="btn btn-icon btn-ghost btn-sm" data-close title="Fechar">${icon('x')}</button>` : ''}`;
  if (old && old.dataset.html === html) return;
  const el = old ?? document.createElement('div');
  el.className = `banner ${kind}`;
  el.dataset.html = html;
  el.innerHTML = html;
  el.querySelector('[data-act]')?.addEventListener('click', onAction);
  el.querySelector('[data-close]')?.addEventListener('click', () => {
    el.dataset.dismissed = '1';
    el.hidden = true;
  });
  if (!old) $('banners').append(el);
  banners.set(id, el);
}

function ask({ title, text = '', ok = 'OK', cancel = 'Cancelar', input = null, danger = false }) {
  const dlg = $('confirm');
  $('confirmTitle').textContent = title;
  $('confirmText').textContent = text;
  $('confirmYes').textContent = ok;
  $('confirmNo').textContent = cancel;
  $('confirmYes').classList.toggle('btn-danger', danger);
  const field = $('confirmInput');
  field.hidden = input === null;
  field.value = input ?? '';
  dlg.returnValue = '';
  dlg.showModal();
  if (input !== null) {
    field.focus();
    field.select();
  }
  return new Promise((resolve) => {
    dlg.addEventListener(
      'close',
      () => {
        const yes = dlg.returnValue === 'yes';
        resolve(input === null ? yes : yes ? field.value.trim() : null);
      },
      { once: true },
    );
  });
}
$('confirmInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('confirm').close('yes');
  }
});

// ---- theme --------------------------------------------------------------------

const THEME_ICON = { auto: 'auto', light: 'sun', dark: 'moon' };
const THEME_NAME = { auto: 'Tema do sistema', light: 'Tema claro', dark: 'Tema escuro' };
function applyTheme() {
  const t = settings.theme;
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  $('themeBtn').innerHTML = icon(THEME_ICON[t]);
  $('themeBtn').title = `${THEME_NAME[t]} (clique para trocar)`;
  chart.draw();
}
$('themeBtn').addEventListener('click', () => {
  settings.theme = { auto: 'light', light: 'dark', dark: 'auto' }[settings.theme];
  saveSettings(settings);
  applyTheme();
});

// ---- profile header & buttons ----------------------------------------------------

function sourceOf(profile) {
  return findPreset(profile.id) ?? settings.customProfiles.find((p) => p.id === profile.id) ?? null;
}

function isModified(profile, customs = settings.customProfiles) {
  const src = findPreset(profile.id) ?? customs.find((p) => p.id === profile.id);
  return src ? !sameBehaviour(src, profile) : false;
}

function renderProfile() {
  const p = settings.profile;
  $('profileName').textContent = p.name + (isModified(p) ? ' (ajustado)' : '');
  $('profileSerial').textContent = serialSummary(p.serial);
  const c = p.commands;
  $('zeroBtn').hidden = !c.zero;
  $('printBtn').hidden = !c.print;
  $('tareBtn').hidden = !c.tare;
  $('simFormat').textContent = SIM_FORMATS.find(([k]) => k === p.sim)?.[1].split(' — ')[0] ?? '';
  const gap = settings.sampleInterval;
  $('intervalLabel').textContent = gap > 0 ? `uma leitura a cada ≥ ${fmt(gap, gap % 1 ? 1 : 0)} s` : 'todas as leituras';
  $('stWindow').textContent = `últimas ${settings.uncertaintyWindow} leituras`;
  $('csvHint').textContent = settings.csvFormat === 'br' ? 'Separador ";" e vírgula decimal' : 'Separador "," e ponto decimal';
}

function renderState() {
  const connected = reader.connected;
  const running = reader.running;
  const pill = $('connPill');
  let state = 'off';
  let text = 'Desconectado';
  if (connected) {
    state = running ? 'rec' : 'on';
    text = running ? 'Gravando' : reader.isSimulator ? 'Simulador' : 'Conectado';
    if (reader.diagnose()) state = running ? 'rec' : 'warn';
  }
  pill.dataset.state = state;
  $('connText').textContent = text;
  pill.title = connected ? reader.transport.label : '';

  const btn = $('connectBtn');
  btn.classList.toggle('btn-primary', !connected);
  btn.querySelector('use').setAttribute('href', connected ? '#i-unplug' : '#i-plug');
  $('connectLabel').textContent = connected ? (reader.isSimulator ? 'Simulador' : 'Porta') : 'Conectar';

  const rec = $('recordBtn');
  rec.disabled = !connected;
  rec.dataset.rec = running ? '1' : '0';
  rec.innerHTML = running
    ? `${icon('pause')}<span>Pausar gravação</span>`
    : `${icon('play')}<span>${session.length ? 'Continuar gravação' : 'Iniciar gravação'}</span>`;
  document.querySelector('.hero').dataset.rec = running ? '1' : '0';

  for (const id of ['tareBtn', 'zeroBtn', 'printBtn', 'consoleSend']) $(id).disabled = !connected;
  $('containerFromReading').disabled = !lastReading;
  $('exportBtn').disabled = !session.length;
  $('clearBtn').disabled = !session.length;
  $('simCard').hidden = !reader.isSimulator;
  document.title = running ? `● Gravando — Balance Reader` : 'Balance Reader';
}

// ---- live readout -------------------------------------------------------------------

function renderReadout() {
  const readout = $('readout');
  const badge = $('stableBadge');
  const stale = lastReading && performance.now() - lastReadingAt > 3000;
  if (!lastReading) {
    $('weightValue').textContent = '—';
    readout.dataset.state = 'none';
    badge.dataset.state = 'none';
    badge.textContent = reader.connected ? 'Aguardando' : 'Sem leitura';
  } else {
    const net = lastReading.value - session.container;
    $('weightValue').textContent = fmt(net, lastReading.decimals);
    $('weightUnit').textContent = lastReading.unit;
    readout.dataset.state = stale ? 'none' : lastReading.stable ? 'stable' : 'unstable';
    badge.dataset.state = stale ? 'stale' : lastReading.stable ? 'stable' : 'unstable';
    badge.textContent = stale ? 'Sem sinal' : lastReading.stable ? 'Estável' : 'Instável';
  }
  $('netHint').hidden = !session.container;

  let sub;
  if (!reader.connected) sub = lastReading ? 'Última leitura antes de desconectar' : 'Conecte a balança ou use o simulador';
  else if (lastReading && session.container) {
    sub = `bruto ${fmt(lastReading.value, lastReading.decimals)} − recipiente ${fmt(session.container, lastReading.decimals)} ${lastReading.unit}`;
  } else if (reader.running) sub = 'Gravando as leituras';
  else sub = lastReading ? 'Ao vivo — clique em Iniciar para gravar' : 'Esperando a primeira leitura…';
  $('readoutSub').textContent = sub;
}

// ---- stats + chart -----------------------------------------------------------------------

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderStats();
    renderChart();
  });
}

function renderStats() {
  const st = session.stats();
  const u = session.unit;
  const d = session.decimals;
  $('stCount').textContent = st ? st.count.toLocaleString('pt-BR') : '0';
  $('stStable').textContent = st ? `${Math.round(st.stableShare * 100)}% estáveis` : '—';
  $('stMean').textContent = st ? `${fmt(st.mean, d + 1)} ${u}` : '—';
  $('stMeanUnc').textContent = st ? `incerteza ± ${fmt(st.meanUncertainty, d + 1)} ${u}` : 'incerteza ± —';
  $('stUnc').textContent = st?.lastUncertainty != null ? `± ${fmt(st.lastUncertainty, d + 1)}` : '—';
  $('stMin').textContent = st ? fmt(st.min, d) : '—';
  $('stMax').textContent = st ? fmt(st.max, d) : '—';
  $('stUnitMin').textContent = u;
  $('stRange').textContent = st ? `amplitude ${fmt(st.range, d)} ${u}` : 'amplitude —';
  $('containerUnit').textContent = u;
}

function renderChart() {
  const range = settings.chartRange;
  const s = session.samples;
  let from = 0;
  if (range > 0 && s.length) {
    const cut = s.at(-1).t - range;
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid].t < cut) lo = mid + 1;
      else hi = mid;
    }
    from = lo;
  }
  const view = s.slice(from);
  chart.set({
    t: view.map((x) => x.t),
    v: view.map((x) => x.value - session.container),
    stable: view.map((x) => x.stable),
    unit: session.unit,
    decimals: session.decimals,
    mean: session.mean(),
  });
}

function renderRange() {
  for (const b of $('rangeSeg').querySelectorAll('button')) b.setAttribute('aria-checked', String(Number(b.dataset.range) === settings.chartRange));
}
$('rangeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  settings.chartRange = Number(b.dataset.range);
  saveSettings(settings);
  renderRange();
  renderChart();
});

// ---- autosave -----------------------------------------------------------------------------

let saveTimer = null;
function autosave(now = false) {
  clearTimeout(saveTimer);
  const run = () => {
    if (session.length) {
      if (!saveSession(session)) banner('storage', { title: 'Não foi possível salvar a cópia de segurança', text: '<p>O armazenamento do navegador está cheio ou bloqueado. Exporte as leituras para não perdê-las.</p>' });
    } else clearSavedSession();
  };
  if (now) run();
  else saveTimer = setTimeout(run, 1000);
}

// ---- console --------------------------------------------------------------------------------

const MAX_CONSOLE = 600;
let consoleLines = 0;
function logLine(kind, text, tag = '') {
  const box = $('console');
  box.querySelector('.console-empty')?.remove();
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  const el = document.createElement('div');
  el.className = `ln ${kind}`;
  const dir = { rx: '←', tx: '→', ok: '←', no: '←', err: '!', sys: '·' }[kind] ?? '';
  el.innerHTML = `<span class="ts">${clockTime(Date.now())}</span><span class="dir">${dir}</span><span class="txt"></span>${tag ? `<span class="tag">${escapeHtml(tag)}</span>` : '<span></span>'}`;
  el.querySelector('.txt').textContent = text;
  box.append(el);
  if (++consoleLines > MAX_CONSOLE) {
    box.firstElementChild?.remove();
    consoleLines--;
  }
  if (atBottom) box.scrollTop = box.scrollHeight;
  $('consoleCount').textContent = `${consoleLines} linha${consoleLines === 1 ? '' : 's'}`;
}
function resetConsole() {
  $('console').innerHTML = '<div class="console-empty">Nada recebido ainda. As linhas enviadas pela balança aparecem aqui.</div>';
  consoleLines = 0;
  $('consoleCount').textContent = 'o que a balança envia, linha a linha';
}
$('consoleClear').addEventListener('click', resetConsole);
$('consoleDetails').open = settings.consoleOpen;
$('consoleDetails').addEventListener('toggle', () => {
  settings.consoleOpen = $('consoleDetails').open;
  saveSettings(settings);
});
$('consoleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cmd = $('consoleInput').value;
  if (!cmd.trim()) return;
  try {
    await reader.send(cmd);
    $('consoleInput').value = '';
  } catch (err) {
    toast(err.message, 'danger');
  }
});

// ---- reader events ----------------------------------------------------------------------------

reader.on('state', renderState);
reader.on('rx', ({ line, reading, skipped }) => {
  if (skipped) logLine('no', visible(line), 'descartada');
  else if (reading) logLine('ok', visible(line), `${fmt(reading.value, reading.decimals)} ${reading.unit}${reading.stable ? '' : ' ~'}`);
  else logLine('no', visible(line), 'não é peso');
});
reader.on('tx', (cmd) => logLine('tx', cmd, 'enviado'));
reader.on('warn', (name) => logLine('err', `Erro de recepção (${name}) — velocidade ou paridade diferente da balança?`));
reader.on('error', (err) => logLine('err', err?.message ?? String(err)));
reader.on('reading', ({ reading, sample }) => {
  const first = !lastReading;
  lastReading = reading;
  lastReadingAt = performance.now();
  if (first) renderState();
  if (sample) {
    session.profileName = settings.profile.name;
    session.add(sample);
    autosave();
    scheduleRender();
    if (session.length === 1) renderState();
  }
  renderReadout();
});
reader.on('disconnected', (err) => {
  logLine('err', `Conexão perdida: ${err?.message ?? ''}`);
  lostPort = currentPort;
  pausedAt = session.length ? session.last.t : 0;
  banner('lost', {
    kind: 'danger',
    title: 'A conexão com a balança foi perdida',
    text: '<p>As leituras já feitas foram mantidas. Confira o cabo — o programa reconecta sozinho quando a porta voltar.</p>',
  });
  renderReadout();
});

// ---- connection --------------------------------------------------------------------------------

async function connectSerial(port, { quiet = false } = {}) {
  try {
    const t = new WebSerialTransport(port, settings.profile.serial);
    await reader.connect(t);
    currentPort = port;
    lostPort = null;
    banner('lost', {});
    logLine('sys', `Conectado a ${t.label} — ${serialSummary(settings.profile.serial)}`);
    if (!quiet) toast(`Conectado a ${t.label}`);
  } catch (err) {
    currentPort = null;
    if (quiet) return;
    const busy = /already open|failed to open/i.test(err?.message ?? '') || err?.name === 'InvalidStateError' || err?.name === 'NetworkError';
    toast(busy ? 'Não foi possível abrir a porta. Feche outros programas ou abas que estejam usando a balança.' : `Falha ao conectar: ${err.message}`, 'danger', 6000);
  }
  renderState();
  renderReadout();
}

async function choosePort() {
  try {
    const port = await navigator.serial.requestPort();
    await connectSerial(port);
  } catch (err) {
    if (err?.name !== 'NotFoundError') toast(`Falha ao escolher a porta: ${err.message}`, 'danger');
  }
}

async function connectSimulator() {
  const sim = new SimulatedBalance(() => settings.profile);
  await reader.connect(sim);
  currentPort = null;
  logLine('sys', `Simulador conectado — formato ${settings.profile.sim}`);
  renderState();
  renderReadout();
}

async function disconnect() {
  if (reader.running) pauseRecording();
  await reader.disconnect();
  currentPort = null;
  logLine('sys', 'Desconectado');
  renderState();
  renderReadout();
}

async function reconnectWithNewSettings() {
  if (!reader.connected) return;
  if (reader.isSimulator) {
    reader.startPolling();
    return;
  }
  const port = currentPort;
  const wasRunning = reader.running;
  if (wasRunning) pauseRecording();
  await reader.disconnect();
  await connectSerial(port, { quiet: true });
  if (reader.connected) {
    toast(`Reconectado com ${serialSummary(settings.profile.serial)}`, 'info');
    if (wasRunning) startRecording();
  }
}

const menu = $('connectMenu');
function closeMenus() {
  for (const m of document.querySelectorAll('.menu')) m.hidden = true;
  $('connectBtn').setAttribute('aria-expanded', 'false');
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu-wrap')) closeMenus();
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenus());

async function buildConnectMenu() {
  const items = [];
  const supported = webSerialSupported() && window.isSecureContext;
  if (reader.connected) {
    items.push(`<div class="menu-label">${escapeHtml(reader.transport.label)}</div>`);
    if (!reader.isSimulator) items.push(`<button data-m="choose">${icon('usb')}<span><strong>Trocar de porta…</strong><small>Escolher outra porta USB</small></span></button>`);
    items.push(`<button data-m="disconnect">${icon('unplug')}<span><strong>Desconectar</strong><small>As leituras gravadas continuam aqui</small></span></button>`);
  } else if (supported) {
    const ports = await navigator.serial.getPorts();
    if (ports.length) {
      items.push('<div class="menu-label">Portas já autorizadas</div>');
      ports.forEach((p, i) => items.push(`<button data-m="port" data-i="${i}">${icon('plug')}<span><strong>${escapeHtml(portLabel(p))}</strong><small>Conectar com ${serialSummary(settings.profile.serial)}</small></span></button>`));
      items.push('<hr>');
    }
    items.push(`<button data-m="choose">${icon('usb')}<span><strong>Escolher porta USB…</strong><small>O navegador pede permissão uma vez</small></span></button>`);
    menu._ports = ports;
  } else {
    items.push(`<div class="menu-label">Sem acesso à porta USB</div><button disabled>${icon('alert')}<span><strong>Use Chrome ou Edge no computador</strong><small>Este navegador não tem Web Serial</small></span></button>`);
  }
  if (!reader.connected) {
    items.push('<hr>');
    items.push(`<button data-m="sim">${icon('chip')}<span><strong>Usar o simulador</strong><small>Testar sem balança, com dados gerados</small></span></button>`);
  }
  menu.innerHTML = items.join('');
}

$('connectBtn').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!menu.hidden) return closeMenus();
  closeMenus();
  await buildConnectMenu();
  menu.hidden = false;
  $('connectBtn').setAttribute('aria-expanded', 'true');
});
menu.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-m]');
  if (!b) return;
  closeMenus();
  const m = b.dataset.m;
  if (m === 'disconnect') return disconnect();
  if (m === 'sim') return connectSimulator();
  if (m === 'port') return connectSerial(menu._ports[Number(b.dataset.i)]);
  if (m === 'choose') {
    if (reader.connected) await disconnect();
    return choosePort();
  }
});

if (webSerialSupported()) {
  navigator.serial.addEventListener('connect', (e) => {
    if (!reader.connected && lostPort && e.target === lostPort) {
      logLine('sys', 'A porta voltou — reconectando…');
      connectSerial(e.target, { quiet: true }).then(() => reader.connected && toast('Balança reconectada'));
    }
  });
}

// ---- recording ---------------------------------------------------------------------------------

function startRecording() {
  if (!reader.connected) return;
  try {
    reader.start(session.length ? pausedAt : 0);
  } catch (err) {
    toast(err.message, 'danger');
  }
  renderReadout();
}

function pauseRecording() {
  pausedAt = reader.elapsed;
  reader.stop();
  autosave(true);
  renderReadout();
}

$('recordBtn').addEventListener('click', () => (reader.running ? pauseRecording() : startRecording()));

async function sendCommand(kind) {
  const cmd = settings.profile.commands[kind];
  if (!cmd) return;
  try {
    await reader.send(cmd);
  } catch (err) {
    toast(`Falha ao enviar o comando: ${err.message}`, 'danger');
  }
}
$('tareBtn').addEventListener('click', () => sendCommand('tare'));
$('zeroBtn').addEventListener('click', () => sendCommand('zero'));
$('printBtn').addEventListener('click', () => sendCommand('print'));

$('clearBtn').addEventListener('click', async () => {
  if (session.dirty) {
    const ok = await ask({
      title: 'Começar uma nova sessão?',
      text: `As ${session.length.toLocaleString('pt-BR')} leituras atuais ainda não foram exportadas e serão apagadas.`,
      ok: 'Apagar e começar',
      danger: true,
    });
    if (!ok) return;
  }
  const container = session.container;
  session.clear();
  session.container = container;
  pausedAt = 0;
  if (reader.running) {
    reader.stop();
    reader.start(0);
  }
  autosave(true);
  renderStats();
  renderChart();
  renderState();
  toast('Nova sessão iniciada', 'info');
});

// auto stop
$('autoStopOn').checked = settings.autoStop.enabled;
$('autoStopValue').value = settings.autoStop.value;
function autoStopLimit() {
  return $('autoStopOn').checked ? parseDuration($('autoStopValue').value) : null;
}
function onAutoStopChange() {
  const limit = parseDuration($('autoStopValue').value);
  $('autoStopValue').setAttribute('aria-invalid', String($('autoStopOn').checked && limit === null));
  if (limit !== null) $('autoStopValue').value = hms(limit);
  settings.autoStop = { enabled: $('autoStopOn').checked, value: $('autoStopValue').value };
  saveSettings(settings);
  tick();
}
$('autoStopOn').addEventListener('change', onAutoStopChange);
$('autoStopValue').addEventListener('change', onAutoStopChange);

// ---- container -----------------------------------------------------------------------------------

$('containerInput').value = session.container ? fmt(session.container, 3) : '';
function setContainer(value) {
  session.container = value;
  $('containerInput').value = value ? fmt(value, Math.max(3, lastReading?.decimals ?? 0)) : '';
  $('containerInput').removeAttribute('aria-invalid');
  session.dirty = session.length > 0 || session.dirty;
  autosave();
  renderReadout();
  renderStats();
  renderChart();
}
function applyContainer() {
  const v = parseDecimal($('containerInput').value);
  if (v === null) {
    $('containerInput').setAttribute('aria-invalid', 'true');
    toast('Peso do recipiente inválido. Use um número, por exemplo 12,345', 'warn');
    return;
  }
  if (v !== session.container) {
    setContainer(v);
    toast(v ? `Recipiente de ${fmt(v, 3)} ${session.unit} descontado` : 'Recipiente removido', 'info');
  }
}
$('containerApply').addEventListener('click', applyContainer);
$('containerInput').addEventListener('keydown', (e) => e.key === 'Enter' && applyContainer());
$('containerFromReading').addEventListener('click', () => {
  if (!lastReading) return;
  setContainer(lastReading.value);
  toast(`Recipiente de ${fmt(lastReading.value, lastReading.decimals)} ${lastReading.unit} descontado`, 'info');
});

// ---- simulator -------------------------------------------------------------------------------------

$('simCard').addEventListener('click', (e) => {
  const b = e.target.closest('[data-place]');
  const sim = reader.isSimulator ? reader.transport : null;
  if (!b || !sim) return;
  if (b.dataset.place === 'clear') sim.clearPan();
  else sim.place(Number(b.dataset.place));
});

// ---- export ------------------------------------------------------------------------------------------

async function download(data, filename, type) {
  const blob = new Blob([data], { type });
  if ('showSaveFilePicker' in window) {
    try {
      const ext = filename.split('.').pop();
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: ext === 'xlsx' ? 'Planilha do Excel' : 'Arquivo CSV', accept: { [type]: [`.${ext}`] } }],
      });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return handle.name;
    } catch (err) {
      if (err?.name === 'AbortError') return null;
      // fall back to a regular download (e.g. inside an iframe)
    }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return filename;
}

async function exportAs(kind) {
  closeMenus();
  if (!session.length) return toast('Não há leituras para exportar.', 'warn');
  try {
    const name =
      kind === 'xlsx'
        ? await download(buildXlsx(session), session.suggestedFilename('xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        : await download(session.toCSV(settings.csvFormat), session.suggestedFilename('csv'), 'text/csv;charset=utf-8');
    if (!name) return;
    session.dirty = false;
    autosave(true);
    toast(`${session.length.toLocaleString('pt-BR')} leituras exportadas em ${name}`);
  } catch (err) {
    toast(`Falha ao exportar: ${err.message}`, 'danger', 6000);
  }
}
$('exportBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const m = $('exportMenu');
  const open = m.hidden;
  closeMenus();
  m.hidden = !open;
});
$('exportMenu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-export]');
  if (b) exportAs(b.dataset.export);
});

// ---- clock tick: elapsed time, auto stop, diagnostics ------------------------------------------------

function tick() {
  const running = reader.running;
  const secs = running ? reader.elapsed : pausedAt;
  $('elapsed').textContent = hms(secs);

  const limit = autoStopLimit();
  const bar = $('autoStopProgress');
  bar.hidden = limit === null;
  if (limit !== null) {
    bar.firstElementChild.style.width = `${Math.min(100, (secs / limit) * 100)}%`;
    $('autoStopHint').textContent = running ? `faltam ${hms(limit - secs)}` : `a gravação para sozinha aos ${hms(limit)}`;
    if (running && secs >= limit) {
      pauseRecording();
      $('autoStopHint').textContent = `parado automaticamente aos ${hms(limit)}`;
      toast(`Gravação parada automaticamente aos ${hms(limit)}`, 'info', 6000);
      try {
        if (Notification?.permission === 'granted' && document.hidden) new Notification('Balance Reader', { body: 'Gravação concluída.' });
      } catch {
        /* notifications are optional */
      }
    }
  } else {
    $('autoStopHint').textContent = $('autoStopOn').checked ? 'Valor inválido — use hh:mm:ss' : '';
  }

  diagnoseBanner();
  if (lastReading) renderReadout();
}

let lastDiag = null;
function diagnoseBanner() {
  const d = reader.diagnose();
  if (d === lastDiag) return;
  lastDiag = d;
  renderState();
  const serial = serialSummary(settings.profile.serial);
  const goto = (tab) => () => openSettings(tab);
  if (d === 'silent') {
    banner('diag', {
      title: 'Nada chega da balança',
      text: `<p>Coloque a balança no modo de envio contínuo, aperte PRINT nela, ou configure a consulta automática. Confira também se o cabo está na porta certa.</p>`,
      action: 'Ver comandos',
      onAction: goto('commands'),
    });
  } else if (d === 'garbage') {
    banner('diag', {
      title: 'Chegam caracteres ilegíveis',
      text: `<p>A velocidade ou a paridade não confere com a da balança (agora ${serial}). Detecte automaticamente ou copie os valores do menu de comunicação da balança.</p>`,
      action: 'Detectar',
      onAction: goto('serial'),
    });
  } else if (d === 'unparsed') {
    banner('diag', {
      title: 'Chegam dados, mas nenhum peso foi reconhecido',
      text: '<p>Abra <em>Comunicação serial</em> para ver as linhas recebidas e ajuste o formato de leitura do perfil.</p>',
      action: 'Ajustar formato',
      onAction: goto('format'),
    });
  } else banner('diag', {});
}

// ---- keyboard ----------------------------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    exportAs('xlsx');
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === 'Space' && reader.connected && !e.target.closest('button, summary')) {
    e.preventDefault();
    $('recordBtn').click();
  } else if (e.key.toLowerCase() === 't' && reader.connected) sendCommand('tare');
  else if (e.key.toLowerCase() === 'p' && reader.connected) sendCommand('print');
});

window.addEventListener('beforeunload', (e) => {
  autosave(true);
  if (session.dirty) e.preventDefault();
});

// ---- settings dialog -----------------------------------------------------------------------------------

let draft = null;
let testEdited = false;
const dlg = $('settings');

function fillSelect(id, options) {
  $(id).innerHTML = options.map((o) => (Array.isArray(o) ? `<option value="${o[0]}">${escapeHtml(o[1])}</option>` : `<option value="${o}">${o}</option>`)).join('');
}
fillSelect('fBaud', BAUD_RATES);
fillSelect('fDataBits', DATA_BITS);
fillSelect('fParity', PARITIES);
fillSelect('fStopBits', STOP_BITS);
fillSelect('fFlow', FLOW_CONTROLS);
fillSelect('fEnding', LINE_ENDING_OPTIONS);
fillSelect('fSim', SIM_FORMATS);
$('fCsv').innerHTML = Object.entries(CSV_FORMATS)
  .map(([k, f]) => `<label class="radio-card"><input type="radio" name="fCsv" value="${k}"><span><strong>${k === 'br' ? 'Brasil' : 'Internacional'}</strong><small>${escapeHtml(f.label.split(' — ')[1])}</small></span></label>`)
  .join('');

function selectTab(name) {
  for (const t of dlg.querySelectorAll('[role=tab]')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const p of dlg.querySelectorAll('.tab-panel')) p.hidden = p.dataset.panel !== name;
}
dlg.querySelector('.tabs').addEventListener('click', (e) => {
  const t = e.target.closest('[role=tab]');
  if (t) selectTab(t.dataset.tab);
});

function openSettings(tab = 'balance') {
  draft = structuredClone({
    profile: settings.profile,
    customProfiles: settings.customProfiles,
    sampleInterval: settings.sampleInterval,
    uncertaintyWindow: settings.uncertaintyWindow,
    csvFormat: settings.csvFormat,
    theme: settings.theme,
  });
  testEdited = false;
  fillForm();
  selectTab(tab);
  $('detectStatus').dataset.default ??= $('detectStatus').textContent;
  $('detectStatus').textContent = $('detectStatus').dataset.default;
  dlg.showModal();
}
$('settingsBtn').addEventListener('click', () => openSettings());
$('profileChip').addEventListener('click', () => openSettings('balance'));

function renderProfileGrid() {
  const all = [...PRESETS, ...draft.customProfiles];
  const p = draft.profile;
  $('profileGrid').innerHTML = all
    .map((x) => {
      const selected = x.id === p.id;
      const mod = selected && isModified(p, draft.customProfiles);
      const tags = [
        x.builtin ? (x.validated ? '<span class="tag ok">Testado na balança</span>' : '<span class="tag">Padrão do fabricante</span>') : '<span class="tag own">Seu perfil</span>',
        mod ? '<span class="tag mod">Ajustado</span>' : '',
      ].join('');
      return `<button type="button" class="profile-card" role="radio" aria-checked="${selected}" data-id="${escapeHtml(x.id)}">
        <span class="check">${icon('check')}</span>
        <strong>${escapeHtml(x.name)}</strong>
        <span class="meta mono">${serialSummary((selected ? p : x).serial)}${x.brand ? ` · <span style="font-family:var(--font)">${escapeHtml(x.brand)}</span>` : ''}</span>
        <span class="tag-row">${tags}</span>
      </button>`;
    })
    .join('');
  const notes = p.notes || 'Perfil personalizado.';
  const warn = p.builtin && !p.validated;
  $('profileNotes').className = `callout${warn ? ' warn' : ''}`;
  $('profileNotes').innerHTML = `${icon(warn ? 'alert' : 'info')}<div>${escapeHtml(notes)}${
    warn ? '<br><strong>Este perfil segue o padrão do fabricante e não foi testado numa balança real.</strong> Se algo não funcionar, confira o manual e ajuste nas outras abas.' : ''
  }</div>`;
  $('profileDelete').hidden = p.builtin || !draft.customProfiles.some((c) => c.id === p.id);
  const changed =
    !sameBehaviour(settings.profile, draft.profile) ||
    settings.profile.id !== draft.profile.id ||
    settings.sampleInterval !== draft.sampleInterval ||
    settings.uncertaintyWindow !== draft.uncertaintyWindow;
  $('settingsDirty').textContent = changed ? 'Alterações não salvas' : '';
}

$('profileGrid').addEventListener('click', (e) => {
  const card = e.target.closest('.profile-card');
  if (!card) return;
  const src = findPreset(card.dataset.id) ?? draft.customProfiles.find((p) => p.id === card.dataset.id);
  if (!src) return;
  draft.profile = normalizeProfile(structuredClone(src));
  testEdited = false;
  fillForm();
});

function setRadio(name, value) {
  for (const r of dlg.querySelectorAll(`input[name=${name}]`)) r.checked = r.value === value;
}

function fillForm() {
  const p = draft.profile;
  $('fBaud').value = String(p.serial.baudRate);
  if ($('fBaud').value !== String(p.serial.baudRate)) {
    $('fBaud').insertAdjacentHTML('beforeend', `<option value="${p.serial.baudRate}">${p.serial.baudRate}</option>`);
    $('fBaud').value = String(p.serial.baudRate);
  }
  $('fDataBits').value = String(p.serial.dataBits);
  $('fParity').value = p.serial.parity;
  $('fStopBits').value = String(p.serial.stopBits);
  $('fFlow').value = p.serial.flowControl;
  setRadio('fMode', p.parser.mode);
  $('fRegex').value = p.parser.regex;
  $('fRegexField').hidden = p.parser.mode !== 'regex';
  $('fUnit').value = p.parser.defaultUnit;
  $('fStable').value = p.parser.stableRegex;
  $('fUnstable').value = p.parser.unstableRegex;
  $('fIgnore').value = p.parser.ignoreRegex;
  $('fEnding').value = p.commands.lineEnding;
  $('fTare').value = p.commands.tare;
  $('fZero').value = p.commands.zero;
  $('fPrint').value = p.commands.print;
  $('fPoll').value = p.poll.command;
  $('fPollInterval').value = p.poll.intervalS ? String(p.poll.intervalS).replace('.', ',') : '';
  $('fSim').value = p.sim;
  $('fInterval').value = String(draft.sampleInterval).replace('.', ',');
  $('fWindow').value = String(draft.uncertaintyWindow);
  setRadio('fCsv', draft.csvFormat);
  for (const b of $('fTheme').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.themeOpt === draft.theme));
  if (!testEdited) $('fTest').value = sampleLines(p.sim).join('\n');
  renderTester();
  renderProfileGrid();
}

function sampleLines(format) {
  const extra = {
    bel: ['--------------------', '16-09-26 13:16:27', 'Peso:      22.91 g'],
    mtsics: ['S I', 'ES'],
    and: ['OL,+9999999 g'],
    ohaus: ['Total:  45.678 g'],
    sbi: ['N     +    22.92   '],
    generic: ['Peso bruto: 22,93 g'],
  }[format] ?? [];
  return [formatLine(format, 22.92, true), formatLine(format, 22.97, false), ...extra].map((l) => l.trimEnd());
}

function readForm() {
  const p = draft.profile;
  const numOr = (v, f) => {
    const n = parseDecimal(v);
    return n === null ? f : n;
  };
  p.serial = {
    baudRate: Number($('fBaud').value),
    dataBits: Number($('fDataBits').value),
    parity: $('fParity').value,
    stopBits: Number($('fStopBits').value),
    flowControl: $('fFlow').value,
  };
  p.parser = {
    mode: dlg.querySelector('input[name=fMode]:checked')?.value ?? 'auto',
    regex: $('fRegex').value.trim(),
    defaultUnit: $('fUnit').value.trim() || 'g',
    stableRegex: $('fStable').value.trim(),
    unstableRegex: $('fUnstable').value.trim(),
    ignoreRegex: $('fIgnore').value.trim(),
  };
  p.commands = { lineEnding: $('fEnding').value, tare: $('fTare').value.trim(), zero: $('fZero').value.trim(), print: $('fPrint').value.trim() };
  p.poll = { command: $('fPoll').value.trim(), intervalS: Math.max(0, numOr($('fPollInterval').value, 0)) };
  const prevSim = p.sim;
  p.sim = $('fSim').value;
  if (prevSim !== p.sim && !testEdited) $('fTest').value = sampleLines(p.sim).join('\n');
  draft.sampleInterval = Math.max(0, numOr($('fInterval').value, draft.sampleInterval));
  draft.uncertaintyWindow = Math.max(2, Math.round(numOr($('fWindow').value, draft.uncertaintyWindow)));
  draft.csvFormat = dlg.querySelector('input[name=fCsv]:checked')?.value ?? 'br';
  $('fRegexField').hidden = p.parser.mode !== 'regex';
  renderTester();
  renderProfileGrid();
}

function regexErrors() {
  const p = draft.profile.parser;
  const checks = [
    ['fRegex', p.mode === 'regex' ? p.regex : '', 'Expressão regular'],
    ['fStable', p.stableRegex, 'Estável'],
    ['fUnstable', p.unstableRegex, 'Instável'],
    ['fIgnore', p.ignoreRegex, 'Ignorar'],
  ];
  const errors = [];
  for (const [id, src, label] of checks) {
    const err = validateRegex(src);
    $(id).setAttribute('aria-invalid', String(Boolean(err)));
    if (err) errors.push(`${label}: ${err}`);
  }
  if (p.mode === 'regex' && !p.regex) errors.push('Escreva a expressão regular ou volte para o modo automático.');
  if (p.mode === 'regex' && p.regex && !validateRegex(p.regex) && !/\(\?<(valor|value|peso)>/.test(p.regex) && !/\((?!\?)/.test(p.regex)) {
    errors.push('A expressão precisa de um grupo (?<valor>…) com o número.');
  }
  return errors;
}

function renderTester() {
  const errors = regexErrors();
  $('fRegexError').hidden = !errors.length;
  $('fRegexError').textContent = errors.join(' · ');
  const lines = $('fTest').value.split(/\r?\n/).filter((l) => l.trim());
  $('fTestOut').innerHTML = errors.length
    ? ''
    : lines
        .slice(0, 30)
        .map((line) => {
          const r = tryParse(line, draft.profile.parser);
          const res = r
            ? `<span class="res ${r.stable ? 'ok' : 'unstable'}">${fmt(r.value, r.decimals)} ${escapeHtml(r.unit)} · ${r.stable ? 'estável' : 'instável'}</span>`
            : '<span class="res no">não é peso</span>';
          return `<div class="row"><span class="src">${escapeHtml(visible(line))}</span>${res}</div>`;
        })
        .join('');
}

dlg.addEventListener('input', (e) => {
  if (e.target.id === 'fTest') {
    testEdited = true;
    renderTester();
  } else if (e.target.closest('.tab-panel') && e.target.id !== 'profileImport') readForm();
});
dlg.addEventListener('change', (e) => {
  if (e.target.closest('.tab-panel') && e.target.id !== 'profileImport' && e.target.id !== 'fTest') readForm();
});
$('fTheme').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  draft.theme = b.dataset.themeOpt;
  for (const x of $('fTheme').querySelectorAll('button')) x.setAttribute('aria-checked', String(x === b));
});

// profile management
$('profileSaveAs').addEventListener('click', async () => {
  const base = draft.profile;
  const name = await ask({ title: 'Salvar como perfil próprio', text: 'Dê um nome para encontrar este perfil depois.', ok: 'Salvar', input: base.builtin ? `${base.name} (meu)` : base.name });
  if (!name) return;
  const profile = normalizeProfile({ ...structuredClone(base), id: `custom-${Date.now().toString(36)}`, name, builtin: false, validated: false });
  draft.customProfiles.push(profile);
  draft.profile = structuredClone(profile);
  fillForm();
  toast(`Perfil "${name}" criado — clique em Salvar para usar`, 'info');
});
$('profileDelete').addEventListener('click', async () => {
  const p = draft.profile;
  const ok = await ask({ title: `Excluir o perfil "${p.name}"?`, text: 'Esta ação não pode ser desfeita.', ok: 'Excluir', danger: true });
  if (!ok) return;
  draft.customProfiles = draft.customProfiles.filter((c) => c.id !== p.id);
  draft.profile = normalizeProfile(findPreset('generic'));
  fillForm();
});
$('profileExport').addEventListener('click', () => {
  const p = draft.profile;
  const data = JSON.stringify({ type: 'balance-reader-profile', version: 1, profile: { ...p, builtin: false } }, null, 2);
  const slug = p.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'perfil';
  download(data, `perfil-${slug}.json`, 'application/json');
});
$('profileImport').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const raw = data?.profile ?? data;
    if (!raw || typeof raw !== 'object' || !raw.serial) throw new Error('o arquivo não é um perfil do Balance Reader');
    const profile = normalizeProfile({ ...raw, id: `custom-${Date.now().toString(36)}`, builtin: false, validated: false });
    draft.customProfiles.push(profile);
    draft.profile = structuredClone(profile);
    testEdited = false;
    fillForm();
    toast(`Perfil "${profile.name}" importado`, 'ok');
  } catch (err) {
    toast(`Não foi possível importar: ${err.message}`, 'danger', 6000);
  }
});

// save / cancel
dlg.addEventListener('close', async () => {
  if (dlg.returnValue !== 'save' || !draft) {
    stopDetect();
    return;
  }
  stopDetect();
  const errors = regexErrors();
  if (errors.length) {
    toast('Corrija as expressões regulares antes de salvar.', 'danger');
    dlg.returnValue = '';
    dlg.showModal();
    selectTab('format');
    return;
  }
  const serialChanged = JSON.stringify(settings.profile.serial) !== JSON.stringify(draft.profile.serial);
  const pollChanged = JSON.stringify(settings.profile.poll) !== JSON.stringify(draft.profile.poll);
  // edits to one of the user's own profiles are saved into it
  const ownIdx = draft.customProfiles.findIndex((c) => c.id === draft.profile.id);
  if (ownIdx >= 0) draft.customProfiles[ownIdx] = structuredClone(draft.profile);
  Object.assign(settings, {
    profile: normalizeProfile(draft.profile),
    customProfiles: draft.customProfiles.map(normalizeProfile),
    sampleInterval: draft.sampleInterval,
    uncertaintyWindow: draft.uncertaintyWindow,
    csvFormat: draft.csvFormat,
    theme: draft.theme,
  });
  saveSettings(settings);
  if (session.window !== settings.uncertaintyWindow) {
    session.setWindow(settings.uncertaintyWindow);
    autosave();
  }
  applyTheme();
  renderProfile();
  scheduleRender();
  if (serialChanged && reader.connected && !reader.isSimulator) await reconnectWithNewSettings();
  else if (pollChanged) reader.startPolling();
  lastDiag = undefined;
  toast('Configurações salvas');
});
$('settingsForm').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault(); // never submit by accident
});

// ---- auto-detect serial parameters --------------------------------------------------------------------

let detecting = null;
function stopDetect() {
  if (detecting) detecting.cancelled = true;
}

$('detectBtn').addEventListener('click', async () => {
  if (detecting) return stopDetect();
  if (!webSerialSupported()) return toast('Este navegador não tem acesso à porta USB. Use Chrome ou Edge.', 'warn');
  let port = currentPort;
  if (!port) {
    try {
      port = await navigator.serial.requestPort();
    } catch {
      return;
    }
  }
  const wasConnected = reader.connected && !reader.isSimulator;
  if (reader.running) pauseRecording();
  if (wasConnected) await reader.disconnect();
  const job = { cancelled: false };
  detecting = job;
  const status = $('detectStatus');
  const btn = $('detectBtn');
  btn.innerHTML = `${icon('x')}Parar detecção`;
  readForm();
  const frames = [
    [8, 'none', 1],
    [7, 'even', 1],
    [7, 'odd', 1],
  ];
  const bauds = [9600, 1200, 2400, 4800, 19200, 600, 38400, 300, 57600, 115200];
  const combos = [];
  for (const [dataBits, parity, stopBits] of frames) for (const baudRate of bauds) combos.push({ baudRate, dataBits, parity, stopBits });
  for (const baudRate of bauds.slice(0, 5)) combos.push({ baudRate, dataBits: 8, parity: 'none', stopBits: 2 });
  // try the current setting first
  const cur = draft.profile.serial;
  const curIdx = combos.findIndex((c) => c.baudRate === cur.baudRate && c.dataBits === cur.dataBits && c.parity === cur.parity && c.stopBits === cur.stopBits);
  if (curIdx > 0) combos.unshift(...combos.splice(curIdx, 1));

  let found = null;
  let best = null;
  for (let i = 0; i < combos.length && !job.cancelled; i++) {
    const c = combos[i];
    const label = serialSummary(c);
    status.textContent = `Testando ${label}… (${i + 1} de ${combos.length})`;
    const lines = [];
    let text = '';
    const t = new WebSerialTransport(port, { ...c, flowControl: draft.profile.serial.flowControl });
    t.onData = (chunk) => {
      text += chunk;
      const parts = text.split(/\r\n|\r|\n/);
      text = parts.pop();
      lines.push(...parts.filter((l) => l.trim()));
    };
    try {
      await t.open();
      const ask = draft.profile.poll.command || draft.profile.commands.print;
      if (ask) {
        await t.write(encodeCommand(ask, draft.profile.commands.lineEnding)).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 1600));
    } catch (err) {
      status.textContent = `Não foi possível abrir a porta: ${err.message}`;
      await t.close();
      break;
    }
    await t.close();
    const parsed = lines.slice(1).filter((l) => tryParse(l, draft.profile.parser)).length;
    const readable = lines.filter((l) => !/[\x00-\x08\x0e-\x1f\x7f-\x9f�]/.test(l)).length;
    if (parsed >= 2) {
      found = { ...c, parsed };
      break;
    }
    if (readable >= 2 && (!best || readable > best.readable)) best = { ...c, readable };
  }

  detecting = null;
  btn.innerHTML = `${icon('search')}Detectar automaticamente`;
  if (found) {
    $('fBaud').value = String(found.baudRate);
    $('fDataBits').value = String(found.dataBits);
    $('fParity').value = found.parity;
    $('fStopBits').value = String(found.stopBits);
    readForm();
    status.innerHTML = `<strong style="color:var(--ok)">Encontrado: ${serialSummary(found)}</strong> — ${found.parsed} leituras reconhecidas. Clique em Salvar para usar.`;
  } else if (job.cancelled) {
    status.textContent = 'Detecção interrompida.';
  } else if (best) {
    $('fBaud').value = String(best.baudRate);
    $('fDataBits').value = String(best.dataBits);
    $('fParity').value = best.parity;
    $('fStopBits').value = String(best.stopBits);
    readForm();
    status.innerHTML = `Com <strong>${serialSummary(best)}</strong> chegou texto legível, mas nenhum peso foi reconhecido. Ajuste o formato em <em>Formato dos dados</em> (o console serial mostra as linhas).`;
  } else if (!status.textContent.startsWith('Não foi')) {
    status.textContent = 'Nenhuma combinação recebeu dados. A balança está ligada e enviando? Se ela só responde a comandos, preencha "Pedir leitura" na aba Comandos e tente de novo.';
  }
  currentPort = port;
  if (wasConnected || found) {
    // reconnect with whatever is saved now; the user decides whether to keep the detected values
    await connectSerial(port, { quiet: true });
  }
});

// ---- unsupported browser / startup --------------------------------------------------------------------------

function startupBanners() {
  if (!window.isSecureContext) {
    banner('secure', {
      kind: 'danger',
      title: 'Abra esta página por HTTPS',
      text: '<p>O acesso à porta USB só funciona em páginas seguras (https:// ou localhost).</p>',
      dismissible: false,
    });
  } else if (!webSerialSupported()) {
    banner('support', {
      kind: 'warn',
      title: 'Este navegador não acessa a porta USB',
      text: '<p>Use o <strong>Google Chrome</strong>, o <strong>Microsoft Edge</strong> ou o Opera no computador (Windows, macOS, Linux ou ChromeOS). Firefox, Safari e celulares não têm Web Serial. O simulador funciona em qualquer navegador.</p>',
    });
  }
}

async function autoReconnect() {
  if (!webSerialSupported() || !window.isSecureContext) return;
  const ports = await navigator.serial.getPorts();
  if (ports.length === 1) await connectSerial(ports[0], { quiet: true });
  if (reader.connected) toast(`Reconectado a ${reader.transport.label}`, 'info');
}

function restoreNotice() {
  if (!session.length) return;
  banner('restored', {
    kind: 'info',
    title: `Sessão anterior recuperada — ${session.length.toLocaleString('pt-BR')} leituras`,
    text: `<p>${session.dirty ? 'Ainda não exportada. ' : ''}Clique em Continuar gravação para seguir de onde parou, ou em Nova para começar do zero.</p>`,
  });
}

applyTheme();
renderProfile();
renderRange();
renderState();
renderReadout();
renderStats();
renderChart();
resetConsole();
startupBanners();
restoreNotice();
tick();
setInterval(tick, 250);
autoReconnect();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// handy for debugging from the console
window.balanceReader = { reader, session: () => session, settings };
