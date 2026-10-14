// Turns user input (arXiv ids, links, DOIs) into something we can download,
// and talks to the remote sites (arXiv API, arXiv HTML, OpenReview, publishers).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { HttpError, USER_AGENT, collapseWs, decodeEntities } from './util.js';
import { httpFetch } from './net.js';

const MAX_PDF_BYTES = 150 * 1024 * 1024;

const NEW_ID_RE = /(\d{4}\.\d{4,5})(v\d+)?/;
const OLD_ID_RE = /([a-z][a-z-]*(?:\.[a-z]{2})?\/\d{7})(v\d+)?/i;

// "math.GT/0309136" is really "math/0309136": the subject class is not part of old-style ids.
function canonicalOldId(id) {
  return id.replace(/^([a-z-]+)\.[a-z]{2}\//i, '$1/');
}

function arxivFromPath(p) {
  const m = p.match(NEW_ID_RE);
  if (m) return { kind: 'arxiv', id: m[1], version: m[2] || '' };
  const o = p.match(OLD_ID_RE);
  if (o) return { kind: 'arxiv', id: canonicalOldId(o[1]), version: o[2] || '' };
  return null;
}

export function parseInput(raw) {
  const input = String(raw || '').trim();
  if (!input) throw new HttpError(400, 'import.empty');

  const bare = input.replace(/^arxiv\s*:\s*/i, '');
  let m = bare.match(/^(\d{4}\.\d{4,5})(v\d+)?$/);
  if (m) return { kind: 'arxiv', id: m[1], version: m[2] || '' };
  m = bare.match(/^([a-z][a-z-]*(?:\.[a-z]{2})?\/\d{7})(v\d+)?$/i);
  if (m) return { kind: 'arxiv', id: canonicalOldId(m[1]), version: m[2] || '' };

  const doi = input.replace(/^(doi:\s*|https?:\/\/(dx\.)?doi\.org\/)/i, '');
  if (/^10\.\d{4,9}\/\S+$/.test(doi)) {
    const ax = doi.match(/^10\.48550\/arxiv\.(.+)$/i);
    if (ax) return parseInput(ax[1]);
    return { kind: 'doi', doi };
  }

  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new HttpError(400, 'import.unrecognized');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'import.httpOnly');
  }
  if (!url.hostname.includes('.')) {
    throw new HttpError(400, 'import.unrecognized');
  }
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  const p = decodeURIComponent(url.pathname);
  const arxivLike =
    host === 'arxiv.org' ||
    host.endsWith('.arxiv.org') ||
    host === 'ar5iv.org' ||
    host === 'alphaxiv.org' ||
    host.endsWith('.alphaxiv.org') ||
    host === 'papers.cool' ||
    ((host === 'huggingface.co' || host === 'hf.co') && p.startsWith('/papers/'));
  if (arxivLike) {
    const a = arxivFromPath(p);
    if (a) return a;
  }
  if (host === 'openreview.net') {
    const id = url.searchParams.get('id');
    if (id && /^[\w-]{4,40}$/.test(id)) return { kind: 'openreview', id };
  }
  if (host === 'aclanthology.org') {
    const a = p.match(/^\/([A-Za-z0-9.-]+?)(?:\.pdf)?\/?$/);
    // The landing page carries citation_* metadata and points at the PDF.
    if (a) return { kind: 'url', url: `https://aclanthology.org/${a[1]}/`, source: 'acl', sourceId: a[1] };
  }
  return { kind: 'url', url: url.toString() };
}

async function fetchRemote(url, { timeoutMs = 30000, accept } = {}) {
  let res;
  try {
    res = await httpFetch(url, {
      headers: { 'User-Agent': USER_AGENT, ...(accept ? { Accept: accept } : {}) },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const host = new URL(url).hostname;
    if (err.name === 'TimeoutError') throw retryable(new HttpError(502, 'net.timeout', { host }));
    throw retryable(new HttpError(502, 'net.unreachable', { host, reason: err.cause?.code || err.message }));
  }
  return res;
}

function retryable(err) {
  err.retryable = true;
  return err;
}

// One more attempt for dropped connections and timeouts; HTTP errors are final.
async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!err.retryable) throw err;
    await new Promise((r) => setTimeout(r, 800));
    return fn();
  }
}

function refusedError(url, status) {
  const host = new URL(url).hostname;
  if (host.endsWith('openreview.net')) {
    return new HttpError(502, 'dl.openreview');
  }
  if (status === 404) return new HttpError(404, 'dl.notFound', { host });
  if (status === 401 || status === 403 || status === 429) return new HttpError(502, 'dl.refused', { host, status });
  return new HttpError(502, 'dl.failed', { host, status });
}

async function readLimitedText(res, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    chunks.push(Buffer.from(chunk));
    if (size > maxBytes) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Streams a response body to `file`, enforcing the size limit and checking the PDF signature.
async function saveResponseAsPdf(res, file) {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_PDF_BYTES) throw new HttpError(413, 'dl.tooLarge');
  const handle = await fs.open(file, 'w');
  const hash = crypto.createHash('sha1');
  let size = 0;
  let head = Buffer.alloc(0);
  try {
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk);
      size += buf.length;
      if (size > MAX_PDF_BYTES) throw new HttpError(413, 'dl.tooLarge');
      if (head.length < 1024) head = Buffer.concat([head, buf]).subarray(0, 1024);
      hash.update(buf);
      await handle.write(buf);
    }
  } catch (err) {
    await handle.close();
    await fs.rm(file, { force: true });
    if (err instanceof HttpError) throw err;
    throw retryable(new HttpError(502, 'dl.interrupted', { reason: err.message }));
  }
  await handle.close();
  if (!head.includes('%PDF-')) {
    await fs.rm(file, { force: true });
    throw new HttpError(422, 'dl.notPdf');
  }
  return { size, sha1: hash.digest('hex') };
}

function looksLikePdf(res) {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  return ct.includes('pdf') || ct.includes('octet-stream');
}

// Attribute values may be double-quoted, single-quoted or bare (e.g. ACL Anthology).
function attrsOf(tag) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let m;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

function parseMetaTags(html) {
  const out = new Map();
  for (const tag of html.match(/<meta\s[^>]*>/gi) || []) {
    const attrs = attrsOf(tag);
    const name = (attrs.name || attrs.property || '').toLowerCase();
    const content = attrs.content;
    if (!name || content == null) continue;
    if (!out.has(name)) out.set(name, []);
    out.get(name).push(collapseWs(decodeEntities(content)));
  }
  return out;
}

function metaFromHtml(html) {
  const tags = parseMetaTags(html);
  const first = (...names) => {
    for (const n of names) if (tags.get(n)?.[0]) return tags.get(n)[0];
    return '';
  };
  return {
    title: first('citation_title', 'dc.title', 'og:title'),
    authors: (tags.get('citation_author') || tags.get('dc.creator') || []).slice(0, 50),
    // Generic page descriptions are often an author list or a teaser; only trust long ones.
    abstract: first('citation_abstract', 'dc.description') || [first('description'), first('og:description')].find((d) => d.length > 300) || '',
    published: first('citation_publication_date', 'citation_date', 'dc.date'),
    pdfUrl: first('citation_pdf_url'),
  };
}

// Downloads a PDF from any URL. If the URL is a landing page, follows its
// `citation_pdf_url` meta tag (the convention Google Scholar indexes).
export function downloadPdfFromUrl(url, file) {
  return withRetry(() => downloadPdfOnce(url, file));
}

async function downloadPdfOnce(url, file) {
  let res = await fetchRemote(url, { timeoutMs: 60000, accept: 'application/pdf,text/html;q=0.9,*/*;q=0.8' });
  if (!res.ok) throw refusedError(url, res.status);
  let meta = {};
  if (!looksLikePdf(res)) {
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('html')) {
      // Some servers mislabel PDFs; let the signature check decide.
      const saved = await saveResponseAsPdf(res, file);
      return { ...saved, finalUrl: res.url, meta };
    }
    const html = await readLimitedText(res, 3 * 1024 * 1024);
    meta = metaFromHtml(html);
    if (!meta.pdfUrl) {
      if (new URL(res.url).hostname.endsWith('openreview.net')) throw refusedError(res.url, 403);
      throw new HttpError(422, 'dl.noPdfLink');
    }
    const pdfUrl = new URL(meta.pdfUrl, res.url).toString();
    res = await fetchRemote(pdfUrl, { timeoutMs: 60000, accept: 'application/pdf,*/*;q=0.8' });
    if (!res.ok) throw refusedError(pdfUrl, res.status);
  }
  const saved = await saveResponseAsPdf(res, file);
  return { ...saved, finalUrl: res.url, meta };
}

export async function fetchArxivMeta(id, version = '') {
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id + version)}&max_results=1`;
  try {
    const res = await fetchRemote(url, { timeoutMs: 15000 });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const xml = await res.text();
    const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
    if (!entry) return null;
    const pick = (tag) => collapseWs(decodeEntities(entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] || ''));
    const title = pick('title');
    if (!title || title === 'Error') return null;
    const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((a) => collapseWs(decodeEntities(a[1])));
    const absId = pick('id');
    return {
      title,
      authors,
      abstract: pick('summary'),
      published: pick('published').slice(0, 10),
      version: absId.match(/v(\d+)$/)?.[0] || version,
      category: entry.match(/<arxiv:primary_category[^>]*term="([^"]+)"/)?.[1] || '',
    };
  } catch {
    // The listing page carries the same data in citation_* meta tags.
    try {
      const res = await fetchRemote(`https://arxiv.org/abs/${id}${version}`, { timeoutMs: 15000 });
      if (!res.ok) return null;
      const meta = metaFromHtml(await readLimitedText(res, 2 * 1024 * 1024));
      if (!meta.title) return null;
      return { title: meta.title, authors: meta.authors, abstract: meta.abstract, published: meta.published, version, category: '' };
    } catch {
      return null;
    }
  }
}

export async function downloadArxivPdf(id, version, file) {
  const urls = [`https://arxiv.org/pdf/${id}${version}`, `https://export.arxiv.org/pdf/${id}${version}`];
  let lastErr;
  for (const url of urls) {
    try {
      return await withRetry(async () => {
        const res = await fetchRemote(url, { timeoutMs: 90000, accept: 'application/pdf' });
        if (res.status === 404) throw new HttpError(404, 'arxiv.notFound', { id: id + version });
        if (!res.ok) throw new HttpError(502, 'arxiv.status', { status: res.status });
        const saved = await saveResponseAsPdf(res, file);
        return { ...saved, finalUrl: res.url };
      });
    } catch (err) {
      lastErr = err;
      if (err.status === 404) break;
    }
  }
  throw lastErr;
}

// arXiv renders most LaTeX submissions to HTML; ar5iv covers older papers.
export async function fetchArxivHtml(id, version = '') {
  const candidates = [
    { url: `https://arxiv.org/html/${id}${version}`, source: 'arxiv' },
    { url: `https://ar5iv.labs.arxiv.org/html/${id}${version}`, source: 'ar5iv' },
  ];
  for (const c of candidates) {
    try {
      const res = await fetchRemote(c.url, { timeoutMs: 45000, accept: 'text/html' });
      if (!res.ok) continue;
      const html = await readLimitedText(res, 25 * 1024 * 1024);
      if (!html.includes('ltx_document')) continue;
      let baseUrl = res.url;
      const baseHref = html.match(/<base\s[^>]*href\s*=\s*["']([^"']+)["']/i)?.[1];
      if (baseHref) baseUrl = new URL(baseHref, res.url).toString();
      return { html, baseUrl, source: c.source };
    } catch {
      // try the next source
    }
  }
  return null;
}

export async function fetchOpenReviewMeta(id) {
  try {
    const res = await fetchRemote(`https://api2.openreview.net/notes?id=${encodeURIComponent(id)}`, { timeoutMs: 15000 });
    if (!res.ok) return null;
    const data = await res.json();
    const c = data?.notes?.[0]?.content;
    if (!c) return null;
    const val = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : x);
    return {
      title: collapseWs(String(val(c.title) || '')),
      authors: (val(c.authors) || []).map(String),
      abstract: collapseWs(String(val(c.abstract) || '')),
      published: '',
    };
  } catch {
    return null;
  }
}

// Only files under the paper's own HTML location may be proxied.
export async function fetchAsset(url) {
  const res = await fetchRemote(url, { timeoutMs: 30000, accept: 'image/*,*/*;q=0.5' });
  if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, 'asset.failed', { status: res.status });
  const type = res.headers.get('content-type') || 'application/octet-stream';
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 30 * 1024 * 1024) throw new HttpError(413, 'asset.tooLarge');
  return { type, buf };
}
