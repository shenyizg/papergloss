// Drag-to-select overlay used to capture a region of a PDF page (formulas, figures, tables).
import { h } from './ui.js';
import { t } from './i18n.js';

export function startCapture(stage, { onDone, onCancel }) {
  const layer = h('div', { class: 'capture-layer' });
  const rectEl = h('div', { class: 'capture-rect', hidden: true });
  const cancelBtn = h('button', { type: 'button' }, t('common.cancel'));
  const hint = h('div', { class: 'capture-hint' }, h('span', { text: t('capture.hint') }), cancelBtn);
  layer.append(rectEl);
  stage.append(layer, hint);

  let start = null;
  let current = null;
  const finish = (result) => {
    layer.remove();
    hint.remove();
    document.removeEventListener('keydown', onKey);
    if (result) onDone(result);
    else onCancel?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') finish(null);
  };
  document.addEventListener('keydown', onKey);
  cancelBtn.addEventListener('click', () => finish(null));

  const toLocal = (e) => {
    const r = layer.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, cx: e.clientX, cy: e.clientY };
  };
  layer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try {
      layer.setPointerCapture(e.pointerId);
    } catch {
      // synthetic or already-released pointers can't be captured; dragging still works
    }
    start = toLocal(e);
    current = start;
    rectEl.hidden = false;
    draw();
  });
  layer.addEventListener('pointermove', (e) => {
    if (!start) return;
    current = toLocal(e);
    draw();
  });
  layer.addEventListener('pointerup', () => {
    if (!start) return;
    const r = box();
    start = null;
    if (r.width < 16 || r.height < 12) {
      rectEl.hidden = true;
      return;
    }
    const lr = layer.getBoundingClientRect();
    finish({ left: lr.left + r.left, top: lr.top + r.top, right: lr.left + r.left + r.width, bottom: lr.top + r.top + r.height, width: r.width, height: r.height });
  });
  layer.addEventListener('pointercancel', () => {
    start = null;
    rectEl.hidden = true;
  });

  function box() {
    return {
      left: Math.min(start.x, current.x),
      top: Math.min(start.y, current.y),
      width: Math.abs(current.x - start.x),
      height: Math.abs(current.y - start.y),
    };
  }
  function draw() {
    const b = box();
    Object.assign(rectEl.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
  }
  return { cancel: () => finish(null) };
}
