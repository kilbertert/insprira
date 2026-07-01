// 认证 + 会话 + KB 凭证加密
// 依赖：lib/db（实例）
const crypto = require('crypto');
const { db } = require('./db');

const sessions = new Map();

function sessionSet(token, userId, expiresAt) {
  const session = { userId, expiresAt };
  sessions.set(token, session);
  db.prepare(`
    INSERT OR REPLACE INTO sessions (token, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(token, userId, expiresAt, Date.now());
}

function sessionDel(token) {
  sessions.delete(token);
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function sessionGet(token) {
  if (sessions.has(token)) return sessions.get(token);
  const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').get(token);
  if (row?.user_id) {
    const session = { userId: row.user_id, expiresAt: row.expires_at };
    sessions.set(token, session);
    return session;
  }
  return null;
}

function sessionClean() {
  const now = Date.now();
  sessions.forEach((value, token) => {
    if (value.expiresAt < now) sessions.delete(token);
  });
  db.prepare('DELETE FROM sessions WHERE expires_at < ? OR user_id IS NULL').run(now);
}

function getCookies(req) {
  return String(req.headers.cookie || '').split(';').reduce((cookies, part) => {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    return cookies;
  }, {});
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    mustChangePassword: Boolean(row.must_change_password),
    lastLoginAt: row.last_login_at,
    passwordChangedAt: row.password_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function currentSession(req) {
  const token = getCookies(req).furnace_session;
  const session = token ? sessionGet(token) : null;
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessionDel(token);
    return null;
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.userId);
  if (!user) {
    sessionDel(token);
    return null;
  }
  return { token, session, user };
}

function isAuthorized(req) {
  return Boolean(currentSession(req));
}

// 知识库凭证 AES-256-GCM 加密
const KB_ENC_ALGO = 'aes-256-gcm';
const KB_ENC_KEY_SRC = process.env.KB_ENCRYPTION_KEY;
const KB_ENC_INSECURE = !KB_ENC_KEY_SRC;
if (KB_ENC_INSECURE) {
  console.error('[security] KB_ENCRYPTION_KEY 未配置。知识库凭证使用默认弱密钥加密，cache.db 泄漏即等于凭证泄漏。请在 .env 设置 KB_ENCRYPTION_KEY（生成命令：openssl rand -hex 32；已有数据库设置后请勿修改）');
}
const KB_ENC_KEY = crypto.createHash('sha256').update(String(KB_ENC_KEY_SRC || 'furnace-kb-key')).digest();

function encryptKb(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(KB_ENC_ALGO, KB_ENC_KEY, iv);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + enc;
}

function decryptKb(text) {
  if (!text) return '';
  const parts = text.split(':');
  if (parts.length !== 3) return '';
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const enc = parts[2];
  const decipher = crypto.createDecipheriv(KB_ENC_ALGO, KB_ENC_KEY, iv);
  decipher.setAuthTag(authTag);
  let dec = decipher.update(enc, 'hex', 'utf8');
  dec += decipher.final('utf8');
  return dec;
}

module.exports = {
  sessions,
  sessionSet,
  sessionDel,
  sessionGet,
  sessionClean,
  getCookies,
  publicUser,
  currentSession,
  isAuthorized,
  KB_ENC_ALGO,
  KB_ENC_INSECURE,
  encryptKb,
  decryptKb,
};
