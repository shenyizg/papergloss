// Reflowable reading view for arXiv's HTML rendering (LaTeXML output).
import { api } from './api.js';
import { h, local } from './ui.js';
import { normalizeText } from './selection.js';
import { t } from './i18n.js';

const DROP =
  'script, style, link, meta, iframe, frame, object, embed, form, input, button, textarea, select, noscript, template, ' +
  '.ltx_page_logo, .ltx_page_navbar, .ltx_page_footer, .ltx_TOC, .ltx_ERROR';

function nodeEl(node) {
  return node?.nodeType === 1 ? node : node?.parentElement || null;
}

function texOf(mathEl) {
  return (
    mathEl.getAttribute('alttext') ||
    mathEl.querySelector('annotation[encoding="application/x-tex"]')?.textContent ||
    mathEl.textContent ||
    ''
  ).trim();
}

// Text of a node with MathML replaced by $LaTeX$, so the model sees real formulas.
export function textWithLatex(node, { keepBlocks = false } = {}) {
  if (!node) return '';
  const clone = node.cloneNode(true);
  clone.querySelectorAll('math').forEach((m) => {
    const tex = texOf(m);
    const block = m.getAttribute('display') === 'block';
    m.replaceWith(document.createTextNode(block ? ` $$${tex}$$ ` : ` $${tex}$ `));
  });
  clone.querySelectorAll('.ltx_note_outer').forEach((e) => e.remove());
  if (keepBlocks) {
    clone
      .querySelectorAll('p, .ltx_para, h1, h2, h3, h4, h5, h6, li, figcaption, .ltx_caption, .ltx_equation, .ltx_equationgroup, tr, .ltx_bibitem')
      .forEach((e) => e.append(document.createTextNode('\n')));
    return clone.textContent
      .replace(/[ \t ]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return normalizeText(clone.textContent);
}

function sameDocument(abs, base) {
  const strip = (p) => p.replace(/\/$/, '').replace(/v\d+$/, '');
  return abs.origin === base.origin && strip(abs.pathname) === strip(base.pathname);
}

function sanitize(root, baseUrl, paperId) {
  const base = new URL(baseUrl);
  root.querySelectorAll(DROP).forEach((e) => e.remove());
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith('on') || name === 'srcset' || name === 'formaction' || name === 'action' || name === 'ping') {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === 'href' || name === 'xlink:href') {
        if (value.startsWith('#')) continue;
        let abs;
        try {
          abs = new URL(value, base);
        } catch {
          el.removeAttribute(attr.name);
          continue;
        }
        if (abs.protocol !== 'https:' && abs.protocol !== 'http:') {
          el.removeAttribute(attr.name);
          continue;
        }
        if (el.localName === 'image') {
          el.setAttribute(attr.name, api.assetUrl(paperId, abs.href));
          continue;
        }
        if (abs.hash && sameDocument(abs, base)) {
          el.setAttribute(attr.name, abs.hash);
          continue;
        }
        el.setAttribute(attr.name, abs.href);
        if (el.localName === 'a') {
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
        }
      } else if (name === 'src') {
        let abs;
        try {
          abs = new URL(value, base);
        } catch {
          el.removeAttribute('src');
          continue;
        }
        if (abs.protocol === 'https:' || abs.protocol === 'http:') el.setAttribute('src', api.assetUrl(paperId, abs.href));
        else if (abs.protocol !== 'data:') el.removeAttribute('src');
      } else if (name === 'style' && /url\s*\(/i.test(value)) {
        el.removeAttribute('style');
      }
    }
    if (el.localName === 'img') {
      el.setAttribute('loading', 'lazy');
      el.setAttribute('decoding', 'async');
    }
  }
}

export class HtmlView {
  constructor({ paper, host, onScroll, onTap, onPeek, onJump, onImage }) {
    Object.assign(this, { paper, host, onScroll, onTap, onPeek, onJump, onImage });
    this.kind = 'html';
  }

  async open(saved) {
    const data = await api.getHtml(this.paper.id);
    const doc = new DOMParser().parseFromString(data.html, 'text/html');
    const article = doc.querySelector('article.ltx_document') || doc.querySelector('.ltx_page_content') || doc.body;
    sanitize(article, data.baseUrl, this.paper.id);
    this.source = data.source;
    this.scrollEl = h('div', { class: 'html-scroll' });
    this.article = h('div', { class: 'html-article', lang: 'en' });
    this.article.append(document.importNode(article, true));
    // Author blocks are "Name<br>Affiliation<br>email": keep only the name in bold.
    this.article.querySelectorAll('.ltx_authors .ltx_personname').forEach((pn) => {
      const br = pn.querySelector('br');
      if (!br) return;
      const rest = h('span', { class: 'pr-affil' });
      while (br.nextSibling) rest.append(br.nextSibling);
      br.remove();
      pn.append(rest);
    });
    this.scrollEl.append(this.article);
    this.applyTypography();
    this.host.append(this.scrollEl);

    this.ac = new AbortController();
    const signal = this.ac.signal;
    let selAtDown = false;
    this.article.addEventListener(
      'pointerdown',
      () => {
        const sel = document.getSelection();
        selAtDown = !!sel && !sel.isCollapsed;
      },
      { signal },
    );
    this.article.addEventListener('click', (e) => this.onClick(e, selAtDown), { signal });
    this.scrollEl.addEventListener('scroll', () => this.onScroll?.(this.scrollEl.scrollTop), { passive: true, signal });
    // Native pinch would zoom the whole app; text size has its own control.
    this.scrollEl.addEventListener('gesturestart', (e) => e.preventDefault(), { signal });
    this.restore(saved);
    return this;
  }

  applyTypography() {
    const size = local.get('readSize', 17);
    this.article.style.setProperty('--read-size', `${size}px`);
    this.article.classList.toggle('sans', local.get('readFont', 'serif') === 'sans');
  }

  setFontSize(delta) {
    const anchor = this.firstVisible();
    const size = Math.max(13, Math.min(26, local.get('readSize', 17) + delta));
    local.set('readSize', size);
    this.applyTypography();
    if (anchor) this.scrollToEl(anchor.el, anchor.offset);
    return size;
  }

  toggleFont() {
    const next = local.get('readFont', 'serif') === 'serif' ? 'sans' : 'serif';
    local.set('readFont', next);
    this.applyTypography();
    return next;
  }

  topInset() {
    const bar = document.querySelector('.topbar');
    return bar ? bar.getBoundingClientRect().height : 60;
  }

  firstVisible() {
    const top = this.scrollEl.getBoundingClientRect().top + this.topInset();
    const blocks = this.article.querySelectorAll('[id].ltx_para, [id].ltx_title, section[id], figure[id], [id].ltx_equation, li[id]');
    for (const el of blocks) {
      const r = el.getBoundingClientRect();
      if (r.bottom > top + 4) return { el, offset: r.top - top };
    }
    return null;
  }

  scrollToEl(el, offset = 0) {
    const elTop = el.getBoundingClientRect().top - this.scrollEl.getBoundingClientRect().top + this.scrollEl.scrollTop;
    this.scrollEl.scrollTop = elTop - this.topInset() - offset;
  }

  restore(saved) {
    requestAnimationFrame(() => {
      if (saved?.anchorId) {
        const el = this.article.querySelector(`[id="${CSS.escape(saved.anchorId)}"]`);
        if (el) {
          this.scrollToEl(el, saved.offset || 0);
          return;
        }
      }
      if (saved?.ratio) {
        this.scrollEl.scrollTop = saved.ratio * (this.scrollEl.scrollHeight - this.scrollEl.clientHeight);
      }
    });
  }

  getProgress() {
    const first = this.firstVisible();
    const max = this.scrollEl.scrollHeight - this.scrollEl.clientHeight;
    return {
      anchorId: first?.el.id || null,
      offset: first ? Math.round(first.offset) : 0,
      ratio: max > 0 ? Math.round((this.scrollEl.scrollTop / max) * 10000) / 10000 : 0,
    };
  }

  jumpTo(el) {
    const back = this.scrollEl.scrollTop;
    this.scrollToEl(el, 8);
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    this.onJump?.(() => {
      this.scrollEl.scrollTop = back;
    });
  }

  goToLocation(loc) {
    if (!loc?.anchorId) return;
    const el = this.article.querySelector(`[id="${CSS.escape(loc.anchorId)}"]`);
    if (el) this.jumpTo(el);
  }

  captionFor(el) {
    const fig = el.closest('figure, .ltx_figure, .ltx_table');
    const cap = fig?.querySelector('figcaption, .ltx_caption');
    return cap ? textWithLatex(cap) : '';
  }

  onClick(e, selAtDown) {
    const noteMark = e.target.closest('.ltx_note_mark');
    if (noteMark) {
      e.preventDefault();
      const content = noteMark.closest('.ltx_note')?.querySelector('.ltx_note_content');
      if (content) {
        const clone = content.cloneNode(true);
        clone.querySelectorAll('.ltx_note_mark, .ltx_tag_note').forEach((x) => x.remove());
        this.onPeek?.({ title: t('peek.footnote'), text: textWithLatex(clone) });
      }
      return;
    }
    const a = e.target.closest('a');
    if (a) {
      const href = a.getAttribute('href') || '';
      if (!href.startsWith('#')) return;
      e.preventDefault();
      let id;
      try {
        id = decodeURIComponent(href.slice(1));
      } catch {
        return;
      }
      const target = id && this.article.querySelector(`[id="${CSS.escape(id)}"]`);
      if (!target) return;
      if (id.startsWith('bib.')) {
        this.onPeek?.({ title: t('peek.reference'), text: textWithLatex(target), go: () => this.jumpTo(target) });
      } else if (target.matches('figure, .ltx_figure, .ltx_table')) {
        const img = target.querySelector('img');
        this.onPeek?.({
          title: target.classList.contains('ltx_table') ? t('peek.table') : t('peek.figure'),
          text: this.captionFor(target) || textWithLatex(target).slice(0, 600),
          image: img?.getAttribute('src') || null,
          go: () => this.jumpTo(target),
        });
      } else if (target.matches('.ltx_equation, .ltx_equationgroup, [id^="S"][id*=".E"]')) {
        const eq = target.closest('.ltx_equation, .ltx_equationgroup') || target;
        this.onPeek?.({ title: t('peek.equation'), text: textWithLatex(eq), go: () => this.jumpTo(eq) });
      } else {
        this.jumpTo(target);
      }
      return;
    }
    const img = e.target.closest('img');
    if (img && this.article.contains(img)) {
      this.onImage?.(img, this.captionFor(img));
      return;
    }
    if (!selAtDown) {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed) this.onTap?.();
    }
  }

  describeSelection(sel) {
    const range = sel.getRangeAt(0);
    if (!this.article.contains(range.commonAncestorContainer)) return null;
    const r = range.cloneRange();
    const startMath = nodeEl(r.startContainer)?.closest('math');
    if (startMath) r.setStartBefore(startMath);
    const endMath = nodeEl(r.endContainer)?.closest('math');
    if (endMath) r.setEndAfter(endMath);
    const text = textWithLatex(r.cloneContents());
    if (!text) return null;
    const startEl = nodeEl(r.startContainer);
    const block = startEl?.closest('.ltx_para, .ltx_p, figcaption, .ltx_caption, li, .ltx_bibitem, .ltx_abstract, .ltx_equation, td, th');
    const sectionEl = startEl?.closest('section');
    const heading = sectionEl?.querySelector(':scope > .ltx_title');
    const anchor = startEl?.closest('[id]');
    let section = heading ? normalizeText(heading.textContent).slice(0, 48) : '';
    if (!section && startEl?.closest('.ltx_abstract')) section = 'Abstract';
    return {
      text,
      rect: range.getBoundingClientRect(),
      location: { kind: 'html', anchorId: anchor?.id || null, section },
      getContext: async () => this.contextFor(block),
    };
  }

  contextFor(block) {
    if (!block) return '';
    const para = block.closest('.ltx_para') || block;
    const parts = [];
    const prev = para.previousElementSibling;
    const next = para.nextElementSibling;
    const usable = (el) => el && el.matches('.ltx_para, .ltx_equation, .ltx_equationgroup, .ltx_p');
    if (usable(prev)) parts.push(textWithLatex(prev));
    parts.push(textWithLatex(para));
    if (usable(next)) parts.push(textWithLatex(next));
    const ctx = parts.join('\n\n');
    return ctx.length > 3200 ? `${ctx.slice(0, 3200)}…` : ctx;
  }

  async getFullText(limit) {
    const clone = this.article.cloneNode(true);
    const bib = clone.querySelector('.ltx_bibliography');
    bib?.remove();
    let text = textWithLatex(clone, { keepBlocks: true });
    if (bib) {
      const refs = textWithLatex(bib, { keepBlocks: true });
      if (text.length + refs.length + 20 <= limit) text += `\n\nReferences\n${refs}`;
    }
    const truncated = text.length > limit;
    return { text: truncated ? text.slice(0, limit) : text, truncated };
  }

  getOutline() {
    const items = [];
    const abs = this.article.querySelector('.ltx_abstract');
    if (abs) items.push({ title: 'Abstract', level: 1, el: abs });
    this.article
      .querySelectorAll('section.ltx_section, section.ltx_appendix, section.ltx_bibliography, section.ltx_subsection')
      .forEach((sec) => {
        const heading = sec.querySelector(':scope > .ltx_title');
        if (!heading) return;
        items.push({ title: normalizeText(heading.textContent), level: sec.classList.contains('ltx_subsection') ? 2 : 1, el: sec });
      });
    return items;
  }

  destroy() {
    this.ac?.abort();
    this.scrollEl?.remove();
  }
}
