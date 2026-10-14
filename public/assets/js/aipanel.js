import { api, getSettings } from './api.js';
import {
  buildSystem,
  followUpText,
  imageMessage,
  newThread,
  quoteMessage,
  runTurn,
} from './ai.js';
import { renderMarkdown } from './markdown.js';
import { icon } from './icons.js';
import { confirmDialog, copyText, h, iconButton, isWide, timeAgo, toast } from './ui.js';
// `t` is used for threads throughout this file, so the translator is `tr`.
import { formatLocation, t as tr } from './i18n.js';

const KIND_ICON = { translate: 'translate', explain: 'bulb', ask: 'message', chat: 'sparkles', image: 'scan' };

// Markdown/LaTeX markers are noise in one-line previews.
function plainText(md = '') {
  return md
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>|$\\]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
const HEIGHTS = [0.45, 0.62, 0.92];

export class AiPanel {
  // host: the reader root. getView(): current PdfView/HtmlView.
  constructor({ paper, host, getView, onOpenChange, onHeightChange, openSettings, jumpTo }) {
    Object.assign(this, { paper, host, getView, onOpenChange, onHeightChange, openSettings, jumpTo });
    this.thread = null;
    this.view = 'history';
    this.isOpen = false;
    this.controller = null;
    this.heightFrac = HEIGHTS[1];
    this.threadCount = 0;
    this.build();
  }

  build() {
    this.titleEl = h('div', { class: 'title' });
    this.historyBtn = iconButton('clock', { title: tr('reader.history'), onClick: () => this.showHistory() });
    this.newChatBtn = iconButton('sparkles', { title: tr('reader.askPaper'), onClick: () => this.startChat() });
    this.closeBtn = iconButton('close', { title: tr('common.close'), onClick: () => this.close() });
    this.handle = h('div', { class: 'sheet-handle', 'aria-hidden': 'true' });
    this.head = h('div', { class: 'ai-head' }, this.titleEl, this.newChatBtn, this.historyBtn, this.closeBtn);
    this.body = h('div', { class: 'ai-body' });
    this.quickRow = h('div', { class: 'quick-row' });
    this.input = h('textarea', { rows: '1', placeholder: tr('ai.followUp'), enterkeyhint: 'send', 'aria-label': tr('ai.input') });
    this.sendBtn = h('button', { class: 'send-btn', type: 'button', 'aria-label': tr('ai.send'), html: icon('send', 19) });
    this.composer = h('div', { class: 'composer' }, this.input, this.sendBtn);
    this.foot = h('div', { class: 'ai-foot' }, this.quickRow, this.composer);
    this.el = h('aside', { class: 'ai-panel', 'aria-label': tr('ai.panel') }, this.handle, this.head, this.body, this.foot);
    this.host.append(this.el);

    this.input.addEventListener('input', () => this.autosize());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !('ontouchstart' in window)) {
        e.preventDefault();
        this.submit();
      }
    });
    this.input.addEventListener('focus', () => {
      if (!isWide()) this.setHeight(HEIGHTS[2]);
    });
    this.sendBtn.addEventListener('click', () => (this.controller ? this.stop() : this.submit()));
    this.setupDrag();
    this.applyHeight();
  }

  // ---- sheet geometry (phones) ----

  applyHeight() {
    const px = Math.round(window.innerHeight * this.heightFrac);
    this.el.style.setProperty('--sheet-h', `${px}px`);
    this.notifyHeight();
  }

  notifyHeight() {
    const visible = this.isOpen && !isWide();
    this.onHeightChange?.(visible ? Math.round(window.innerHeight * this.heightFrac) : 0);
  }

  setHeight(frac) {
    this.heightFrac = frac;
    this.applyHeight();
  }

  setupDrag() {
    let startY = 0;
    let startH = 0;
    let dragging = false;
    const onMove = (e) => {
      if (!dragging) return;
      const dy = e.clientY - startY;
      const hpx = Math.max(80, Math.min(window.innerHeight * 0.94, startH - dy));
      this.el.style.setProperty('--sheet-h', `${hpx}px`);
    };
    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      this.el.classList.remove('dragging');
      const frac = (startH - (e.clientY - startY)) / window.innerHeight;
      if (frac < 0.3) {
        this.close();
        this.heightFrac = HEIGHTS[1];
        this.applyHeight();
        return;
      }
      const nearest = HEIGHTS.reduce((a, b) => (Math.abs(b - frac) < Math.abs(a - frac) ? b : a));
      this.setHeight(nearest);
    };
    const onDown = (e) => {
      if (isWide() || e.target.closest('button')) return;
      dragging = true;
      startY = e.clientY;
      startH = this.el.getBoundingClientRect().height;
      this.el.classList.add('dragging');
      e.currentTarget.setPointerCapture?.(e.pointerId);
    };
    for (const zone of [this.handle, this.head]) {
      zone.addEventListener('pointerdown', onDown);
      zone.addEventListener('pointermove', onMove);
      zone.addEventListener('pointerup', onUp);
      zone.addEventListener('pointercancel', onUp);
    }
    window.addEventListener('resize', (this.onResize = () => this.applyHeight()));
  }

  // ---- open / close ----

  open() {
    if (!this.isOpen) {
      this.isOpen = true;
      this.el.classList.add('open');
      this.onOpenChange?.(true);
      this.notifyHeight();
    }
    if (!this.thread && this.view !== 'history') this.showHistory();
  }

  toggle() {
    if (this.isOpen) this.close();
    else {
      this.open();
      if (!this.thread) this.showHistory();
    }
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.classList.remove('open');
    this.input.blur();
    this.onOpenChange?.(false);
    this.notifyHeight();
  }

  autosize() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(140, this.input.scrollHeight + 2)}px`;
    this.updateSendState();
  }

  updateSendState() {
    if (this.controller) {
      this.sendBtn.classList.add('stop');
      this.sendBtn.innerHTML = icon('stop', 18);
      this.sendBtn.disabled = false;
      this.sendBtn.setAttribute('aria-label', tr('ai.stop'));
    } else {
      this.sendBtn.classList.remove('stop');
      this.sendBtn.innerHTML = icon('send', 19);
      this.sendBtn.disabled = !this.input.value.trim();
      this.sendBtn.setAttribute('aria-label', tr('ai.send'));
    }
  }

  // ---- starting threads ----

  async prefs() {
    return (await getSettings()).prefs;
  }

  async startQuote(action, info) {
    if (this.controller) this.stop();
    const prefs = await this.prefs();
    const context = info.getContext ? await info.getContext().catch(() => '') : info.context || '';
    const quote = { text: info.text, context, location: info.location || null };
    this.thread = newThread({ paper: this.paper, kind: 'quote', action, quote, system: buildSystem(this.paper, prefs) });
    this.view = 'thread';
    this.open();
    if (action === 'ask') {
      this.render();
      this.input.placeholder = tr('ai.askQuote');
      this.input.focus();
      return;
    }
    this.render();
    await this.send({ action, content: quoteMessage(action, quote, prefs), isAction: true });
  }

  async startImage(action, image) {
    if (this.controller) this.stop();
    const prefs = await this.prefs();
    const quote = {
      text: image.text || '',
      caption: image.caption || '',
      image: { mediaType: image.mediaType, data: image.data, width: image.width, height: image.height },
      location: image.location || null,
    };
    // 'pick' shows the screenshot and lets the user choose an action or type a question.
    const first = action === 'pick' ? 'ask' : action;
    this.thread = newThread({ paper: this.paper, kind: 'image', action: first, quote, system: buildSystem(this.paper, prefs) });
    this.view = 'thread';
    this.open();
    this.input.placeholder = tr('ai.askImage');
    this.render();
    if (action === 'ask' || action === 'pick') {
      if (action === 'ask') this.input.focus();
      return;
    }
    await this.send({ action, content: imageMessage(action, quote, prefs), isAction: true });
  }

  async startChat() {
    if (this.controller) this.stop();
    const prefs = await this.prefs();
    this.thread = newThread({ paper: this.paper, kind: 'chat', action: 'chat', quote: null, system: '' });
    this.view = 'thread';
    this.open();
    this.render();
    this.input.placeholder = tr('ai.askPaper');
    if (isWide()) this.input.focus();
    this.thread.pendingFullText = this.loadFullText(prefs);
  }

  async loadFullText(prefs) {
    const view = this.getView();
    if (!view) return { text: '', truncated: false };
    try {
      return await view.getFullText(prefs.fullTextLimit || 120000);
    } catch {
      return { text: '', truncated: false };
    }
  }

  // ---- sending ----

  async submit() {
    const text = this.input.value.trim();
    if (!text || this.controller || !this.thread) return;
    this.input.value = '';
    this.autosize();
    const prefs = await this.prefs();
    const t = this.thread;
    const first = !t.messages.length;
    if (t.kind === 'quote' && first) {
      await this.send({ action: 'ask', content: quoteMessage('ask', t.quote, prefs, text), display: text });
    } else if (t.kind === 'image' && first) {
      await this.send({ action: 'ask', content: imageMessage('ask', t.quote, prefs, text), display: text });
    } else if (t.kind === 'chat' && first) {
      const full = await (t.pendingFullText || this.loadFullText(prefs));
      delete t.pendingFullText;
      t.system = buildSystem(this.paper, prefs, { fullText: full.text, truncated: full.truncated });
      t.truncated = full.truncated;
      t.title = text.slice(0, 60);
      await this.send({ action: 'chat', content: text, display: text });
    } else {
      await this.send({ action: t.kind === 'chat' ? 'chat' : 'ask', content: text, display: text });
    }
  }

  async quick(action) {
    const t = this.thread;
    if (!t || this.controller) return;
    const prefs = await this.prefs();
    if (!t.messages.length) {
      // A thread opened with "ask" but no question yet: run the action as its first turn.
      const content = t.kind === 'image' ? imageMessage(action, t.quote, prefs) : quoteMessage(action, t.quote, prefs);
      t.action = action;
      await this.send({ action, content, isAction: true });
      return;
    }
    await this.send({ action, content: followUpText(action, prefs, t.kind === 'image'), isAction: true });
  }

  async send({ action, content, display, isAction = false }) {
    const t = this.thread;
    const user = { role: 'user', content, display, isAction: isAction || undefined, action, at: new Date().toISOString() };
    const reply = { role: 'assistant', content: '', pending: true };
    t.messages.push(user, reply);
    await this.runReply(user, reply, action);
  }

  async runReply(user, reply, action) {
    const t = this.thread;
    const controller = new AbortController();
    this.controller = controller;
    this.updateSendState();
    this.render();
    let frame = 0;
    await runTurn(t, reply, {
      action,
      signal: controller.signal,
      onUpdate: () => {
        if (this.thread !== t) return;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => this.renderMessage(reply));
      },
    });
    cancelAnimationFrame(frame);
    if (reply.error) user.failed = true;
    else delete user.failed;
    // The user may have moved to another thread meanwhile; only clear our own controller.
    if (this.controller === controller) this.controller = null;
    if (this.thread === t) this.render();
    else this.updateSendState();
    if (reply.errorCode === 'no_key' || reply.errorCode === 'no_model' || reply.errorCode === 'no_base_url') {
      toast(tr('ai.configureFirst'));
    }
    if (!reply.error || t.messages.some((m) => m.role === 'assistant' && !m.error)) this.persist(t);
  }

  stop() {
    this.controller?.abort();
  }

  async retry(reply) {
    const t = this.thread;
    const i = t.messages.indexOf(reply);
    const user = t.messages[i - 1];
    if (!user || this.controller) return;
    t.messages.splice(i, 1);
    delete user.failed;
    const fresh = { role: 'assistant', content: '', pending: true };
    t.messages.splice(i, 0, fresh);
    await this.runReply(user, fresh, user.action || 'ask');
  }

  async persist(t) {
    try {
      const { pendingFullText, ...clean } = t;
      const res = await api.saveThread(this.paper.id, clean);
      t.updatedAt = res.updatedAt;
      if (!t.saved) {
        t.saved = true;
        this.threadCount += 1;
        this.onCountChange?.(this.threadCount);
      }
    } catch (err) {
      toast(tr('ai.saveFailed', { msg: err.message }), { type: 'error' });
    }
  }

  // ---- rendering ----

  setTitle(iconName, text, extra) {
    this.titleEl.innerHTML = '';
    this.titleEl.insertAdjacentHTML('beforeend', icon(iconName));
    this.titleEl.append(h('span', { text }));
    if (extra) this.titleEl.append(h('span', { class: 'model', text: extra }));
  }

  render() {
    if (this.view === 'history') return this.renderHistory();
    const t = this.thread;
    if (!t) return this.renderHistory();
    const titleIcon = { translate: 'translate', explain: 'bulb', ask: 'message', chat: 'sparkles' }[t.action] || 'sparkles';
    const lastModel = [...t.messages].reverse().find((m) => m.model)?.model;
    const titleText = t.kind === 'chat' ? tr('action.chat') : t.kind === 'image' ? tr('action.image') : tr(`action.${t.action}`);
    this.setTitle(t.kind === 'image' ? 'scan' : titleIcon, titleText, lastModel || '');
    this.body.replaceChildren();
    this.msgEls = new Map();

    if (t.quote) this.body.append(this.renderQuote(t));
    if (t.kind === 'chat' && !t.messages.length) {
      this.body.append(
        h(
          'div',
          { class: 'ai-intro' },
          h('div', { text: tr('ai.chatIntro') }),
          h('ul', {}, h('li', { text: tr('ai.chatEx1') }), h('li', { text: tr('ai.chatEx2') }), h('li', { text: tr('ai.chatEx3') })),
        ),
      );
    }
    if (t.truncated) this.body.append(h('div', { class: 'notice', text: tr('ai.truncated') }));
    for (const m of t.messages) {
      if (m.role === 'user') {
        this.body.append(
          m.isAction ? h('div', { class: 'msg-action', text: tr(`action.${m.action}`) }) : h('div', { class: 'msg-user', text: m.display || '' }),
        );
      } else {
        const el = h('div', { class: 'msg-ai' });
        this.msgEls.set(m, el);
        this.body.append(el);
        this.renderMessage(m);
      }
    }
    this.renderQuick();
    if (t.messages.length) this.body.scrollTop = this.body.scrollHeight;
    this.input.placeholder = t.messages.length ? tr('ai.followUp') : this.input.placeholder;
    this.foot.hidden = false;
    this.updateSendState();
  }

  renderQuote(t) {
    const q = t.quote;
    const wrap = h('div', { class: 'quote' });
    if (q.image) {
      wrap.append(h('img', { src: `data:${q.image.mediaType};base64,${q.image.data}`, alt: tr('ai.screenshot') }));
    }
    if (q.text && !q.image) {
      const text = h('div', { class: 'quote-text', text: q.text });
      wrap.append(text);
      wrap.addEventListener('click', () => wrap.classList.toggle('expanded'));
    }
    const meta = h('div', { class: 'quote-meta' });
    const where = formatLocation(q.location);
    if (where) meta.append(h('span', { text: where }));
    if (q.location && (q.location.page || q.location.anchorId)) {
      const jump = h('button', { type: 'button', html: `${icon('undo', 14)}<span>${tr('ai.backToSource')}</span>` });
      jump.addEventListener('click', (e) => {
        e.stopPropagation();
        this.jumpTo?.(q.location);
        if (!isWide()) this.setHeight(HEIGHTS[0]);
      });
      meta.append(jump);
    }
    if (meta.childNodes.length) wrap.append(meta);
    return wrap;
  }

  renderMessage(m) {
    const el = this.msgEls?.get(m);
    if (!el) return;
    const stick = this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight < 80;
    el.replaceChildren();
    if (m.notice) el.append(h('div', { class: 'notice', text: m.notice }));
    if (m.pending && !m.content) {
      el.append(
        h(
          'div',
          { class: 'thinking' },
          h('span', { class: 'dots', html: '<i></i><i></i><i></i>' }),
          h('span', { text: m.status === 'thinking' ? tr('ai.thinking') : tr('ai.waiting') }),
        ),
      );
    }
    if (m.content) {
      const md = h('div', { class: `md${m.pending ? ' streaming' : ''}`, html: renderMarkdown(m.content) });
      el.append(md);
    }
    if (m.error) {
      const box = h('div', { class: 'msg-error', text: m.error });
      if (['no_key', 'no_model', 'no_base_url'].includes(m.errorCode)) {
        box.append(h('div', {}, h('button', { class: 'btn btn-sm btn-secondary', onClick: () => this.openSettings?.() }, tr('ai.openSettings'))));
      } else if (m.errorCode !== 'refusal' && !m.stopped) {
        box.append(h('div', {}, h('button', { class: 'btn btn-sm btn-secondary', onClick: () => this.retry(m) }, tr('common.retry'))));
      }
      el.append(box);
    }
    if (!m.pending && m.content) {
      const tools = h('div', { class: 'msg-tools' });
      tools.append(
        h('button', {
          type: 'button',
          html: `${icon('copy')}<span>${tr('common.copy')}</span>`,
          onClick: async () => toast((await copyText(m.content)) ? tr('common.copied') : tr('common.copyFailed')),
        }),
      );
      const last = this.thread?.messages[this.thread.messages.length - 1] === m;
      if (last && !this.controller) {
        tools.append(h('button', { type: 'button', html: `${icon('refresh')}<span>${tr('ai.regenerate')}</span>`, onClick: () => this.retry(m) }));
      }
      el.append(tools);
      if (m.stopReason === 'max_tokens') el.append(h('div', { class: 'msg-note', text: tr('ai.cutOff') }));
      if (m.stopped) el.append(h('div', { class: 'msg-note', text: tr('ai.stopped') }));
    }
    if (stick || m.pending) this.body.scrollTop = this.body.scrollHeight;
  }

  renderQuick() {
    const t = this.thread;
    this.quickRow.replaceChildren();
    if (!t || t.kind === 'chat') {
      this.quickRow.hidden = true;
      return;
    }
    const acts = ['translate', 'explain'];
    for (const a of acts) {
      const chip = h('button', { class: 'chip', type: 'button', html: `${icon(KIND_ICON[a])}<span>${tr(`action.${a}`)}</span>` });
      chip.disabled = !!this.controller;
      chip.addEventListener('click', () => this.quick(a));
      this.quickRow.append(chip);
    }
    this.quickRow.hidden = false;
  }

  async showHistory() {
    if (this.controller) this.stop();
    this.view = 'history';
    this.thread = null;
    this.open();
    this.renderHistory();
  }

  async renderHistory() {
    this.setTitle('clock', tr('reader.history'));
    this.foot.hidden = true;
    this.body.replaceChildren(
      h(
        'div',
        { class: 'hist-new' },
        h('button', { class: 'chip', type: 'button', html: `${icon('sparkles')}<span>${tr('reader.askPaper')}</span>`, onClick: () => this.startChat() }),
      ),
      h('div', { class: 'hint', text: tr('ai.historyHint') }),
    );
    const list = h('div', { class: 'hist-list' }, h('div', { class: 'skeleton', style: { height: '56px' } }));
    this.body.append(list);
    let threads = [];
    try {
      threads = (await api.listThreads(this.paper.id)).threads;
    } catch (err) {
      list.replaceChildren(h('div', { class: 'hist-empty', text: tr('common.loadFailed', { msg: err.message }) }));
      return;
    }
    if (this.view !== 'history') return;
    this.threadCount = threads.length;
    this.onCountChange?.(this.threadCount);
    if (!threads.length) {
      list.replaceChildren(h('div', { class: 'hist-empty', text: tr('ai.noHistory') }));
      return;
    }
    list.replaceChildren();
    for (const t of threads) {
      const kindIcon = t.hasImage ? KIND_ICON.image : KIND_ICON[t.kind === 'chat' ? 'chat' : t.action] || KIND_ICON.ask;
      const where = formatLocation(t.location);
      const main = h(
        'div',
        { class: 'hist-main' },
        h('div', { class: 'hist-q', text: t.kind === 'chat' ? t.title || tr('action.chat') : t.quote || (t.hasImage ? tr('ai.screenshot') : t.title) }),
        h('div', {
          class: 'hist-a',
          text: [timeAgo(t.updatedAt), where, t.turns > 1 ? tr('ai.turns', { n: t.turns }) : '', plainText(t.preview)].filter(Boolean).join(' · '),
        }),
      );
      const del = iconButton('trash', { title: tr('ai.deleteRecord') });
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!(await confirmDialog({ title: tr('ai.deleteRecordTitle'), okText: tr('common.delete'), danger: true }))) return;
        try {
          await api.deleteThread(this.paper.id, t.id);
          item.remove();
          this.threadCount = Math.max(0, this.threadCount - 1);
          this.onCountChange?.(this.threadCount);
        } catch (err) {
          toast(err.message, { type: 'error' });
        }
      });
      const item = h('div', { class: 'hist-item', role: 'button', tabindex: '0' }, h('div', { class: 'hist-kind', html: icon(kindIcon) }), main, del);
      item.addEventListener('click', () => this.openThread(t.id));
      list.append(item);
    }
  }

  async openThread(tid) {
    try {
      const { thread } = await api.getThread(this.paper.id, tid);
      thread.saved = true;
      for (const m of thread.messages) {
        if (m.pending) {
          m.pending = false;
          if (!m.content) m.error = tr('ai.unfinished');
        }
      }
      this.thread = thread;
      this.view = 'thread';
      this.open();
      this.render();
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
  }

  destroy() {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    this.el.remove();
  }
}
