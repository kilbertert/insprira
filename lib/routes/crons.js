// 路由组：crontab CRUD + 立即运行 + 重排
// 由 handleLocalApi 调用 try(req, res, url, ctx)，返回 true 表示已处理
const { db } = require('../db');
const { parseCronExpr } = require('../cron-parser');
const { parseJson } = require('../utils');
const { json, readBody } = require('../http');

const ALLOWED_TASK_TYPES = [
  'hot-realtime', 'hot-platform', 'hot-trend-analysis', 'inspiration-generate',
  'daily-hot-report', 'tracker-refresh', 'cache-clean', 'usage-clean', 'wersss-sync',
];

// 系统固定任务：不允许删除（与 js/config.js PROTECTED_CRONS 对应）
const PROTECTED_CRON_IDS = [
  'cache-clean', 'usage-clean',
  'hot-realtime', 'hot-trend-analysis', 'hot-daily-report',
  'tracked-account-daily', 'wersss-sync',
];

async function tryRoute(req, res, url, ctx) {
  const { listCronJobs, saveCronJob, deleteCronJob, runCronJob, isInspirationCronId } = ctx;

  if (url.pathname === '/api/_/crons' && req.method === 'GET') {
    json(res, 200, { ok: true, data: listCronJobs() });
    return true;
  }

  if (url.pathname === '/api/_/crons' && req.method === 'POST') {
    const { data } = await readBody(req);
    const id = String(data.id || '').trim();
    const name = String(data.name || '').trim();
    const cronExpr = String(data.cronExpr || '').trim();
    const enabled = Boolean(data.enabled);
    const taskType = String(data.taskType || 'custom');
    const taskConfig = data.taskConfig || null;
    const notifyOnFailure = data.notifyOnFailure !== false;
    const notifyOnSuccess = Boolean(data.notifyOnSuccess);
    if (!id || !name || !cronExpr) { json(res, 400, { ok: false, error: 'id、名称和 Cron表达式不能为空' }); return true; }
    if (isInspirationCronId(id)) { json(res, 400, { ok: false, error: '自动选题调度由灵感库页面管理，不能在此创建' }); return true; }
    if (!parseCronExpr(cronExpr)) { json(res, 400, { ok: false, error: 'Cron 表达式格式无效' }); return true; }
    if (!ALLOWED_TASK_TYPES.includes(taskType)) {
      json(res, 400, { ok: false, error: '不支持的任务类型' });
      return true;
    }
    try {
      const jobs = await saveCronJob(id, name, cronExpr, enabled, taskType, taskConfig, { notifyOnFailure, notifyOnSuccess });
      json(res, 200, { ok: true, data: jobs });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }

  const cronDelMatch = url.pathname.match(/^\/api\/_\/crons\/([^/]+)$/);
  if (cronDelMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(cronDelMatch[1]);
    if (isInspirationCronId(id)) { json(res, 400, { ok: false, error: '自动选题调度由灵感库页面管理' }); return true; }
    if (PROTECTED_CRON_IDS.includes(id)) {
      json(res, 400, { ok: false, error: '系统固定任务不能删除' });
      return true;
    }
    try { json(res, 200, { ok: true, data: deleteCronJob(id) }); }
    catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }

  if (url.pathname === '/api/_/crons/run' && req.method === 'POST') {
    const { data } = await readBody(req);
    const id = String(data.id || '');
    const job = db.prepare('SELECT * FROM crontab WHERE id = ?').get(id);
    if (!job) { json(res, 404, { ok: false, error: '任务不存在' }); return true; }
    try {
      await runCronJob(id, job.task_type, parseJson(job.task_config) || {});
      db.prepare('UPDATE crontab SET last_run = ? WHERE id = ?').run(Date.now(), id);
      json(res, 200, { ok: true });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }

  if (url.pathname === '/api/_/crons/reorder' && req.method === 'POST') {
    const { data } = await readBody(req);
    const ids = Array.isArray(data.ids) ? data.ids.map(String) : [];
    if (!ids.length) { json(res, 400, { ok: false, error: '缺少排序 ID 列表' }); return true; }
    try {
      const update = db.prepare('UPDATE crontab SET sort_order = ? WHERE id = ?');
      const reorderTx = db.transaction((idList) => {
        idList.forEach((id, idx) => update.run((idx + 1) * 10, id));
      });
      reorderTx(ids);
      json(res, 200, { ok: true, data: listCronJobs() });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }

  return false;
}

module.exports = { tryRoute, ALLOWED_TASK_TYPES, PROTECTED_CRON_IDS };
