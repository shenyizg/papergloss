import { getLang, t } from './i18n.js';

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const unauthorizedHandlers = new Set();
export function onUnauthorized(fn) {
  unauthorizedHandlers.add(fn);
  return () => unauthorizedHandlers.delete(fn);
}

async function request(method, url, body, { keepalive = false, quiet401 = false } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), 'X-UI-Lang': getLang() },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      keepalive,
    });
  } catch {
    throw new ApiError(0, t('net.offline'));
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401 && !quiet401) unauthorizedHandlers.forEach((fn) => fn());
    throw new ApiError(res.status, data?.error || t('net.requestFailed', { status: res.status }), data?.code);
  }
  return data;
}

const enc = encodeURIComponent;

export const api = {
  session: () => request('GET', '/api/session'),
  login: (password) => request('POST', '/api/login', { password }, { quiet401: true }),
  logout: () => request('POST', '/api/logout', {}),
  changePassword: (oldPassword, newPassword) => request('PUT', '/api/password', { oldPassword, newPassword }),
  getSettings: () => request('GET', '/api/settings'),
  saveSettings: (patch) => request('PUT', '/api/settings', patch),
  listModels: (llm) => request('POST', '/api/llm/models', { llm }),
  testLlm: (llm) => request('POST', '/api/llm/test', { llm }),
  listPapers: () => request('GET', '/api/papers'),
  importPaper: (input) => request('POST', '/api/papers/import', { input }),
  getPaper: (id) => request('GET', `/api/papers/${enc(id)}`),
  patchPaper: (id, patch, opts) => request('PATCH', `/api/papers/${enc(id)}`, patch, opts),
  deletePaper: (id) => request('DELETE', `/api/papers/${enc(id)}`),
  getHtml: (id) => request('GET', `/api/papers/${enc(id)}/html`),
  listThreads: (id) => request('GET', `/api/papers/${enc(id)}/threads`),
  getThread: (id, tid) => request('GET', `/api/papers/${enc(id)}/threads/${enc(tid)}`),
  saveThread: (id, thread) => request('PUT', `/api/papers/${enc(id)}/threads/${enc(thread.id)}`, thread),
  deleteThread: (id, tid) => request('DELETE', `/api/papers/${enc(id)}/threads/${enc(tid)}`),
  pdfUrl: (id) => `/api/papers/${enc(id)}/pdf`,
  pdfDownloadUrl: (id) => `/api/papers/${enc(id)}/pdf?download=1`,
  assetUrl: (id, url) => `/api/papers/${enc(id)}/asset?u=${enc(url)}`,
};

export function uploadPaper(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/papers/upload');
    xhr.setRequestHeader('Content-Type', 'application/pdf');
    xhr.setRequestHeader('X-File-Name', enc(file.name || 'paper.pdf'));
    xhr.setRequestHeader('X-UI-Lang', getLang());
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else {
        if (xhr.status === 401) unauthorizedHandlers.forEach((fn) => fn());
        reject(new ApiError(xhr.status, data?.error || t('net.uploadFailed', { status: xhr.status })));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, t('net.uploadInterrupted')));
    xhr.send(file);
  });
}

// Streams one model turn. Events: start, thinking, delta, notice, done, refusal, error.
export async function streamChat({ action, system, messages }, { signal, onEvent }) {
  let res;
  try {
    res = await fetch('/api/llm/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-UI-Lang': getLang() },
      body: JSON.stringify({ action, system, messages }),
      credentials: 'same-origin',
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, t('net.offline'));
  }
  if (!res.ok) {
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (res.status === 401) unauthorizedHandlers.forEach((fn) => fn());
    throw new ApiError(res.status, data?.error || t('net.requestFailed', { status: res.status }), data?.code);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        let evt;
        try {
          evt = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        onEvent(evt);
      }
    }
  }
}

// Settings are read by many modules; keep one cached copy.
let settingsCache = null;
export async function getSettings(force = false) {
  if (!settingsCache || force) settingsCache = await api.getSettings();
  return settingsCache;
}
export function setSettingsCache(s) {
  settingsCache = s;
}
