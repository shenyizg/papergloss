// Cross-site requests, the API key, imports from local addresses, errors and downloads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { api, recordingServer, signIn, sleep, startServer, tempDir, waitFor } from './helpers.js';

const PW = 'test-password';

test('requests from other sites cannot change anything', async () => {
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const save = (headers) => api(srv.url, 'PUT', '/api/settings', { cookie, body: { prefs: { targetLang: 'English' } }, headers });
    // Other subdomains of the same site count as other sites too.
    assert.equal((await save({ 'Sec-Fetch-Site': 'same-site' })).status, 403);
    assert.equal((await save({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await save({ Origin: 'https://blog.example' })).status, 403);
    assert.equal((await save({ Origin: 'null' })).status, 403);
    assert.equal((await save({ 'Sec-Fetch-Site': 'same-origin' })).status, 200);
    assert.equal((await save({ Origin: srv.url })).status, 200);
    const login = await api(srv.url, 'POST', '/api/login', { body: { password: PW }, headers: { Origin: 'https://blog.example' } });
    assert.equal(login.status, 403);
    // What an HTML form on another page can send.
    const form = await api(srv.url, 'POST', '/api/llm/test', { cookie, body: '{"llm":{}}', headers: { 'Content-Type': 'text/plain' } });
    assert.equal(form.status, 415);
  } finally {
    await srv.stop();
  }
});

test('the saved API key only goes to the server it was saved for', async () => {
  const saved = await recordingServer();
  const other = await recordingServer((req, res) => res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":{"message":"no key"}}'));
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const llm = { protocol: 'openai', preset: 'custom', baseUrl: `${saved.url}/v1`, apiKey: 'sk-saved-key', model: 'm' };
    assert.equal((await api(srv.url, 'PUT', '/api/settings', { cookie, body: { llm } })).status, 200);

    // "Fetch list" for another provider before typing its key.
    const list = await api(srv.url, 'POST', '/api/llm/models', { cookie, body: { llm: { protocol: 'openai', baseUrl: `${other.url}/v1` } } });
    assert.equal(other.requests.length, 1);
    assert.equal(other.requests[0].headers.authorization, undefined);
    assert.equal(list.data.code, 'no_key');

    // Same server, another path: the key belongs there.
    await api(srv.url, 'POST', '/api/llm/models', { cookie, body: { llm: { protocol: 'openai', baseUrl: `${saved.url}/other/v1` } } });
    assert.equal(saved.requests.at(-1).headers.authorization, 'Bearer sk-saved-key');

    // Saving another server without a new key drops the old one.
    const moved = await api(srv.url, 'PUT', '/api/settings', { cookie, body: { llm: { baseUrl: `${other.url}/v1` } } });
    assert.equal(moved.data.llm.hasKey, false);
  } finally {
    await srv.stop();
    await saved.close();
    await other.close();
  }
});

const PDF = Buffer.from('%PDF-1.4\n%test\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

test('papers cannot be imported from local addresses unless allowed', async () => {
  const local = await recordingServer((req, res) => res.writeHead(200, { 'Content-Type': 'application/pdf' }).end(PDF));
  try {
    let srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW } });
    try {
      const cookie = await signIn(srv.url, PW);
      // 2130706433 is 127.0.0.1 written as one number.
      for (const input of [`${local.url}/internal.pdf`, `http://2130706433:${local.port}/internal.pdf`]) {
        const res = await api(srv.url, 'POST', '/api/papers/import', { cookie, body: { input } });
        assert.equal(res.status, 403, input);
      }
      assert.equal(local.requests.length, 0);
    } finally {
      await srv.stop();
    }
    srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW, PAPERGLOSS_ALLOW_PRIVATE_URLS: '1' } });
    try {
      const cookie = await signIn(srv.url, PW);
      const res = await api(srv.url, 'POST', '/api/papers/import', { cookie, body: { input: `${local.url}/internal.pdf` } });
      assert.equal(res.status, 200);
      assert.equal(local.requests.length, 1);
    } finally {
      await srv.stop();
    }
  } finally {
    await local.close();
  }
});

test('internal errors are reported without details', async () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'papers', 'broken'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'papers', 'broken', 'meta.json'), '{ not json');
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const res = await api(srv.url, 'GET', '/api/papers/broken', { cookie, headers: { 'X-UI-Lang': 'en' } });
    assert.equal(res.status, 500);
    assert.equal(res.data.error, 'Internal server error');
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Asks for a file, reads the first bytes, stops reading and hangs up.
function abortedDownload(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
    socket.once('data', () => {
      socket.pause();
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 100);
    });
    socket.once('error', reject);
  });
}

test('aborted downloads do not leave files open', { skip: !fs.existsSync('/proc/self/fd') && 'needs /proc' }, async () => {
  const dir = tempDir();
  const pdf = path.join(dir, 'papers', 'big', 'paper.pdf');
  fs.mkdirSync(path.dirname(pdf), { recursive: true });
  fs.writeFileSync(pdf, '');
  fs.truncateSync(pdf, 64 * 1024 * 1024); // sparse: big enough that the stream has to wait for the client
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  const openCount = () =>
    fs.readdirSync(`/proc/${srv.pid}/fd`).filter((fd) => {
      try {
        return fs.readlinkSync(`/proc/${srv.pid}/fd/${fd}`).endsWith('paper.pdf');
      } catch {
        return false;
      }
    }).length;
  try {
    const cookie = await signIn(srv.url, PW);
    for (let i = 0; i < 5; i++) {
      await abortedDownload(srv.port, `GET /api/papers/big/pdf HTTP/1.1\r\nHost: x\r\nCookie: ${cookie}\r\n\r\n`);
    }
    const head = await fetch(`${srv.url}/api/papers/big/pdf`, { method: 'HEAD', headers: { Cookie: cookie } });
    assert.equal(head.status, 200);
    await sleep(200);
    assert.equal(await waitFor(() => openCount() === 0), true, `${openCount()} file handles still open`);
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
