import { api, uploadPaper } from './api.js';
import { icon } from './icons.js';
import { openSettings } from './settings.js';
import { confirmDialog, h, iconButton, openMenu, timeAgo, toast } from './ui.js';
import { t } from './i18n.js';

const SOURCE_LABEL = { arxiv: 'arXiv', openreview: 'OpenReview', acl: 'ACL', doi: 'DOI' };
const EXAMPLES = ['2401.04088', 'arxiv.org/abs/1706.03762', 'aclanthology.org/2023.acl-long.1', '10.48550/arXiv.2005.14165'];

function sourceLabel(source) {
  if (source === 'upload') return t('source.upload');
  return SOURCE_LABEL[source] || t('source.url');
}

// First author's family name: "Jiang, Albert Q." and "Albert Q. Jiang" both give "Jiang".
function authorsLine(authors = []) {
  if (!authors.length) return '';
  const a = authors[0].trim();
  const family = a.includes(',') ? a.split(',')[0].trim() : a.split(/\s+/).pop();
  return authors.length > 1 ? t('home.etAl', { name: family }) : a;
}

export async function renderHome(root) {
  document.title = t('app.name');
  const input = h('input', {
    class: 'input',
    type: 'text',
    inputmode: 'url',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'go',
    placeholder: t('home.inputPlaceholder'),
    'aria-label': t('home.inputPlaceholder'),
  });
  const openBtn = h('button', { class: 'btn btn-primary', type: 'submit', text: t('home.open') });
  const errorEl = h('div', { class: 'import-error', hidden: true });
  const form = h('form', { class: 'import-form' }, h('div', { class: 'input-wrap', html: icon('link') }, input), openBtn);

  const fileInput = h('input', { type: 'file', accept: 'application/pdf,.pdf', hidden: true });
  const progress = h('div', { class: 'progress' });
  const uploadLabel = h('span', { html: `${icon('upload')}<span>${t('home.upload')}</span>` });
  const uploadBtn = h('button', { class: 'upload-btn', type: 'button' }, progress, uploadLabel);
  uploadBtn.addEventListener('click', () => fileInput.click());

  const examples = h('div', { class: 'examples' }, h('span', { text: t('home.examples') }));
  for (const ex of EXAMPLES) {
    const chip = h('button', { class: 'chip', type: 'button', text: ex });
    chip.addEventListener('click', () => {
      input.value = ex;
      input.focus();
    });
    examples.append(chip);
  }

  const listEl = h('div', { class: 'paper-list' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));
  const countEl = h('span', { class: 'count' });
  const el = h(
    'main',
    { class: 'home' },
    h(
      'header',
      { class: 'home-header' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark', html: icon('book') }), h('span', { text: t('app.name') })),
      iconButton('sliders', { title: t('common.settings'), onClick: () => openSettings() }),
    ),
    h(
      'section',
      { class: 'hero' },
      h('h1', { text: t('home.title') }),
      h('p', { class: 'sub', text: t('home.sub') }),
      form,
      errorEl,
      h('div', { class: 'or-divider', text: t('home.or') }),
      uploadBtn,
      fileInput,
      examples,
    ),
    h('div', { class: 'section-title' }, h('span', { text: t('home.recent') }), countEl),
    listEl,
  );
  root.append(el);

  const setBusy = (busy, text = t('home.open')) => {
    openBtn.disabled = busy;
    input.disabled = busy;
    uploadBtn.disabled = busy;
    openBtn.replaceChildren(...(busy ? [h('span', { class: 'spinner' }), h('span', { text })] : [h('span', { text })]));
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (!value) {
      input.focus();
      return;
    }
    errorEl.hidden = true;
    setBusy(true, t('home.downloading'));
    try {
      const { paper } = await api.importPaper(value);
      location.hash = `#/read/${encodeURIComponent(paper.id)}`;
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      setBusy(false);
    }
  });

  const handleFile = async (file) => {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      toast(t('home.choosePdf'), { type: 'error' });
      return;
    }
    errorEl.hidden = true;
    setBusy(true);
    uploadLabel.innerHTML = `${icon('upload')}<span>${t('home.uploading', { n: 0 })}</span>`;
    try {
      const { paper } = await uploadPaper(file, (f) => {
        progress.style.width = `${Math.round(f * 100)}%`;
        uploadLabel.innerHTML = `${icon('upload')}<span>${t('home.uploading', { n: Math.round(f * 100) })}</span>`;
      });
      location.hash = `#/read/${encodeURIComponent(paper.id)}`;
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      setBusy(false);
      progress.style.width = '0';
      uploadLabel.innerHTML = `${icon('upload')}<span>${t('home.upload')}</span>`;
    }
  };
  fileInput.addEventListener('change', () => handleFile(fileInput.files?.[0]));

  // Desktop: drop a PDF anywhere on the page.
  const onDragOver = (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) {
      e.preventDefault();
      el.classList.add('dragging');
    }
  };
  const onDragLeave = (e) => {
    if (e.target === document.documentElement || !e.relatedTarget) el.classList.remove('dragging');
  };
  const onDrop = (e) => {
    e.preventDefault();
    el.classList.remove('dragging');
    handleFile(e.dataTransfer?.files?.[0]);
  };
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);

  const renderList = (papers) => {
    countEl.textContent = papers.length ? t('home.count', { n: papers.length }) : '';
    if (!papers.length) {
      listEl.replaceChildren(h('div', { class: 'empty', text: t('home.empty') }));
      return;
    }
    listEl.replaceChildren();
    for (const p of papers) {
      const tag = h('span', { class: `src-tag ${p.source}`, text: sourceLabel(p.source) });
      const meta = h('div', { class: 'm' }, tag);
      if (p.source === 'arxiv') meta.append(h('span', { text: p.sourceId }));
      const authors = authorsLine(p.authors);
      if (authors) meta.append(h('span', { class: 'authors', text: authors }));
      meta.append(h('span', { text: timeAgo(p.lastOpenedAt || p.createdAt) }));
      const more = iconButton('more', { title: t('home.moreActions'), className: 'more' });
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        openMenu(more, [
          p.absUrl ? { icon: 'external', label: t('common.openSource'), onClick: () => window.open(p.absUrl, '_blank', 'noopener') } : null,
          { icon: 'download', label: t('common.downloadPdf'), onClick: () => window.open(api.pdfDownloadUrl(p.id), '_blank') },
          'sep',
          {
            icon: 'trash',
            label: t('common.delete'),
            danger: true,
            onClick: async () => {
              const ok = await confirmDialog({ title: t('home.deleteTitle'), message: t('home.deleteMsg'), okText: t('common.delete'), danger: true });
              if (!ok) return;
              try {
                await api.deletePaper(p.id);
                papers.splice(papers.indexOf(p), 1);
                renderList(papers);
              } catch (err) {
                toast(err.message, { type: 'error' });
              }
            },
          },
        ]);
      });
      const card = h('article', { class: 'paper-card', role: 'link', tabindex: '0' }, h('div', {}, h('div', { class: 't', text: p.title }), meta), more);
      const open = () => (location.hash = `#/read/${encodeURIComponent(p.id)}`);
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => e.key === 'Enter' && open());
      listEl.append(card);
    }
  };

  api
    .listPapers()
    .then(({ papers }) => renderList(papers))
    .catch((err) => listEl.replaceChildren(h('div', { class: 'empty', text: t('common.loadFailed', { msg: err.message }) })));

  return {
    destroy() {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    },
  };
}
