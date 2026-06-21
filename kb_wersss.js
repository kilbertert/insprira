// 灵感熔炉 · we-mp-rss API 客户端
// 所有方法参数化 baseUrl + token，无状态，由 server.js 端点负责持久化和缓存。

const DEFAULT_TIMEOUT = 15000;

// we-mp-rss 响应统一格式：{code, message, data: ...}，提取 data 层
function unwrap(payload) {
  if (payload && typeof payload === 'object' && 'code' in payload && 'data' in payload) {
    return payload.data;
  }
  return payload;
}

function extractList(payload) {
  const data = unwrap(payload);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.list)) return data.list;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

async function wersssFetch(baseUrl, token, path, options = {}) {
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT);
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
    if (!response.ok) {
      const detail = payload?.detail;
      const message = typeof detail === 'string'
        ? detail
        : detail?.message || payload?.message || detail?.[0]?.msg || `we-mp-rss HTTP ${response.status}`;
      const err = new Error(message);
      err.status = response.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function loginWithPath(baseUrl, username, password, path) {
  const body = new URLSearchParams();
  body.set('username', username);
  body.set('password', password);
  if (path.includes('/login')) body.set('grant_type', 'password');
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
    if (!response.ok) {
      const detail = payload?.detail;
      const message = typeof detail === 'string'
        ? detail
        : detail?.message || payload?.message || `登录失败 HTTP ${response.status}`;
      const err = new Error(message);
      err.status = response.status;
      throw err;
    }
    return unwrap(payload);
  } finally {
    clearTimeout(timer);
  }
}

async function login(baseUrl, username, password) {
  // 1.5.2 优先使用 /api/v1/wx/auth/token；旧版使用 /api/v1/wx/auth/login
  const paths = ['/api/v1/wx/auth/token', '/api/v1/wx/auth/login'];
  let lastErr = null;
  for (const path of paths) {
    try {
      const result = await loginWithPath(baseUrl, username, password, path);
      if (result?.access_token) return result;
    } catch (e) {
      lastErr = e;
      // 405 / 404 时尝试下一个路径
      if (e.status !== 405 && e.status !== 404) break;
    }
  }
  throw lastErr || new Error('WeRss 登录失败');
}

// 公众号字段映射：
// - GET /mps（已订阅列表）: id/mp_name/mp_cover/mp_intro/status
// - GET /mps/search/{kw}（微信搜索）: fakeid/nickname/alias/round_head_img/signature
function adaptMp(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    mpId: String(raw.id || raw.mp_id || raw.fakeid || raw.mpId || ''),
    mpName: raw.mp_name || raw.nickname || raw.name || raw.mpName || '',
    mpAlias: raw.mp_alias || raw.alias || raw.username || raw.mpAlias || '',
    mpIntro: raw.mp_intro || raw.signature || raw.intro || raw.mpIntro || '',
    avatar: raw.mp_cover || raw.round_head_img || raw.headimg || raw.head_img || raw.logo || raw.icon || raw.avatar || raw.cover || '',
    status: raw.status,
  };
}

// 文章字段映射（实测：id/title/description/pic_url/url/updated_at_millis）
function adaptArticle(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const publishTime = raw.publish_time || raw.published_at || raw.pub_time || raw.publish_at || raw.timestamp || raw.time || raw.date || raw.updated_at_millis || raw.updated_at || raw.create_time || raw.publishTime;
  let ts = null;
  if (publishTime) {
    if (typeof publishTime === 'number') {
      // 秒级时间戳转毫秒
      ts = publishTime > 1e12 ? Math.floor(publishTime) : Math.floor(publishTime * 1000);
    } else {
      const parsed = new Date(publishTime).getTime();
      ts = Number.isFinite(parsed) ? parsed : null;
    }
  }
  return {
    id: String(raw.id || raw.article_id || raw.doc_id || ''),
    mpId: String(raw.mp_id || raw.mpId || ''),
    title: raw.title || raw.article_title || '',
    summary: raw.summary || raw.description || raw.intro || raw.digest || '',
    content: raw.content || raw.article_content || '',
    url: raw.url || raw.source_url || raw.link || '',
    cover: raw.cover || raw.pic_url || raw.article_cover || raw.thumb || '',
    publishTime: ts,
  };
}

async function listSubscriptions(baseUrl, token, opts = {}) {
  const { limit = 50, offset = 0, kw = '' } = opts;
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  if (kw) params.set('kw', kw);
  const payload = await wersssFetch(baseUrl, token, `/api/v1/wx/mps?${params}`);
  return extractList(payload).map(adaptMp).filter(Boolean);
}

// 触发 we-mp-rss 去微信抓取该公众号的最新文章（同步返回抓取结果，但 list 可能为空）
async function updateMp(baseUrl, token, mpId, opts = {}) {
  const params = new URLSearchParams();
  if (opts.startPage) params.set('start_page', String(opts.startPage));
  if (opts.endPage) params.set('end_page', String(opts.endPage));
  const qs = params.toString();
  const url = `/api/v1/wx/mps/update/${encodeURIComponent(mpId)}${qs ? `?${qs}` : ''}`;
  const payload = await wersssFetch(baseUrl, token, url);
  return unwrap(payload);
}

async function searchMp(baseUrl, token, kw, opts = {}) {
  const { limit = 20 } = opts;
  const payload = await wersssFetch(baseUrl, token, `/api/v1/wx/mps/search/${encodeURIComponent(kw)}?limit=${limit}`);
  return extractList(payload).map(adaptMp).filter(Boolean);
}

async function listArticles(baseUrl, token, opts = {}) {
  const { mpId = '', limit = 20, offset = 0, hasContent = false } = opts;
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  if (mpId) params.set('mp_id', mpId);
  if (hasContent) params.set('has_content', 'true');
  const payload = await wersssFetch(baseUrl, token, `/api/v1/wx/articles?${params}`);
  return extractList(payload).map(adaptArticle).filter(Boolean);
}

async function getArticle(baseUrl, token, id) {
  const payload = await wersssFetch(baseUrl, token, `/api/v1/wx/articles/${encodeURIComponent(id)}?content=true`);
  return adaptArticle(unwrap(payload));
}

async function verifyToken(baseUrl, token) {
  const payload = await wersssFetch(baseUrl, token, '/api/v1/auth/verify');
  return unwrap(payload);
}

async function qrStatus(baseUrl, token) {
  const payload = await wersssFetch(baseUrl, token, '/api/v1/auth/qr/status');
  return unwrap(payload);
}

async function qrImage(baseUrl, token) {
  const payload = await wersssFetch(baseUrl, token, '/api/v1/auth/qr/image');
  const data = unwrap(payload);
  if (typeof data === 'string') return data;
  return data?.qr_url || data?.url || data?.image || data?.code || '';
}

async function qrCode(baseUrl, token) {
  const payload = await wersssFetch(baseUrl, token, '/api/v1/auth/qr/code');
  const data = unwrap(payload);
  if (typeof data === 'string') return data;
  return data?.qr_url || data?.url || data?.code || '';
}

module.exports = {
  login,
  listSubscriptions,
  searchMp,
  listArticles,
  getArticle,
  updateMp,
  verifyToken,
  qrStatus,
  qrImage,
  qrCode,
  wersssFetch,
  unwrap,
  extractList,
  adaptMp,
  adaptArticle,
};
