// 纯工具函数：无副作用，不依赖 db 或其他模块状态
const crypto = require('crypto');

function parseJson(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableObject(value[key]);
    return result;
  }, {});
}

function toNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function localDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateDaysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return localDate(date);
}

function dateFromYmd(value, offsetDays) {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  date.setDate(date.getDate() + offsetDays);
  return localDate(date);
}

function workPublishAt(work) {
  const raw = work.publishTime || work.workPublishTime || work.createTime || work.publicTime || '';
  const numeric = typeof raw === 'number' ? raw : Number(String(raw).trim());
  const value = Number.isFinite(numeric) && String(raw).trim() !== ''
    ? numeric
    : Date.parse(String(raw).replace(/-/g, '/'));
  if (!Number.isFinite(value)) return 0;
  return value < 1e12 ? value * 1000 : value;
}

function workContentKey(work) {
  return crypto.createHash('sha1').update([
    String(work.title || '').trim().toLowerCase(),
    String(work.publishTime || work.workPublishTime || work.createTime || work.publicTime || ''),
  ].join('\n')).digest('hex');
}

function gitBlobSha(content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return crypto.createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]))
    .digest('hex');
}

function parseAgentJsonLines(output, role = 'assistant') {
  const events = String(output || '').split(/\r?\n/)
    .map(line => parseJson(line))
    .filter(Boolean);
  const messages = events.filter(event => event.role === role && typeof event.content === 'string');
  return messages.length ? messages[messages.length - 1].content.trim() : '';
}

module.exports = {
  parseJson,
  stableObject,
  toNumber,
  localDate,
  dateDaysAgo,
  dateFromYmd,
  workPublishAt,
  workContentKey,
  gitBlobSha,
  parseAgentJsonLines,
};
