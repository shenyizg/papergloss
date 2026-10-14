import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonFile, writeJsonFile, randomId } from './util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '..');
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, 'data'));
export const PAPERS_DIR = path.join(DATA_DIR, 'papers');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const ACTIONS = ['translate', 'explain', 'ask', 'chat'];

export const DEFAULT_LLM = {
  protocol: 'anthropic',
  preset: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: '',
  model: 'claude-opus-5-5',
  // Only sent to OpenAI-compatible providers, and only when set.
  temperature: null,
  maxTokens: null,
  // Claude effort per action; "auto" leaves the model default.
  effort: { translate: 'low', explain: 'medium', ask: 'medium', chat: 'medium' },
};

export const DEFAULT_PREFS = {
  targetLang: '简体中文',
  fullTextLimit: 120000,
  preferHtml: true,
  prompts: { translate: '', explain: '', ask: '' },
};

let config = null;
// The hash kept on disk. With PAPERGLOSS_PASSWORD set, the one in use lives only in memory.
let storedHash = '';

function normalize(raw = {}) {
  const llm = { ...DEFAULT_LLM, ...(raw.llm || {}) };
  llm.effort = { ...DEFAULT_LLM.effort, ...(raw.llm?.effort || {}) };
  const prefs = { ...DEFAULT_PREFS, ...(raw.prefs || {}) };
  prefs.prompts = { ...DEFAULT_PREFS.prompts, ...(raw.prefs?.prompts || {}) };
  return {
    secret: raw.secret || crypto.randomBytes(32).toString('hex'),
    passwordHash: raw.passwordHash || '',
    llm,
    prefs,
  };
}

// ---- access password: stored as an scrypt hash -----------------------------------------

const SCRYPT = { N: 16384, r: 8, p: 1 };

function scrypt(password, salt, keylen, opts) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password).normalize('NFC'), salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(password, salt = crypto.randomBytes(16)) {
  const key = await scrypt(password, salt, 32, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password) {
  const [kind, N, r, p, salt, hash] = String(config.passwordHash).split('$');
  const expected = Buffer.from(hash || '', 'base64');
  if (kind !== 'scrypt' || expected.length < 16) return false;
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(key, expected);
}

export async function loadConfig() {
  const raw = await readJsonFile(CONFIG_FILE, {});
  config = normalize(raw);
  // Older versions kept the password itself; it keeps working, stored as a hash from now on.
  if (!config.passwordHash && raw.password) config.passwordHash = await hashPassword(raw.password);
  storedHash = config.passwordHash;
  let generatedPassword = null;
  if (process.env.PAPERGLOSS_PASSWORD) {
    // A salt derived from the secret keeps the hash, and so every session, stable across restarts.
    const salt = crypto.createHmac('sha256', config.secret).update('env-password').digest().subarray(0, 16);
    config.passwordHash = await hashPassword(process.env.PAPERGLOSS_PASSWORD, salt);
  } else if (!config.passwordHash) {
    generatedPassword = randomId(10);
    config.passwordHash = storedHash = await hashPassword(generatedPassword);
  }
  await saveConfig();
  return { config, generatedPassword };
}

export function getConfig() {
  return config;
}

export async function saveConfig() {
  // Holds the API key: owner-only. An env-provided password is never written, not even hashed.
  const toSave = { secret: config.secret, passwordHash: storedHash, llm: config.llm, prefs: config.prefs };
  await writeJsonFile(CONFIG_FILE, toSave, { mode: 0o600 });
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 10) return '•'.repeat(key.length);
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}

export function publicSettings() {
  const { apiKey, ...llm } = config.llm;
  return {
    llm: { ...llm, hasKey: !!apiKey, keyPreview: maskKey(apiKey) },
    prefs: config.prefs,
    passwordFromEnv: !!process.env.PAPERGLOSS_PASSWORD,
  };
}

const EFFORTS = new Set(['auto', 'low', 'medium', 'high', 'xhigh', 'max']);

const normalizeBaseUrl = (url) => url.trim().replace(/\/+$/, '');

// A saved API key belongs to the server it was saved for (scheme, host and port).
function endpointOrigin(protocol, baseUrl) {
  try {
    return new URL(baseUrl || (protocol === 'anthropic' ? DEFAULT_LLM.baseUrl : '')).origin;
  } catch {
    return '';
  }
}

function sameEndpoint(a, b) {
  const origin = endpointOrigin(a.protocol, a.baseUrl);
  return !!origin && origin === endpointOrigin(b.protocol, b.baseUrl);
}

export async function updateSettings(patch = {}) {
  if (patch.llm) {
    const l = patch.llm;
    const llm = config.llm;
    const before = { protocol: llm.protocol, baseUrl: llm.baseUrl };
    if (typeof l.protocol === 'string' && ['anthropic', 'openai'].includes(l.protocol)) llm.protocol = l.protocol;
    if (typeof l.preset === 'string') llm.preset = l.preset.slice(0, 40);
    if (typeof l.baseUrl === 'string') llm.baseUrl = normalizeBaseUrl(l.baseUrl);
    if (typeof l.model === 'string') llm.model = l.model.trim();
    if (typeof l.apiKey === 'string' && l.apiKey.trim()) llm.apiKey = l.apiKey.trim();
    else if (!sameEndpoint(before, llm)) llm.apiKey = '';
    if (l.clearKey === true) llm.apiKey = '';
    if ('temperature' in l) {
      const t = l.temperature === '' || l.temperature === null ? null : Number(l.temperature);
      llm.temperature = Number.isFinite(t) ? Math.min(2, Math.max(0, t)) : null;
    }
    if ('maxTokens' in l) {
      const m = l.maxTokens === '' || l.maxTokens === null ? null : Math.round(Number(l.maxTokens));
      llm.maxTokens = Number.isFinite(m) && m > 0 ? m : null;
    }
    if (l.effort && typeof l.effort === 'object') {
      for (const a of ACTIONS) {
        if (EFFORTS.has(l.effort[a])) llm.effort[a] = l.effort[a];
      }
    }
  }
  if (patch.prefs) {
    const p = patch.prefs;
    const prefs = config.prefs;
    if (typeof p.targetLang === 'string' && p.targetLang.trim()) prefs.targetLang = p.targetLang.trim().slice(0, 40);
    if ('fullTextLimit' in p) {
      const n = Math.round(Number(p.fullTextLimit));
      if (Number.isFinite(n)) prefs.fullTextLimit = Math.min(2_000_000, Math.max(5000, n));
    }
    if (typeof p.preferHtml === 'boolean') prefs.preferHtml = p.preferHtml;
    if (p.prompts && typeof p.prompts === 'object') {
      for (const k of Object.keys(DEFAULT_PREFS.prompts)) {
        if (typeof p.prompts[k] === 'string') prefs.prompts[k] = p.prompts[k].slice(0, 8000);
      }
    }
  }
  await saveConfig();
  return publicSettings();
}

export async function setPassword(newPassword) {
  config.passwordHash = storedHash = await hashPassword(newPassword);
  await saveConfig();
}

// Builds the effective LLM config for one request: saved settings, optionally
// overridden by unsaved values from the settings form (used by "test" / "list models").
export function effectiveLlm(override) {
  const base = { ...config.llm, effort: { ...config.llm.effort } };
  if (!override) return base;
  if (override.protocol === 'anthropic' || override.protocol === 'openai') base.protocol = override.protocol;
  if (typeof override.baseUrl === 'string') base.baseUrl = normalizeBaseUrl(override.baseUrl);
  if (typeof override.model === 'string' && override.model.trim()) base.model = override.model.trim();
  if (typeof override.apiKey === 'string' && override.apiKey.trim()) {
    base.apiKey = override.apiKey.trim();
  } else if (!sameEndpoint(base, config.llm)) {
    // Never send the saved key to a server the user is only trying out.
    base.apiKey = '';
    base.keyWithheld = !!config.llm.apiKey;
  }
  return base;
}
