// 路由组：杂项（系统操作、统计、配额、通知、图片代理、agent、snapshot、rewrite）
// 依赖通过 ctx 注入：listActionLogs/usageSummary/getOfficialQuota/
// publicNotificationConfigs/saveNotificationConfigs/notificationConfigs/
// NOTIFICATION_CHANNELS/sendNotification/listLocalAgents/runLocalAgent/
// captureHotSnapshot/findRewriteHotspots/rewriteForPlatform/logAction
const { db } = require('../db');
const { restartCurrentService } = require('../env');
const { json, readBody } = require('../http');

const IMAGE_HOST_ALLOWLIST = ['qpic.cn', 'qlogo.cn', 'redfox.hk'];

async function tryRoute(req, res, url, ctx) {
  const {
    listActionLogs, usageSummary, getOfficialQuota,
    publicNotificationConfigs, saveNotificationConfigs, notificationConfigs,
    NOTIFICATION_CHANNELS, sendNotification,
    listLocalAgents, runLocalAgent,
    captureHotSnapshot, findRewriteHotspots, rewriteForPlatform,
  } = ctx;

  if (url.pathname === '/api/_/service/restart' && req.method === 'POST') {
    json(res, 200, { ok: true, data: { restarting: true } });
    restartCurrentService();
    return true;
  }

  if (url.pathname === '/api/_/stats' && req.method === 'GET') {
    json(res, 200, {
      cache: db.prepare('SELECT COUNT(*) AS n FROM api_cache').get().n,
      accounts: db.prepare('SELECT COUNT(*) AS n FROM tracked_accounts').get().n,
      works: db.prepare('SELECT COUNT(*) AS n FROM account_works').get().n,
      snapshots: db.prepare("SELECT COUNT(*) AS n FROM hot_batches WHERE status = 'success'").get().n,
      inspirations: db.prepare('SELECT COUNT(*) AS n FROM inspirations').get().n,
    });
    return true;
  }

  if (url.pathname === '/api/_/action-logs' && req.method === 'GET') {
    json(res, 200, { ok: true, data: listActionLogs(Number(url.searchParams.get('limit')) || 100) });
    return true;
  }

  if (url.pathname === '/api/_/quota' && req.method === 'GET') {
    json(res, 200, {
      ok: true,
      data: {
        usage: usageSummary(),
        official: await getOfficialQuota(),
      },
    });
    return true;
  }

  if (url.pathname === '/api/_/notifications' && req.method === 'GET') {
    json(res, 200, { ok: true, data: publicNotificationConfigs() });
    return true;
  }

  if (url.pathname === '/api/_/notifications' && req.method === 'PUT') {
    const { data } = await readBody(req);
    json(res, 200, { ok: true, data: saveNotificationConfigs(data || {}) });
    return true;
  }

  if (url.pathname === '/api/_/notifications/test' && req.method === 'POST') {
    const { data } = await readBody(req);
    const channel = String(data.channel || '');
    if (!NOTIFICATION_CHANNELS.has(channel)) {
      json(res, 400, { ok: false, error: '不支持的通知渠道' });
      return true;
    }
    const saved = notificationConfigs()[channel] || {};
    const incoming = data.config || {};
    const config = {
      ...saved,
      ...incoming,
      url: String(incoming.url || '').trim() || saved.url || '',
      botToken: String(incoming.botToken || '').trim() || saved.botToken || '',
      chatId: String(incoming.chatId || '').trim() || saved.chatId || '',
    };
    await sendNotification(channel, config, '灵感熔炉测试通知', '通知渠道配置成功。');
    json(res, 200, { ok: true });
    return true;
  }

  if (url.pathname === '/api/_/image' && req.method === 'GET') {
    const rawUrl = url.searchParams.get('url');
    if (!rawUrl) throw new Error('缺少图片地址');
    const target = new URL(rawUrl);
    const allowed = IMAGE_HOST_ALLOWLIST.some(host => target.hostname === host || target.hostname.endsWith(`.${host}`));
    if (!allowed || !['http:', 'https:'].includes(target.protocol)) {
      json(res, 403, { ok: false, error: '不允许代理该图片地址' });
      return true;
    }
    target.protocol = 'https:';
    const response = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 insprira/0.1.0',
        Referer: 'https://mp.weixin.qq.com/',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || !contentType.startsWith('image/')) {
      json(res, 502, { ok: false, error: `图片获取失败 HTTP ${response.status}` });
      return true;
    }
    const content = Buffer.from(await response.arrayBuffer());
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
      'Cache-Control': 'public, max-age=86400',
    });
    res.end(content);
    return true;
  }

  if (url.pathname === '/api/_/agents' && req.method === 'GET') {
    json(res, 200, { ok: true, data: await listLocalAgents() });
    return true;
  }

  if (url.pathname === '/api/_/agent/chat' && req.method === 'POST') {
    const { data } = await readBody(req);
    json(res, 200, { ok: true, data: await runLocalAgent(data) });
    return true;
  }

  if (url.pathname === '/api/_/snapshot/run' && req.method === 'POST') {
    json(res, 200, { ok: true, data: await captureHotSnapshot() });
    return true;
  }

  if (url.pathname === '/api/_/rewrite/hotspots' && req.method === 'POST') {
    const { data } = await readBody(req);
    json(res, 200, { ok: true, data: await findRewriteHotspots(data) });
    return true;
  }

  if (url.pathname === '/api/_/rewrite' && req.method === 'POST') {
    const { data } = await readBody(req);
    json(res, 200, { ok: true, data: await rewriteForPlatform(data) });
    return true;
  }

  return false;
}

module.exports = { tryRoute, IMAGE_HOST_ALLOWLIST };
