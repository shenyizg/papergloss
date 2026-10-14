// Test helpers: real server processes against throwaway data folders.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'papergloss-test-'));
}

export async function waitFor(fn, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value || Date.now() > end) return value;
    await sleep(50);
  }
}

// Starts server/index.js on a free port. Settings from the caller's environment that
// would change its behaviour (PAPERGLOSS_*) are left out.
export async function startServer({ env = {}, dataDir } = {}) {
  const ownDir = !dataDir;
  dataDir ||= tempDir();
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PAPERGLOSS_')));
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...base, HOST: '127.0.0.1', PORT: '0', DATA_DIR: dataDir, PAPERGLOSS_NO_PROXY: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const port = await new Promise((resolve, reject) => {
    const check = () => {
      const m = output.match(/Local: http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) resolve(Number(m[1]));
    };
    child.stdout.on('data', check);
    child.once('exit', (code) => reject(new Error(`server exited with ${code}:\n${output}`)));
  });
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    dataDir,
    pid: child.pid,
    output: () => output,
    stop: async () => {
      if (child.exitCode == null) {
        await new Promise((resolve) => {
          child.once('exit', resolve);
          child.kill();
        });
      }
      if (ownDir) fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function api(base, method, pathname, { body, headers = {}, cookie } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

// Signs in and returns the session cookie ("pr_session=…").
export async function signIn(base, password) {
  const res = await api(base, 'POST', '/api/login', { body: { password } });
  assert.equal(res.status, 200, `sign-in failed: ${JSON.stringify(res.data)}`);
  return res.headers.get('set-cookie').split(';')[0];
}

// A local HTTP server that records every request it gets.
export async function recordingServer(handler = (req, res) => res.writeHead(404).end('internal page')) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    req.resume();
    req.on('end', () => handler(req, res));
  });
  // Proxies are asked with CONNECT.
  server.on('connect', (req, socket) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

export function readConfig(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
}

// An IPv4 address of this machine other than loopback, to connect from a "remote" peer.
export function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}
