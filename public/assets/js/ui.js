import { icon } from './icons.js';
import { t } from './i18n.js';

// Tiny element builder: h('div', { class: 'x', onClick: fn }, child, 'text')
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function iconEl(name, size) {
  const span = document.createElement('span');
  span.innerHTML = icon(name, size);
  return span.firstElementChild;
}

export function iconButton(name, { title, onClick, className = '' } = {}) {
  return h('button', { class: `icon-btn ${className}`, type: 'button', title, 'aria-label': title, onClick, html: icon(name) });
}

let toastWrap = null;
export function toast(message, { type = 'info', duration = 2600 } = {}) {
  if (!toastWrap) {
    toastWrap = h('div', { class: 'toast-wrap', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastWrap);
  }
  const el = h('div', { class: `toast ${type}` }, message);
  toastWrap.append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 260);
  }, duration);
}

export function confirmDialog({ title, message = '', okText = t('common.ok'), cancelText = t('common.cancel'), danger = false }) {
  return new Promise((resolve) => {
    const scrim = h('div', { class: 'scrim' });
    const done = (v) => {
      scrim.remove();
      box.remove();
      resolve(v);
    };
    const box = h(
      'div',
      { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true' },
      h('h3', { text: title }),
      message ? h('p', { text: message }) : null,
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn btn-secondary btn-sm', onClick: () => done(false) }, cancelText),
        h('button', { class: `btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}`, onClick: () => done(true) }, okText),
      ),
    );
    scrim.addEventListener('click', () => done(false));
    document.body.append(scrim, box);
  });
}

// Popover menu anchored to a button. items: [{ icon, label, onClick, danger, right }] or 'sep' or { el }
export function openMenu(anchor, items, { align = 'right' } = {}) {
  closeMenus();
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === 'sep') {
      menu.append(h('div', { class: 'menu-sep' }));
      continue;
    }
    if (it.el) {
      menu.append(it.el);
      continue;
    }
    const btn = h(
      'button',
      { class: `menu-item${it.danger ? ' danger' : ''}`, role: 'menuitem', type: 'button' },
      it.icon ? iconEl(it.icon) : null,
      h('span', { text: it.label }),
      it.right ? h('span', { class: 'right', text: it.right }) : null,
    );
    btn.addEventListener('click', () => {
      if (!it.keepOpen) closeMenus();
      it.onClick?.();
    });
    menu.append(btn);
  }
  const scrim = h('div', { class: 'menu-scrim', style: { position: 'fixed', inset: '0', zIndex: 74 } });
  scrim.addEventListener('click', closeMenus);
  scrim.addEventListener('touchmove', closeMenus, { passive: true });
  document.body.append(scrim, menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.top = `${top}px`;
  if (align === 'right') menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw))}px`;
  else menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.left))}px`;
  return menu;
}

// A menu row with an on/off switch; the menu stays open while it's toggled.
export function menuSwitch({ icon: name, label, checked, onChange }) {
  const input = h('input', { type: 'checkbox' });
  input.checked = !!checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h(
    'label',
    { class: 'menu-row menu-switch' },
    h('span', { class: 'label' }, iconEl(name), h('span', { text: label })),
    h('span', { class: 'switch' }, input, h('span')),
  );
}

export function closeMenus() {
  document.querySelectorAll('.menu, .menu-scrim').forEach((e) => e.remove());
}

export async function copyText(text) {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  // Plain-HTTP deployments have no Clipboard API; execCommand still works.
  const ta = h('textarea', { style: { position: 'fixed', top: '0', left: '0', opacity: '0', fontSize: '16px' }, readonly: true });
  ta.value = text;
  document.body.append(ta);
  const sel = document.getSelection();
  const saved = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  if (saved) {
    sel.removeAllRanges();
    sel.addRange(saved);
  }
  return ok;
}

export function timeAgo(iso) {
  if (!iso) return '';
  const diff = (Date.now() - Date.parse(iso)) / 1000;
  if (diff < 60) return t('time.justNow');
  if (diff < 3600) return t('time.minutes', { n: Math.floor(diff / 60) });
  if (diff < 86400) return t('time.hours', { n: Math.floor(diff / 3600) });
  if (diff < 86400 * 30) return t('time.days', { n: Math.floor(diff / 86400) });
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  wrapped.flush = (...args) => {
    clearTimeout(t);
    fn(...args);
  };
  return wrapped;
}

export function uid(prefix = 't') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const loadedCss = new Set();
export function loadCss(href) {
  if (loadedCss.has(href)) return Promise.resolve();
  loadedCss.add(href);
  return new Promise((resolve) => {
    const link = h('link', { rel: 'stylesheet', href });
    link.onload = resolve;
    link.onerror = resolve;
    document.head.append(link);
  });
}

export const isCoarse = () => window.matchMedia('(pointer: coarse)').matches;
export const isWide = () => window.matchMedia('(min-width: 900px)').matches;

const LS_PREFIX = 'pr.';
export const local = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(LS_PREFIX + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
    } catch {
      // storage unavailable (private mode); preferences just won't stick
    }
  },
};

export function applyTheme(theme = local.get('theme', 'system')) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  document.head.append(h('meta', { name: 'theme-color', content: dark ? '#0e1014' : '#f3f4f6' }));
  document.dispatchEvent(new CustomEvent('themechange', { detail: { dark } }));
  return dark;
}

export function isDarkTheme() {
  const theme = local.get('theme', 'system');
  return theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

// Tracks the on-screen keyboard on iOS, where fixed elements are not pushed up.
export function trackKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const update = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--kb', `${kb > 40 ? kb : 0}px`);
    document.documentElement.classList.toggle('kb-open', kb > 40);
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}
