// ============= 格式化 =============
export const fmt = n => {
  if (n == null || n === '') return '--';
  if (typeof n === 'string') return n;
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
  if (n >= 10000) return (n / 10000).toFixed(1) + 'w';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
};

// ============= UUID 生成（带降级） =============
// 优先用浏览器的 crypto.randomUUID（仅在 secure context 暴露：HTTPS / localhost / 127.0.0.1）。
// 通过局域网 IP、0.0.0.0 等访问时 randomUUID 可能是 undefined，降级到 RFC4122 v4 的 Math.random 实现。
export function genUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ============= HTML 转义 =============
export const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

// ============= 安全外部链接 =============
export const safeExternalUrl = value => {
  try {
    const url = new URL(String(value || ''), location.href);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '#';
  } catch {
    return '#';
  }
};

// ============= Markdown 渲染 =============
export function renderMarkdown(value) {
  const source = String(value || '');
  if (!source) return '<p class="text-gray-500">（无内容）</p>';
  if (!window.marked || !window.DOMPurify) {
    return `<pre class="whitespace-pre-wrap">${esc(source)}</pre>`;
  }
  const html = marked.parse(source, { gfm: true, breaks: true });
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form'],
    FORBID_ATTR: ['style'],
  });
}

export function renderWechatArticle(value) {
  const source = String(value || '').trim();
  if (!source) return '<p class="text-gray-500">（无正文）</p>';
  const looksLikeHtml = /<(?:article|p|section|div|img|br|h[1-6]|blockquote|pre|ul|ol|table)\b/i.test(source);
  if (looksLikeHtml && window.DOMPurify) {
    return DOMPurify.sanitize(source, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form', 'script'],
      FORBID_ATTR: ['style', 'onerror', 'onload'],
    });
  }
  const looksLikeMarkdown = /(^|\n)\s{0,3}(#{1,6}\s|>\s|[-*+]\s|\d+\.\s|```|~~~)|\[[^\]]+\]\([^)]+\)|`[^`\n]+`|\|.+\|/m.test(source);
  if (looksLikeMarkdown) return renderMarkdown(source);
  const paragraphs = source
    .split(/\n\s*\n|\n+/)
    .map(part => part.trim())
    .filter(Boolean);
  if (paragraphs.length <= 3) {
    return source.split(/ {2,}/).map(part => part.trim()).filter(Boolean)
      .map(paragraph => `<p>${esc(paragraph)}</p>`).join('');
  }
  return paragraphs.map(paragraph => `<p>${esc(paragraph)}</p>`).join('');
}

export function prepareMarkdownLinks(container) {
  if (!container) return;
  container.querySelectorAll('a[href]').forEach(link => {
    const href = safeExternalUrl(link.getAttribute('href'));
    if (href === '#') {
      link.removeAttribute('href');
      return;
    }
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  });
  container.querySelectorAll('img').forEach(image => {
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
  });
}

// ============= 图片代理 =============
export const proxyImage = url => {
  if (!url) return '';
  try {
    const host = new URL(url, location.href).hostname;
    return /(^|\.)qpic\.cn$|(^|\.)qlogo\.cn$|(^|\.)redfox\.hk$/.test(host)
      ? `/api/_/image?url=${encodeURIComponent(url)}`
      : url;
  } catch {
    return '';
  }
};

// ============= 日期 =============
export const dateYmd = (offsetDays = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ============= 剪贴板 =============
export async function copyToClipboard(text, { onSuccess, onError } = {}) {
  try {
    await navigator.clipboard.writeText(String(text ?? ''));
    if (onSuccess) onSuccess();
  } catch {
    if (onError) onError();
  }
}
