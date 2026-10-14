import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT_DIR } from './config.js';
import { sendFile } from './util.js';

const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const NM = path.join(ROOT_DIR, 'node_modules');

// URL prefix -> directory on disk. Order matters: first match wins.
const MOUNTS = [
  ['/vendor/pdfjs/build/', path.join(NM, 'pdfjs-dist/legacy/build')],
  ['/vendor/pdfjs/web/', path.join(NM, 'pdfjs-dist/legacy/web')],
  ['/vendor/pdfjs/cmaps/', path.join(NM, 'pdfjs-dist/cmaps')],
  ['/vendor/pdfjs/standard_fonts/', path.join(NM, 'pdfjs-dist/standard_fonts')],
  ['/vendor/pdfjs/wasm/', path.join(NM, 'pdfjs-dist/wasm')],
  ['/vendor/pdfjs/iccs/', path.join(NM, 'pdfjs-dist/iccs')],
  ['/vendor/katex/', path.join(NM, 'katex/dist')],
  ['/vendor/marked/', path.join(NM, 'marked/lib')],
  ['/vendor/dompurify/', path.join(NM, 'dompurify/dist')],
  ['/', PUBLIC_DIR],
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.pfb': 'application/octet-stream',
  '.bcmap': 'application/octet-stream',
  '.icc': 'application/octet-stream',
  '.wasm': 'application/wasm',
};

const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.map', '.webmanifest', '.ttf', '.wasm', '.bcmap', '.pfb']);

export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

// Compressed bodies are cached in memory, keyed by path + mtime + encoding.
const compressedCache = new Map();

function resolveFile(urlPath) {
  for (const [prefix, dir] of MOUNTS) {
    if (!urlPath.startsWith(prefix)) continue;
    let rel;
    try {
      rel = decodeURIComponent(urlPath.slice(prefix.length)) || 'index.html';
    } catch {
      return null;
    }
    const file = path.resolve(dir, rel);
    if (file !== dir && !file.startsWith(dir + path.sep)) return null;
    return { file, isVendor: prefix.startsWith('/vendor/') };
  }
  return null;
}

export async function serveStatic(req, res, urlPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  // The app shell handles its own routes (hash-based), so "/" is the only page.
  if (urlPath === '/' || urlPath === '/index.html') urlPath = '/index.html';
  const resolved = resolveFile(urlPath);
  if (!resolved) return false;
  let stat;
  try {
    stat = await fsp.stat(resolved.file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const ext = path.extname(resolved.file).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Last-Modified': stat.mtime.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': resolved.isVendor ? 'public, max-age=86400' : 'no-cache',
  };
  if (ext === '.html') {
    headers['Content-Security-Policy'] = CSP;
    headers['Referrer-Policy'] = 'no-referrer';
  }
  const ims = req.headers['if-modified-since'];
  if (ims && Math.floor(stat.mtimeMs / 1000) <= Math.floor(Date.parse(ims) / 1000)) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }

  const ae = req.headers['accept-encoding'] || '';
  const encoding = COMPRESSIBLE.has(ext) && stat.size > 1024 ? (/\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : null) : null;
  if (encoding) {
    const key = `${resolved.file}|${stat.mtimeMs}|${encoding}`;
    let body = compressedCache.get(key);
    if (!body) {
      const raw = await fsp.readFile(resolved.file);
      body =
        encoding === 'br'
          ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } })
          : zlib.gzipSync(raw, { level: 9 });
      compressedCache.set(key, body);
    }
    headers['Content-Encoding'] = encoding;
    headers.Vary = 'Accept-Encoding';
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  sendFile(req, res, resolved.file);
  return true;
}
