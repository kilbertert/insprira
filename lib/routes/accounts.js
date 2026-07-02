// 路由组：我的账号 + 风格档案 + 创作提示词模板
// 依赖通过 ctx 注入：listMyAccounts/saveMyAccount/getMyAccount/
// extractAccountTracks/extractAccountStyleProfile/generatePresetInspirations/
// suggestInspirationConfigs/createInspirationConfigFromSuggestion
const { db } = require('../db');
const { json, readBody } = require('../http');

async function tryRoute(req, res, url, ctx) {
  const {
    listMyAccounts, saveMyAccount, getMyAccount,
    extractAccountTracks, extractAccountStyleProfile, generatePresetInspirations,
    suggestInspirationConfigs, createInspirationConfigFromSuggestion,
  } = ctx;

  // ========== 我的账号 + 风格档案 ==========
  if (url.pathname === '/api/_/my-accounts' && req.method === 'GET') {
    json(res, 200, { ok: true, data: listMyAccounts() });
    return true;
  }
  if (url.pathname === '/api/_/my-accounts' && req.method === 'POST') {
    const { data } = await readBody(req);
    if (!data.name || !data.plat) { json(res, 400, { ok: false, error: 'name 和 plat 必填' }); return true; }
    const saved = saveMyAccount(data);
    json(res, 200, { ok: true, data: saved });
    return true;
  }
  const myAccDelMatch = url.pathname.match(/^\/api\/_\/my-accounts\/([^/]+)$/);
  if (myAccDelMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(myAccDelMatch[1]);
    db.prepare('DELETE FROM my_accounts WHERE id = ?').run(id);
    json(res, 200, { ok: true });
    return true;
  }
  const extractTracksMatch = url.pathname.match(/^\/api\/_\/my-accounts\/([^/]+)\/extract-tracks$/);
  if (extractTracksMatch && req.method === 'POST') {
    const id = decodeURIComponent(extractTracksMatch[1]);
    const account = getMyAccount(id);
    if (!account) { json(res, 404, { ok: false, error: '账号不存在' }); return true; }
    try {
      const tracks = await extractAccountTracks(account);
      const saved = saveMyAccount({ ...account, tracks });
      json(res, 200, { ok: true, data: { tracks, account: saved } });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }
  const extractStyleMatch = url.pathname.match(/^\/api\/_\/my-accounts\/([^/]+)\/extract-style$/);
  if (extractStyleMatch && req.method === 'POST') {
    const id = decodeURIComponent(extractStyleMatch[1]);
    const account = getMyAccount(id);
    if (!account) { json(res, 404, { ok: false, error: '账号不存在' }); return true; }
    try {
      const profile = await extractAccountStyleProfile(account);
      const saved = saveMyAccount({ ...account, styleProfile: profile, styleUpdatedAt: Date.now() });
      json(res, 200, { ok: true, data: { profile, account: saved } });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }
  const presetInspMatch = url.pathname.match(/^\/api\/_\/my-accounts\/([^/]+)\/preset-inspirations$/);
  if (presetInspMatch && req.method === 'POST') {
    const id = decodeURIComponent(presetInspMatch[1]);
    const account = getMyAccount(id);
    if (!account) { json(res, 404, { ok: false, error: '账号不存在' }); return true; }
    try {
      const ideas = await generatePresetInspirations(account);
      json(res, 200, { ok: true, data: ideas });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }
  const suggestCfgMatch = url.pathname.match(/^\/api\/_\/my-accounts\/([^/]+)\/suggest-configs$/);
  if (suggestCfgMatch && req.method === 'GET') {
    const id = decodeURIComponent(suggestCfgMatch[1]);
    const account = getMyAccount(id);
    if (!account) { json(res, 404, { ok: false, error: '账号不存在' }); return true; }
    try {
      const suggestions = await suggestInspirationConfigs(account);
      json(res, 200, { ok: true, data: suggestions });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }
  const createCfgMatch = url.pathname.match(/^\/api\/_\/my-accounts\/([^/]+)\/create-config$/);
  if (createCfgMatch && req.method === 'POST') {
    const id = decodeURIComponent(createCfgMatch[1]);
    const account = getMyAccount(id);
    if (!account) { json(res, 404, { ok: false, error: '账号不存在' }); return true; }
    const { data } = await readBody(req);
    try {
      const config = createInspirationConfigFromSuggestion(account, data.suggestion || data);
      json(res, 200, { ok: true, data: config });
    } catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return true;
  }

  // ========== 创作提示词模板 ==========
  if (url.pathname === '/api/_/style-templates' && req.method === 'GET') {
    const rows = db.prepare('SELECT * FROM style_templates ORDER BY is_default DESC, created_at DESC').all();
    json(res, 200, { ok: true, data: rows.map(r => ({
      id: r.id, name: r.name, platform: r.platform, template: r.template,
      isDefault: Boolean(r.is_default), createdAt: r.created_at, updatedAt: r.updated_at,
    })) });
    return true;
  }
  if (url.pathname === '/api/_/style-templates' && req.method === 'POST') {
    const { data } = await readBody(req);
    if (!data.name || !data.template) { json(res, 400, { ok: false, error: 'name 和 template 必填' }); return true; }
    const id = data.id || `tpl:${Date.now()}`;
    const now = Date.now();
    db.prepare(`
      INSERT INTO style_templates (id, name, platform, template, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, platform = excluded.platform, template = excluded.template,
        is_default = excluded.is_default, updated_at = excluded.updated_at
    `).run(id, String(data.name), String(data.platform || 'all'), String(data.template), data.isDefault ? 1 : 0, now, now);
    json(res, 200, { ok: true, data: { id } });
    return true;
  }
  const styleTplDelMatch = url.pathname.match(/^\/api\/_\/style-templates\/([^/]+)$/);
  if (styleTplDelMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(styleTplDelMatch[1]);
    db.prepare('DELETE FROM style_templates WHERE id = ?').run(id);
    json(res, 200, { ok: true });
    return true;
  }

  return false;
}

module.exports = { tryRoute };
