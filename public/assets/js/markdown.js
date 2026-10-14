import { marked } from '/vendor/marked/marked.esm.js';
import DOMPurify from '/vendor/dompurify/purify.es.mjs';
import katex from '/vendor/katex/katex.mjs';

marked.setOptions({ gfm: true, breaks: false });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

// Split out code so math delimiters inside code are left alone.
const CODE_RE = /(```[\s\S]*?(?:```|$)|`[^`\n]+`)/g;
// No lookbehind here: older iOS Safari can't parse it and the whole module would fail.
const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(^|[^\\$\w])\$(?!\s)((?:\\\$|[^$\n])+?)\$(?![\w$])/g;

function renderMath(tex, display) {
  try {
    return katex.renderToString(tex.trim(), { displayMode: display, throwOnError: false, strict: 'ignore', output: 'htmlAndMathml' });
  } catch {
    return `<code>${tex.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</code>`;
  }
}

// Some reasoning models put their scratchpad inline as <think>…</think>.
function stripThink(src) {
  return src.replace(/^\s*<think>[\s\S]*?(<\/think>|$)/i, '').trimStart();
}

export function renderMarkdown(src) {
  const text = stripThink(src || '');
  const maths = [];
  const protectedText = text
    .split(CODE_RE)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part.replace(MATH_RE, (m, d1, d2, i1, pre, i2) => {
        if (i2 != null && /\s$/.test(i2)) return m;
        const display = d1 != null || d2 != null;
        const tex = d1 ?? d2 ?? i1 ?? i2;
        maths.push({ tex, display });
        const token = display ? `MATHBLOCK${maths.length - 1}ENDMATH` : `MATHINLINE${maths.length - 1}ENDMATH`;
        return (pre || '') + token;
      });
    })
    .join('');
  let html = marked.parse(protectedText);
  html = html
    .replace(/<p>MATHBLOCK(\d+)ENDMATH<\/p>/g, (_, n) => renderMath(maths[n].tex, true))
    .replace(/MATH(?:BLOCK|INLINE)(\d+)ENDMATH/g, (_, n) => renderMath(maths[n].tex, maths[n].display));
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true, mathMl: true, svg: true } });
}
