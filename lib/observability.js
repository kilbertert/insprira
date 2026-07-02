// 用量统计 + 操作审计日志 + 官方余额查询
// logAction/listActionLogs 只依赖 db；getOfficialQuota 需要 REDFOX_WEB_COOKIE
const { db } = require('./db');
const { parseJson } = require('./utils');

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function logAction(action, triggerSource, dataSource, detail = {}, apiCalls = 0, llmCalls = 0) {
  db.prepare(`
    INSERT INTO action_logs
      (action, trigger_source, data_source, api_calls, llm_calls, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(action, triggerSource, dataSource, apiCalls, llmCalls, JSON.stringify(detail || {}), Date.now());
}

function listActionLogs(limit = 100) {
  return db.prepare(`
    SELECT * FROM action_logs ORDER BY created_at DESC LIMIT ?
  `).all(clamp(limit, 1, 200)).map(row => ({
    id: row.id,
    action: row.action,
    triggerSource: row.trigger_source,
    dataSource: row.data_source,
    apiCalls: row.api_calls,
    llmCalls: row.llm_calls,
    detail: parseJson(row.detail_json) || {},
    createdAt: row.created_at,
  }));
}

function usageSummary() {
  const now = Date.now();
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const summarize = since => db.prepare(`
    SELECT COUNT(*) AS requests,
      SUM(CASE WHEN cached = 0 THEN 1 ELSE 0 END) AS calls,
      SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END) AS cache_hits,
      SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors
    FROM api_usage WHERE created_at >= ?
  `).get(since);
  return {
    today: summarize(dayStart.getTime()),
    last30Days: summarize(now - 30 * 24 * 60 * 60 * 1000),
    topEndpoints: db.prepare(`
      SELECT endpoint, COUNT(*) AS calls
      FROM api_usage WHERE created_at >= ? AND cached = 0
      GROUP BY endpoint ORDER BY calls DESC LIMIT 8
    `).all(now - 30 * 24 * 60 * 60 * 1000),
  };
}

async function getOfficialQuota(redfoxHost, webCookie) {
  if (!webCookie) return { configured: false, error: '未配置 REDFOX_WEB_COOKIE' };
  try {
    const response = await fetch(`https://${redfoxHost}/story/web/points/overview`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Cookie: webCookie,
      },
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json();
    if (!response.ok || ![0, 200, 2000].includes(payload?.code)) {
      throw new Error(payload?.msg || `HTTP ${response.status}`);
    }
    return { configured: true, data: payload.data ?? payload };
  } catch (error) {
    return { configured: true, error: error.message };
  }
}

module.exports = { clamp, logAction, listActionLogs, usageSummary, getOfficialQuota };
