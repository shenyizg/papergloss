import { api } from './api.js';
import { icon } from './icons.js';
import { getLang, setLang, t } from './i18n.js';
import { h } from './ui.js';

export function renderLogin(root, onSuccess) {
  const input = h('input', { class: 'input', type: 'password', placeholder: t('login.password'), autocomplete: 'current-password', 'aria-label': t('login.password') });
  const btn = h('button', { class: 'btn btn-primary', type: 'submit', text: t('login.enter') });
  const err = h('div', { class: 'form-error' });
  const langBtn = h('button', { class: 'lang-switch', type: 'button', text: t('login.switchLang') });
  langBtn.addEventListener('click', () => {
    setLang(getLang() === 'zh' ? 'en' : 'zh');
    renderLogin(root, onSuccess);
  });
  const form = h(
    'form',
    { class: 'login-card' },
    h(
      'div',
      { class: 'login-top' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark', html: icon('book') }), h('span', { text: t('app.name') })),
      langBtn,
    ),
    h('h1', { text: t('login.title') }),
    h('p', { text: t('login.hint') }),
    input,
    err,
    btn,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    err.textContent = '';
    try {
      await api.login(input.value);
      onSuccess();
    } catch (ex) {
      err.textContent = ex.message;
      input.select();
    } finally {
      btn.disabled = false;
    }
  });
  const el = h('main', { class: 'login' }, form);
  root.replaceChildren(el);
  document.title = t('app.name');
  setTimeout(() => input.focus(), 50);
  return { destroy() {} };
}
