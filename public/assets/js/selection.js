// Watches the text selection inside the reading area and shows the action bar.
import { h, isCoarse } from './ui.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

// Cleans text copied out of a PDF text layer or an HTML page.
export function normalizeText(text) {
  return String(text || '')
    .replace(/­/g, '')
    .replace(/\r/g, '')
    .replace(/([A-Za-z])-\n\s*([a-z])/g, '$1$2')
    .replace(/([　-〿㐀-鿿＀-￯])\s*\n\s*([　-〿㐀-鿿＀-￯])/g, '$1$2')
    .replace(/[ \t ]*\n[ \t ]*/g, ' ')
    .replace(/[ \t ]{2,}/g, ' ')
    .trim();
}

// Returns a window of `full` around `needle`, or null when it can't be located.
export function contextAround(full, needle, radius = 1200) {
  if (!full) return '';
  const squash = (s) => s.replace(/\s+/g, ' ');
  const hay = squash(full);
  const probe = squash(needle).slice(0, 60);
  let idx = probe.length >= 4 ? hay.indexOf(probe) : -1;
  if (idx < 0 && probe.length > 16) idx = hay.indexOf(probe.slice(0, 16));
  if (idx < 0) return hay.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(hay.length, idx + needle.length + radius);
  return `${start > 0 ? '…' : ''}${hay.slice(start, end)}${end < hay.length ? '…' : ''}`;
}

const ACTIONS = [
  { act: 'translate', icon: 'translate' },
  { act: 'explain', icon: 'bulb' },
  { act: 'ask', icon: 'message' },
  { act: 'copy', icon: 'copy' },
];

export class SelectionBar {
  // describe(selection) -> info object or null when the selection is outside the reading area.
  // While instant() is true the bar stays hidden and onInstant(info) receives each selection.
  constructor({ describe, onAction, onVisibility, instant, onInstant }) {
    this.describe = describe;
    this.onAction = onAction;
    this.onVisibility = onVisibility;
    this.instant = instant;
    this.onInstant = onInstant;
    this.info = null;
    this.visible = false;
    this.el = h('div', { class: 'selbar', role: 'toolbar', 'aria-label': t('sel.toolbar') });
    for (const a of ACTIONS) {
      const btn = h('button', { type: 'button', dataset: { act: a.act }, html: `${icon(a.icon)}<span>${t(`action.${a.act}`)}</span>` });
      btn.addEventListener('click', () => this.trigger(a.act));
      this.el.append(btn);
    }
    // Keep the selection alive when the bar is pressed.
    this.el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      clearTimeout(this.hideTimer);
    });
    this.el.addEventListener('mousedown', (e) => e.preventDefault());
    document.body.append(this.el);

    this.onSelChange = () => {
      clearTimeout(this.timer);
      // On touch screens a selection is adjusted by dragging its handles; give instant
      // translation a moment so it doesn't start on a half-made selection.
      const delay = isCoarse() ? (this.instant?.() ? 600 : 260) : 120;
      this.timer = setTimeout(() => this.update(), delay);
    };
    document.addEventListener('selectionchange', this.onSelChange);
    // A mouse selection is finished when the button comes up.
    this.onPointerDown = (e) => {
      if (e.pointerType === 'mouse' && e.button === 0) this.mouseDown = true;
    };
    this.onPointerUp = () => {
      if (!this.mouseDown) return;
      this.mouseDown = false;
      this.onSelChange();
    };
    document.addEventListener('pointerdown', this.onPointerDown, true);
    document.addEventListener('pointerup', this.onPointerUp, true);
    window.addEventListener('blur', this.onPointerUp);
    this.onScroll = () => {
      if (this.visible && this.el.classList.contains('floating')) this.position();
    };
    window.addEventListener('scroll', this.onScroll, true);
  }

  update() {
    if (this.mouseDown) return;
    const sel = document.getSelection();
    const text = sel && !sel.isCollapsed ? sel.toString() : '';
    let info = null;
    if (text.trim()) {
      try {
        info = this.describe(sel);
      } catch (err) {
        console.warn('describe selection failed', err);
        info = null;
      }
    }
    if (info && info.text) {
      this.info = info;
      if (this.instant?.()) {
        this.hide();
        this.onInstant?.(info);
        return;
      }
      this.show();
    } else {
      // Delay so a tap on the bar (which may clear the selection on iOS) still lands.
      clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => this.hide(), 320);
    }
  }

  show() {
    clearTimeout(this.hideTimer);
    const floating = !isCoarse();
    this.el.classList.toggle('floating', floating);
    if (floating) this.position();
    this.el.classList.add('show');
    if (!this.visible) {
      this.visible = true;
      this.onVisibility?.(true);
    }
  }

  position() {
    const rect = this.info?.rect;
    if (!rect) return;
    const sel = document.getSelection();
    const live = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : rect;
    const r = live.width || live.height ? live : rect;
    const bw = this.el.offsetWidth || 300;
    const bh = this.el.offsetHeight || 44;
    let top = r.top - bh - 10;
    if (top < 60) top = r.bottom + 10;
    const left = Math.max(8, Math.min(window.innerWidth - bw - 8, r.left + r.width / 2 - bw / 2));
    this.el.style.top = `${top}px`;
    this.el.style.left = `${left}px`;
  }

  hide() {
    this.el.classList.remove('show');
    if (this.visible) {
      this.visible = false;
      this.onVisibility?.(false);
    }
  }

  trigger(act) {
    const info = this.info;
    if (!info) return;
    this.onAction(act, info);
    if (act !== 'copy') {
      document.getSelection()?.removeAllRanges();
      this.hide();
    }
  }

  setOffset(px) {
    this.el.style.setProperty('--sel-offset', `${px}px`);
  }

  destroy() {
    clearTimeout(this.timer);
    clearTimeout(this.hideTimer);
    document.removeEventListener('selectionchange', this.onSelChange);
    document.removeEventListener('pointerdown', this.onPointerDown, true);
    document.removeEventListener('pointerup', this.onPointerUp, true);
    window.removeEventListener('blur', this.onPointerUp);
    window.removeEventListener('scroll', this.onScroll, true);
    this.el.remove();
  }
}
