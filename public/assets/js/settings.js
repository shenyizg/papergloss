import { api, getSettings, setSettingsCache } from './api.js';
import { icon } from './icons.js';
import { applyTheme, h, iconButton, local, toast } from './ui.js';
import { LANGS as UI_LANGS, getLang, setLang, t } from './i18n.js';

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

const presetName = (p) => (p.nameKey ? t(p.nameKey) : p.name);

const LANGS = ['简体中文', '繁體中文', 'English', '日本語', '한국어', 'Français', 'Deutsch', 'Español', 'Русский'];
const EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];

function field(label, control, hint) {
  return h('div', { class: 'field' }, h('label', { text: label }), control, hint ? h('div', { class: 'hint', text: hint }) : null);
}

function select(options, value) {
  const el = h('select', { class: 'input' });
  for (const [v, label] of options) el.append(h('option', { value: v, text: label }));
  el.value = value;
  return el;
}

export async function openSettings({ section } = {}) {
  if (document.querySelector('.modal.settings')) return;
  let settings;
  try {
    settings = await getSettings(true);
  } catch (err) {
    toast(err.message, { type: 'error' });
    return;
  }
  const llm = settings.llm;
  const prefs = settings.prefs;

  const scrim = h('div', { class: 'scrim' });
  const body = h('div', { class: 'modal-body' });
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', text: t('common.save') });
  const cancelBtn = h('button', { class: 'btn btn-secondary', type: 'button', text: t('common.cancel') });
  const modal = h(
    'div',
    { class: 'modal settings', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('settings.title') },
    h('div', { class: 'modal-head' }, h('span', { class: 'title', text: t('settings.title') }), iconButton('close', { title: t('common.close'), onClick: () => close() })),
    body,
    h('div', { class: 'modal-foot' }, cancelBtn, saveBtn),
  );
  const close = () => {
    scrim.remove();
    modal.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  scrim.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);

  // ---- AI service ----
  const presetSel = select(PRESETS.map((p) => [p.id, presetName(p)]), PRESETS.some((p) => p.id === llm.preset) ? llm.preset : 'custom');
  const baseInput = h('input', { class: 'input', type: 'url', value: llm.baseUrl || '', placeholder: 'https://…/v1', autocomplete: 'off', spellcheck: 'false' });
  const keyInput = h('input', {
    class: 'input',
    type: 'password',
    placeholder: llm.hasKey ? t('settings.keySaved', { key: llm.keyPreview }) : t('settings.keyPaste'),
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const keyToggle = iconButton('eye', { title: t('settings.showHide') });
  keyToggle.addEventListener('click', () => (keyInput.type = keyInput.type === 'password' ? 'text' : 'password'));
  const keyHint = h('div', { class: 'hint', text: t('settings.keyHint') });
  const modelInput = h('input', { class: 'input', type: 'text', value: llm.model || '', placeholder: t('settings.modelName'), autocomplete: 'off', spellcheck: 'false' });
  const modelPick = h('select', { class: 'input', hidden: true, 'aria-label': t('settings.pickModelAria') });
  const fetchBtn = h('button', { class: 'btn btn-sm btn-secondary', type: 'button', text: t('settings.fetchModels') });
  const testBtn = h('button', { class: 'btn btn-sm btn-secondary', type: 'button', html: `${icon('check', 16)}<span>${t('settings.test')}</span>` });
  const testResult = h('div', { class: 'hint' });
  const protocolHint = h('div', { class: 'hint' });
  let protocol = llm.protocol;
  let presetChanged = false;

  // The server only ever sends the saved key to the server it was saved for.
  const originOf = (proto, url) => {
    try {
      return new URL(url || (proto === 'anthropic' ? 'https://api.anthropic.com' : '')).origin;
    } catch {
      return '';
    }
  };
  const endpointChanged = () => {
    const origin = originOf(protocol, baseInput.value.trim());
    return presetChanged || !origin || origin !== originOf(llm.protocol, llm.baseUrl);
  };
  const refreshKeyHint = () => {
    keyHint.textContent = llm.hasKey && endpointChanged() ? t('settings.keyChanged') : t('settings.keyHint');
  };
  baseInput.addEventListener('input', refreshKeyHint);

  const showModelOptions = (models) => {
    modelPick.replaceChildren(h('option', { value: '', text: t('settings.pickModel', { n: models.length }) }), ...models.map((m) => h('option', { value: m, text: m })));
    modelPick.hidden = !models.length;
  };
  modelPick.addEventListener('change', () => {
    if (modelPick.value) modelInput.value = modelPick.value;
  });

  const refreshProtocol = () => {
    protocolHint.textContent =
      protocol === 'anthropic'
        ? t('settings.protoAnthropic')
        : t('settings.protoOpenai');
    effortBox.hidden = protocol !== 'anthropic';
    tempField.hidden = protocol === 'anthropic';
  };

  presetSel.addEventListener('change', () => {
    const p = PRESETS.find((x) => x.id === presetSel.value);
    presetChanged = presetSel.value !== llm.preset;
    protocol = p.protocol;
    if (p.baseUrl || !p.id.startsWith('custom')) baseInput.value = p.baseUrl;
    modelInput.value = p.model || '';
    showModelOptions(p.models || []);
    refreshKeyHint();
    testResult.textContent = '';
    refreshProtocol();
  });

  const formLlm = () => ({
    protocol,
    preset: presetSel.value,
    baseUrl: baseInput.value.trim(),
    model: modelInput.value.trim(),
    apiKey: keyInput.value.trim() || undefined,
  });

  fetchBtn.addEventListener('click', async () => {
    fetchBtn.disabled = true;
    fetchBtn.textContent = t('settings.fetching');
    try {
      const { models } = await api.listModels(formLlm());
      if (!models.length) toast(t('settings.noModels'));
      showModelOptions(models);
      if (models.length) modelPick.focus();
    } catch (err) {
      toast(err.message, { type: 'error', duration: 4500 });
    } finally {
      fetchBtn.disabled = false;
      fetchBtn.textContent = t('settings.fetchModels');
    }
  });

  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testResult.className = 'hint';
    testResult.textContent = t('settings.testing');
    try {
      const r = await api.testLlm(formLlm());
      testResult.className = 'hint ok';
      testResult.textContent = t('settings.testOk', { model: r.model, s: (r.ms / 1000).toFixed(1), reply: r.reply || t('settings.emptyReply') });
    } catch (err) {
      testResult.className = 'hint err';
      testResult.textContent = err.message;
    } finally {
      testBtn.disabled = false;
    }
  });

  // ---- advanced ----
  const effortSelects = {};
  const effortBox = h('div', { class: 'field' }, h('div', { class: 'label', text: t('settings.effort') }));
  const effortGrid = h('div', { class: 'grid-2' });
  for (const k of ['translate', 'explain', 'ask', 'chat']) {
    effortSelects[k] = select(EFFORTS.map((e) => [e, t(`settings.effort.${e}`)]), llm.effort?.[k] || 'auto');
    effortGrid.append(h('div', {}, h('div', { class: 'hint', text: t(`action.${k}`) }), effortSelects[k]));
  }
  effortBox.append(effortGrid, h('div', { class: 'hint', text: t('settings.effortHint') }));
  const tempInput = h('input', { class: 'input', type: 'number', step: '0.1', min: '0', max: '2', value: llm.temperature ?? '', placeholder: t('settings.tempPlaceholder') });
  const tempField = field(t('settings.temperature'), tempInput, t('settings.tempHint'));
  const maxTokInput = h('input', { class: 'input', type: 'number', min: '256', step: '256', value: llm.maxTokens ?? '', placeholder: t('settings.maxTokensPlaceholder') });
  const fullLimitInput = h('input', { class: 'input', type: 'number', min: '5000', step: '10000', value: prefs.fullTextLimit ?? 120000 });
  const promptTranslate = h('textarea', { class: 'input', placeholder: t('settings.promptPlaceholder'), rows: '3' });
  promptTranslate.value = prefs.prompts?.translate || '';
  const promptExplain = h('textarea', { class: 'input', placeholder: t('settings.promptPlaceholder'), rows: '3' });
  promptExplain.value = prefs.prompts?.explain || '';
  const promptAsk = h('textarea', { class: 'input', placeholder: t('settings.promptPlaceholder'), rows: '3' });
  promptAsk.value = prefs.prompts?.ask || '';

  const langSel = select(
    LANGS.map((l) => [l, l]),
    LANGS.includes(prefs.targetLang) ? prefs.targetLang : '简体中文',
  );

  // ---- reading ----
  const themeSeg = h('div', { class: 'seg' });
  const theme = local.get('theme', 'system');
  for (const v of ['system', 'light', 'dark']) {
    const b = h('button', { type: 'button', text: t(`theme.${v}`), class: v === theme ? 'on' : '' });
    b.addEventListener('click', () => {
      themeSeg.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      local.set('theme', v);
      applyTheme(v);
    });
    themeSeg.append(b);
  }
  const htmlSwitch = h('input', { type: 'checkbox' });
  htmlSwitch.checked = prefs.preferHtml !== false;

  // ---- account ----
  const oldPw = h('input', { class: 'input', type: 'password', placeholder: t('settings.currentPassword'), autocomplete: 'current-password' });
  const newPw = h('input', { class: 'input', type: 'password', placeholder: t('settings.newPassword'), autocomplete: 'new-password' });
  const pwBtn = h('button', { class: 'btn btn-sm btn-secondary', type: 'button', text: t('settings.changePasswordBtn') });
  pwBtn.addEventListener('click', async () => {
    try {
      await api.changePassword(oldPw.value, newPw.value);
      oldPw.value = '';
      newPw.value = '';
      toast(t('settings.passwordChanged'));
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
  });
  const logoutBtn = h('button', { class: 'btn btn-sm btn-secondary', type: 'button', html: `${icon('logout', 16)}<span>${t('settings.logout')}</span>` });

  // ---- interface language: applied right away (the page reloads to re-render) ----
  const uiLangSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': t('settings.uiLang') });
  for (const [code, label] of UI_LANGS) {
    const b = h('button', { type: 'button', role: 'radio', text: label, class: code === getLang() ? 'on' : '', 'aria-checked': String(code === getLang()) });
    b.addEventListener('click', () => {
      if (code === getLang()) return;
      setLang(code);
      location.reload();
    });
    uiLangSeg.append(b);
  }
  const uiGroup = h(
    'section',
    { class: 'settings-group' },
    h('h3', { text: t('settings.ui') }),
    h('div', { class: 'switch-row' }, h('span', { text: t('settings.uiLang') }), uiLangSeg),
  );
  logoutBtn.addEventListener('click', async () => {
    await api.logout().catch(() => {});
    location.reload();
  });

  const aiGroup = h(
    'section',
    { class: 'settings-group' },
    h('h3', { text: t('settings.ai') }),
    field(t('settings.provider'), presetSel),
    protocolHint,
    field(t('settings.baseUrl'), baseInput),
    h('div', { class: 'field' }, h('label', { text: 'API Key' }), h('div', { class: 'field-row' }, keyInput, keyToggle), keyHint),
    h('div', { class: 'field' }, h('label', { text: t('settings.model') }), h('div', { class: 'field-row' }, modelInput, fetchBtn), modelPick),
    h('div', { class: 'field' }, h('div', { class: 'field-row' }, testBtn), testResult),
  );
  const answerGroup = h(
    'section',
    { class: 'settings-group' },
    h('h3', { text: t('settings.answers') }),
    field(t('settings.targetLang'), langSel),
  );
  const advanced = h(
    'details',
    { class: 'advanced' },
    h('summary', { text: t('settings.advanced') }),
    effortBox,
    tempField,
    field(t('settings.maxTokens'), maxTokInput, t('settings.maxTokensHint')),
    field(t('settings.fullLimit'), fullLimitInput, t('settings.fullLimitHint')),
    field(t('settings.promptTranslate'), promptTranslate),
    field(t('settings.promptExplain'), promptExplain),
    field(t('settings.promptAsk'), promptAsk),
  );
  const readGroup = h(
    'section',
    { class: 'settings-group' },
    h('h3', { text: t('settings.reading') }),
    h('div', { class: 'switch-row' }, h('span', { text: t('settings.theme') }), themeSeg),
    h(
      'div',
      { class: 'switch-row' },
      h('div', {}, h('div', { text: t('settings.preferHtml') }), h('div', { class: 'hint', text: t('settings.preferHtmlHint') })),
      h('label', { class: 'switch' }, htmlSwitch, h('span')),
    ),
  );
  const accountGroup = h(
    'section',
    { class: 'settings-group' },
    h('h3', { text: t('settings.account') }),
    settings.passwordFromEnv
      ? h('div', { class: 'hint', text: t('settings.envPassword') })
      : h('div', { class: 'field' }, h('label', { text: t('settings.changePassword') }), oldPw, newPw, h('div', {}, pwBtn)),
    h('div', { style: { marginTop: '14px' } }, logoutBtn),
  );
  body.append(uiGroup, aiGroup, answerGroup, advanced, readGroup, accountGroup);
  refreshProtocol();
  if (llm.preset === 'anthropic') showModelOptions(PRESETS[0].models);

  saveBtn.addEventListener('click', async () => {
    const effort = {};
    for (const [k, sel] of Object.entries(effortSelects)) effort[k] = sel.value;
    const llmPatch = {
      protocol,
      preset: presetSel.value,
      baseUrl: baseInput.value.trim(),
      model: modelInput.value.trim(),
      temperature: tempInput.value === '' ? null : Number(tempInput.value),
      maxTokens: maxTokInput.value === '' ? null : Number(maxTokInput.value),
      effort,
    };
    if (keyInput.value.trim()) llmPatch.apiKey = keyInput.value.trim();
    else if (endpointChanged()) llmPatch.clearKey = true;
    saveBtn.disabled = true;
    try {
      const saved = await api.saveSettings({
        llm: llmPatch,
        prefs: {
          targetLang: langSel.value,
          fullTextLimit: Number(fullLimitInput.value) || 120000,
          preferHtml: htmlSwitch.checked,
          prompts: { translate: promptTranslate.value, explain: promptExplain.value, ask: promptAsk.value },
        },
      });
      setSettingsCache(saved);
      toast(t('settings.saved'));
      close();
    } catch (err) {
      toast(err.message, { type: 'error' });
    } finally {
      saveBtn.disabled = false;
    }
  });

  document.body.append(scrim, modal);
  if (section === 'ai' && !llm.hasKey) keyInput.focus();
}
