import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, PAPERS_DIR, TMP_DIR, effectiveLlm, loadConfig, publicSettings, updateSettings } from './config.js';
import { changePassword, checkSession, forwardedHeader, login, logout, requireAuth } from './auth.js';
import { serveStatic } from './static.js';
import { HttpError, readJson, sendError, sendFile, sendJson } from './util.js';
import * as papers from './papers.js';
import { describeLlmError, listModels, streamChat } from './llm/index.js';
import { proxyDescription } from './net.js';
import { reqLang, tr } from './i18n.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

const routes = [];
function route(method, pattern, handler, { auth = true } = {}) {
  const keys = [];
  const source = pattern.replace(/:(\w+)/g, (_, k) => {
    keys.push(k);
    return '([^/]+)';
  });
  routes.push({ method, re: new RegExp(`^${source}$`), keys, handler, auth });
}

// ---- session & settings ---------------------------------------------------------------

route('GET', '/api/session', (req, res) => sendJson(req, res, 200, { authed: checkSession(req, res) }), { auth: false });

route(
  'POST',
  '/api/login',
  async (req, res) => {
    const body = await readJson(req);
    await login(req, res, body.password);
    sendJson(req, res, 200, { ok: true });
  },
  { auth: false },
);

route(
  'POST',
  '/api/logout',
  (req, res) => {
    logout(req, res);
    sendJson(req, res, 200, { ok: true });
  },
  { auth: false },
);

route('PUT', '/api/password', async (req, res) => {
  const body = await readJson(req);
  await changePassword(req, res, body.oldPassword, body.newPassword);
  sendJson(req, res, 200, { ok: true });
});

route('GET', '/api/settings', (req, res) => sendJson(req, res, 200, publicSettings()));

route('PUT', '/api/settings', async (req, res) => {
  const body = await readJson(req);
  sendJson(req, res, 200, await updateSettings(body));
});

// ---- LLM ------------------------------------------------------------------------------------

const ACTIONS = new Set(['translate', 'explain', 'ask', 'chat']);

function sanitizeMessages(list) {
  if (!Array.isArray(list) || !list.length || list.length > 200) throw new HttpError(400, 'llm.badMessages');
  return list.map((m) => {
    const role = m?.role === 'assistant' ? 'assistant' : 'user';
    let content;
    if (typeof m?.content === 'string') {
      content = m.content;
    } else if (Array.isArray(m?.content)) {
      content = m.content
        .map((p) => {
          if (p?.type === 'text' && typeof p.text === 'string') return { type: 'text', text: p.text };
          if (p?.type === 'image' && typeof p.data === 'string' && /^image\/(png|jpeg|webp|gif)$/.test(p.mediaType || '')) {
            return { type: 'image', mediaType: p.mediaType, data: p.data };
          }
          return null;
        })
        .filter(Boolean);
    } else {
      throw new HttpError(400, 'llm.badMessages');
    }
    const out = { role, content };
    if (role === 'assistant' && m.raw && typeof m.raw === 'object') out.raw = m.raw;
    return out;
  });
}

route('POST', '/api/llm/chat', async (req, res) => {
  const body = await readJson(req, 24 * 1024 * 1024);
  const action = ACTIONS.has(body.action) ? body.action : 'ask';
  const messages = sanitizeMessages(body.messages);
  if (messages[messages.length - 1].role !== 'user') throw new HttpError(400, 'llm.lastUser');
  const system = typeof body.system === 'string' ? body.system : '';
  const llm = effectiveLlm();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });
  const lang = reqLang(req);
  const send = (evt) => {
    if (evt.key) {
      // Adapter notices carry a message key; render it in the caller's language.
      const { key, params, ...rest } = evt;
      evt = { ...rest, text: tr(lang, key, params) };
    }
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };
  // Keeps proxies from closing the connection while the model is thinking.
  const ping = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15000);
  try {
    await streamChat({ llm, system, messages, action, signal: ac.signal }, send);
  } catch (err) {
    const info = describeLlmError(err, llm);
    if (info) {
      if (info.status >= 500 && info.status !== 502 && info.status !== 504) console.error('[llm]', err);
      send({ t: 'error', message: tr(lang, info.key, info.params), code: info.code, status: info.status });
    }
  } finally {
    clearInterval(ping);
    res.end();
  }
});

route('POST', '/api/llm/models', async (req, res) => {
  const body = await readJson(req);
  const llm = effectiveLlm(body.llm);
  try {
    sendJson(req, res, 200, { models: await listModels(llm) });
  } catch (err) {
    const info = describeLlmError(err, llm) || { status: 499, key: 'llm.cancelled', params: {} };
    throw new HttpError(info.status, info.key, info.params, info.code);
  }
});

route('POST', '/api/llm/test', async (req, res) => {
  const body = await readJson(req);
  const llm = effectiveLlm(body.llm);
  llm.effort = { ...llm.effort, test: 'low' };
  const started = Date.now();
  let reply = '';
  let model = llm.model;
  let failure = null;
  try {
    await streamChat(
      {
        llm,
        system: '',
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        action: 'test',
        signal: AbortSignal.timeout(60000),
      },
      (evt) => {
        if (evt.t === 'delta') reply += evt.text;
        if (evt.t === 'done' || evt.t === 'start') model = evt.model || model;
        if (evt.t === 'refusal') failure = { status: 422, key: 'llm.testRefused', params: {} };
      },
    );
  } catch (err) {
    failure = describeLlmError(err, llm) || { status: 504, key: 'llm.testTimeout', params: {} };
  }
  if (failure) throw new HttpError(failure.status, failure.key, failure.params, failure.code);
  sendJson(req, res, 200, { ok: true, model, ms: Date.now() - started, reply: reply.trim().slice(0, 200) });
});

// ---- papers ----------------------------------------------------------------------------------

route('GET', '/api/papers', async (req, res) => sendJson(req, res, 200, { papers: await papers.listPapers() }));

route('POST', '/api/papers/import', async (req, res) => {
  const body = await readJson(req);
  sendJson(req, res, 200, { paper: await papers.importFromInput(body.input, reqLang(req)) });
});

route('POST', '/api/papers/upload', async (req, res) => {
  sendJson(req, res, 200, { paper: await papers.importUpload(req, reqLang(req)) });
});

route('GET', '/api/papers/:id', async (req, res, { params }) => {
  sendJson(req, res, 200, { paper: await papers.getMeta(papers.checkId(params.id)) });
});

route('PATCH', '/api/papers/:id', async (req, res, { params }) => {
  const body = await readJson(req);
  const meta = await papers.patchPaper(papers.checkId(params.id), body);
  sendJson(req, res, 200, { paper: meta });
});

route('DELETE', '/api/papers/:id', async (req, res, { params }) => {
  await papers.deletePaper(papers.checkId(params.id));
  sendJson(req, res, 200, { ok: true });
});

route('GET', '/api/papers/:id/pdf', async (req, res, { params, query }) => {
  const id = papers.checkId(params.id);
  const file = papers.pdfFile(id);
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    throw new HttpError(404, 'paper.noPdf');
  }
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': 'application/pdf',
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': stat.mtime.toUTCString(),
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  };
  if (query.get('download')) {
    const meta = await papers.getMeta(id);
    const name = `${(meta.title || id).replace(/[\\/:*?"<>|\n\r]+/g, ' ').slice(0, 120)}.pdf`;
    headers['Content-Disposition'] = `attachment; filename="paper.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`;
  }
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let start;
    let end;
    if (m[1]) {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
    } else {
      start = Math.max(0, stat.size - Number(m[2]));
      end = stat.size - 1;
    }
    if (start >= stat.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    sendFile(req, res, file, { start, end });
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  sendFile(req, res, file);
});

route('GET', '/api/papers/:id/html', async (req, res, { params }) => {
  const result = await papers.readHtml(papers.checkId(params.id));
  if (!result) throw new HttpError(404, 'paper.noHtml', {}, 'no_html');
  sendJson(req, res, 200, result);
});

route('GET', '/api/papers/:id/asset', async (req, res, { params, query }) => {
  const { type, file } = await papers.getAsset(papers.checkId(params.id), query.get('u') || '');
  const stat = await fsp.stat(file);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'private, max-age=604800',
    'X-Content-Type-Options': 'nosniff',
    // Proxied files (SVG in particular) must never run script in this origin.
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
  });
  sendFile(req, res, file);
});

route('GET', '/api/papers/:id/threads', async (req, res, { params }) => {
  sendJson(req, res, 200, { threads: await papers.listThreads(papers.checkId(params.id)) });
});

route('GET', '/api/papers/:id/threads/:tid', async (req, res, { params }) => {
  sendJson(req, res, 200, { thread: await papers.getThread(papers.checkId(params.id), params.tid) });
});

route('PUT', '/api/papers/:id/threads/:tid', async (req, res, { params }) => {
  const body = await readJson(req, 24 * 1024 * 1024);
  sendJson(req, res, 200, await papers.saveThread(papers.checkId(params.id), params.tid, body));
});

route('DELETE', '/api/papers/:id/threads/:tid', async (req, res, { params }) => {
  await papers.deleteThread(papers.checkId(params.id), params.tid);
  sendJson(req, res, 200, { ok: true });
});

// ---- server -----------------------------------------------------------------------------------

// Pages on other sites, including other subdomains of the same site, may not change anything
// here. Browsers label such requests with Sec-Fetch-Site; older ones still send Origin.
function crossSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site !== 'same-origin' && site !== 'none';
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const { host } = new URL(origin);
    return host !== req.headers.host && host !== forwardedHeader(req, 'x-forwarded-host');
  } catch {
    return true;
  }
}

async function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    throw new HttpError(400, 'common.badUrl');
  }
  const pathname = url.pathname;
  if (pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD' && crossSite(req)) throw new HttpError(403, 'common.crossSite');
    for (const r of routes) {
      if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      if (r.auth) requireAuth(req);
      let params;
      try {
        params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      } catch {
        throw new HttpError(400, 'common.badUrl');
      }
      await r.handler(req, res, { params, query: url.searchParams });
      return;
    }
    throw new HttpError(404, 'common.notFound');
  }
  if (await serveStatic(req, res, pathname)) return;
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

async function cleanTmp() {
  try {
    const now = Date.now();
    for (const name of await fsp.readdir(TMP_DIR)) {
      const file = path.join(TMP_DIR, name);
      const stat = await fsp.stat(file);
      if (now - stat.mtimeMs > 6 * 3600_000) await fsp.rm(file, { force: true });
    }
  } catch {
    // nothing to clean
  }
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

const { generatedPassword } = await loadConfig();
await fsp.mkdir(PAPERS_DIR, { recursive: true });
await fsp.mkdir(TMP_DIR, { recursive: true });
await cleanTmp();

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => sendError(req, res, err));
});
// Large uploads over mobile networks can take a while.
server.requestTimeout = 30 * 60 * 1000;
server.listen(PORT, HOST, () => {
  const { port } = server.address();
  console.log(`PaperGloss is running (data: ${DATA_DIR}; outbound: ${proxyDescription()})`);
  console.log(`  Local: http://127.0.0.1:${port}`);
  if (HOST === '0.0.0.0') for (const ip of lanAddresses()) console.log(`  LAN:   http://${ip}:${port}`);
  if (generatedPassword) {
    console.log(`  Generated access password: ${generatedPassword} (shown only this once; change it in Settings)`);
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
