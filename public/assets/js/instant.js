// "Translate on select": selecting text in the paper opens a popup that streams its
// translation. Nothing is saved unless the user carries on in the AI panel.
import { cachedSettings, getSettings } from './api.js';
import { buildSystem, newThread, quoteMessage, runTurn } from './ai.js';
import { renderMarkdown } from './markdown.js';
import { canSwitchProvider, openProviderMenu } from './providers.js';
import { copyText, h, iconButton, iconEl, isCoarse, toast } from './ui.js';
import { t } from './i18n.js';

// Longer selections (e.g. select-all by accident) wait for a tap instead of starting a request.
const AUTO_LIMIT = 3000;
const CACHE_SIZE = 30;
const CONFIG_ERRORS = ['no_key', 'no_model', 'no_base_url'];

export class InstantTranslate {
  // onAction(act, info): explain / ask in the AI panel. onContinue(thread): follow up there.
  constructor({ paper, onAction, onContinue, onVisibility, openSettings }) {
    Object.assign(this, { paper, onAction, onContinue, onVisibility, openSettings });
    this.cache = new Map();
    this.offset = 0;
    this.el = null;
  }

  get isOpen() {
    return !!this.el;
  }

  show(info) {
    // The same selection settling again (e.g. after a tap on the popup): nothing new to do.
    if (this.el && this.info?.text === info.text) {
      this.info = info;
      this.position();
      return;
    }
    this.stop();
    this.info = info;
    this.open();
    const cached = this.cache.get(this.cacheKey(info.text));
    this.thread = cached || null;
    if (cached || info.text.length > AUTO_LIMIT) this.render();
    else this.run();
  }

  cacheKey(text) {
    const prefs = cachedSettings()?.prefs || {};
    return JSON.stringify([prefs.targetLang, prefs.prompts?.translate || '', text]);
  }

  remember(text, thread) {
    const key = this.cacheKey(text);
    this.cache.delete(key);
    this.cache.set(key, thread);
    if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value);
  }

  async run() {
    this.stop();
    const info = this.info;
    if (!info) return;
    const controller = new AbortController();
    this.controller = controller;
    const prefs = (await getSettings()).prefs;
    const context = info.getContext ? await info.getContext().catch(() => '') : info.context || '';
    if (controller.signal.aborted || this.info !== info) return;
    const quote = { text: info.text, context, location: info.location || null };
    const thread = newThread({ paper: this.paper, kind: 'quote', action: 'translate', quote, system: buildSystem(this.paper, prefs) });
    const user = { role: 'user', content: quoteMessage('translate', quote, prefs), isAction: true, action: 'translate', at: new Date().toISOString() };
    const reply = { role: 'assistant', content: '', pending: true };
    thread.messages.push(user, reply);
    this.thread = thread;
    this.render();
    let frame = 0;
    await runTurn(thread, reply, {
      action: 'translate',
      signal: controller.signal,
      onUpdate: () => {
        if (this.thread !== thread) return;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => this.render());
      },
    });
    cancelAnimationFrame(frame);
    if (this.controller === controller) this.controller = null;
    if (reply.error) user.failed = true;
    else this.remember(info.text, thread);
    if (this.thread === thread) this.render();
  }

  stop() {
    this.controller?.abort();
    this.controller = null;
  }

  // ---- popup ----

  open() {
    if (this.el) return;
    this.modelEl = h('span', { class: 'model' });
    this.body = h('div', { class: 'instant-body' });
    this.foot = h('div', { class: 'instant-foot' });
    this.el = h(
      'div',
      { class: 'instant-pop', role: 'dialog', 'aria-label': t('action.translate') },
      h(
        'div',
        { class: 'instant-head' },
        h('span', { class: 'title' }, iconEl('translate'), h('span', { text: t('action.translate') }), this.modelEl),
        iconButton('close', { title: t('common.close'), onClick: () => this.close() }),
      ),
      this.body,
      this.foot,
    );
    // Keep the source text selected while the popup's buttons are used (mouse).
    this.el.addEventListener('mousedown', (e) => {
      if (!e.target.closest('.instant-body')) e.preventDefault();
    });
    // A plain tap elsewhere closes the popup; scrolling, a new selection, or menus and dialogs
    // opened from the popup (e.g. "switch provider") don't.
    this.onDown = (e) => {
      const inside = this.el?.contains(e.target) || e.target.closest?.('.menu, .menu-scrim, .dialog, .scrim, .modal');
      this.down = inside ? null : { x: e.clientX, y: e.clientY, at: Date.now() };
    };
    this.onUp = (e) => {
      const d = this.down;
      this.down = null;
      if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 10 && Date.now() - d.at < 450) this.close();
    };
    this.onKey = (e) => {
      if (e.key === 'Escape') this.close();
    };
    this.onScroll = () => this.position();
    document.addEventListener('pointerdown', this.onDown, true);
    document.addEventListener('pointerup', this.onUp, true);
    document.addEventListener('keydown', this.onKey);
    window.addEventListener('scroll', this.onScroll, true);
    window.addEventListener('resize', this.onScroll);
    document.body.append(this.el);
    this.onVisibility?.(true);
  }

  close() {
    this.stop();
    if (!this.el) return;
    document.removeEventListener('pointerdown', this.onDown, true);
    document.removeEventListener('pointerup', this.onUp, true);
    document.removeEventListener('keydown', this.onKey);
    window.removeEventListener('scroll', this.onScroll, true);
    window.removeEventListener('resize', this.onScroll);
    this.el.remove();
    this.el = null;
    this.info = null;
    this.thread = null;
    this.onVisibility?.(false);
  }

  setOffset(px) {
    this.offset = px;
    this.position();
  }

  // Phones: a card above the bottom edge. Larger screens: next to the selection.
  position() {
    const el = this.el;
    if (!el) return;
    const docked = isCoarse() || window.innerWidth < 640;
    el.classList.toggle('docked', docked);
    el.style.setProperty('--sel-offset', `${this.offset}px`);
    if (docked) {
      el.style.top = '';
      el.style.left = '';
      return;
    }
    let r = this.info?.rect;
    const sel = document.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const live = sel.getRangeAt(0).getBoundingClientRect();
      if (live.width || live.height) r = live;
    }
    if (!r) return;
    const w = el.offsetWidth;
    const ht = el.offsetHeight;
    let top = r.bottom + 10;
    if (top + ht > window.innerHeight - 10) top = r.top - ht - 10;
    top = Math.max(10, Math.min(top, window.innerHeight - ht - 10));
    const left = Math.max(10, Math.min(window.innerWidth - w - 10, r.left + r.width / 2 - w / 2));
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
  }

  render() {
    if (!this.el) return;
    const reply = this.thread?.messages[this.thread.messages.length - 1];
    this.modelEl.textContent = reply?.model || '';
    this.body.replaceChildren();
    if (!this.thread) {
      this.body.append(
        h('div', { class: 'instant-long', text: t('instant.long', { n: this.info.text.length }) }),
        h('button', { class: 'btn btn-sm btn-primary', type: 'button', text: t('action.translate'), onClick: () => this.run() }),
      );
    } else if (reply.pending && !reply.content) {
      this.body.append(
        h('div', { class: 'thinking' }, h('span', { class: 'dots', html: '<i></i><i></i><i></i>' }), h('span', { text: reply.status === 'thinking' ? t('ai.thinking') : t('ai.waiting') })),
      );
    }
    if (reply?.content) this.body.append(h('div', { class: `md${reply.pending ? ' streaming' : ''}`, html: renderMarkdown(reply.content) }));
    if (reply?.error) this.body.append(this.renderError(reply));
    this.renderFoot(reply);
    this.position();
  }

  renderError(reply) {
    const box = h('div', { class: 'msg-error', text: reply.error });
    const actions = h('div', { class: 'msg-error-actions' });
    if (CONFIG_ERRORS.includes(reply.errorCode)) {
      actions.append(h('button', { class: 'btn btn-sm btn-secondary', type: 'button', text: t('ai.openSettings'), onClick: () => this.openSettings?.() }));
    } else if (!reply.stopped) {
      actions.append(h('button', { class: 'btn btn-sm btn-secondary', type: 'button', text: t('common.retry'), onClick: () => this.run() }));
      if (canSwitchProvider()) {
        const btn = h('button', { class: 'btn btn-sm btn-secondary', type: 'button', text: t('ai.switchProvider') });
        btn.addEventListener('click', () => openProviderMenu(btn, { onSwitched: () => this.run(), openSettings: this.openSettings }));
        actions.append(btn);
      }
    }
    if (actions.childNodes.length) box.append(actions);
    return box;
  }

  renderFoot(reply) {
    const done = !!reply && !reply.pending && !reply.error && !!reply.content;
    const action = (name, label, onClick, enabled = true) => {
      const btn = h('button', { type: 'button' }, iconEl(name), h('span', { text: label }));
      btn.disabled = !enabled;
      btn.addEventListener('click', onClick);
      return btn;
    };
    this.foot.replaceChildren(
      action('bulb', t('action.explain'), () => this.handOff('explain')),
      action('message', t('action.ask'), () => this.handOff('ask')),
      action('copy', t('common.copy'), async () => toast((await copyText(reply.content)) ? t('common.copied') : t('common.copyFailed')), done),
      h('span', { class: 'grow' }),
      action('sparkles', t('instant.continue'), () => this.continueInPanel(), done),
    );
  }

  handOff(act) {
    const info = this.info;
    this.close();
    if (info) this.onAction?.(act, info);
  }

  // The panel gets its own copy: follow-ups there must not change the cached translation.
  continueInPanel() {
    const thread = structuredClone(this.thread);
    this.close();
    this.onContinue?.(thread);
  }

  destroy() {
    this.close();
  }
}
