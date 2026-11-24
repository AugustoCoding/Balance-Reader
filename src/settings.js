// User settings and the autosaved session, kept in this browser's localStorage.

import { DEFAULT_PROFILE_ID, findPreset, normalizeProfile } from './profiles.js';

const SETTINGS_KEY = 'balance-reader:settings';
const SESSION_KEY = 'balance-reader:session';

export const DEFAULTS = Object.freeze({
  version: 1,
  profile: null, // filled with the default preset
  customProfiles: [],
  sampleInterval: 1, // s between recorded readings (0 = every line)
  uncertaintyWindow: 5,
  chartRange: 0, // seconds shown in the chart (0 = all)
  csvFormat: 'br',
  theme: 'auto',
  autoStop: { enabled: false, value: '00:10:00' },
  consoleOpen: false,
});

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // private mode or quota full: keep working without persistence
  }
}

const num = (v, fallback, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export function loadSettings() {
  const raw = read(SETTINGS_KEY) ?? {};
  const s = {
    ...DEFAULTS,
    ...raw,
    autoStop: { ...DEFAULTS.autoStop, ...raw.autoStop },
  };
  s.profile = normalizeProfile(raw.profile ?? findPreset(DEFAULT_PROFILE_ID));
  s.customProfiles = Array.isArray(raw.customProfiles) ? raw.customProfiles.map(normalizeProfile) : [];
  s.sampleInterval = num(s.sampleInterval, DEFAULTS.sampleInterval, 0, 3600);
  s.uncertaintyWindow = Math.round(num(s.uncertaintyWindow, DEFAULTS.uncertaintyWindow, 2, 1000));
  s.chartRange = num(s.chartRange, 0, 0, 86400);
  if (!['br', 'intl'].includes(s.csvFormat)) s.csvFormat = 'br';
  if (!['auto', 'light', 'dark'].includes(s.theme)) s.theme = 'auto';
  return s;
}

export function saveSettings(s) {
  return write(SETTINGS_KEY, s);
}

export function loadSavedSession() {
  return read(SESSION_KEY);
}

export function saveSession(session) {
  return write(SESSION_KEY, session.toJSON());
}

export function clearSavedSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}
