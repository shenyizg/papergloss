import Anthropic from '@anthropic-ai/sdk';
import { httpFetch } from '../net.js';

// Models that accept the server-side refusal fallback (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

function isOfficialApi(baseUrl) {
  return !baseUrl || /^https:\/\/api\.anthropic\.com\/?$/i.test(baseUrl);
}

// Effort is accepted by Opus 4.5+, the 4.6+ family and every 5.x model; older ones reject it.
function effortFor(model, effort) {
  if (!effort || effort === 'auto') return null;
  if (/^claude-(fable|mythos)-/.test(model) || /^claude-(opus|sonnet|haiku)-5/.test(model)) return effort;
  if (/^claude-(opus|sonnet)-4-6/.test(model)) return effort === 'xhigh' ? 'high' : effort;
  if (/^claude-opus-4-[78]/.test(model)) return effort;
  if (/^claude-opus-4-5/.test(model)) return ['xhigh', 'max'].includes(effort) ? 'high' : effort;
  return null;
}

function makeClient(llm) {
  const opts = { maxRetries: 1, fetch: httpFetch };
  if (llm.apiKey) opts.apiKey = llm.apiKey;
  if (llm.baseUrl && !isOfficialApi(llm.baseUrl)) opts.baseURL = llm.baseUrl;
  return new Anthropic(opts);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  return (content || [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

function userContent(content) {
  if (typeof content === 'string') return content;
  const images = [];
  const texts = [];
  for (const p of content || []) {
    if (p.type === 'image' && p.data) {
      images.push({ type: 'image', source: { type: 'base64', media_type: p.mediaType || 'image/png', data: p.data } });
    } else if (p.type === 'text' && p.text) {
      texts.push({ type: 'text', text: p.text });
    }
  }
  return [...images, ...texts];
}

// Assistant turns are replayed exactly as the API returned them (thinking blocks
// included), so later turns keep their reasoning. After a refusal fallback only the
// text written before the last `fallback` marker is carried over.
function replayContent(blocks) {
  const last = blocks.map((b) => b.type).lastIndexOf('fallback');
  if (last < 0) return blocks;
  return [...blocks.slice(0, last).filter((b) => b.type === 'text'), ...blocks.slice(last + 1)];
}

function toMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      if (m.raw?.provider === 'anthropic' && Array.isArray(m.raw.content) && m.raw.content.length) {
        return { role: 'assistant', content: replayContent(m.raw.content) };
      }
      return { role: 'assistant', content: textOf(m.content) || '(empty)' };
    }
    return { role: 'user', content: userContent(m.content) };
  });
}

export async function streamAnthropic({ llm, system, messages, action, maxTokens, signal }, emit) {
  const client = makeClient(llm);
  const model = llm.model || 'claude-opus-5-5';
  const params = {
    model,
    max_tokens: llm.maxTokens || maxTokens,
    messages: toMessages(messages),
  };
  // The system prompt is frozen per conversation, so caching it pays off on follow-ups
  // (and on whole-paper chats, where it carries the full text).
  if (system) params.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  const effort = effortFor(model, llm.effort?.[action]);
  if (effort) params.output_config = { effort };

  const stream =
    isOfficialApi(llm.baseUrl) && FALLBACK_MODELS.has(model)
      ? client.beta.messages.stream(
          { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' },
          { signal },
        )
      : client.messages.stream(params, { signal });

  let announcedThinking = false;
  for await (const event of stream) {
    if (event.type === 'message_start') {
      emit({ t: 'start', model: event.message.model });
    } else if (event.type === 'content_block_start') {
      const block = event.content_block;
      if ((block.type === 'thinking' || block.type === 'redacted_thinking') && !announcedThinking) {
        announcedThinking = true;
        emit({ t: 'thinking' });
      } else if (block.type === 'fallback') {
        emit({ t: 'notice', key: 'llm.fallbackNotice', params: { model: block.to?.model || 'fallback model' } });
      }
    } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      emit({ t: 'delta', text: event.delta.text });
    }
  }

  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal') {
    emit({ t: 'refusal', category: final.stop_details?.category || null });
    return;
  }
  emit({
    t: 'done',
    stopReason: final.stop_reason,
    model: final.model,
    usage: final.usage,
    raw: { provider: 'anthropic', model: final.model, content: final.content },
  });
}

export async function listAnthropicModels(llm) {
  const client = makeClient(llm);
  const ids = [];
  for await (const m of client.models.list({ limit: 100 })) ids.push(m.id);
  return ids;
}

function apiMessage(err) {
  return err.error?.error?.message || err.error?.message || err.message || '';
}

export function describeAnthropicError(err) {
  if (err instanceof Anthropic.APIUserAbortError) return null;
  if (err instanceof Anthropic.AuthenticationError) {
    return { status: 401, key: 'llm.badKey', params: {} };
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return { status: 403, key: 'llm.forbiddenAnthropic', params: { detail: apiMessage(err) } };
  }
  if (err instanceof Anthropic.NotFoundError) {
    return { status: 404, key: 'llm.notFound', params: {} };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { status: 429, key: 'llm.rateLimit', params: {} };
  }
  if (err instanceof Anthropic.BadRequestError) {
    return { status: 400, key: 'llm.badRequest', params: { status: 400, detail: apiMessage(err) } };
  }
  if (err instanceof Anthropic.InternalServerError) {
    return { status: 502, key: 'llm.unavailable', params: { status: err.status } };
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return { status: 504, key: 'llm.timeout', params: {} };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { status: 502, key: 'llm.unreachable', params: { reason: err.cause?.code || 'connection error' } };
  }
  if (err instanceof Anthropic.APIError) {
    return { status: err.status || 502, key: 'llm.apiError', params: { status: err.status ?? '?', detail: apiMessage(err) } };
  }
  if (/authentication method/i.test(err.message || '')) {
    return { status: 400, key: 'llm.noKey', params: {}, code: 'no_key' };
  }
  return { status: 500, key: 'llm.unknown', params: { detail: err.message } };
}
