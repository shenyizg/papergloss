import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream';
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
  // Other sites can only send a JSON content type after a CORS preflight, which this
  // server never grants, so plain form posts from elsewhere stop here.
  const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'] != null;
  if (hasBody && !/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) {
    throw new HttpError(415, 'common.needJson');
  }
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

// Streams a file (or a byte range of it) after the headers are written. pipeline() closes
// the file when the client goes away mid-download; pipe() would leave it open for good.
export function sendFile(req, res, file, range) {
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  pipeline(createReadStream(file, range), res, () => {});
}

export function sendError(req, res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  if (res.headersSent) {
    res.end();
    return;
  }
  const lang = reqLang(req);
  // Only messages written for users go out; anything else may carry paths or internals.
  const message = err.key ? tr(lang, err.key, err.params) : tr(lang, 'common.internal');
  sendJson(req, res, status, { error: message, code: err.code });
}

// Every value sent for one cookie name. A parent domain can set a cookie with the same
// name, and a malformed value from another app must not break the request.
export function cookieValues(header, name) {
  const out = [];
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== name) continue;
    const raw = part.slice(i + 1).trim();
    try {
      out.push(decodeURIComponent(raw));
    } catch {
      out.push(raw);
    }
  }
  return out;
}

const fromCodePoint = (n) => (n <= 0x10ffff ? String.fromCodePoint(n) : '\uFFFD');

export function decodeEntities(str = '') {
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => fromCodePoint(Number(d)))
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
