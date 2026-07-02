// 路由组：选题系统（灵感库）
// 依赖通过 ctx 注入：getInspirationSourceMeta/listInspirationConfigs/saveInspirationConfig/
// getInspirationConfig/deleteInspirationConfig/runInspirationConfig/listInspirationRuns/
// listInspirations/generateInspirations/setInspirationFavorite/applyInspirationFeedback/
// trashInspiration/restoreInspiration/permanentlyDeleteInspiration/logAction
const crypto = require('crypto');
const { db } = require('../db');
const { json, readBody } = require('../http');

async function tryRoute(req, res, url, ctx) {
  const {
    getInspirationSourceMeta, listInspirationConfigs, saveInspirationConfig,
    getInspirationConfig, deleteInspirationConfig, runInspirationConfig,
    listInspirationRuns, listInspirations, generateInspirations,
    setInspirationFavorite, applyInspirationFeedback,
    trashInspiration, restoreInspiration, permanentlyDeleteInspiration,
    logAction,
  } = ctx;

  if (url.pathname === '/api/_/inspiration-sources' && req.method === 'GET') {
    json(res, 200, { ok: true, data: getInspirationSourceMeta() });
    return true;
  }

  if (url.pathname === '/api/_/inspiration-configs' && req.method === 'GET') {
    json(res, 200, { ok: true, data: listInspirationConfigs() });
    return true;
  }

  if (url.pathname === '/api/_/inspiration-configs' && req.method === 'POST') {
    const { data } = await readBody(req);
    try {
      json(res, 200, { ok: true, data: saveInspirationConfig(data) });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    return true;
  }

  const configMatch = url.pathname.match(/^\/api\/_\/inspiration-configs\/([^/]+)(?:\/(run|toggle))?$/);
  if (configMatch) {
    const id = decodeURIComponent(configMatch[1]);
    const action = configMatch[2] || '';
    if (!action && req.method === 'GET') {
      const config = getInspirationConfig(id);
      json(res, config ? 200 : 404, config
        ? { ok: true, data: config }
        : { ok: false, error: '主题配置不存在' });
      return true;
    }
    if (!action && req.method === 'PUT') {
      const { data } = await readBody(req);
      try {
        json(res, 200, { ok: true, data: saveInspirationConfig(data, id) });
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
      }
      return true;
    }
    if (!action && req.method === 'DELETE') {
      const deleted = deleteInspirationConfig(id);
      json(res, deleted ? 200 : 404, deleted
        ? { ok: true }
        : { ok: false, error: '主题配置不存在' });
      return true;
    }
    if (action === 'toggle' && req.method === 'POST') {
      const { data } = await readBody(req);
      const config = getInspirationConfig(id);
      if (!config) { json(res, 404, { ok: false, error: '主题配置不存在' }); return true; }
      json(res, 200, { ok: true, data: saveInspirationConfig({ ...config, enabled: Boolean(data.enabled) }, id) });
      return true;
    }
    if (action === 'run' && req.method === 'POST') {
      try {
        json(res, 200, { ok: true, data: await runInspirationConfig(id, 'manual') });
      } catch (error) {
        json(res, 500, { ok: false, error: error.message });
      }
      return true;
    }
  }

  if (url.pathname === '/api/_/inspiration-runs' && req.method === 'GET') {
    json(res, 200, { ok: true, data: listInspirationRuns(url.searchParams.get('configId')) });
    return true;
  }

  if (url.pathname === '/api/_/inspirations' && req.method === 'GET') {
    json(res, 200, { ok: true, data: listInspirations(url.searchParams.get('deleted') === '1') });
    return true;
  }

  if (url.pathname === '/api/_/inspirations/count' && req.method === 'GET') {
    const active = db.prepare('SELECT COUNT(*) AS n FROM inspirations WHERE deleted_at IS NULL').get().n;
    const favorite = db.prepare('SELECT COUNT(*) AS n FROM inspirations WHERE deleted_at IS NULL AND is_favorite = 1').get().n;
    const trash = db.prepare('SELECT COUNT(*) AS n FROM inspirations WHERE deleted_at IS NOT NULL').get().n;
    json(res, 200, { ok: true, data: { active, favorite, trash } });
    return true;
  }

  if (url.pathname === '/api/_/inspirations' && req.method === 'POST') {
    const { data } = await readBody(req);
    const title = String(data.title || '').trim();
    if (!title) { json(res, 400, { ok: false, error: '标题必填' }); return true; }
    const id = data.id || `insp:${crypto.randomUUID()}`;
    const now = Date.now();
    db.prepare(`
      INSERT INTO inspirations (id, title, summary, angle, target_platform, source_keywords, source_items, status, created_at, updated_at, generation_type, source_mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, summary = excluded.summary, updated_at = excluded.updated_at
    `).run(
      id, title, String(data.summary || ''), String(data.angle || '预设'),
      String(data.targetPlatform || ''), JSON.stringify(data.sourceKeywords || []),
      JSON.stringify(data.sourceItems || []), String(data.status || '待研究'),
      now, now, String(data.generationType || 'manual'),
      String(data.sourceMode || 'llm-reasoning')
    );
    json(res, 200, { ok: true, data: { id } });
    return true;
  }

  if (url.pathname === '/api/_/inspirations/generate' && req.method === 'POST') {
    const { data } = await readBody(req);
    const result = await generateInspirations(data);
    logAction('generate-inspirations', 'button', result.research?.localGroupCount ? 'database+api' : 'api', {
      keywords: result.keywords,
      searches: result.research?.searches || [],
      articleCount: result.research?.articleCount || 0,
    }, result.research?.apiCalls || 0, result.research?.llmCalls || 1);
    json(res, 200, { ok: true, data: result });
    return true;
  }

  if (url.pathname.startsWith('/api/_/inspirations/') && req.method === 'PATCH') {
    const id = decodeURIComponent(url.pathname.slice('/api/_/inspirations/'.length));
    const { data } = await readBody(req);
    db.prepare('UPDATE inspirations SET status = ? WHERE id = ?').run(String(data.status || '待研究'), id);
    json(res, 200, { ok: true });
    return true;
  }

  const inspirationActionMatch = url.pathname.match(/^\/api\/_\/inspirations\/([^/]+)\/(favorite|feedback|trash|restore|permanent)$/);
  if (inspirationActionMatch && req.method === 'POST') {
    const id = decodeURIComponent(inspirationActionMatch[1]);
    const { data } = await readBody(req);
    try {
      if (inspirationActionMatch[2] === 'favorite') {
        setInspirationFavorite(id, Boolean(data.favorite));
        json(res, 200, { ok: true });
      } else if (inspirationActionMatch[2] === 'feedback') {
        json(res, 200, { ok: true, data: applyInspirationFeedback(id, String(data.type || 'none')) });
      } else if (inspirationActionMatch[2] === 'trash') {
        trashInspiration(id);
        json(res, 200, { ok: true });
      } else if (inspirationActionMatch[2] === 'restore') {
        restoreInspiration(id);
        json(res, 200, { ok: true });
      } else {
        permanentlyDeleteInspiration(id);
        json(res, 200, { ok: true });
      }
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    return true;
  }

  return false;
}

module.exports = { tryRoute };
