// 路由组：WeRss 公众号文章同步（we-mp-rss）
// 依赖通过 ctx 注入：getWersssConfigRow/getWersssConfig/getValidWersssToken/
// getWersssAuthStatus/syncWersssArticles/prefetchWersssContent
const { db } = require('../db');
const { encryptKb } = require('../auth');
const { json, readBody } = require('../http');
const wersss = require('../../kb_wersss');

async function tryRoute(req, res, url, ctx) {
  const {
    getWersssConfigRow, getWersssConfig, getValidWersssToken,
    getWersssAuthStatus, syncWersssArticles, prefetchWersssContent,
  } = ctx;

  if (url.pathname === '/api/_/wersss/config' && req.method === 'GET') {
    const row = getWersssConfigRow();
    if (!row) { json(res, 200, { ok: true, data: { configured: false, enabled: false } }); return true; }
    json(res, 200, {
      ok: true,
      data: {
        configured: true,
        enabled: Boolean(row.enabled),
        baseUrl: row.base_url,
        username: row.username,
        hasToken: Boolean(row.token),
        tokenExpiresAt: row.token_expires_at,
        updatedAt: row.updated_at,
      },
    });
    return true;
  }

  if (url.pathname === '/api/_/wersss/config' && req.method === 'POST') {
    const { data } = await readBody(req);
    const baseUrl = String(data.baseUrl || '').trim().replace(/\/$/, '');
    const username = String(data.username || '').trim();
    const password = String(data.password || '');
    const enabled = data.enabled !== false;
    if (!baseUrl || !username) { json(res, 400, { ok: false, error: 'baseUrl 和 username 必填' }); return true; }
    if (!password) {
      const existing = getWersssConfigRow();
      if (!existing) { json(res, 400, { ok: false, error: '首次配置必须填写 password' }); return true; }
      db.prepare(`UPDATE wersss_config SET base_url = ?, username = ?, enabled = ?, updated_at = ? WHERE id = 1`)
        .run(baseUrl, username, enabled ? 1 : 0, Date.now());
      json(res, 200, { ok: true, data: { saved: true, tested: false } });
      return true;
    }
    let loginResult;
    try { loginResult = await wersss.login(baseUrl, username, password); }
    catch (e) { json(res, 400, { ok: false, error: `连接测试失败：${e.message}` }); return true; }
    if (!loginResult?.access_token) { json(res, 400, { ok: false, error: 'we-mp-rss 未返回 token' }); return true; }
    const expiresIn = loginResult.expires_in ? Number(loginResult.expires_in) * 1000 : 24 * 60 * 60 * 1000;
    const expiresAt = Date.now() + expiresIn;
    const enc = encryptKb(password);
    db.prepare(`
      INSERT INTO wersss_config (id, base_url, username, password_enc, token, token_expires_at, enabled, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        base_url = excluded.base_url,
        username = excluded.username,
        password_enc = excluded.password_enc,
        token = excluded.token,
        token_expires_at = excluded.token_expires_at,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(baseUrl, username, enc, loginResult.access_token, expiresAt, enabled ? 1 : 0, Date.now());
    json(res, 200, { ok: true, data: { saved: true, tested: true, tokenExpiresAt: expiresAt } });
    return true;
  }

  if (url.pathname === '/api/_/wersss/status' && req.method === 'GET') {
    try {
      const status = await getWersssAuthStatus();
      json(res, 200, { ok: true, data: status });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }

  if (url.pathname === '/api/_/wersss/qr/start' && req.method === 'POST') {
    try {
      const valid = await getValidWersssToken();
      const config = getWersssConfig();
      const qrUrl = await wersss.startWersssAuth(config.baseUrl, valid.token);
      json(res, 200, { ok: true, data: { qrUrl } });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }

  if (url.pathname === '/api/_/wersss/subscriptions' && req.method === 'GET') {
    const rows = db.prepare('SELECT * FROM wersss_subscriptions ORDER BY added_at DESC').all();
    json(res, 200, { ok: true, data: rows.map(r => ({
      mpId: r.mp_id, mpName: r.mp_name, mpAlias: r.mp_alias, avatar: r.avatar,
      lastSyncedAt: r.last_synced_at, enabled: Boolean(r.enabled), addedAt: r.added_at,
    })) });
    return true;
  }

  if (url.pathname === '/api/_/wersss/subscriptions' && req.method === 'POST') {
    const { data } = await readBody(req);
    const mpId = String(data.mpId || '').trim();
    const mpName = String(data.mpName || '').trim();
    if (!mpId || !mpName) { json(res, 400, { ok: false, error: 'mpId 和 mpName 必填' }); return true; }
    db.prepare(`
      INSERT INTO wersss_subscriptions (mp_id, mp_name, mp_alias, avatar, enabled, added_at)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(mp_id) DO UPDATE SET mp_name = excluded.mp_name, mp_alias = excluded.mp_alias, avatar = excluded.avatar
    `).run(mpId, mpName, String(data.mpAlias || ''), String(data.avatar || ''), Date.now());
    json(res, 200, { ok: true });
    return true;
  }

  const wersssSubMatch = url.pathname.match(/^\/api\/_\/wersss\/subscriptions\/([^/]+)$/);
  if (wersssSubMatch && req.method === 'DELETE') {
    const mpId = decodeURIComponent(wersssSubMatch[1]);
    db.prepare('DELETE FROM wersss_subscriptions WHERE mp_id = ?').run(mpId);
    db.prepare('DELETE FROM wersss_articles WHERE mp_id = ?').run(mpId);
    json(res, 200, { ok: true });
    return true;
  }

  if (url.pathname === '/api/_/wersss/search' && req.method === 'GET') {
    const kw = String(url.searchParams.get('kw') || '').trim();
    if (!kw) { json(res, 400, { ok: false, error: 'kw 必填' }); return true; }
    try {
      const { token, config } = await getValidWersssToken();
      const result = await wersss.searchMp(config.baseUrl, token, kw, { limit: 20 });
      json(res, 200, { ok: true, data: result });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }

  if (url.pathname === '/api/_/wersss/subscriptions/available' && req.method === 'GET') {
    try {
      const { token, config } = await getValidWersssToken();
      const result = await wersss.listSubscriptions(config.baseUrl, token, { limit: 100 });
      const subscribedHere = new Set(db.prepare('SELECT mp_id FROM wersss_subscriptions').all().map(r => r.mp_id));
      const data = result.map(mp => ({ ...mp, alreadySubscribed: subscribedHere.has(mp.mpId) }));
      json(res, 200, { ok: true, data });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }

  if (url.pathname === '/api/_/wersss/articles' && req.method === 'GET') {
    const mpId = String(url.searchParams.get('mp_id') || '').trim();
    const limit = Math.min(100, Number(url.searchParams.get('limit')) || 50);
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const rows = mpId
      ? db.prepare(`SELECT a.id, a.mp_id, s.mp_name, a.title, a.summary, a.url, a.cover, a.publish_time, a.synced_at
                    FROM wersss_articles a LEFT JOIN wersss_subscriptions s ON s.mp_id = a.mp_id
                    WHERE a.mp_id = ? ORDER BY a.publish_time DESC, a.synced_at DESC LIMIT ? OFFSET ?`).all(mpId, limit, offset)
      : db.prepare(`SELECT a.id, a.mp_id, s.mp_name, a.title, a.summary, a.url, a.cover, a.publish_time, a.synced_at
                    FROM wersss_articles a LEFT JOIN wersss_subscriptions s ON s.mp_id = a.mp_id
                    ORDER BY a.publish_time DESC, a.synced_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
    json(res, 200, { ok: true, data: rows.map(r => ({
      id: r.id, mpId: r.mp_id, mpName: r.mp_name, title: r.title, summary: r.summary,
      url: r.url, cover: r.cover, publishTime: r.publish_time, syncedAt: r.synced_at,
    })) });
    return true;
  }

  const wersssArtMatch = url.pathname.match(/^\/api\/_\/wersss\/articles\/([^/]+)$/);
  if (wersssArtMatch && req.method === 'GET') {
    const id = decodeURIComponent(wersssArtMatch[1]);
    const row = db.prepare(`
      SELECT a.*, s.mp_name FROM wersss_articles a
      LEFT JOIN wersss_subscriptions s ON s.mp_id = a.mp_id
      WHERE a.id = ?
    `).get(id);
    if (!row) { json(res, 404, { ok: false, error: '文章不存在，请先同步' }); return true; }
    if (!row.content || row.content.length < 100) {
      try {
        const { token, config } = await getValidWersssToken();
        const fresh = await wersss.getArticle(config.baseUrl, token, id);
        if (fresh && fresh.content) {
          db.prepare('UPDATE wersss_articles SET content = ? WHERE id = ?').run(fresh.content, id);
          row.content = fresh.content;
          if (fresh.title && !row.title) row.title = fresh.title;
        }
      } catch (e) {
        console.warn(`[wersss] 抓正文失败 ${id}:`, e.message);
      }
    }
    json(res, 200, { ok: true, data: {
      id: row.id, mpId: row.mp_id, mpName: row.mp_name, title: row.title, summary: row.summary,
      content: row.content, url: row.url, cover: row.cover,
      publishTime: row.publish_time, syncedAt: row.synced_at,
    } });
    return true;
  }

  const wersssPrefetchMatch = url.pathname.match(/^\/api\/_\/wersss\/articles\/([^/]+)\/prefetch$/);
  if (wersssPrefetchMatch && req.method === 'POST') {
    const id = decodeURIComponent(wersssPrefetchMatch[1]);
    const row = db.prepare('SELECT mp_id FROM wersss_articles WHERE id = ?').get(id);
    if (!row) { json(res, 404, { ok: false, error: '文章不存在' }); return true; }
    try {
      const { token, config } = await getValidWersssToken();
      const fresh = await wersss.getArticle(config.baseUrl, token, id);
      if (!fresh?.content) { json(res, 500, { ok: false, error: 'we-mp-rss 未返回正文' }); return true; }
      db.prepare('UPDATE wersss_articles SET content = ? WHERE id = ?').run(fresh.content, id);
      json(res, 200, { ok: true, data: { length: fresh.content.length } });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }

  if (url.pathname === '/api/_/wersss/sync' && req.method === 'POST') {
    try {
      const result = await syncWersssArticles();
      json(res, 200, { ok: true, data: result });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }

  if (url.pathname === '/api/_/wersss/prefetch' && req.method === 'POST') {
    try {
      const result = await prefetchWersssContent();
      json(res, 200, { ok: true, data: result });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }

  if (url.pathname === '/api/_/wersss/search-local' && req.method === 'GET') {
    const q = String(url.searchParams.get('q') || '').trim();
    const mpId = String(url.searchParams.get('mp_id') || '').trim();
    const limit = Math.min(50, Number(url.searchParams.get('limit')) || 30);
    if (!q) { json(res, 200, { ok: true, data: [] }); return true; }
    const like = `%${q}%`;
    const rows = db.prepare(`
      SELECT a.id, a.mp_id, s.mp_name, a.title, a.summary, a.url, a.cover, a.publish_time, a.synced_at
      FROM wersss_articles a LEFT JOIN wersss_subscriptions s ON s.mp_id = a.mp_id
      WHERE (a.title LIKE ? OR a.summary LIKE ? OR a.content LIKE ?)
        ${mpId ? 'AND a.mp_id = ?' : ''}
      ORDER BY a.publish_time DESC LIMIT ?
    `).all(...(mpId ? [like, like, like, mpId, limit] : [like, like, like, limit]));
    json(res, 200, { ok: true, data: rows.map(r => ({
      id: r.id, mpId: r.mp_id, mpName: r.mp_name, title: r.title, summary: r.summary,
      url: r.url, cover: r.cover, publishTime: r.publish_time, syncedAt: r.synced_at,
    })) });
    return true;
  }

  return false;
}

module.exports = { tryRoute };
