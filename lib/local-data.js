// local_data 表的简单 KV 包装：模块级缓存、运行状态、过期标记
// 依赖：lib/db、lib/utils.parseJson
const { db } = require('./db');
const { parseJson } = require('./utils');

function getLocalData(module, key) {
  const row = db.prepare('SELECT data_json, expires_at FROM local_data WHERE module = ? AND data_key = ?').get(module, key);
  if (!row) return null;
  if (row.expires_at && row.expires_at < Date.now()) {
    db.prepare('DELETE FROM local_data WHERE module = ? AND data_key = ?').run(module, key);
    return null;
  }
  return parseJson(row.data_json);
}

function setLocalData(module, key, data, expiresAt = null) {
  db.prepare(`
    INSERT INTO local_data (module, data_key, data_json, cached_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(module, data_key) DO UPDATE SET
      data_json = excluded.data_json,
      cached_at = excluded.cached_at,
      expires_at = excluded.expires_at
  `).run(module, key, JSON.stringify(data), Date.now(), expiresAt);
}

module.exports = { getLocalData, setLocalData };
