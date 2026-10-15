// AI providers: the presets offered in Settings, the ones saved on the server (each with
// its own key, kept there), and a quick switcher for when one of them is down.
import { api, cachedSettings, getSettings, setSettingsCache } from './api.js';
import { openMenu, toast } from './ui.js';
import { t } from './i18n.js';

export const PRESETS = [
  {
    id: 'anthropic',
    nameKey: 'preset.anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-opus-5-5',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
  },
  { id: 'openai', name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1' },
  { id: 'deepseek', name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'gemini', name: 'Google Gemini', protocol: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'qwen', nameKey: 'preset.qwen', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'moonshot', nameKey: 'preset.moonshot', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'zhipu', nameKey: 'preset.zhipu', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'siliconflow', nameKey: 'preset.siliconflow', protocol: 'openai', baseUrl: 'https://api.siliconflow.cn/v1' },
  { id: 'openrouter', name: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'ollama', nameKey: 'preset.ollama', protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1' },
  { id: 'custom', nameKey: 'preset.custom', protocol: 'openai', baseUrl: '' },
  { id: 'custom-anthropic', nameKey: 'preset.customAnthropic', protocol: 'anthropic', baseUrl: '' },
];

// A provider's display name; custom endpoints are told apart by their host.
export function presetLabel(id, saved) {
  const p = PRESETS.find((x) => x.id === id);
  const name = p ? (p.nameKey ? t(p.nameKey) : p.name) : id;
  if ((!p || id.startsWith('custom')) && saved?.baseUrl) {
    try {
      return `${name} · ${new URL(saved.baseUrl).host}`;
    } catch {
      return name;
    }
  }
  return name;
}

const LOCAL_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]$)|\.local$/i;

// Saved providers that can answer right away: a model, plus a key unless the server is local.
export function usableProviders(settings = cachedSettings()) {
  const out = [];
  for (const [id, p] of Object.entries(settings?.providers || {})) {
    let local = false;
    try {
      local = LOCAL_HOST.test(new URL(p.baseUrl).hostname);
    } catch {
      local = false;
    }
    if (p.model && (p.hasKey || local)) out.push({ id, label: presetLabel(id, p), model: p.model, active: id === settings.llm.preset });
  }
  return out;
}

export function canSwitchProvider() {
  return usableProviders().length > 1;
}

// Menu of saved providers; picking one makes it the provider in use.
export async function openProviderMenu(anchor, { onSwitched, openSettings } = {}) {
  // Fresh from the server: the provider may have been switched on another device.
  await getSettings(true).catch(() => null);
  const items = usableProviders().map((p) => ({
    icon: p.active ? 'check' : 'blank',
    label: p.label,
    right: p.model,
    onClick: async () => {
      if (p.active) return onSwitched?.(p.id);
      try {
        setSettingsCache(await api.saveSettings({ llm: { preset: p.id } }));
        toast(t('ai.switched', { name: p.label }));
        onSwitched?.(p.id);
      } catch (err) {
        toast(err.message, { type: 'error' });
      }
    },
  }));
  if (openSettings) items.push('sep', { icon: 'sliders', label: t('ai.manageProviders'), onClick: openSettings });
  openMenu(anchor, items);
}
