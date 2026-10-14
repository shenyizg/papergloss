// Prompt construction and conversation ("thread") handling for the AI panel.
import { streamChat } from './api.js';
import { t } from './i18n.js';
import { uid } from './ui.js';

// Prompts stay in Chinese whatever the interface language; the answer language
// comes from the "translate into" setting.
function promptLocation(loc) {
  if (!loc) return '';
  if (loc.page) return `第 ${loc.page} 页`;
  return loc.section || loc.label || '';
}

function authorsShort(authors = []) {
  if (!authors.length) return '';
  return authors.length > 3 ? `${authors.slice(0, 3).join(', ')} 等` : authors.join(', ');
}

// The system prompt is computed once per thread and never changed afterwards, so
// follow-up turns keep a stable prefix (prompt caching, preserved reasoning).
export function buildSystem(paper, prefs, { fullText = '', truncated = false } = {}) {
  const lang = prefs.targetLang || '简体中文';
  const parts = [
    `你是一名严谨、耐心的科研阅读助手，帮助用户读懂学术论文。除非用户另有要求，用${lang}回答。`,
    `用户正在阅读的论文：《${paper.title}》${paper.authors?.length ? `（作者：${authorsShort(paper.authors)}）` : ''}`,
  ];
  if (paper.abstract) parts.push(`论文摘要：${paper.abstract.slice(0, 2000)}`);
  parts.push(
    '回答要求：使用 Markdown；数学公式用 $...$（行内）或 $$...$$（独立成行）书写 LaTeX；专业术语可保留英文原词；不要编造论文里没有的内容，拿不准时直接说明。',
  );
  if (fullText) {
    parts.push(
      `下面是论文全文，从 PDF 或网页版中自动提取，公式和排版可能有损${truncated ? '；全文较长，只保留了前面的部分' : ''}：\n<paper>\n${fullText}\n</paper>\n回答时尽量指出依据所在的章节或页码。`,
    );
  }
  return parts.join('\n\n');
}

export function isWordLike(text) {
  const t = text.trim();
  if (!t || t.length > 48) return false;
  if (!/[A-Za-z]/.test(t)) return false;
  if (/[.!?;:。！？；]$/.test(t)) return false;
  return t.split(/\s+/).length <= 3;
}

function translateTask(lang, word) {
  if (word) {
    return `【选中内容】是一个词或短语。用${lang}简要回答，格式：
**原词** /音标/（普通英文单词才给音标）
- 本文语境中的意思：……
- 常见释义：……（最多 3 条）
- 如果是专业术语或缩写，用一两句话说明它在该领域指什么。`;
  }
  return `把【选中内容】翻译成${lang}。要求：忠实、通顺，符合该领域的学术表达；公式、变量名和引用编号保持原样（公式用 LaTeX）；专业术语第一次出现时在译文后用括号保留英文原词。如果【选中内容】本来就是${lang}，就翻译成英文。只输出译文，不要解释，也不要重复原文。`;
}

function explainTask(lang) {
  return `结合上下文，用${lang}解释【选中内容】：先用一两句话直白地说明它在讲什么；再解释其中的关键概念、符号或公式（公式逐项说明符号含义）；最后说明它在论文论证中的作用或背后的直觉。简洁、分点，避免空话。`;
}

function imageTask(action, lang) {
  if (action === 'translate') return `图片是从论文页面截取的区域。把其中的文字翻译成${lang}（公式保持 LaTeX 形式），只输出译文。`;
  return `图片是从论文页面截取的区域（可能是公式、图、表或一段文字）。用${lang}解释它：先说明它是什么；再逐项解释关键元素（公式里的符号、图的坐标轴/曲线/趋势、表格的主要结论）；最后点出它在论文中想说明什么。`;
}

function customOr(custom, fallback) {
  return custom && custom.trim() ? custom.trim() : fallback;
}

// First user turn of a thread anchored on a text selection.
export function quoteMessage(action, quote, prefs, question = '') {
  const lang = prefs.targetLang || '简体中文';
  const prompts = prefs.prompts || {};
  let task;
  if (action === 'translate') task = customOr(prompts.translate, translateTask(lang, isWordLike(quote.text)));
  else if (action === 'explain') task = customOr(prompts.explain, explainTask(lang));
  else task = `${customOr(prompts.ask, '结合上下文和你的专业知识，回答用户关于【选中内容】的问题。')}\n问题：${question}`;
  const loc = promptLocation(quote.location);
  const where = loc ? `（位置：${loc}）` : '';
  const blocks = [];
  if (quote.context && quote.context.trim() && quote.context.trim() !== quote.text.trim()) {
    blocks.push(`【上下文】（仅用于理解，不需要处理）\n${quote.context}`);
  }
  blocks.push(`【选中内容】${where}\n${quote.text}`);
  blocks.push(`【任务】\n${task}`);
  return blocks.join('\n\n');
}

export function imageMessage(action, quote, prefs, question = '') {
  const lang = prefs.targetLang || '简体中文';
  const loc = promptLocation(quote.location);
  const where = loc ? `（截取位置：${loc}）` : '';
  let task = action === 'ask' ? `结合论文内容回答用户关于这张截图的问题。\n问题：${question}` : imageTask(action, lang);
  if (quote.caption) task = `图注/附近文字：${quote.caption}\n\n${task}`;
  return [
    { type: 'image', ref: 'quote' },
    { type: 'text', text: `${where ? `${where}\n` : ''}${task}` },
  ];
}

// Follow-up turns triggered by the quick chips under an existing quote.
export function followUpText(action, prefs, hasImage) {
  const lang = prefs.targetLang || '简体中文';
  if (hasImage) return action === 'translate' ? `请把截图中的文字翻译成${lang}，只输出译文。` : '请详细解释这张截图的内容。';
  if (action === 'translate') return `请把【选中内容】翻译成${lang}，要求同前，只输出译文。`;
  if (action === 'explain') return '请结合上下文，详细解释【选中内容】。';
  return '';
}

export function newThread({ paper, kind, action, quote = null, system }) {
  const now = new Date().toISOString();
  return {
    id: uid('t'),
    paperId: paper.id,
    kind, // 'quote' | 'image' | 'chat'
    action,
    title: '',
    quote,
    system,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

function materialize(content, thread) {
  if (typeof content === 'string') return content;
  return content.map((p) => {
    if (p.type === 'image' && p.ref === 'quote') {
      const img = thread.quote?.image;
      return img ? { type: 'image', mediaType: img.mediaType, data: img.data } : { type: 'text', text: '(image missing)' };
    }
    return p;
  });
}

// Only completed turns are sent: failed or stopped-empty turns are skipped, and an
// assistant turn goes back with its provider payload (`raw`) when there is one.
export function apiMessages(thread) {
  const out = [];
  const msgs = thread.messages;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'user') {
      if (m.failed) continue;
      out.push({ role: 'user', content: materialize(m.content, thread) });
    } else if (!m.error && !m.pending && m.content) {
      const msg = { role: 'assistant', content: m.content };
      if (m.raw) msg.raw = m.raw;
      out.push(msg);
    }
  }
  return out;
}

// Runs one assistant turn. `msg` is the assistant placeholder already in thread.messages.
export async function runTurn(thread, msg, { action, signal, onUpdate }) {
  msg.pending = true;
  msg.content = '';
  msg.status = 'waiting';
  delete msg.error;
  delete msg.raw;
  const payload = apiMessages(thread);
  let refused = false;
  try {
    await streamChat(
      { action, system: thread.system, messages: payload },
      {
        signal,
        onEvent: (evt) => {
          if (evt.t === 'start') {
            msg.model = evt.model;
          } else if (evt.t === 'thinking') {
            if (!msg.content) msg.status = 'thinking';
          } else if (evt.t === 'delta') {
            msg.content += evt.text;
            msg.status = 'streaming';
          } else if (evt.t === 'notice') {
            msg.notice = evt.text;
          } else if (evt.t === 'done') {
            msg.raw = evt.raw || undefined;
            msg.model = evt.model || msg.model;
            msg.stopReason = evt.stopReason;
          } else if (evt.t === 'refusal') {
            refused = true;
            msg.error = t('ai.refused');
            msg.errorCode = 'refusal';
          } else if (evt.t === 'error') {
            msg.error = evt.message || t('ai.failed');
            msg.errorCode = evt.code;
          }
          onUpdate?.();
        },
      },
    );
    if (refused) msg.content = '';
    if (!msg.error && !msg.content) {
      msg.error = t('ai.empty');
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      msg.stopped = true;
      if (!msg.content) msg.error = t('ai.stoppedShort');
    } else {
      msg.error = err.message || t('ai.failed');
      msg.errorCode = err.code;
    }
  } finally {
    msg.pending = false;
    msg.status = 'done';
    msg.at = new Date().toISOString();
    onUpdate?.();
  }
  return msg;
}
