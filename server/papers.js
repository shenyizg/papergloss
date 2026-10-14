import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { PAPERS_DIR, TMP_DIR } from './config.js';
import { HttpError, collapseWs, exists, randomId, readJsonFile, sha1, withLock, writeJsonFile } from './util.js';
import { tr } from './i18n.js';
import {
  downloadArxivPdf,
  downloadPdfFromUrl,
  fetchArxivHtml,
  fetchArxivMeta,
  fetchAsset,
  fetchOpenReviewMeta,
  parseInput,
} from './sources.js';

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,119}$/i;
const THREAD_ID_RE = /^[a-z0-9_-]{6,48}$/i;
const MAX_UPLOAD = 150 * 1024 * 1024;

export function checkId(id) {
  if (!ID_RE.test(id) || id.includes('..')) throw new HttpError(400, 'paper.badId');
  return id;
}

const dirOf = (id) => path.join(PAPERS_DIR, checkId(id));
const metaFile = (id) => path.join(dirOf(id), 'meta.json');
export const pdfFile = (id) => path.join(dirOf(id), 'paper.pdf');
const htmlFile = (id) => path.join(dirOf(id), 'paper.html');

export async function getMeta(id) {
  const meta = await readJsonFile(metaFile(id));
  if (!meta) throw new HttpError(404, 'paper.notFound');
  return meta;
}

async function saveMeta(meta) {
  await writeJsonFile(metaFile(meta.id), meta);
  return meta;
}

export function updateMeta(id, fn) {
  return withLock(`meta:${id}`, async () => {
    const meta = await getMeta(id);
    const next = (await fn(meta)) || meta;
    return saveMeta(next);
  });
}

export async function listPapers() {
  let names = [];
  try {
    names = await fsp.readdir(PAPERS_DIR);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const metas = [];
  for (const name of names) {
    if (!ID_RE.test(name)) continue;
    const meta = await readJsonFile(path.join(PAPERS_DIR, name, 'meta.json'));
    if (meta) metas.push(meta);
  }
  metas.sort((a, b) => (b.lastOpenedAt || b.createdAt).localeCompare(a.lastOpenedAt || a.createdAt));
  return metas.map(summary);
}

function summary(meta) {
  const { abstract, progress, ...rest } = meta;
  return rest;
}

function newTmpPath() {
  return path.join(TMP_DIR, `${Date.now()}-${randomId(8)}.part`);
}

async function finalizePdf(id, tmp) {
  await fsp.mkdir(dirOf(id), { recursive: true });
  await fsp.rename(tmp, pdfFile(id));
}

function now() {
  return new Date().toISOString();
}

// ---- import --------------------------------------------------------------

const inflight = new Map();

export async function importFromInput(input, lang = 'zh') {
  const parsed = parseInput(input);
  const key = JSON.stringify(parsed);
  if (inflight.has(key)) return inflight.get(key);
  const job = doImport(parsed, lang).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function existingOrNull(id) {
  if (!(await exists(metaFile(id))) || !(await exists(pdfFile(id)))) return null;
  return updateMeta(id, (m) => {
    m.lastOpenedAt = now();
  });
}

async function doImport(parsed, lang) {
  await fsp.mkdir(TMP_DIR, { recursive: true });
  if (parsed.kind === 'arxiv') return importArxiv(parsed.id, parsed.version);
  if (parsed.kind === 'openreview') return importOpenReview(parsed.id);
  if (parsed.kind === 'doi') {
    return importUrl(`https://doi.org/${parsed.doi}`, { source: 'doi', sourceId: parsed.doi, idKey: `doi:${parsed.doi.toLowerCase()}`, lang });
  }
  return importUrl(parsed.url, { source: parsed.source || 'url', sourceId: parsed.sourceId || '', lang });
}

async function importArxiv(arxivId, version) {
  const id = `arxiv-${arxivId.replace('/', '_')}${version}`;
  const existing = await existingOrNull(id);
  if (existing) return existing;

  const tmp = newTmpPath();
  const [meta, pdf] = await Promise.all([fetchArxivMeta(arxivId, version), downloadArxivPdf(arxivId, version, tmp)]);
  await finalizePdf(id, tmp);
  const record = {
    id,
    source: 'arxiv',
    sourceId: arxivId,
    version: meta?.version || version || '',
    title: meta?.title || arxivId,
    titleSource: meta?.title ? 'source' : 'id',
    authors: meta?.authors || [],
    abstract: meta?.abstract || '',
    published: meta?.published || '',
    category: meta?.category || '',
    absUrl: `https://arxiv.org/abs/${arxivId}${version}`,
    pdfUrl: pdf.finalUrl,
    fileSize: pdf.size,
    createdAt: now(),
    lastOpenedAt: now(),
    html: { status: 'unknown' },
  };
  await saveMeta(record);
  // Prefetch the HTML rendering in the background; the reader asks for it later.
  ensureHtml(id).catch(() => {});
  return record;
}

async function importOpenReview(orId) {
  const id = `openreview-${orId}`.slice(0, 120);
  const existing = await existingOrNull(id);
  if (existing) return existing;
  const tmp = newTmpPath();
  const pdfUrl = `https://openreview.net/pdf?id=${encodeURIComponent(orId)}`;
  const [meta, pdf] = await Promise.all([fetchOpenReviewMeta(orId), downloadPdfFromUrl(pdfUrl, tmp)]);
  await finalizePdf(id, tmp);
  return saveMeta({
    id,
    source: 'openreview',
    sourceId: orId,
    title: meta?.title || `OpenReview ${orId}`,
    titleSource: meta?.title ? 'source' : 'id',
    authors: meta?.authors || [],
    abstract: meta?.abstract || '',
    published: '',
    absUrl: `https://openreview.net/forum?id=${encodeURIComponent(orId)}`,
    pdfUrl,
    fileSize: pdf.size,
    createdAt: now(),
    lastOpenedAt: now(),
    html: { status: 'none' },
  });
}

async function importUrl(url, { source, sourceId, idKey, lang }) {
  const id = `${source === 'doi' ? 'doi' : 'url'}-${sha1(idKey || url).slice(0, 12)}`;
  const existing = await existingOrNull(id);
  if (existing) return existing;
  const tmp = newTmpPath();
  const pdf = await downloadPdfFromUrl(url, tmp);
  await finalizePdf(id, tmp);
  let fallbackTitle = new URL(pdf.finalUrl).pathname.split('/').pop() || '';
  try {
    fallbackTitle = decodeURIComponent(fallbackTitle);
  } catch {
    // keep it encoded
  }
  fallbackTitle = fallbackTitle.replace(/\.pdf$/i, '');
  return saveMeta({
    id,
    source,
    sourceId,
    title: pdf.meta.title || fallbackTitle || tr(lang, 'paper.untitled'),
    titleSource: pdf.meta.title ? 'source' : 'filename',
    authors: pdf.meta.authors || [],
    abstract: pdf.meta.abstract || '',
    published: pdf.meta.published || '',
    absUrl: url,
    pdfUrl: pdf.finalUrl,
    fileSize: pdf.size,
    createdAt: now(),
    lastOpenedAt: now(),
    html: { status: 'none' },
  });
}

export async function importUpload(req, lang = 'zh') {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD) throw new HttpError(413, 'dl.tooLarge');
  let fileName = 'paper.pdf';
  try {
    fileName = decodeURIComponent(String(req.headers['x-file-name'] || 'paper.pdf'));
  } catch {
    // keep the default
  }
  await fsp.mkdir(TMP_DIR, { recursive: true });
  const tmp = newTmpPath();
  const hash = crypto.createHash('sha1');
  let size = 0;
  let head = Buffer.alloc(0);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD) {
        req.destroy();
        out.destroy();
        reject(new HttpError(413, 'dl.tooLarge'));
        return;
      }
      if (head.length < 1024) head = Buffer.concat([head, chunk]).subarray(0, 1024);
      hash.update(chunk);
      if (!out.write(chunk)) {
        req.pause();
        out.once('drain', () => req.resume());
      }
    });
    req.on('end', () => out.end(resolve));
    req.on('close', () => {
      if (!req.complete) {
        out.destroy();
        reject(new HttpError(400, 'upload.interrupted'));
      }
    });
    req.on('error', reject);
    out.on('error', reject);
  }).catch(async (err) => {
    await fsp.rm(tmp, { force: true });
    throw err;
  });
  if (!head.includes('%PDF-')) {
    await fsp.rm(tmp, { force: true });
    throw new HttpError(422, 'upload.notPdf');
  }
  const id = `pdf-${hash.digest('hex').slice(0, 12)}`;
  const existing = await existingOrNull(id);
  if (existing) {
    await fsp.rm(tmp, { force: true });
    return existing;
  }
  await finalizePdf(id, tmp);
  const title = collapseWs(fileName.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ')) || tr(lang, 'paper.untitled');
  return saveMeta({
    id,
    source: 'upload',
    sourceId: fileName,
    title,
    titleSource: 'filename',
    authors: [],
    abstract: '',
    published: '',
    absUrl: '',
    pdfUrl: '',
    fileSize: size,
    createdAt: now(),
    lastOpenedAt: now(),
    html: { status: 'none' },
  });
}

// ---- metadata edits --------------------------------------------------------

export async function patchPaper(id, patch = {}) {
  return updateMeta(id, (m) => {
    if (typeof patch.title === 'string' && patch.title.trim()) {
      m.title = collapseWs(patch.title).slice(0, 500);
      m.titleSource = patch.titleSource === 'pdf' ? 'pdf' : 'user';
    }
    if (Array.isArray(patch.authors) && (!m.authors || !m.authors.length)) {
      m.authors = patch.authors.slice(0, 50).map((a) => String(a).slice(0, 200));
    }
    if (typeof patch.abstract === 'string' && !m.abstract) m.abstract = patch.abstract.slice(0, 5000);
    if (patch.progress && typeof patch.progress === 'object') {
      const raw = JSON.stringify(patch.progress);
      if (raw.length < 4000) m.progress = { ...(m.progress || {}), ...patch.progress };
    }
    if (patch.opened) m.lastOpenedAt = now();
    if (typeof patch.pages === 'number') m.pages = patch.pages;
  });
}

export async function deletePaper(id) {
  const dir = dirOf(id);
  if (!(await exists(dir))) throw new HttpError(404, 'paper.notFound');
  await fsp.rm(dir, { recursive: true, force: true });
}

// ---- HTML rendering ----------------------------------------------------------

const htmlJobs = new Map();

export function ensureHtml(id) {
  if (htmlJobs.has(id)) return htmlJobs.get(id);
  const job = (async () => {
    const meta = await getMeta(id);
    if (meta.source !== 'arxiv') return meta.html;
    if (meta.html?.status === 'ok' && (await exists(htmlFile(id)))) return meta.html;
    // Don't hammer arXiv for papers that have no HTML; retry after a day.
    if (meta.html?.status === 'none' && Date.now() - Date.parse(meta.html.checkedAt || 0) < 24 * 3600_000) return meta.html;
    const res = await fetchArxivHtml(meta.sourceId, meta.version && meta.id.endsWith(meta.version) ? meta.version : '');
    let html;
    if (res) {
      await fsp.writeFile(htmlFile(id), res.html);
      html = { status: 'ok', baseUrl: res.baseUrl, source: res.source, checkedAt: now() };
    } else {
      html = { status: 'none', checkedAt: now() };
    }
    await updateMeta(id, (m) => {
      m.html = html;
    });
    return html;
  })().finally(() => htmlJobs.delete(id));
  htmlJobs.set(id, job);
  return job;
}

export async function readHtml(id) {
  const info = await ensureHtml(id);
  if (info?.status !== 'ok') return null;
  return { html: await fsp.readFile(htmlFile(id), 'utf8'), baseUrl: info.baseUrl, source: info.source };
}

const ASSET_HOSTS = new Set(['arxiv.org', 'www.arxiv.org', 'ar5iv.labs.arxiv.org', 'ar5iv.org', 'static.arxiv.org']);

export async function getAsset(id, url) {
  const meta = await getMeta(id);
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new HttpError(400, 'asset.badUrl');
  }
  if (u.protocol !== 'https:' || !ASSET_HOSTS.has(u.hostname) || meta.html?.status !== 'ok') {
    throw new HttpError(403, 'asset.forbidden');
  }
  const dir = path.join(dirOf(id), 'assets');
  const key = sha1(u.toString());
  const file = path.join(dir, key);
  const cached = await readJsonFile(`${file}.json`);
  if (cached && (await exists(file))) return { type: cached.type, file };
  const { type, buf } = await fetchAsset(u.toString());
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(file, buf);
  await writeJsonFile(`${file}.json`, { type, url: u.toString() });
  return { type, file };
}

// ---- AI threads ------------------------------------------------------------------

const threadsDir = (id) => path.join(dirOf(id), 'threads');

function checkThreadId(tid) {
  if (!THREAD_ID_RE.test(tid)) throw new HttpError(400, 'thread.badId');
  return tid;
}

export async function listThreads(id) {
  let names = [];
  try {
    names = await fsp.readdir(threadsDir(id));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const t = await readJsonFile(path.join(threadsDir(id), name));
    if (!t) continue;
    const firstAnswer = t.messages?.find((m) => m.role === 'assistant' && !m.error)?.content || '';
    out.push({
      id: t.id,
      kind: t.kind,
      action: t.action,
      title: t.title || '',
      quote: (t.quote?.text || '').slice(0, 300),
      hasImage: !!t.quote?.image,
      location: t.quote?.location || null,
      preview: String(firstAnswer).slice(0, 200),
      turns: (t.messages || []).filter((m) => m.role === 'user').length,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    });
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out;
}

export async function getThread(id, tid) {
  const t = await readJsonFile(path.join(threadsDir(id), `${checkThreadId(tid)}.json`));
  if (!t) throw new HttpError(404, 'thread.notFound');
  return t;
}

export async function saveThread(id, tid, thread) {
  await getMeta(id);
  if (!thread || typeof thread !== 'object' || !Array.isArray(thread.messages)) throw new HttpError(400, 'thread.bad');
  thread.id = checkThreadId(tid);
  thread.updatedAt = now();
  thread.createdAt ||= thread.updatedAt;
  await writeJsonFile(path.join(threadsDir(id), `${tid}.json`), thread);
  return { id: tid, updatedAt: thread.updatedAt };
}

export async function deleteThread(id, tid) {
  await fsp.rm(path.join(threadsDir(id), `${checkThreadId(tid)}.json`), { force: true });
}
