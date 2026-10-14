import { describeAnthropicError, listAnthropicModels, streamAnthropic } from './anthropic.js';
import { LlmHttpError, listOpenAIModels, streamOpenAI } from './openai.js';

// Output ceilings per action for Claude (thinking counts toward max_tokens).
const MAX_TOKENS = { translate: 16000, explain: 16000, ask: 16000, chat: 32000, test: 2048 };

export function streamChat({ llm, system, messages, action, signal }, emit) {
  const opts = { llm, system, messages, action, signal, maxTokens: MAX_TOKENS[action] || 16000 };
  return llm.protocol === 'anthropic' ? streamAnthropic(opts, emit) : streamOpenAI(opts, emit);
}

export function listModels(llm) {
  return llm.protocol === 'anthropic' ? listAnthropicModels(llm) : listOpenAIModels(llm);
}

// Maps provider errors to { status, key, params, code } (message keys live in
// server/i18n.js); null means "aborted by the client".
export function describeLlmError(err, llm) {
  if (err?.name === 'AbortError') return null;
  if (err instanceof LlmHttpError) return { status: err.status, key: err.key, params: err.params, code: err.code };
  if (llm.protocol === 'anthropic') return describeAnthropicError(err);
  return { status: 500, key: 'llm.unknown', params: { detail: err?.message } };
}
