import { api, getSettings } from './api.js';
import { AiPanel } from './aipanel.js';
import { startCapture } from './capture.js';
import { HtmlView } from './htmlview.js';
import { icon } from './icons.js';
import { InstantTranslate } from './instant.js';
import { PdfView } from './pdfview.js';
import { canSwitchProvider, openProviderMenu, usableProviders } from './providers.js';
import { SelectionBar } from './selection.js';
import { openSettings } from './settings.js';
import {
  applyTheme,
  closeMenus,
  copyText,
  debounce,
  h,
  iconButton,
  isCoarse,
  isDarkTheme,
  local,
  menuSwitch,
  openMenu,
  toast,
} from './ui.js';
import { t } from './i18n.js';

const THEMES = ['system', 'light', 'dark'];
const themeLabel = (name) => t(`theme.${name}`);

// Returns as soon as the shell is on screen; loading continues in the background so
// navigating away (e.g. back while a big PDF downloads) is never blocked.
export async function openReader(root, paperId) {
  const reader = new Reader(root, paperId);
  reader.init().catch((err) => {
    if (!reader.destroyed) reader.showError(err.message || String(err));
  });
  return reader;
}

// Downscales any image to PNG/JPEG base64 that vision models accept.
async function imageToBase64(src, maxSide = 1568) {
  const res = await fetch(src, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(t('reader.imageLoadFailed', { status: res.status }));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error(t('reader.imageDecodeFailed')));
      img.src = url;
    });
    let w = img.naturalWidth || 1200;
    let hgt = img.naturalHeight || 800;
    const k = Math.min(1, maxSide / Math.max(w, hgt));
    w = Math.max(1, Math.round(w * k));
    hgt = Math.max(1, Math.round(hgt * k));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = hgt;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, hgt);
    ctx.drawImage(img, 0, 0, w, hgt);
    let dataUrl = canvas.toDataURL('image/png');
    let mediaType = 'image/png';
    if (dataUrl.length > 1_800_000) {
      dataUrl = canvas.toDataURL('image/jpeg', 0.9);
      mediaType = 'image/jpeg';
    }
    return { mediaType, data: dataUrl.slice(dataUrl.indexOf(',') + 1), width: w, height: hgt };
  } finally {
    URL.revokeObjectURL(url);
  }
}

class Reader {
  constructor(root, paperId) {
    this.host = root;
    this.paperId = paperId;
    this.view = null;
    this.mode = null;
    this.htmlAvailable = false;
    this.lastScrollTop = 0;
    this.quietScrollUntil = 0;
    this.saveProgress = debounce(() => this.persistProgress(false), 1500);
    this.listeners = [];
    // Per-device reading options.
    this.tocPinned = local.get('tocPinned', false);
    this.barPinned = local.get('barPinned', false);
    this.instantOn = local.get('instantTranslate', false);
  }

  on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.listeners.push(() => target.removeEventListener(type, fn, opts));
  }

  buildShell() {
    this.titleEl = h('div', { class: 'title' });
    this.seg = h('div', { class: 'seg', role: 'tablist', hidden: true });
    this.segPdf = h('button', { type: 'button', role: 'tab', text: t('reader.pdf') });
    this.segHtml = h('button', { type: 'button', role: 'tab', text: t('reader.html') });
    this.segPdf.addEventListener('click', () => this.mode !== 'pdf' && this.setMode('pdf'));
    this.segHtml.addEventListener('click', () => this.mode !== 'html' && this.setMode('html'));
    this.seg.append(this.segPdf, this.segHtml);
    this.captureBtn = iconButton('scan', { title: t('reader.capture'), onClick: () => this.toggleCapture() });
    this.captureBtn.hidden = true;
    this.tocBtn = iconButton('list', { title: t('reader.toc'), onClick: () => this.openToc() });
    this.moreBtn = iconButton('more', { title: t('common.more'), onClick: () => this.openMore() });
    this.topbar = h(
      'header',
      { class: 'topbar' },
      iconButton('back', { title: t('common.back'), onClick: () => (location.hash = '#/') }),
      this.titleEl,
      this.seg,
      this.captureBtn,
      this.tocBtn,
      this.moreBtn,
    );
    this.viewHost = h('div', { class: 'view-host' });
    this.loading = h('div', { class: 'reader-loading', hidden: true });
    this.pill = h('div', { class: 'page-pill', 'aria-hidden': 'true' });
    this.badge = h('span', { class: 'badge', hidden: true });
    this.fab = h('button', { class: 'fab', type: 'button', 'aria-label': t('reader.ai'), html: icon('sparkles') }, this.badge);
    this.fab.addEventListener('click', () => this.panel?.toggle());
    this.stage = h('div', { class: 'reader-stage' }, this.viewHost, this.topbar, this.loading, this.pill, this.fab);
    this.root = h('div', { class: `reader${this.tocPinned ? ' toc-pinned' : ''}` }, this.stage);
    this.host.append(this.root);
    // The pinned contents frame is there from the start; it fills in once the paper opens.
    if (this.tocPinned) this.renderTocSide();
  }

  async init() {
    this.buildShell();
    this.showLoading(t('reader.opening'));
    try {
      this.paper = (await api.getPaper(this.paperId)).paper;
    } catch (err) {
      if (!this.destroyed) this.showError(err.message);
      return;
    }
    if (this.destroyed) return;
    api.patchPaper(this.paperId, { opened: true }).catch(() => {});
    this.settings = await getSettings().catch(() => ({ prefs: {} }));
    if (this.destroyed) return;
    this.titleEl.textContent = this.paper.title;
    document.title = `${this.paper.title} · ${t('app.name')}`;

    this.panel = new AiPanel({
      paper: this.paper,
      host: this.root,
      getView: () => this.view,
      onOpenChange: (open) => {
        this.root.classList.toggle('panel-open', open);
        if (open) this.setChrome(true);
      },
      onHeightChange: (px) => {
        this.selbar?.setOffset(px);
        this.instant?.setOffset(px);
      },
      openSettings: () => openSettings({ section: 'ai' }),
      jumpTo: (loc) => this.jumpToLocation(loc),
    });
    this.panel.onCountChange = (n) => this.updateBadge(n);
    this.instant = new InstantTranslate({
      paper: this.paper,
      onAction: (act, info) => this.panel.startQuote(act, info),
      onContinue: (thread) => this.panel.adoptThread(thread),
      onVisibility: (v) => this.root.classList.toggle('selecting', v),
      openSettings: () => openSettings({ section: 'ai' }),
    });
    this.selbar = new SelectionBar({
      describe: (sel) => (this.capture ? null : this.view?.describeSelection(sel) || null),
      onAction: (act, info) => this.onSelectionAction(act, info),
      onVisibility: (v) => this.root.classList.toggle('selecting', v),
      instant: () => this.instantOn,
      onInstant: (info) => this.instant.show(info),
    });
    // The same options can be changed in Settings while a paper is open.
    this.on(document, 'readerprefs', () => {
      this.setBarPinned(local.get('barPinned', false), { save: false });
      this.setInstant(local.get('instantTranslate', false), { save: false });
    });
    this.on(window, 'resize', () => this.scheduleTocCurrent());

    this.pdfInvert = local.get('pdfInvert', true);
    this.on(document, 'themechange', () => this.updateInvert());
    this.on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.persistProgress(true);
    });
    this.on(window, 'pagehide', () => this.persistProgress(true));
    this.on(document, 'keydown', (e) => this.onKey(e));
    // iOS: keep two-finger gestures from zooming the whole app.
    this.on(document, 'gesturestart', (e) => e.preventDefault());

    const isArxiv = this.paper.source === 'arxiv';
    this.htmlAvailable = isArxiv && this.paper.html?.status !== 'none';
    let mode = this.paper.progress?.mode;
    if (mode === 'html' && !this.htmlAvailable) mode = 'pdf';
    if (!mode) mode = this.htmlAvailable && this.settings.prefs?.preferHtml !== false ? 'html' : 'pdf';
    await this.setMode(mode, { initial: true });

    api
      .listThreads(this.paperId)
      .then(({ threads }) => {
        this.panel.threadCount = threads.length;
        this.updateBadge(threads.length);
      })
      .catch(() => {});
  }

  updateBadge(n) {
    this.badge.hidden = !n;
    this.badge.textContent = n > 99 ? '99+' : String(n);
  }

  // ---- modes ----

  updateModeUi() {
    this.seg.hidden = !this.htmlAvailable;
    this.segPdf.classList.toggle('on', this.mode === 'pdf');
    this.segHtml.classList.toggle('on', this.mode === 'html');
    this.segPdf.setAttribute('aria-selected', String(this.mode === 'pdf'));
    this.segHtml.setAttribute('aria-selected', String(this.mode === 'html'));
    this.captureBtn.hidden = this.mode !== 'pdf';
    this.updateInvert();
  }

  updateInvert() {
    this.root.classList.toggle('pdf-invert', this.mode === 'pdf' && this.pdfInvert && isDarkTheme());
  }

  async setMode(mode, { initial = false } = {}) {
    if (this.switching) return;
    this.switching = true;
    this.capture?.cancel();
    this.closePeek();
    this.instant?.close();
    this.backChip?.remove();
    this.tocItems = null;
    this.tocSide?.querySelector('.drawer-body')?.replaceChildren();
    clearTimeout(this.pillTimer);
    this.pill.classList.remove('show');
    this.persistProgress(false);
    const prev = this.view;
    this.view = null;
    prev?.destroy();
    this.mode = mode;
    this.updateModeUi();
    this.lastScrollTop = 0;
    this.quietScrollUntil = Date.now() + 60_000;
    this.setChrome(true);
    this.showLoading(mode === 'pdf' ? t('reader.openingPdf') : t('reader.openingHtml'));
    const saved = this.paper.progress?.[mode];
    const common = {
      paper: this.paper,
      host: this.viewHost,
      onScroll: (top) => this.handleScroll(top),
      onTap: () => this.setChrome(this.root.classList.contains('chrome-hidden')),
      onJump: (back) => this.showBackChip(back),
    };
    let view;
    try {
      if (mode === 'pdf') {
        view = new PdfView({
          ...common,
          onPageChange: (n, total) => this.showPage(n, total),
          onViewChange: () => this.saveProgress(),
          onInternalLink: (dest) => this.previewDest(dest),
          onProgress: (f) => this.setLoadingProgress(f),
        });
      } else {
        view = new HtmlView({
          ...common,
          onPeek: (info) => this.showPeek(info),
          onImage: (img, caption) => this.openLightbox(img, caption),
        });
      }
      await view.open(saved);
      if (this.destroyed) {
        view.destroy();
        return;
      }
      this.view = view;
      this.hideLoading();
      this.quietScrollUntil = Date.now() + 1200;
      this.paper.progress = { ...(this.paper.progress || {}), mode };
      if (this.tocPinned) this.renderTocSide();
      if (mode === 'pdf') this.afterPdfOpen(view);
      if (mode === 'html' && !initial) this.saveProgress();
    } catch (err) {
      view?.destroy();
      this.switching = false;
      if (this.destroyed) return;
      if (mode === 'html') {
        this.htmlAvailable = false;
        if (!initial) toast(err.status === 404 ? t('reader.noHtml') : t('reader.htmlFailed', { msg: err.message }));
        return this.setMode('pdf', { initial });
      }
      this.showError(t('reader.pdfFailed', { msg: err.message || err }), () => this.setMode('pdf'));
      return;
    }
    this.switching = false;
  }

  async afterPdfOpen(view) {
    const pdfTip = !local.get('tip.pdf') && isCoarse();
    if (pdfTip) {
      local.set('tip.pdf', true);
      this.showTip(t('reader.tip'));
    }
    try {
      if (['filename', 'id'].includes(this.paper.titleSource)) {
        const title = await view.guessTitle();
        if (title && this.view === view) {
          this.paper.title = title;
          this.paper.titleSource = 'pdf';
          this.titleEl.textContent = title;
          document.title = `${title} · ${t('app.name')}`;
          api.patchPaper(this.paperId, { title, titleSource: 'pdf' }).catch(() => {});
        }
      }
      if (!this.paper.abstract) {
        const abstract = await view.guessAbstract();
        if (abstract) {
          this.paper.abstract = abstract;
          api.patchPaper(this.paperId, { abstract }).catch(() => {});
        }
      }
    } catch {
      // best effort only
    }
  }

  // ---- chrome, loading, progress ----

  setChrome(visible) {
    if (!visible && this.barPinned) return;
    this.root.classList.toggle('chrome-hidden', !visible);
  }

  setBarPinned(on, { save = true } = {}) {
    this.barPinned = on;
    if (save) local.set('barPinned', on);
    if (on) this.setChrome(true);
  }

  setInstant(on, { save = true } = {}) {
    if (on && save && !this.instantOn) toast(t('reader.instantOn'));
    this.instantOn = on;
    if (save) local.set('instantTranslate', on);
    if (!on) this.instant?.close();
  }

  handleScroll(top) {
    const d = top - this.lastScrollTop;
    this.lastScrollTop = top;
    // Programmatic scrolls (restoring the position, jumps) shouldn't hide the toolbar.
    if (!this.panel?.isOpen && Date.now() > this.quietScrollUntil) {
      if (top < 60) this.setChrome(true);
      else if (d > 10) this.setChrome(false);
      else if (d < -14) this.setChrome(true);
    }
    this.scheduleTocCurrent();
    this.saveProgress();
  }

  showPage(n, total) {
    this.scheduleTocCurrent();
    this.pill.textContent = `${n} / ${total}`;
    this.pill.classList.add('show');
    clearTimeout(this.pillTimer);
    this.pillTimer = setTimeout(() => this.pill.classList.remove('show'), 1400);
  }

  showLoading(text) {
    this.loading.hidden = false;
    this.loadingBar = h('div');
    this.loading.replaceChildren(
      h('div', { class: 'box' }, h('div', { class: 'spinner' }), h('div', { text }), h('div', { class: 'bar' }, this.loadingBar)),
    );
  }

  setLoadingProgress(f) {
    if (this.loadingBar) this.loadingBar.style.width = `${Math.round(Math.min(1, f) * 100)}%`;
  }

  hideLoading() {
    this.loading.hidden = true;
  }

  showError(message, retry) {
    this.hideLoading();
    const box = h('div', { class: 'reader-error' }, h('div', {}, h('p', { text: message })));
    const actions = h('div', { style: { display: 'flex', gap: '10px', justifyContent: 'center' } });
    actions.append(h('button', { class: 'btn btn-secondary btn-sm', onClick: () => (location.hash = '#/') }, t('common.back')));
    if (retry) {
      actions.append(
        h('button', {
          class: 'btn btn-primary btn-sm',
          onClick: () => {
            box.remove();
            retry();
          },
        }, t('common.retry')),
      );
    }
    box.firstChild.append(actions);
    this.stage.append(box);
  }

  persistProgress(keepalive) {
    this.saveProgress.cancel?.();
    if (!this.view || !this.paper) return;
    const p = this.view.getProgress();
    if (!p) return;
    const progress = { mode: this.mode, [this.mode]: p };
    this.paper.progress = { ...(this.paper.progress || {}), ...progress };
    api.patchPaper(this.paperId, { progress }, { keepalive }).catch(() => {});
  }

  showTip(text) {
    const tip = h('div', { class: 'tip', text });
    this.stage.append(tip);
    const remove = () => tip.remove();
    setTimeout(remove, 6500);
    tip.addEventListener('click', remove);
  }

  // ---- selection & AI ----

  async onSelectionAction(act, info) {
    if (act === 'copy') {
      toast((await copyText(info.text)) ? t('common.copied') : t('common.copyFailed'));
      return;
    }
    this.panel.startQuote(act, info);
  }

  async jumpToLocation(loc) {
    if (!loc) return;
    if (loc.kind && loc.kind !== this.mode) {
      if (loc.kind === 'html' && !this.htmlAvailable) return;
      await this.setMode(loc.kind);
    }
    this.view?.goToLocation(loc);
  }

  toggleCapture() {
    if (this.capture) {
      this.capture.cancel();
      return;
    }
    if (this.view?.kind !== 'pdf') return;
    document.getSelection()?.removeAllRanges();
    this.setChrome(true);
    this.captureBtn.classList.add('on');
    this.capture = startCapture(this.stage, {
      onDone: async (rect) => {
        this.capture = null;
        this.captureBtn.classList.remove('on');
        try {
          const shot = await this.view.captureRegion(rect);
          if (!shot) return;
          this.panel.startImage('pick', { ...shot, location: { kind: 'pdf', page: shot.page } });
        } catch (err) {
          toast(t('reader.captureFailed', { msg: err.message }), { type: 'error' });
        }
      },
      onCancel: () => {
        this.capture = null;
        this.captureBtn.classList.remove('on');
      },
    });
  }

  // ---- previews ----

  async previewDest(dest) {
    const view = this.view;
    if (view?.kind !== 'pdf') return;
    let info = null;
    try {
      info = await view.describeDest(dest);
    } catch {
      info = null;
    }
    if (!info || !info.text) {
      view.goToDest(dest);
      return;
    }
    this.showPeek({
      title: t('reader.page', { n: info.page }),
      text: info.text,
      go: () => view.goToDest(dest),
      location: { kind: 'pdf', page: info.page },
    });
  }

  showPeek(info) {
    this.closePeek();
    const body = h('div', { class: 'peek-body' });
    if (info.image) {
      body.append(
        h('img', {
          src: info.image,
          alt: '',
          style: { display: 'block', maxWidth: '100%', maxHeight: '180px', margin: '4px auto 10px', background: '#fff', borderRadius: '6px' },
        }),
      );
    }
    body.append(h('div', { text: info.text || '' }));
    const actions = h('div', { class: 'peek-actions' });
    if (info.text) {
      actions.append(
        h('button', {
          class: 'btn btn-sm btn-secondary',
          html: `${icon('translate', 16)}<span>${t('action.translate')}</span>`,
          onClick: () => {
            this.closePeek();
            this.panel.startQuote('translate', { text: info.text, context: '', location: info.location || null });
          },
        }),
        h('button', {
          class: 'btn btn-sm btn-secondary',
          html: `${icon('copy', 16)}<span>${t('common.copy')}</span>`,
          onClick: async () => toast((await copyText(info.text)) ? t('common.copied') : t('common.copyFailed')),
        }),
      );
    }
    if (info.go) {
      actions.append(
        h('button', {
          class: 'btn btn-sm btn-primary',
          text: t('reader.jumpThere'),
          onClick: () => {
            this.closePeek();
            info.go();
          },
        }),
      );
    }
    const peek = h(
      'div',
      { class: 'peek', role: 'dialog', 'aria-label': info.title },
      h('div', { class: 'peek-head' }, h('span', { class: 'title', text: info.title }), iconButton('close', { title: t('common.close'), onClick: () => this.closePeek() })),
      body,
      actions,
    );
    this.root.append(peek);
    this.peekEl = peek;
    setTimeout(() => {
      this.peekOutside = (e) => {
        if (this.peekEl && !this.peekEl.contains(e.target)) this.closePeek();
      };
      document.addEventListener('pointerdown', this.peekOutside, true);
    }, 0);
  }

  closePeek() {
    this.peekEl?.remove();
    this.peekEl = null;
    if (this.peekOutside) document.removeEventListener('pointerdown', this.peekOutside, true);
    this.peekOutside = null;
  }

  showBackChip(back) {
    this.quietScrollUntil = Date.now() + 800;
    this.backChip?.remove();
    clearTimeout(this.backTimer);
    const chip = h('button', { class: 'back-chip', type: 'button', html: `${icon('undo')}<span>${t('reader.backToSpot')}</span>` });
    chip.addEventListener('click', () => {
      chip.remove();
      back();
    });
    this.root.append(chip);
    this.backChip = chip;
    this.backTimer = setTimeout(() => chip.remove(), 9000);
  }

  openLightbox(img, caption) {
    const src = img.currentSrc || img.src;
    const figure = img.closest('figure, .ltx_figure, .ltx_table');
    const location = { kind: 'html', anchorId: figure?.id || img.id || null, section: t('reader.figure') };
    const close = () => {
      box.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    const wrap = h('div', { class: 'lightbox-img' }, h('img', { src, alt: caption || '' }));
    wrap.addEventListener('dblclick', () => wrap.classList.toggle('zoomed'));
    const ask = async (action) => {
      close();
      try {
        const data = await imageToBase64(src);
        this.panel.startImage(action, { ...data, caption, text: '', location });
      } catch (err) {
        toast(err.message, { type: 'error' });
      }
    };
    const box = h(
      'div',
      { class: 'lightbox', role: 'dialog', 'aria-label': t('reader.image') },
      h('div', { class: 'lightbox-bar' }, h('span', { class: 'title', text: t('reader.imageHint') }), iconButton('close', { title: t('common.close'), onClick: close })),
      wrap,
      h(
        'div',
        { class: 'lightbox-actions' },
        h('button', { class: 'btn btn-primary', html: `${icon('bulb', 17)}<span>${t('reader.explainImage')}</span>`, onClick: () => ask('explain') }),
        h('button', { class: 'btn btn-secondary', html: `${icon('message', 17)}<span>${t('reader.ask')}</span>`, onClick: () => ask('ask') }),
      ),
      caption ? h('div', { class: 'lightbox-cap', text: caption }) : null,
    );
    document.addEventListener('keydown', onKey);
    document.body.append(box);
  }

  // ---- table of contents ----

  // Pinned, the contents sit beside the text; that needs a window at least this wide.
  canPinToc() {
    return window.matchMedia('(min-width: 760px)').matches;
  }

  tocSideShown() {
    return this.tocPinned && this.canPinToc();
  }

  openToc() {
    // With the pinned list on screen, the toolbar button puts it away.
    if (this.tocSideShown()) {
      this.setTocPinned(false);
      return;
    }
    const view = this.view;
    if (!view) return;
    const scrim = h('div', { class: 'scrim' });
    const body = h('div', { class: 'drawer-body' });
    const drawer = h('nav', { class: 'drawer', 'aria-label': t('reader.toc') });
    const close = () => {
      scrim.remove();
      drawer.remove();
    };
    scrim.addEventListener('click', close);
    const pin = this.canPinToc()
      ? iconButton('pushpin', {
          title: t('reader.pinToc'),
          onClick: () => {
            close();
            this.setTocPinned(true);
          },
        })
      : null;
    drawer.append(h('div', { class: 'drawer-head' }, h('span', { class: 'title', text: t('reader.toc') }), pin, iconButton('close', { title: t('common.close'), onClick: close })), body);
    this.root.append(scrim, drawer);
    this.fillToc(body, view, close);
  }

  setTocPinned(on) {
    this.tocPinned = on;
    local.set('tocPinned', on);
    this.root.classList.toggle('toc-pinned', on);
    if (on) {
      this.renderTocSide();
    } else {
      this.tocSide?.remove();
      this.tocSide = null;
      this.tocItems = null;
    }
  }

  renderTocSide() {
    this.tocSide?.remove();
    const body = h('div', { class: 'drawer-body' });
    this.tocSide = h(
      'nav',
      { class: 'toc-side', 'aria-label': t('reader.toc') },
      h(
        'div',
        { class: 'drawer-head' },
        h('span', { class: 'title', text: t('reader.toc') }),
        iconButton('pushpin', { title: t('reader.unpinToc'), className: 'on', onClick: () => this.setTocPinned(false) }),
      ),
      body,
    );
    this.root.append(this.tocSide);
    const view = this.view;
    if (!view) return;
    this.fillToc(body, view, null).then((items) => {
      if (this.view !== view || !this.tocSide?.contains(body)) return;
      this.tocItems = items;
      this.tocCurrent = null;
      this.updateTocCurrent();
    });
  }

  // Fills a contents list. `done` runs after a jump (closes the drawer); the pinned list stays.
  async fillToc(body, view, done) {
    if (view.kind === 'pdf') {
      const input = h('input', {
        class: 'input',
        type: 'number',
        min: '1',
        max: String(view.numPages),
        value: String(view.currentPage),
        inputmode: 'numeric',
        'aria-label': t('reader.pageNo'),
      });
      const go = h('button', { class: 'btn btn-sm btn-secondary', type: 'button', text: t('reader.jump') });
      const jump = () => {
        view.goToPage(Number(input.value) || 1);
        done?.();
      };
      go.addEventListener('click', jump);
      input.addEventListener('keydown', (e) => e.key === 'Enter' && jump());
      body.append(h('div', { class: 'page-jump' }, h('span', { text: t('reader.pageWord') }), input, h('span', { text: t('reader.pageOf', { n: view.numPages }) }), go));
    }
    let items = [];
    try {
      items = await view.getOutline();
    } catch {
      items = [];
    }
    if (this.view !== view) return [];
    if (!items.length) {
      body.append(h('div', { class: 'toc-empty', text: view.kind === 'pdf' ? t('reader.noOutlinePdf') : t('reader.noOutlineHtml') }));
      return [];
    }
    const out = [];
    for (const it of items) {
      if (view.kind === 'pdf' && !it.dest) continue;
      const btn = h('button', { class: `toc-item l${it.level}`, type: 'button' }, it.page ? h('span', { class: 'pg', text: String(it.page) }) : null, it.title);
      btn.addEventListener('click', () => {
        done?.();
        if (view.kind === 'pdf') view.goToDestDirect(it.dest);
        else view.jumpTo(it.el);
      });
      body.append(btn);
      out.push({ ...it, btn });
    }
    return out;
  }

  scheduleTocCurrent() {
    if (!this.tocItems || this.tocFrame) return;
    this.tocFrame = requestAnimationFrame(() => {
      this.tocFrame = 0;
      this.updateTocCurrent();
    });
  }

  // Marks the section being read in the pinned list.
  updateTocCurrent() {
    const view = this.view;
    if (!this.tocItems?.length || !view || !this.tocSideShown()) return;
    let current = null;
    if (view.kind === 'pdf') {
      const page = view.currentPage;
      for (const it of this.tocItems) if (it.page && it.page <= page && (!current || it.page >= current.page)) current = it;
    } else {
      const line = view.scrollEl.getBoundingClientRect().top + view.topInset() + 24;
      // Entries come in document order.
      for (const it of this.tocItems) {
        if (it.el.getBoundingClientRect().top > line) break;
        current = it;
      }
    }
    if (current === this.tocCurrent) return;
    this.tocCurrent?.btn.classList.remove('current');
    current?.btn.classList.add('current');
    this.tocCurrent = current;
    current?.btn.scrollIntoView({ block: 'nearest' });
  }

  // ---- menu ----

  openMore() {
    const view = this.view;
    const items = [];
    if (view?.kind === 'pdf') {
      items.push({ icon: 'maximize', label: t('reader.fitWidth'), onClick: () => view.fitWidth() });
      items.push({ icon: 'scan', label: t('reader.capture'), onClick: () => this.toggleCapture() });
      if (isDarkTheme()) {
        items.push({
          icon: 'moon',
          label: this.pdfInvert ? t('reader.invertOff') : t('reader.invertOn'),
          onClick: () => {
            this.pdfInvert = !this.pdfInvert;
            local.set('pdfInvert', this.pdfInvert);
            this.updateInvert();
          },
        });
      }
    }
    if (view?.kind === 'html') {
      const size = h('span', { text: String(local.get('readSize', 17)), style: { minWidth: '24px', textAlign: 'center', fontVariantNumeric: 'tabular-nums' } });
      const row = h(
        'div',
        { class: 'menu-row' },
        h('span', { class: 'label', html: `${icon('type')}<span>${t('reader.fontSize')}</span>` }),
        iconButton('minus', { title: t('reader.smaller'), onClick: () => (size.textContent = String(view.setFontSize(-1))) }),
        size,
        iconButton('plus', { title: t('reader.larger'), onClick: () => (size.textContent = String(view.setFontSize(1))) }),
      );
      items.push({ el: row });
      items.push({
        icon: 'book',
        label: local.get('readFont', 'serif') === 'serif' ? t('reader.useSans') : t('reader.useSerif'),
        onClick: () => view.toggleFont(),
      });
    }
    const theme = local.get('theme', 'system');
    items.push({
      icon: isDarkTheme() ? 'moon' : 'sun',
      label: t('reader.theme', { name: themeLabel(theme) }),
      right: t('reader.switch'),
      onClick: () => {
        const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
        local.set('theme', next);
        applyTheme(next);
        toast(t('reader.theme', { name: themeLabel(next) }));
      },
    });
    items.push('sep');
    items.push({ el: menuSwitch({ icon: 'pushpin', label: t('reader.pinBar'), checked: this.barPinned, onChange: (on) => this.setBarPinned(on) }) });
    items.push({ el: menuSwitch({ icon: 'translate', label: t('reader.instant'), checked: this.instantOn, onChange: (on) => this.setInstant(on) }) });
    if (canSwitchProvider()) {
      items.push({
        icon: 'repeat',
        label: t('reader.provider'),
        right: usableProviders().find((p) => p.active)?.label || '',
        onClick: () => openProviderMenu(this.moreBtn, { openSettings: () => openSettings({ section: 'ai' }) }),
      });
    }
    items.push('sep');
    items.push({ icon: 'sparkles', label: t('reader.askPaper'), onClick: () => this.panel.startChat() });
    items.push({ icon: 'clock', label: t('reader.history'), onClick: () => this.panel.showHistory() });
    items.push('sep');
    if (this.paper?.absUrl) items.push({ icon: 'external', label: t('common.openSource'), onClick: () => window.open(this.paper.absUrl, '_blank', 'noopener') });
    items.push({ icon: 'download', label: t('common.downloadPdf'), onClick: () => window.open(api.pdfDownloadUrl(this.paperId), '_blank') });
    items.push({ icon: 'sliders', label: t('common.settings'), onClick: () => openSettings() });
    openMenu(this.moreBtn, items);
  }

  onKey(e) {
    if (e.key === 'Escape') {
      if (this.peekEl) this.closePeek();
      else if (this.capture) this.capture.cancel();
      else if (this.panel?.isOpen && document.activeElement !== this.panel.input) this.panel.close();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && this.view?.kind === 'pdf' && ['=', '+', '-', '0'].includes(e.key)) {
      e.preventDefault();
      if (e.key === '0') this.view.fitWidth();
      else this.view.zoomBy(e.key === '-' ? 1 / 1.15 : 1.15);
    }
  }

  destroy() {
    this.destroyed = true;
    this.persistProgress(true);
    this.capture?.cancel();
    this.closePeek();
    closeMenus();
    clearTimeout(this.pillTimer);
    clearTimeout(this.backTimer);
    cancelAnimationFrame(this.tocFrame);
    this.view?.destroy();
    this.instant?.destroy();
    this.panel?.destroy();
    this.selbar?.destroy();
    for (const off of this.listeners) off();
    this.root?.remove();
    document.querySelectorAll('.drawer, .scrim, .lightbox').forEach((e) => e.remove());
    document.title = t('app.name');
  }
}
