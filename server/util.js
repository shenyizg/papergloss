import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { reqLang, tr } from './i18n.js';

export const USER_AGENT = 'PaperGloss/0.1 (+https://github.com/shenyizg/papergloss)';

// `key` names a message in i18n.js; it's rendered in the caller's language when sent.
export class HttpError extends Error {
  constructor(status, key, params = {}, code) {
    super(key);
    this.status = status;
    this.key = key;
    this.params = params;
    this.code = code;
  }
}

export function randomId(len = 16) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export function sha1(data) {
  return crypto.createHash('sha1').update(data).digest('hex');
}

export async function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// Write to a temp file first so a crash never leaves half-written JSON behind.
export async function writeJsonFile(file, data, { mode } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomId(6)}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), mode ? { mode } : undefined);
  await fs.rename(tmp, file);
}

export async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'common.tooLarge'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req, limit = 1024 * 1024) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'common.badJson');
  }
}

function acceptsGzip(req) {
  return /\bgzip\b/.test(req.headers['accept-encoding'] || '');
}

export function sendJson(req, res, status, data, headers = {}) {
  let body = Buffer.from(JSON.stringify(data));
  const h = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  };
  if (body.length > 2048 && acceptsGzip(req)) {
    body = zlib.gzipSync(body, { level: 6 });
    h['Content-Encoding'] = 'gzip';
    h.Vary = 'Accept-Encoding';
  }
  h['Content-Length'] = body.length;
  res.writeHead(status, h);
  res.end(body);
}

export function sendError(req, res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  if (res.headersSent) {
    res.end();
    return;
  }
  const lang = reqLang(req);
  const message = err.key ? tr(lang, err.key, err.params) : err.message || tr(lang, 'common.internal');
  sendJson(req, res, status, { error: message, code: err.code });
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function decodeEntities(str = '') {
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

export function collapseWs(str = '') {
  return str.replace(/\s+/g, ' ').trim();
}

// Per-key promise chain so read-modify-write sequences on one file never interleave.
const locks = new Map();
export function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  locks.set(key, tail);
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return next;
}
