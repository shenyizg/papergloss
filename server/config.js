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

function normalize(raw = {}) {
  const llm = { ...DEFAULT_LLM, ...(raw.llm || {}) };
  llm.effort = { ...DEFAULT_LLM.effort, ...(raw.llm?.effort || {}) };
  const prefs = { ...DEFAULT_PREFS, ...(raw.prefs || {}) };
  prefs.prompts = { ...DEFAULT_PREFS.prompts, ...(raw.prefs?.prompts || {}) };
  return {
    secret: raw.secret || crypto.randomBytes(32).toString('hex'),
    password: raw.password || '',
    llm,
    prefs,
  };
}

export async function loadConfig() {
  const raw = await readJsonFile(CONFIG_FILE, {});
  config = normalize(raw);
  let generatedPassword = null;
  if (process.env.PAPERGLOSS_PASSWORD) {
    config.password = process.env.PAPERGLOSS_PASSWORD;
  } else if (!config.password) {
    generatedPassword = randomId(10);
    config.password = generatedPassword;
  }
  await saveConfig();
  return { config, generatedPassword };
}

export function getConfig() {
  return config;
}

export async function saveConfig() {
  // An env-provided password is never written back to disk.
  const toSave = { ...config };
  if (process.env.PAPERGLOSS_PASSWORD) {
    const onDisk = await readJsonFile(CONFIG_FILE, {});
    toSave.password = onDisk.password || '';
  }
  // Holds the access password and the API key: owner-only.
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

export async function updateSettings(patch = {}) {
  if (patch.llm) {
    const l = patch.llm;
    const llm = config.llm;
    if (typeof l.protocol === 'string' && ['anthropic', 'openai'].includes(l.protocol)) llm.protocol = l.protocol;
    if (typeof l.preset === 'string') llm.preset = l.preset.slice(0, 40);
    if (typeof l.baseUrl === 'string') llm.baseUrl = l.baseUrl.trim().replace(/\/+$/, '');
    if (typeof l.model === 'string') llm.model = l.model.trim();
    if (typeof l.apiKey === 'string' && l.apiKey.trim()) llm.apiKey = l.apiKey.trim();
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
  config.password = newPassword;
  await saveConfig();
}

// Builds the effective LLM config for one request: saved settings, optionally
// overridden by unsaved values from the settings form (used by "test" / "list models").
export function effectiveLlm(override) {
  const base = { ...config.llm, effort: { ...config.llm.effort } };
  if (!override) return base;
  if (override.protocol === 'anthropic' || override.protocol === 'openai') base.protocol = override.protocol;
  if (typeof override.baseUrl === 'string') base.baseUrl = override.baseUrl.trim().replace(/\/+$/, '');
  if (typeof override.model === 'string' && override.model.trim()) base.model = override.model.trim();
  if (typeof override.apiKey === 'string' && override.apiKey.trim()) base.apiKey = override.apiKey.trim();
  return base;
}
