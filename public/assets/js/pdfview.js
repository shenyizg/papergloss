import { api } from './api.js';
import { h, isCoarse, loadCss } from './ui.js';
import { contextAround, normalizeText } from './selection.js';

// pdf.js's TouchManager relies on AbortSignal.any (Safari 17.4+).
if (typeof AbortSignal !== 'undefined' && !AbortSignal.any) {
  AbortSignal.any = (signals) => {
    const ac = new AbortController();
    for (const s of signals) {
      if (!s) continue;
      if (s.aborted) {
        ac.abort(s.reason);
        break;
      }
      s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
    }
    return ac.signal;
  };
}

let libs = null;
async function loadPdfjs() {
  if (libs) return libs;
  // pdf.mjs registers globalThis.pdfjsLib, which pdf_viewer.mjs reads on load.
  const pdfjsLib = await import('/vendor/pdfjs/build/pdf.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.mjs';
  const pdfjsViewer = await import('/vendor/pdfjs/web/pdf_viewer.mjs');
  libs = { pdfjsLib, pdfjsViewer };
  return libs;
}

function nodeEl(node) {
  return node?.nodeType === 1 ? node : node?.parentElement || null;
}

// Finds the text column under x on a page: two-column papers zoom to one column,
// single-column pages zoom to the text block without the margins.
function columnBounds(items, view, px) {
  const [vx0, , vx1] = view;
  const W = vx1 - vx0;
  const mid = vx0 + W / 2;
  const width = (arr) => arr.reduce((s, it) => s + (it.x1 - it.x0), 0);
  const total = width(items) || 1;
  const left = items.filter((it) => it.x1 <= mid + W * 0.02);
  const right = items.filter((it) => it.x0 >= mid - W * 0.02);
  const spanning = items.filter((it) => it.x0 < mid - W * 0.06 && it.x1 > mid + W * 0.06);
  const twoCol = width(left) > total * 0.2 && width(right) > total * 0.2 && width(spanning) < total * 0.5;
  const pool = twoCol ? (px < mid ? left : right) : items;
  const xs0 = pool.map((it) => it.x0).sort((a, b) => a - b);
  const xs1 = pool.map((it) => it.x1).sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))))];
  let minX = q(xs0, 0.02);
  let maxX = q(xs1, 0.98);
  if (!(maxX - minX > W * 0.2)) {
    minX = vx0 + W * 0.06;
    maxX = vx1 - W * 0.06;
  }
  const pad = W * 0.012;
  return { minX: minX - pad, maxX: maxX + pad };
}

export class PdfView {
  constructor({ paper, host, onPageChange, onViewChange, onScroll, onTap, onInternalLink, onJump, onProgress }) {
    Object.assign(this, { paper, host, onPageChange, onViewChange, onScroll, onTap, onInternalLink, onJump, onProgress });
    this.kind = 'pdf';
    this.itemCache = new Map();
    this.location = null;
    this.unusedFactor = 1;
  }

  async open(saved) {
    const { pdfjsLib, pdfjsViewer } = await loadPdfjs();
    await loadCss('/vendor/pdfjs/web/pdf_viewer.css');
    this.lib = pdfjsLib;
    this.ac = new AbortController();
    this.scrollEl = h('div', { class: 'pdf-scroll', tabindex: '-1' });
    this.viewerEl = h('div', { class: 'pdfViewer' });
    this.scrollEl.append(this.viewerEl);
    this.host.append(this.scrollEl);

    const eventBus = new pdfjsViewer.EventBus();
    const linkService = new pdfjsViewer.PDFLinkService({
      eventBus,
      externalLinkTarget: pdfjsViewer.LinkTarget.BLANK,
      externalLinkRel: 'noopener noreferrer nofollow',
      ignoreDestinationZoom: true,
    });
    const viewer = new pdfjsViewer.PDFViewer({
      container: this.scrollEl,
      viewer: this.viewerEl,
      eventBus,
      linkService,
      removePageBorders: true,
      textLayerMode: 1,
      annotationMode: pdfjsLib.AnnotationMode.ENABLE,
      maxCanvasPixels: isCoarse() ? 5242880 : 16777216,
      abortSignal: this.ac.signal,
    });
    linkService.setViewer(viewer);
    Object.assign(this, { eventBus, linkService, viewer });

    // Internal links (citations, figure refs) open a preview first instead of jumping.
    const goTo = linkService.goToDestination.bind(linkService);
    this.goToDestDirect = goTo;
    linkService.goToDestination = async (dest) => {
      if (this.onInternalLink) return this.onInternalLink(dest);
      return this.jumpWithBack(() => goTo(dest));
    };

    eventBus.on('pagechanging', ({ pageNumber }) => this.onPageChange?.(pageNumber, this.pdf?.numPages));
    eventBus.on('updateviewarea', ({ location }) => {
      this.location = location;
      this.onViewChange?.();
    });
    // Warm the text cache for pages as they render, so selections get context instantly.
    eventBus.on('textlayerrendered', ({ pageNumber }) => {
      this.getTextItems(pageNumber).catch(() => {});
    });

    const task = pdfjsLib.getDocument({
      url: api.pdfUrl(this.paper.id),
      cMapUrl: '/vendor/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
      wasmUrl: '/vendor/pdfjs/wasm/',
      iccUrl: '/vendor/pdfjs/iccs/',
      enableXfa: false,
      // Font programs are compiled without eval (the CSP forbids it anyway).
      isEvalSupported: false,
    });
    task.onProgress = ({ loaded, total }) => {
      if (total) this.onProgress?.(loaded / total);
    };
    this.task = task;
    this.pdf = await task.promise;
    const pagesInit = new Promise((resolve) => eventBus.on('pagesinit', resolve, { once: true }));
    viewer.setDocument(this.pdf);
    linkService.setDocument(this.pdf, null);
    await pagesInit;
    this.restore(saved);
    this.setupGestures();
    return this;
  }

  get numPages() {
    return this.pdf?.numPages || 0;
  }

  get currentPage() {
    return this.viewer?.currentPageNumber || 1;
  }

  restore(saved) {
    const v = this.viewer;
    if (saved?.page) {
      v.currentScaleValue = saved.scale || 'page-width';
      if (saved.top != null) {
        v.scrollPageIntoView({
          pageNumber: Math.min(saved.page, this.numPages),
          destArray: [null, { name: 'XYZ' }, saved.left ?? 0, saved.top, null],
          allowNegativeOffset: true,
        });
      } else {
        v.currentPageNumber = Math.min(saved.page, this.numPages);
      }
    } else {
      v.currentScaleValue = 'page-width';
    }
  }

  getProgress() {
    const loc = this.location;
    if (!loc) return null;
    return {
      page: loc.pageNumber,
      top: Math.round(loc.top),
      left: Math.round(loc.left),
      scale: this.viewer.currentScaleValue,
    };
  }

  fitWidthScale(pageView) {
    const pv = pageView || this.viewer.getPageView(this.currentPage - 1);
    const vp = pv.pdfPage ? pv.pdfPage.getViewport({ scale: 1, rotation: pv.viewport.rotation }) : null;
    if (!vp) return this.viewer.currentScale;
    return this.scrollEl.clientWidth / (vp.width * this.lib.PixelsPerInch.PDF_TO_CSS_UNITS);
  }

  setupGestures() {
    const el = this.scrollEl;
    const signal = this.ac.signal;
    this.touchManager = new this.lib.TouchManager({
      container: el,
      isPinchingDisabled: () => false,
      isPinchingStopped: () => false,
      onPinchStart: () => {
        this.unusedFactor = 1;
      },
      onPinching: (origin, prevDistance, distance, dx, dy) => {
        const factor = this.accumulate(distance / prevDistance);
        this.viewer.updateScale({ drawingDelay: 400, scaleFactor: factor, origin, pan: [dx, dy] });
      },
      onPinchEnd: () => this.onViewChange?.(),
      onPanning: (dx, dy) => this.viewer.panBy(dx, dy),
      signal,
    });

    let start = null;
    let lastTap = null;
    let tapTimer = null;
    el.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length !== 1) {
          start = null;
          return;
        }
        const t = e.touches[0];
        const sel = document.getSelection();
        start = { x: t.clientX, y: t.clientY, time: Date.now(), hadSelection: !!sel && !sel.isCollapsed };
      },
      { passive: true, signal },
    );
    el.addEventListener(
      'touchmove',
      (e) => {
        if (!start) return;
        const t = e.touches[0];
        if (!t || Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) start = null;
      },
      { passive: true, signal },
    );
    el.addEventListener(
      'touchend',
      (e) => {
        const s = start;
        start = null;
        if (!s || e.touches.length) return;
        if (Date.now() - s.time > 350 || s.hadSelection) {
          lastTap = null;
          return;
        }
        if (e.target.closest?.('a, .annotationLayer section')) return;
        const now = Date.now();
        if (lastTap && now - lastTap.time < 320 && Math.hypot(s.x - lastTap.x, s.y - lastTap.y) < 40) {
          clearTimeout(tapTimer);
          lastTap = null;
          this.toggleColumnZoom(s.x, s.y);
          return;
        }
        lastTap = { x: s.x, y: s.y, time: now };
        clearTimeout(tapTimer);
        tapTimer = setTimeout(() => {
          lastTap = null;
          const sel = document.getSelection();
          if (!sel || sel.isCollapsed) this.onTap?.();
        }, 330);
      },
      { passive: true, signal },
    );
    // Ctrl/Cmd + wheel (and trackpad pinch on macOS) zooms around the pointer.
    el.addEventListener(
      'wheel',
      (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        const factor = Math.exp(-e.deltaY / (e.deltaMode === 1 ? 20 : 300));
        this.viewer.updateScale({ drawingDelay: 300, scaleFactor: factor, origin: [e.clientX, e.clientY] });
      },
      { passive: false, signal },
    );
    el.addEventListener('scroll', () => this.onScroll?.(el.scrollTop), { passive: true, signal });
  }

  // Same rounding compensation the pdf.js viewer uses for touch zoom.
  accumulate(factor) {
    if (factor === 1) return 1;
    if ((this.unusedFactor > 1 && factor < 1) || (this.unusedFactor < 1 && factor > 1)) this.unusedFactor = 1;
    const prev = this.viewer.currentScale;
    const newFactor = Math.floor(prev * factor * this.unusedFactor * 100) / (100 * prev);
    this.unusedFactor = factor / newFactor;
    return newFactor;
  }

  zoomBy(factor) {
    const r = this.scrollEl.getBoundingClientRect();
    this.viewer.updateScale({ drawingDelay: 200, scaleFactor: factor, origin: [r.left + r.width / 2, r.top + r.height / 3] });
  }

  fitWidth() {
    const page = this.currentPage;
    this.viewer.currentScaleValue = 'page-width';
    this.viewer.currentPageNumber = page;
  }

  isZoomedIn() {
    return this.viewer.currentScale > this.fitWidthScale() * 1.12;
  }

  async toggleColumnZoom(clientX, clientY) {
    const v = this.viewer;
    const pageEl = document.elementFromPoint(clientX, clientY)?.closest('.page');
    if (!pageEl) return;
    const n = Number(pageEl.dataset.pageNumber);
    const pv = v.getPageView(n - 1);
    if (!pv) return;
    const rect = pageEl.getBoundingClientRect();
    const [px, py] = pv.viewport.convertToPdfPoint(clientX - rect.left, clientY - rect.top);
    const offsetY = clientY - this.scrollEl.getBoundingClientRect().top;
    const fit = this.fitWidthScale(pv);

    if (v.currentScale > fit * 1.12) {
      v.currentScaleValue = 'page-width';
      const [, vy] = pv.viewport.convertToViewportPoint(px, py);
      this.scrollEl.scrollLeft = 0;
      this.scrollEl.scrollTop = pageEl.offsetTop + vy - offsetY;
      this.onViewChange?.();
      return;
    }

    const { items, view, rotate } = await this.getTextItems(n);
    let target;
    let anchorX = px;
    let alignLeft = false;
    if (rotate % 180 === 0 && items.length) {
      const b = columnBounds(items, view, px);
      target = (this.scrollEl.clientWidth - 12) / ((b.maxX - b.minX) * this.lib.PixelsPerInch.PDF_TO_CSS_UNITS);
      anchorX = b.minX;
      alignLeft = true;
    } else {
      target = fit * 2;
    }
    target = Math.min(Math.max(target, fit * 1.15), 8);
    v.currentScale = target;
    const [vx, vy] = pv.viewport.convertToViewportPoint(anchorX, py);
    this.scrollEl.scrollLeft = alignLeft ? pageEl.offsetLeft + vx - 6 : pageEl.offsetLeft + vx - this.scrollEl.clientWidth / 2;
    this.scrollEl.scrollTop = pageEl.offsetTop + vy - offsetY;
    this.onViewChange?.();
  }

  async getTextItems(n) {
    if (this.itemCache.has(n)) return this.itemCache.get(n);
    const promise = (async () => {
      const page = await this.pdf.getPage(n);
      const tc = await page.getTextContent();
      const items = [];
      let text = '';
      for (const it of tc.items) {
        if (typeof it.str !== 'string') continue;
        text += it.str + (it.hasEOL ? '\n' : '');
        const [a, b, , , e, f] = it.transform;
        if (!it.str.trim() || a <= 0 || Math.abs(b) > Math.abs(a) * 0.2) continue;
        items.push({ str: it.str, x0: e, x1: e + it.width, y: f, size: Math.hypot(it.transform[2], it.transform[3]) || it.height });
      }
      return { items, text: normalizeText(text), view: page.view, rotate: page.rotate };
    })();
    this.itemCache.set(n, promise);
    try {
      return await promise;
    } catch (err) {
      this.itemCache.delete(n);
      throw err;
    }
  }

  async getPageText(n) {
    return (await this.getTextItems(n)).text;
  }

  async getFullText(limit) {
    let out = '';
    let truncated = false;
    for (let n = 1; n <= this.numPages; n++) {
      const chunk = `\n\n[第 ${n} 页]\n${await this.getPageText(n)}`;
      if (out.length + chunk.length > limit) {
        out += chunk.slice(0, Math.max(0, limit - out.length));
        truncated = true;
        break;
      }
      out += chunk;
    }
    return { text: out.trim(), truncated };
  }

  describeSelection(sel) {
    const range = sel.getRangeAt(0);
    if (!this.scrollEl.contains(range.commonAncestorContainer)) return null;
    const startLayer = nodeEl(range.startContainer)?.closest('.textLayer');
    const endLayer = nodeEl(range.endContainer)?.closest('.textLayer');
    const layer = startLayer || endLayer;
    if (!layer) return null;
    const text = normalizeText(sel.toString());
    if (!text) return null;
    const page = Number(layer.closest('.page')?.dataset.pageNumber) || this.currentPage;
    return {
      text,
      rect: range.getBoundingClientRect(),
      location: { kind: 'pdf', page },
      getContext: async () => contextAround(await this.getPageText(page), text),
    };
  }

  async jumpWithBack(go) {
    const back = { top: this.scrollEl.scrollTop, left: this.scrollEl.scrollLeft, scale: this.viewer.currentScaleValue };
    await go();
    this.onJump?.(() => {
      if (this.viewer.currentScaleValue !== back.scale) this.viewer.currentScaleValue = back.scale;
      this.scrollEl.scrollTop = back.top;
      this.scrollEl.scrollLeft = back.left;
    });
  }

  goToDest(dest) {
    return this.jumpWithBack(() => this.goToDestDirect(dest));
  }

  goToPage(n) {
    this.viewer.currentPageNumber = Math.max(1, Math.min(this.numPages, n));
  }

  goToLocation(loc) {
    if (loc?.page) {
      return this.jumpWithBack(async () => {
        this.goToPage(loc.page);
      });
    }
    return null;
  }

  // Text near a link destination, used for the citation/figure preview card.
  async describeDest(dest) {
    const explicit = typeof dest === 'string' ? await this.pdf.getDestination(dest) : await dest;
    if (!Array.isArray(explicit)) return null;
    const ref = explicit[0];
    let pageIndex = null;
    if (ref && typeof ref === 'object') pageIndex = await this.pdf.getPageIndex(ref);
    else if (Number.isInteger(ref)) pageIndex = ref;
    if (pageIndex == null) return null;
    const n = pageIndex + 1;
    const mode = explicit[1]?.name;
    let left = null;
    let top = null;
    if (mode === 'XYZ') {
      left = explicit[2];
      top = explicit[3];
    } else if (mode === 'FitH' || mode === 'FitBH') {
      top = explicit[2];
    } else if (mode === 'FitR') {
      left = explicit[2];
      top = explicit[5];
    }
    const { items, view, text } = await this.getTextItems(n);
    if (top == null || !items.length) return { page: n, text: text.slice(0, 400) };
    const W = view[2] - view[0];
    const mid = view[0] + W / 2;
    let pool = items;
    if (left != null) {
      const inRight = left > mid - W * 0.04;
      const rightItems = items.filter((it) => it.x0 >= mid - W * 0.04);
      if (inRight && rightItems.length > 5) pool = rightItems;
      else if (!inRight) pool = items.filter((it) => it.x0 < mid + W * 0.02);
    }
    const near = pool.filter((it) => it.y <= top + 4 && it.y >= top - 220).sort((a, b) => b.y - a.y || a.x0 - b.x0);
    // Group items into lines.
    const lines = [];
    for (const it of near) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - it.y) < Math.max(2, it.size * 0.4)) {
        last.parts.push(it);
      } else {
        lines.push({ y: it.y, x0: it.x0, size: it.size, parts: [it] });
      }
    }
    const out = [];
    let prevY = null;
    let gap = null;
    for (const [i, line] of lines.entries()) {
      const str = line.parts
        .sort((a, b) => a.x0 - b.x0)
        .map((p) => p.str)
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      if (!str) continue;
      if (prevY != null) {
        const d = prevY - line.y;
        if (gap == null) gap = d;
        // A bigger vertical gap or a new "[n]" label marks the next entry.
        if (d > gap * 1.6 + 1 || (i > 0 && /^\[\d+\]/.test(str) && out.length)) break;
      }
      out.push(str);
      prevY = line.y;
      if (out.join(' ').length > 600) break;
    }
    return { page: n, text: normalizeText(out.join('\n')) };
  }

  async getOutline() {
    const outline = await this.pdf.getOutline();
    if (!outline?.length) return [];
    const flat = [];
    const walk = (list, level) => {
      for (const item of list) {
        flat.push({ title: item.title, dest: item.dest, level });
        if (item.items?.length && level < 3) walk(item.items, level + 1);
      }
    };
    walk(outline, 1);
    // Page numbers, shown in the list and used to highlight the section being read.
    await Promise.all(
      flat.map(async (item) => {
        try {
          const dest = typeof item.dest === 'string' ? await this.pdf.getDestination(item.dest) : item.dest;
          const ref = dest?.[0];
          if (ref != null) item.page = (typeof ref === 'object' ? await this.pdf.getPageIndex(ref) : ref) + 1;
        } catch {
          // leave this entry without a page
        }
      }),
    );
    return flat;
  }

  async captureRegion(rect) {
    let best = null;
    for (const pageEl of this.viewerEl.querySelectorAll('.page')) {
      const r = pageEl.getBoundingClientRect();
      const ix = Math.max(0, Math.min(r.right, rect.right) - Math.max(r.left, rect.left));
      const iy = Math.max(0, Math.min(r.bottom, rect.bottom) - Math.max(r.top, rect.top));
      if (ix * iy > (best?.area || 0)) best = { pageEl, r, area: ix * iy };
    }
    if (!best) return null;
    const n = Number(best.pageEl.dataset.pageNumber);
    const pv = this.viewer.getPageView(n - 1);
    const page = pv.pdfPage || (await this.pdf.getPage(n));
    const r = best.r;
    const x1 = Math.max(rect.left, r.left) - r.left;
    const y1 = Math.max(rect.top, r.top) - r.top;
    const x2 = Math.min(rect.right, r.right) - r.left;
    const y2 = Math.min(rect.bottom, r.bottom) - r.top;
    const p1 = pv.viewport.convertToPdfPoint(x1, y1);
    const p2 = pv.viewport.convertToPdfPoint(x2, y2);
    const longest = Math.max(Math.abs(p2[0] - p1[0]), Math.abs(p2[1] - p1[1])) || 1;
    const scale = Math.min(6, Math.max(1.5, 1568 / longest));
    const vp = page.getViewport({ scale, rotation: pv.viewport.rotation });
    const [ax, ay] = vp.convertToViewportPoint(p1[0], p1[1]);
    const [bx, by] = vp.convertToViewportPoint(p2[0], p2[1]);
    const left = Math.min(ax, bx);
    const top = Math.min(ay, by);
    const w = Math.max(1, Math.round(Math.abs(bx - ax)));
    const hgt = Math.max(1, Math.round(Math.abs(by - ay)));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = hgt;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, hgt);
    await page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -left, -top] }).promise;
    let dataUrl = canvas.toDataURL('image/png');
    let mediaType = 'image/png';
    if (dataUrl.length > 1_800_000) {
      dataUrl = canvas.toDataURL('image/jpeg', 0.9);
      mediaType = 'image/jpeg';
    }
    // Text that falls inside the box helps the model (and the history list).
    const { items } = await this.getTextItems(n);
    const minX = Math.min(p1[0], p2[0]);
    const maxX = Math.max(p1[0], p2[0]);
    const minY = Math.min(p1[1], p2[1]);
    const maxY = Math.max(p1[1], p2[1]);
    const inside = items
      .filter((it) => it.x0 >= minX - 2 && it.x1 <= maxX + 2 && it.y >= minY - 2 && it.y <= maxY + 2)
      .sort((a, b) => b.y - a.y || a.x0 - b.x0)
      .map((it) => it.str)
      .join(' ');
    return {
      mediaType,
      data: dataUrl.slice(dataUrl.indexOf(',') + 1),
      width: w,
      height: hgt,
      page: n,
      text: normalizeText(inside).slice(0, 1500),
    };
  }

  async guessTitle() {
    try {
      const meta = await this.pdf.getMetadata();
      const t = String(meta?.info?.Title || '').trim();
      if (t.length >= 8 && t.length <= 300 && !/^(microsoft word|untitled|title|paper|document)\b|\.(pdf|docx?|tex|dvi)$/i.test(t)) {
        return t;
      }
    } catch {
      // fall back to the layout heuristic
    }
    const page = await this.pdf.getPage(1);
    const tc = await page.getTextContent();
    const [, y0, , y1] = page.view;
    const cand = tc.items.filter((it) => it.str?.trim() && it.transform[5] > y0 + (y1 - y0) * 0.45);
    if (!cand.length) return null;
    const size = (it) => Math.hypot(it.transform[2], it.transform[3]) || it.height;
    const maxSize = Math.max(...cand.map(size));
    const big = cand.filter((it) => size(it) >= maxSize * 0.9).sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);
    const title = normalizeText(big.map((it) => it.str).join(' ')).replace(/\s+/g, ' ');
    return title.length >= 6 && title.length <= 300 ? title : null;
  }

  async guessAbstract() {
    const t = await this.getPageText(1);
    const m = t.match(/\babstract\b[\s.:—-]*/i);
    if (!m) return null;
    let rest = t.slice(m.index + m[0].length);
    const stop = rest.search(/\b(1\.?\s+Introduction|I\.\s+Introduction|Introduction\b|Keywords\b|Index Terms\b)/);
    if (stop > 200) rest = rest.slice(0, stop);
    return rest.slice(0, 1800).trim() || null;
  }

  destroy() {
    this.ac?.abort();
    try {
      this.viewer?.setDocument(null);
    } catch {
      // viewer already torn down
    }
    this.task?.destroy();
    this.scrollEl?.remove();
  }
}
