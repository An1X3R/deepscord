/* 通用工具 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset' && typeof value === 'object') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function esc(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

const AVATAR_COLORS = [
  '#7c6cf5', '#4dd4ac', '#ff8a5c', '#4aa8ff', '#f25f8b',
  '#f5c451', '#8f7dff', '#3ecf8e', '#ff6b6b', '#59c7f0',
];

export function colorFor(seed) {
  const s = String(seed || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function initials(name) {
  const s = String(name || '?').trim();
  if (!s) return '?';
  const chars = [...s];
  // 中文取前 1~2 字，英文取首字母
  if (/^[\u4e00-\u9fa5]/.test(s)) return chars.slice(0, 2).join('');
  return chars.slice(0, 2).join('').toUpperCase();
}

export function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date();
  yest.setDate(today.getDate() - 1);
  const same = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, today)) return '今天';
  if (same(d, yest)) return '昨天';
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

export function debounce(fn, ms = 300) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/** 简易 localStorage 存取（带异常保护） */
export const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
      /* ignore */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch (_) {
      /* ignore */
    }
  },
};

export function relTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/** Render a small Markdown subset while preserving literal code contents.
 * @param {string} text
 * @returns {string}
 */
export function renderText(text) {
  const plain = (/** @type {string} */ value) => esc(value)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/(https?:\/\/[^\s<"）)]+)/g, url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
    .replace(/\n/g, '<br>');
  let html = '', offset = 0;
  for (const match of text.matchAll(/```([\s\S]*?)```|`([^`\n]+)`/g)) {
    html += plain(text.slice(offset, match.index));
    if (match[1] !== undefined) {
      const code = match[1].replace(/^[A-Za-z0-9_+.-]+[ \t]*\r?\n/, '');
      html += `<pre><code>${esc(code)}</code></pre>`;
    } else html += `<code>${esc(match[2])}</code>`;
    offset = match.index + match[0].length;
  }
  html += plain(text.slice(offset));
  return html;
}

export function bytesHuman(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
