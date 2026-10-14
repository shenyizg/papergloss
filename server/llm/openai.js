// Adapter for OpenAI-compatible Chat Completions endpoints
// (DeepSeek, Qwen, Kimi, GLM, SiliconFlow, OpenRouter, Gemini's compat endpoint, Ollama, vLLM...).
import { httpFetch } from '../net.js';

// Same shape as HttpError: a message key (see server/i18n.js) plus params.
export class LlmHttpError extends Error {
  constructor(status, key, params = {}, code) {
    super(key);
    this.status = status;
    this.key = key;
    this.params = params;
    this.code = code;
  }
}

function endpoint(baseUrl, suffix) {
  if (!baseUrl) throw new LlmHttpError(400, 'llm.noBaseUrl', {}, 'no_base_url');
  return `${baseUrl.replace(/\/+$/, '')}${suffix}`;
}

function headers(llm) {
  const h = { 'Content-Type': 'application/json' };
  if (llm.apiKey) h.Authorization = `Bearer ${llm.apiKey}`;
  return h;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  return (content || [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

function toMessage(m) {
  if (m.role === 'assistant') return { role: 'assistant', content: textOf(m.content) };
  if (typeof m.content === 'string') return { role: 'user', content: m.content };
  const parts = [];
  for (const p of m.content || []) {
    if (p.type === 'image' && p.data) {
      parts.push({ type: 'image_url', image_url: { url: `data:${p.mediaType || 'image/png'};base64,${p.data}` } });
    } else if (p.type === 'text' && p.text) {
      parts.push({ type: 'text', text: p.text });
    }
  }
  return { role: 'user', content: parts };
}

function extractMessage(text) {
  try {
    const data = JSON.parse(text);
    return data?.error?.message || data?.message || data?.error || text;
  } catch {
    return text;
  }
}

function httpError(status, detail) {
  const d = String(detail || '').slice(0, 300);
  if (status === 401) return new LlmHttpError(401, 'llm.badKey', { detail: d });
  if (status === 403) return new LlmHttpError(403, 'llm.forbidden', { detail: d });
  if (status === 404) return new LlmHttpError(404, 'llm.notFoundCompat', { detail: d });
  if (status === 429) return new LlmHttpError(429, 'llm.rateLimit', { detail: d });
  if (status >= 500) return new LlmHttpError(502, 'llm.unavailable', { status, detail: d });
  return new LlmHttpError(status === 400 ? 400 : 502, 'llm.badRequest', { status, detail: d });
}

async function post(url, llm, body, signal) {
  try {
    return await httpFetch(url, { method: 'POST', headers: { ...headers(llm), Accept: 'text/event-stream' }, body: JSON.stringify(body), signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new LlmHttpError(502, 'llm.unreachable', { reason: err.cause?.code || err.message });
  }
}

export async function streamOpenAI({ llm, system, messages, signal }, emit) {
  if (!llm.model) throw new LlmHttpError(400, 'llm.noModel', {}, 'no_model');
  const body = {
    model: llm.model,
    stream: true,
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages.map(toMessage)],
  };
  if (llm.temperature != null) body.temperature = llm.temperature;
  if (llm.maxTokens) body.max_tokens = llm.maxTokens;

  const res = await post(endpoint(llm.baseUrl, '/chat/completions'), llm, body, signal);
  if (!res.ok) throw httpError(res.status, extractMessage(await res.text()));

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    // Some gateways ignore `stream: true` and answer with one JSON body.
    const data = JSON.parse(await res.text());
    if (data.error) throw new LlmHttpError(502, 'llm.providerError', { detail: data.error.message || JSON.stringify(data.error) });
    const choice = data.choices?.[0];
    emit({ t: 'start', model: data.model || llm.model });
    if (choice?.message?.content) emit({ t: 'delta', text: choice.message.content });
    emit({ t: 'done', stopReason: choice?.finish_reason === 'length' ? 'max_tokens' : 'end_turn', model: data.model || llm.model, usage: data.usage || null, raw: null });
    return;
  }

  emit({ t: 'start', model: llm.model });
  const decoder = new TextDecoder();
  let buffer = '';
  let announcedThinking = false;
  let finish = null;
  let usage = null;
  let model = null;
  let done = false;
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') {
        done = true;
        break;
      }
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (json.error) throw new LlmHttpError(502, 'llm.providerError', { detail: json.error.message || JSON.stringify(json.error) });
      model ||= json.model;
      const choice = json.choices?.[0];
      const delta = choice?.delta || {};
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning && !announcedThinking) {
        announcedThinking = true;
        emit({ t: 'thinking' });
      }
      if (typeof delta.content === 'string' && delta.content) emit({ t: 'delta', text: delta.content });
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (json.usage) usage = json.usage;
    }
    if (done) break;
  }
  emit({
    t: 'done',
    stopReason: finish === 'length' ? 'max_tokens' : 'end_turn',
    model: model || llm.model,
    usage,
    raw: null,
  });
}

export async function listOpenAIModels(llm) {
  let res;
  try {
    res = await httpFetch(endpoint(llm.baseUrl, '/models'), { headers: headers(llm), signal: AbortSignal.timeout(20000) });
  } catch (err) {
    throw new LlmHttpError(502, 'llm.unreachable', { reason: err.cause?.code || err.message });
  }
  if (!res.ok) throw httpError(res.status, extractMessage(await res.text()));
  const data = await res.json();
  const list = Array.isArray(data) ? data : data.data || data.models || [];
  return list.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean).sort();
}
