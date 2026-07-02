// 灵感熔炉 · 本地服务、RedFox 代理、SQLite 数据仓库
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const Database = require('better-sqlite3');

const { scanVault, readEntry, writeNote, updateNote, deleteNote, listFolders, listAllTags } = require('./kb_obsidian');
const { searchPages, getPage, createPage, updatePage, deletePage } = require('./kb_notion');
const wersss = require('./kb_wersss');

const {
  parseJson, stableObject, toNumber, localDate, dateDaysAgo, dateFromYmd,
  workPublishAt, workContentKey, gitBlobSha, parseAgentJsonLines,
} = require('./lib/utils');
const { parseCronExpr, validateCronField, nextCronTime, matchesCronField } = require('./lib/cron-parser');
const {
  PASSWORD_SCRYPT_OPTIONS, hashPassword, verifyPassword, validateUsername, validatePassword,
} = require('./lib/password');
const {
  EDITABLE_ENV_KEYS, loadEnvFile, readEnvValues, publicEnvConfig, updateEnvConfig, restartCurrentService,
} = require('./lib/env');
const { serveStatic: serveStaticFromLib } = require('./lib/static');
const {
  REDFOX_HOST, REDFOX_PATH_PREFIX, API_KEY,
  REDFOX_ENDPOINTS, CACHE_TTL, AI_FEED_PLATFORMS,
  getCacheKey, getCached, isCacheableRedfoxResponse, setCache, logApiUsage,
  redfoxRequest, redfoxData, redfoxGetData,
} = require('./lib/redfox');
const {
  sessions, sessionSet, sessionDel, sessionGet, sessionClean,
  getCookies, publicUser, currentSession, isAuthorized,
  KB_ENC_INSECURE, encryptKb, decryptKb,
} = require('./lib/auth');
const {
  HOTSPOT_LISTS,
  normalizeSnapshotItems,
  normalizeHotspots,
  normalizeRealtimeHotspots,
} = require('./lib/normalize');
const { MAX_BODY_SIZE, json, readBody } = require('./lib/http');

const APP_VERSION = (() => {
  try { return require('./package.json').version || '0.0.0'; } catch { return '0.0.0'; }
})();

const execFileAsync = promisify(execFile);

const ENV_FILE = path.join(__dirname, '.env');
loadEnvFile(ENV_FILE);

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const ENABLE_SCHEDULER = process.env.ENABLE_SCHEDULER !== 'false';
const REDFOX_WEB_COOKIE = process.env.REDFOX_WEB_COOKIE || '';
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const KIMI_BIN = process.env.KIMI_BIN || 'kimi';
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || 'openclaw';
const HERMES_BIN = process.env.HERMES_BIN || 'hermes';
const { db, ensureColumn, DATA_ROOT } = require('./lib/db');
const SKILLS_ROOT = path.join(DATA_ROOT, 'skills', 'redfox-community', 'skills');
const SKILLS_REPO_ROOT = path.dirname(SKILLS_ROOT);
const SKILLS_GITHUB_REPO = 'redfox-data/redfox-community';
const SKILLS_NEW_BADGE_MS = 7 * 24 * 60 * 60 * 1000;
const WECHAT_ANALYZER_ROOT = path.join(SKILLS_ROOT, 'wechat-account-analyzer');
const DOUYIN_ANALYZER_ROOT = path.join(SKILLS_ROOT, 'douyin-account-diagnosis');
const XHS_ANALYZER_ROOT = path.join(SKILLS_ROOT, 'xiaohongshu-account-analyzer');
const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = '123456';
let agentBusy = false;
let diagnosisBusy = false;

// DB schema + ensureColumn 已移到 lib/db.js；DATA_ROOT / db 通过 require 获取
sessionClean();
db.transaction(() => {
  const update = db.prepare('UPDATE tracked_accounts SET raw_info = ? WHERE id = ?');
  for (const row of db.prepare("SELECT id, raw_info FROM tracked_accounts WHERE raw_info LIKE '%红狐指数%'").all()) {
    const raw = parseJson(row.raw_info) || {};
    if (!String(raw.authorFans || '').startsWith('红狐指数')) continue;
    delete raw.authorFans;
    update.run(JSON.stringify(raw), row.id);
  }
})();
db.transaction(() => {
  const rows = db.prepare(`
    SELECT account_id, plat, work_id, work_data, synced_at
    FROM account_works
    WHERE publish_at IS NULL OR content_key IS NULL
    ORDER BY synced_at DESC
  `).all();
  const seen = new Set();
  const update = db.prepare(`
    UPDATE account_works SET publish_at = ?, content_key = ?
    WHERE account_id = ? AND plat = ? AND work_id = ?
  `);
  const remove = db.prepare(`
    DELETE FROM account_works WHERE account_id = ? AND plat = ? AND work_id = ?
  `);
  for (const row of rows) {
    const work = parseJson(row.work_data);
    if (!work) continue;
    const contentKey = workContentKey(work);
    const uniqueKey = `${row.account_id}:${row.plat}:${contentKey}`;
    if (seen.has(uniqueKey)) {
      remove.run(row.account_id, row.plat, row.work_id);
      continue;
    }
    seen.add(uniqueKey);
    update.run(workPublishAt(work), contentKey, row.account_id, row.plat, row.work_id);
  }
})();

function migrateLegacyHotSnapshots() {
  if (getLocalData('hot', 'batch-migration-v1')) return;
  const groups = db.prepare(`
    SELECT platform, snapshot_date, captured_at
    FROM hot_snapshots
    GROUP BY platform, snapshot_date, captured_at
    ORDER BY captured_at ASC
  `).all();
  const insertBatch = db.prepare(`
    INSERT OR IGNORE INTO hot_batches
      (id, platform, data_date, snapshot_kind, endpoint, request_json, response_json,
       status, item_count, started_at, completed_at)
    VALUES (?, ?, ?, 'legacy', 'legacy/hot_snapshots', '{}', ?, 'success', ?, ?, ?)
  `);
  const insertItem = db.prepare(`
    INSERT OR IGNORE INTO hot_batch_items
      (batch_id, rank, item_key, title, score, raw_data)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const group of groups) {
      const rows = db.prepare(`
        SELECT rank, item_key, title, score, raw_data
        FROM hot_snapshots
        WHERE platform = ? AND snapshot_date = ? AND captured_at = ?
        ORDER BY rank ASC
      `).all(group.platform, group.snapshot_date, group.captured_at);
      const batchId = `legacy-${crypto.createHash('sha1').update(
        `${group.platform}:${group.snapshot_date}:${group.captured_at}`,
      ).digest('hex').slice(0, 24)}`;
      insertBatch.run(
        batchId,
        group.platform,
        group.snapshot_date,
        JSON.stringify(rows.map(row => parseJson(row.raw_data))),
        rows.length,
        group.captured_at,
        group.captured_at,
      );
      for (const row of rows) {
        insertItem.run(batchId, row.rank, row.item_key, row.title, row.score, row.raw_data);
      }
    }
    setLocalData('hot', 'batch-migration-v1', { migratedAt: Date.now(), groups: groups.length });
  })();
}
migrateLegacyHotSnapshots();

// 注册默认定时任务
function registerDefaultCrons() {
  const defaults = [
    { id: 'hot-realtime', name: '全网实时热点刷新', cron_expr: '0 8,14,18,20 * * *', enabled: ENABLE_SCHEDULER ? 1 : 0, task_type: 'hot-realtime', task_config: null },
    { id: 'hot-daily-dy', name: '抖音昨日 TOP50', cron_expr: '0 12 * * *', enabled: ENABLE_SCHEDULER ? 1 : 0, task_type: 'hot-platform', task_config: { platform: 'dy' } },
    { id: 'hot-daily-xhs', name: '小红书昨日 TOP50', cron_expr: '0 12,20 * * *', enabled: ENABLE_SCHEDULER ? 1 : 0, task_type: 'hot-platform', task_config: { platform: 'xhs' } },
    { id: 'hot-daily-gzh', name: '公众号昨日 TOP50', cron_expr: '0 12 * * *', enabled: ENABLE_SCHEDULER ? 1 : 0, task_type: 'hot-platform', task_config: { platform: 'gzh' } },
    { id: 'hot-trend-analysis', name: '昨日热点关键词趋势分析', cron_expr: '0 23 * * *', enabled: ENABLE_SCHEDULER ? 1 : 0, task_type: 'hot-trend-analysis', task_config: null },
    { id: 'hot-daily-report', name: '每日热榜日报推送', cron_expr: '30 9 * * *', enabled: ENABLE_SCHEDULER ? 1 : 0, task_type: 'daily-hot-report', task_config: null },
    { id: 'tracked-account-daily', name: '勾选账号昨日数据刷新', cron_expr: '0 7 * * *', enabled: ENABLE_SCHEDULER ? 1 : 0, task_type: 'tracker-refresh', task_config: null },
    { id: 'cache-clean', name: 'API缓存清理', cron_expr: '*/10 * * * *', enabled: 1, task_type: 'cache-clean' },
    { id: 'usage-clean', name: 'API 用量日志清理', cron_expr: '0 0 * * *', enabled: 1, task_type: 'usage-clean' },
    { id: 'wersss-sync', name: 'WeRss 公众号文章同步', cron_expr: '0 8 * * *', enabled: ENABLE_SCHEDULER ? 1 : 0, task_type: 'wersss-sync', task_config: null },
  ];
  const now = Date.now();
  // 系统固定任务允许配置演进（UPSERT），基础热榜 tab 任务只在首次安装时初始化一次，
  // 之后用户可在 Skill 中心解绑/重新绑定；删除后重启不再自动恢复。
  const upsert = db.prepare(`
    INSERT INTO crontab (id, name, cron_expr, enabled, task_type, task_config, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      task_type = excluded.task_type,
      task_config = excluded.task_config,
      sort_order = CASE WHEN COALESCE(crontab.sort_order, 0) = 0 THEN excluded.sort_order ELSE crontab.sort_order END
  `);
  const hotTabInsert = db.prepare(`
    INSERT OR IGNORE INTO crontab (id, name, cron_expr, enabled, task_type, task_config, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const hotTabsInitialized = db.prepare("SELECT data_json FROM local_data WHERE module = 'system' AND data_key = 'default_hot_tabs_initialized'").get();
  const fixHotTabSort = db.prepare(`
    UPDATE crontab SET sort_order = ? WHERE id = ? AND COALESCE(sort_order, 0) = 0
  `);
  db.prepare("DELETE FROM crontab WHERE id = 'daily-snapshot'").run();
  defaults.forEach((d, idx) => {
    const isHotTab = d.task_type === 'hot-platform';
    if (isHotTab) {
      if (!hotTabsInitialized) {
        hotTabInsert.run(
          d.id,
          d.name,
          d.cron_expr,
          d.enabled,
          d.task_type,
          d.task_config ? JSON.stringify(d.task_config) : null,
          idx * 10,
          now,
        );
      }
      // 已存在但 sort_order 为 0 时补一个默认顺序（不覆盖用户拖拽结果）
      fixHotTabSort.run(idx * 10, d.id);
      return;
    }
    upsert.run(
      d.id,
      d.name,
      d.cron_expr,
      d.enabled,
      d.task_type,
      d.task_config ? JSON.stringify(d.task_config) : null,
      idx * 10,
      now,
    );
  });
  if (!hotTabsInitialized) {
    db.prepare(`
      INSERT INTO local_data (module, data_key, data_json, cached_at, expires_at)
      VALUES ('system', 'default_hot_tabs_initialized', ?, ?, ?)
      ON CONFLICT(module, data_key) DO UPDATE SET data_json = excluded.data_json, cached_at = excluded.cached_at
    `).run(JSON.stringify(true), now, now + 100 * 365 * 24 * 60 * 60 * 1000);
  }
}
registerDefaultCrons();

function initializeDefaultUser() {
  if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count > 0) return;
  const now = Date.now();
  const result = db.prepare(`
    INSERT OR IGNORE INTO users
      (id, username, display_name, password_hash, role, must_change_password, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'owner', 1, ?, ?)
  `).run(crypto.randomUUID(), DEFAULT_USERNAME, '管理员', hashPassword(DEFAULT_PASSWORD), now, now);
  if (result.changes) {
    console.warn('[auth] 已创建默认账号 admin，请首次登录后立即修改默认密码。');
  }
}
initializeDefaultUser();

function redfoxApplyUrl() {
  return String(process.env.REDFOX_APPLY_URL || '').trim();
}

// ============ WeRss 接入源（we-mp-rss） ============
function getWersssConfigRow() {
  return db.prepare('SELECT * FROM wersss_config WHERE id = 1').get();
}

function getWersssConfig() {
  const row = getWersssConfigRow();
  if (!row) return null;
  return {
    baseUrl: row.base_url,
    username: row.username,
    password: decryptKb(row.password_enc),
    token: row.token,
    tokenExpiresAt: row.token_expires_at,
    enabled: Boolean(row.enabled),
  };
}

async function getValidWersssToken() {
  const config = getWersssConfig();
  if (!config || !config.enabled) throw new Error('WeRss 接入未配置');
  const now = Date.now();
  if (config.token && config.tokenExpiresAt && config.tokenExpiresAt - now > 60 * 1000) {
    return { token: config.token, config };
  }
  const result = await wersss.login(config.baseUrl, config.username, config.password);
  if (!result?.access_token) throw new Error('WeRss 登录未返回 token');
  const expiresIn = result.expires_in ? Number(result.expires_in) * 1000 : 24 * 60 * 60 * 1000;
  const expiresAt = now + expiresIn;
  db.prepare(`UPDATE wersss_config SET token = ?, token_expires_at = ?, updated_at = ? WHERE id = 1`)
    .run(result.access_token, expiresAt, now);
  return { token: result.access_token, config: { ...config, token: result.access_token, tokenExpiresAt: expiresAt } };
}

async function getWersssAuthStatus() {
  const cfgRow = getWersssConfigRow();
  if (!cfgRow) return { configured: false, enabled: false, message: 'WeRss 未配置' };
  if (!cfgRow.enabled) return { configured: true, enabled: false, message: 'WeRss 接入已禁用' };
  let token;
  let tokenRefreshed = false;
  let tokenExpiresAt = cfgRow.token_expires_at || 0;
  try {
    const valid = await getValidWersssToken();
    token = valid.token;
    tokenRefreshed = !cfgRow.token || cfgRow.token !== token;
    tokenExpiresAt = valid.config.tokenExpiresAt || tokenExpiresAt;
  } catch (e) {
    return { configured: true, enabled: true, tokenValid: false, message: `登录失败：${e.message}` };
  }
  const config = getWersssConfig();
  const now = Date.now();
  const tokenExpired = tokenExpiresAt > 0 && tokenExpiresAt - now <= 0;
  try {
    const status = await wersss.qrStatus(config.baseUrl, token);
    const loginStatus = Boolean(status?.login_status);
    const hasCode = Boolean(status?.qr_code);
    // 注意：这里不主动拉 qrImage/qrCode，更不触发 QR 生成。
    // QR 触发 / 拉取交给前端的 POST /api/_/wersss/qr/start 单次调用。
    return {
      configured: true,
      enabled: true,
      tokenValid: !tokenExpired,
      tokenExpired,
      tokenExpiresAt,
      tokenRefreshed,
      wxAuthorized: loginStatus,
      hasQrCode: hasCode,
      message: tokenExpired
        ? 'Token 已过期，请点击「授权扫码」刷新'
        : loginStatus ? '微信已授权' : '微信授权已过期，请扫码重新授权',
    };
  } catch (e) {
    return {
      configured: true,
      enabled: true,
      tokenValid: true,
      tokenExpired: false,
      tokenExpiresAt,
      wxAuthorized: false,
      message: `授权状态检测失败：${e.message}`,
    };
  }
}

async function syncWersssArticles() {
  const cfgRow = getWersssConfigRow();
  if (!cfgRow) throw new Error('WeRss 未配置');
  if (!cfgRow.enabled) throw new Error('WeRss 接入已禁用');
  const { token, config } = await getValidWersssToken();
  const tokenRefreshed = !cfgRow.token || cfgRow.token !== token;
  const subs = db.prepare('SELECT * FROM wersss_subscriptions WHERE enabled = 1').all();
  if (!subs.length) return { ok: true, tokenStatus: 'valid', tokenRefreshed, synced: 0, articles: 0, perMp: [] };
  const now = Date.now();
  // 刷新订阅公众号元信息（名称、头像等可能变化），分页拉完所有订阅
  try {
    const updateSubMeta = db.prepare(`
      UPDATE wersss_subscriptions
      SET mp_name = COALESCE(NULLIF(?, ''), mp_name),
          mp_alias = COALESCE(NULLIF(?, ''), mp_alias),
          avatar = COALESCE(NULLIF(?, ''), avatar),
          updated_at = ?
      WHERE mp_id = ?
    `);
    let subOffset = 0;
    const subPageSize = 100;
    while (true) {
      const freshSubs = await wersss.listSubscriptions(config.baseUrl, token, { limit: subPageSize, offset: subOffset });
      if (!freshSubs.length) break;
      for (const mp of freshSubs) {
        updateSubMeta.run(mp.mpName, mp.mpAlias, mp.avatar, now, mp.mpId);
      }
      if (freshSubs.length < subPageSize) break;
      subOffset += subPageSize;
    }
  } catch (e) {
    console.warn('[wersss] 刷新订阅元信息失败:', e.message);
  }
  const upsertArticle = db.prepare(`
    INSERT INTO wersss_articles (id, mp_id, title, summary, content, url, cover, publish_time, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = COALESCE(NULLIF(?, ''), wersss_articles.title),
      summary = COALESCE(NULLIF(?, ''), wersss_articles.summary),
      url = COALESCE(NULLIF(?, ''), wersss_articles.url),
      cover = COALESCE(NULLIF(?, ''), wersss_articles.cover),
      publish_time = COALESCE(?, wersss_articles.publish_time),
      synced_at = ?
  `);
  const updateSub = db.prepare('UPDATE wersss_subscriptions SET last_synced_at = ? WHERE mp_id = ?');
  let totalArticles = 0;
  const perMp = [];
  for (const sub of subs) {
    try {
      // 先触发 we-mp-rss 去微信抓取最新文章（异步线程，等 2 秒让抓取排队完成）
      try {
        await wersss.updateMp(config.baseUrl, token, sub.mp_id);
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        console.warn(`[wersss] updateMp ${sub.mp_name} 失败:`, e.message);
      }
      let offset = 0;
      let count = 0;
      let batch;
      do {
        batch = await wersss.listArticles(config.baseUrl, token, { mpId: sub.mp_id, limit: 100, offset, hasContent: false });
        if (!batch.length) break;
        const tx = db.transaction((items) => {
          for (const a of items) {
            if (!a.id) continue;
            upsertArticle.run(
            a.id, sub.mp_id, a.title || '', a.summary || '', a.content || '', a.url || '', a.cover || '', a.publishTime || null, now,
            a.title || '', a.summary || '', a.url || '', a.cover || '', a.publishTime || null, now,
          );
            count++;
          }
        });
        tx(batch);
        offset += batch.length;
      } while (batch.length === 100 && offset < 1000);
      updateSub.run(now, sub.mp_id);
      totalArticles += count;
      perMp.push({ mpId: sub.mp_id, mpName: sub.mp_name, count, ok: true });
      console.log(`[wersss] 同步公众号 ${sub.mp_name}(${sub.mp_id}) 完成，新增/更新 ${count} 条`);
    } catch (e) {
      console.warn(`[wersss] 同步公众号 ${sub.mp_name}(${sub.mp_id}) 失败:`, e.message);
      perMp.push({ mpId: sub.mp_id, mpName: sub.mp_name, count: 0, ok: false, error: e.message });
    }
  }
  const failed = perMp.filter(m => !m.ok);
  return {
    ok: failed.length === 0,
    tokenStatus: 'valid',
    tokenRefreshed,
    synced: subs.length,
    articles: totalArticles,
    failed: failed.length,
    perMp,
  };
}

async function runWersssSyncCron() {
  const syncResult = await syncWersssArticles();
  let prefetchResult = null;
  if (syncResult.ok && syncResult.articles > 0) {
    try {
      prefetchResult = await prefetchWersssContent();
    } catch (e) {
      console.warn('[wersss] 预抓取正文失败:', e.message);
      prefetchResult = { error: e.message };
    }
  }
  return { ...syncResult, prefetch: prefetchResult };
}

// 批量预抓取正文（4 并发，避免压垮 we-mp-rss）
async function prefetchWersssContent() {
  const { token, config } = await getValidWersssToken();
  const pending = db.prepare(`SELECT id FROM wersss_articles WHERE content IS NULL OR length(content) < 100`).all();
  if (!pending.length) return { total: 0, done: 0, failed: 0 };
  const CONCURRENCY = 4;
  const update = db.prepare('UPDATE wersss_articles SET content = ? WHERE id = ?');
  let done = 0;
  let failed = 0;
  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(a => wersss.getArticle(config.baseUrl, token, a.id))
    );
    const tx = db.transaction(() => {
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled' && r.value?.content && r.value.content.length >= 100) {
          update.run(r.value.content, batch[idx].id);
          done++;
        } else {
          failed++;
        }
      });
    });
    tx();
  }
  return { total: pending.length, done, failed };
}

// ============ 我的账号 + 风格档案 ============
function listMyAccounts() {
  return db.prepare('SELECT * FROM my_accounts ORDER BY created_at DESC').all().map(rowToMyAccount);
}

function getMyAccount(id) {
  const row = db.prepare('SELECT * FROM my_accounts WHERE id = ?').get(id);
  return row ? rowToMyAccount(row) : null;
}

function rowToMyAccount(row) {
  if (!row) return null;
  const tracks = parseJson(row.tracks);
  const profile = parseJson(row.style_profile);
  return {
    id: row.id,
    trackerId: row.tracker_id,
    name: row.name,
    plat: row.plat,
    avatar: row.avatar,
    tracks: Array.isArray(tracks) ? tracks : [],
    styleProfile: (profile && typeof profile === 'object' && Object.keys(profile).length) ? profile : null,
    styleSource: row.style_source || '',
    styleSourceRef: row.style_source_ref || '',
    styleUpdatedAt: row.style_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function saveMyAccount(data) {
  const id = String(data.id || `my:${data.plat}:${data.name}:${Date.now()}`);
  const now = Date.now();
  const existing = db.prepare('SELECT * FROM my_accounts WHERE id = ?').get(id);
  db.prepare(`
    INSERT INTO my_accounts (id, tracker_id, name, plat, avatar, tracks, style_profile, style_source, style_source_ref, style_updated_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      tracker_id = COALESCE(excluded.tracker_id, my_accounts.tracker_id),
      name = excluded.name,
      plat = excluded.plat,
      avatar = COALESCE(excluded.avatar, my_accounts.avatar),
      tracks = COALESCE(excluded.tracks, my_accounts.tracks),
      style_profile = COALESCE(excluded.style_profile, my_accounts.style_profile),
      style_source = COALESCE(excluded.style_source, my_accounts.style_source),
      style_source_ref = COALESCE(excluded.style_source_ref, my_accounts.style_source_ref),
      style_updated_at = COALESCE(excluded.style_updated_at, my_accounts.style_updated_at),
      updated_at = excluded.updated_at
  `).run(
    id,
    data.trackerId || existing?.tracker_id || null,
    String(data.name || '').trim(),
    String(data.plat || ''),
    data.avatar || existing?.avatar || null,
    data.tracks ? JSON.stringify(data.tracks) : (existing?.tracks || null),
    data.styleProfile ? JSON.stringify(data.styleProfile) : (existing?.style_profile || null),
    data.styleSource || existing?.style_source || null,
    data.styleSourceRef || existing?.style_source_ref || null,
    data.styleUpdatedAt || existing?.style_updated_at || null,
    existing?.created_at || now,
    now
  );
  return getMyAccount(id);
}

// 收集账号的风采素材（标题列表 + 正文片段 + 标签）
async function collectAccountSamples(account) {
  const samples = { titles: [], contents: [], tags: [], sourceDesc: '' };
  // 来源 1：tracked_accounts 里的作品（RedFox 抓取过）
  if (account.trackerId) {
    const works = db.prepare(`SELECT work_data FROM account_works WHERE account_id = ? ORDER BY publish_at DESC LIMIT 20`).all(account.trackerId);
    for (const w of works) {
      const data = parseJson(w.work_data);
      if (!data) continue;
      if (data.title) samples.titles.push(data.title);
      if (data.summary || data.desc) samples.titles.push(data.summary || data.desc);
    }
    samples.sourceDesc = `RedFox ${works.length} 篇作品`;
  }
  // 来源 2：知识库（style_source_ref='all' 表示整库；旧值是逗号分隔 entry key）
  if (account.styleSourceRef) {
    const cfg = db.prepare('SELECT * FROM kb_config WHERE source_type = ?').get('current');
    if (cfg) {
      const isAll = account.styleSourceRef === 'all';
      const keys = isAll ? [] : account.styleSourceRef.split(',').map(s => s.trim()).filter(Boolean);
      // 整库模式：拉 Obsidian + Notion 各前 15 条作为样本
      const readObsidian = async (limit) => {
        if (!cfg.source_path || !fs.existsSync(cfg.source_path)) return [];
        const entries = scanVault(cfg.source_path, {});
        return entries.slice(0, limit);
      };
      const readNotion = async (limit) => {
        if (!cfg.notion_api_key || !cfg.notion_database_id) return [];
        const apiKey = decryptKb(cfg.notion_api_key);
        const pages = await searchPages(apiKey, cfg.notion_database_id, {});
        return pages.slice(0, limit);
      };
      try {
        let kbCount = 0;
        if (isAll) {
          const [obs, nt] = await Promise.all([readObsidian(15), readNotion(15)]);
          for (const e of obs) {
            if (e?.title) samples.titles.push(e.title);
            if (e?.content) samples.contents.push(e.content.slice(0, 1500));
            if (e?.tags?.length) samples.tags.push(...e.tags);
            kbCount++;
          }
          for (const page of nt) {
            const t = page?.title;
            if (t) samples.titles.push(t);
            if (page?.content) samples.contents.push(page.content.slice(0, 1500));
            kbCount++;
          }
        } else {
          for (const key of keys.slice(0, 5)) {
            try {
              if (cfg.notion_api_key && cfg.notion_database_id) {
                const apiKey = decryptKb(cfg.notion_api_key);
                const page = await getPage(apiKey, key);
                if (page?.title) samples.titles.push(page.title);
                if (page?.content) samples.contents.push(page.content.slice(0, 1500));
              } else if (cfg.source_path) {
                const entry = readEntry(cfg.source_path, key);
                if (entry?.title) samples.titles.push(entry.title);
                if (entry?.content) samples.contents.push(entry.content.slice(0, 1500));
                if (entry?.tags?.length) samples.tags.push(...entry.tags);
              }
              kbCount++;
            } catch (e) {
              console.warn(`[my-account] 读知识库条目 ${key} 失败:`, e.message);
            }
          }
        }
        if (kbCount) samples.sourceDesc += (samples.sourceDesc ? ' + ' : '') + `知识库 ${kbCount} 条`;
      } catch (e) {
        console.warn('[my-account] 知识库读取失败:', e.message);
      }
    }
  }
  return samples;
}

// LLM 提炼赛道（基于作品标题）
async function extractAccountTracks(account) {
  const samples = await collectAccountSamples(account);
  if (!samples.titles.length) throw new Error('该账号暂无作品数据，请先在「账号追踪」同步或关联知识库条目');
  const titles = samples.titles.slice(0, 30).map((t, i) => `${i + 1}. ${t}`).join('\n');
  const messages = [
    { role: 'system', content: '你是创作赛道分析师。基于账号的作品标题列表，提炼出 3-5 个赛道标签。赛道标签应当是简短的中文短语（如"AI 教程"、"NAS 玩法"、"情感共鸣"），反映此账号主要创作主题。严格输出 JSON 对象：{"tracks": ["...", "..."]}' },
    { role: 'user', content: `账号名称：${account.name}（${account.plat}）\n\n作品标题：\n${titles}\n\n请提炼 3-5 个赛道标签，严格输出 JSON：{"tracks": ["...", "..."]}` },
  ];
  const result = await callLlmJson(messages);
  const tracks = Array.isArray(result) ? result
    : Array.isArray(result?.tracks) ? result.tracks
    : Array.isArray(result?.data) ? result.data
    : Array.isArray(result?.赛道) ? result.赛道
    : [];
  return tracks.slice(0, 5).map(t => String(t).trim()).filter(Boolean);
}

// LLM 提炼风格档案（基于作品 + 已知赛道）
async function extractAccountStyleProfile(account) {
  const samples = await collectAccountSamples(account);
  if (!samples.titles.length && !samples.contents.length) {
    throw new Error('该账号暂无作品数据，无法提炼风格');
  }
  const titles = samples.titles.slice(0, 20).map((t, i) => `${i + 1}. ${t}`).join('\n');
  const contents = samples.contents.slice(0, 3).map((c, i) => `--- 作品 ${i + 1} 正文片段 ---\n${c}`).join('\n\n');
  const tracks = (account.tracks || []).join('、');
  const messages = [
    { role: 'system', content: '你是创作风格分析师。基于账号的作品素材，提炼出结构化的创作风格档案。返回严格 JSON 格式。' },
    { role: 'user', content: `账号名称：${account.name}（${account.plat}）
已知赛道：${tracks || '未提炼'}

【作品标题列表】
${titles}

【作品正文片段】
${contents || '（无）'}

【已知标签】
${samples.tags.slice(0, 20).join('、') || '（无）'}

请输出严格 JSON，结构如下：
{
  "创作心智": {"核心议题": ["..."], "独特视角": "...", "避免话题": ["..."]},
  "标题DNA": {"典型句式": ["..."], "数字偏好": "...", "情绪钩子": "..."},
  "表达风格": {"句式": "...", "词汇偏好": "...", "节奏": "...", "幽默度": "..."},
  "创作边界": ["..."],
  "诚实边界": "基于 N 篇作品提炼，不覆盖最新偏好"
}` },
  ];
  return await callLlmJson(messages);
}

// 基于赛道 + 热点生成预设选题
async function generatePresetInspirations(account) {
  const tracks = account.tracks || [];
  if (!tracks.length) throw new Error('请先提炼赛道');
  const keywordsRow = db.prepare(`SELECT data_json FROM local_data WHERE module = 'hot' AND data_key = 'keywords'`).get();
  let hotKeywords = [];
  if (keywordsRow) {
    try {
      const data = parseJson(keywordsRow.data_json);
      hotKeywords = (data?.keywords || data?.items || []).slice(0, 20).map(k => typeof k === 'string' ? k : (k.keyword || k.title || ''));
    } catch {}
  }
  const hasHot = hotKeywords.length > 0;
  const systemPrompt = hasHot
    ? `你是自媒体选题策划师。基于用户的赛道标签和当前热点关键词，生成 8 个适合的预设选题。每个选题包含标题、角度（一句话说明切入角度）、目标平台。严格输出 JSON：{"ideas": [{"title": "...", "angle": "...", "platform": "dy|xhs|gzh|all"}]}`
    : `你是自媒体选题策划师。基于用户的赛道标签，生成 8 个适合的预设选题（当前无热点数据，仅基于赛道）。每个选题包含标题、角度、目标平台。严格输出 JSON：{"ideas": [{"title": "...", "angle": "...", "platform": "dy|xhs|gzh|all"}]}`;
  const userPrompt = hasHot
    ? `我的赛道：${tracks.join('、')}\n\n当前热点关键词：\n${hotKeywords.join('、')}\n\n请基于「我的赛道 ∩ 当前热点」生成 8 个适合的选题。严格输出：{"ideas": [...]}`
    : `我的赛道：${tracks.join('、')}\n\n请基于赛道生成 8 个适合的选题。严格输出：{"ideas": [...]}`;
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
  const result = await callLlmJson(messages);
  const ideas = Array.isArray(result) ? result : (result?.ideas || result?.data || result?.items || []);
  return ideas.map(idea => ({
    title: String(idea?.title || '').trim(),
    angle: String(idea?.angle || '').trim(),
    platform: String(idea?.platform || 'all').trim(),
  })).filter(idea => idea.title);
}

// 基于账号赛道生成"自动选题配置"建议（关键词组合 + 推荐数据源）
async function suggestInspirationConfigs(account) {
  const tracks = account.tracks || [];
  if (!tracks.length) throw new Error('请先提炼赛道');
  const platformMap = { gzh: 'gzh', dy: 'dy', xhs: 'xhs' };
  const defaultPlatform = platformMap[account.plat] || '';
  const messages = [
    {
      role: 'system',
      content: `你是自媒体运营策略师。基于用户的赛道标签，生成 3 个"自动选题主题配置"建议。每个配置会作为定时任务，每天自动生成灵感选题入库。

每个配置包含：
- name：主题名称（10 字以内，如"AI 工具速递"、"NAS 折腾日记"）
- keywords：3-6 个关键词（用于检索证据 + LLM 推理）
- targetPlatforms：目标平台数组（可选：dy/xhs/gzh）
- sources：推荐数据源（可选：hot/dy/xhs/gzh/ai-gzh/ai-bili/ai-xhs/tracked/gzh-search/wersss）
- ideaCount：每次生成几条选题（3-8）

严格输出 JSON：{"configs": [{"name": "...", "keywords": [...], "targetPlatforms": [...], "sources": [...], "ideaCount": N}]}`,
    },
    {
      role: 'user',
      content: `我的赛道：${tracks.join('、')}
我的主平台：${account.plat === 'gzh' ? '公众号' : account.plat === 'dy' ? '抖音' : account.plat === 'xhs' ? '小红书' : account.plat}

请生成 3 个互补的自动选题配置建议。`,
    },
  ];
  const result = await callLlmJson(messages);
  const configs = Array.isArray(result) ? result : (result?.configs || []);
  return configs.map(c => ({
    name: String(c?.name || '').slice(0, 20).trim(),
    keywords: Array.isArray(c?.keywords) ? c.keywords.slice(0, 8).map(k => String(k).trim()).filter(Boolean) : [],
    targetPlatforms: Array.isArray(c?.targetPlatforms) ? c.targetPlatforms.filter(p => ['dy', 'xhs', 'gzh'].includes(p)) : (defaultPlatform ? [defaultPlatform] : []),
    sources: Array.isArray(c?.sources) ? c.sources.filter(s => getInspirationSourceKeys().has(s)) : DEFAULT_INSPIRATION_SOURCES.filter(s => getInspirationSourceKeys().has(s)),
    ideaCount: Math.min(8, Math.max(3, Number(c?.ideaCount) || 5)),
  })).filter(c => c.name && c.keywords.length);
}

// 把建议保存为真实的自动选题配置
function createInspirationConfigFromSuggestion(account, suggestion) {
  const name = `${suggestion.name}`;
  const config = {
    name,
    domain: (account.tracks || []).join('、'),
    targetPlatforms: suggestion.targetPlatforms,
    cronExpr: '0 9 * * *',  // 默认每天 9 点
    enabled: 1,
    sources: suggestion.sources,
    ideaCount: suggestion.ideaCount,
    evidenceLimit: 20,
    dailyApiBudget: 3,
    searchMode: 'combined',
  };
  return saveInspirationConfig(config);
}

const KB_CACHE_TTL = {
  obsidian: 5 * 60 * 1000,   // 5 分钟
  notion: 60 * 1000,          // 1 分钟（Notion API 限制更严）
};

function getKbEntriesFromCache(sourceType, query, tag, folder) {
  if (query || tag || folder) return null; // 搜索条件不命中缓存
  const cacheKey = `list:${sourceType}`;
  const row = db.prepare('SELECT * FROM kb_entries_cache WHERE cache_key = ?').get(cacheKey);
  if (!row) return null;
  const ttl = KB_CACHE_TTL[sourceType] || KB_CACHE_TTL.obsidian;
  if (Date.now() - row.scanned_at > ttl) return null;
  return JSON.parse(row.content || '[]');
}

function setKbEntriesToCache(sourceType, entries) {
  const cacheKey = `list:${sourceType}`;
  const now = Date.now();
  db.prepare(`INSERT INTO kb_entries_cache (cache_key, source_type, entry_key, content, scanned_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET content=excluded.content, scanned_at=excluded.scanned_at`
  ).run(cacheKey, sourceType, '', JSON.stringify(entries), now);
}

function getKbEntryFromCache(sourceType, entryKey) {
  const cacheKey = `entry:${sourceType}:${entryKey}`;
  const row = db.prepare('SELECT * FROM kb_entries_cache WHERE cache_key = ?').get(cacheKey);
  if (!row) return null;
  const ttl = KB_CACHE_TTL[sourceType] || KB_CACHE_TTL.obsidian;
  if (Date.now() - row.scanned_at > ttl) return null;
  return {
    entry_key: row.entry_key,
    title: row.title,
    tags: parseJson(row.tags) || [],
    folder: row.folder,
    content: row.content,
    content_preview: row.content_preview,
    frontmatter: parseJson(row.frontmatter) || {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function setKbEntryToCache(sourceType, entry) {
  const cacheKey = `entry:${sourceType}:${entry.entry_key}`;
  const now = Date.now();
  db.prepare(`INSERT INTO kb_entries_cache (cache_key, source_type, entry_key, title, tags, folder, content_preview, content, frontmatter, created_at, updated_at, scanned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET title=excluded.title, tags=excluded.tags, folder=excluded.folder,
      content_preview=excluded.content_preview, content=excluded.content, frontmatter=excluded.frontmatter,
      updated_at=excluded.updated_at, scanned_at=excluded.scanned_at`
  ).run(cacheKey, sourceType, entry.entry_key, entry.title, JSON.stringify(entry.tags),
    entry.folder, entry.content_preview, entry.content, JSON.stringify(entry.frontmatter),
    entry.created_at, entry.updated_at, now);
}

function invalidateKbListCache(sourceType) {
  db.prepare('DELETE FROM kb_entries_cache WHERE cache_key = ?').run(`list:${sourceType}`);
}

function invalidateKbEntryCache(sourceType, entryKey) {
  db.prepare('DELETE FROM kb_entries_cache WHERE cache_key = ?').run(`entry:${sourceType}:${entryKey}`);
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

// 豆包 WebSearch：提交搜索任务后轮询等待结果，最多等 60s
async function doDoubaoWebSearch(query, source = 'insprira-rewrite') {
  if (!API_KEY) throw new Error('未配置 REDFOX_API_KEY');
  const submitResp = await redfoxRequest('doubaoSearch/submit', { inquiry_text: query, source });
  const submitPayload = parseJson(submitResp.body);
  if (submitResp.status >= 400 || !submitPayload || ![200, 2000].includes(submitPayload.code)) {
    throw new Error(submitPayload?.msg || submitPayload?.message || `豆包搜索提交失败 HTTP ${submitResp.status}`);
  }
  const taskId = submitPayload?.data?.taskId || submitPayload?.data?.task_id;
  if (!taskId) throw new Error('豆包搜索未返回 taskId');
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const resultResp = await redfoxRequest('doubaoSearch/result', { taskId });
    const resultPayload = parseJson(resultResp.body);
    if (resultResp.status >= 400) continue;
    const data = resultPayload?.data || {};
    const status = String(data.status || resultPayload?.status || '').toLowerCase();
    if (status === 'completed' || status === 'success' || status === 'done') {
      logApiUsage('doubaoSearch/result', 200, false);
      return data;
    }
    if (status === 'failed' || status === 'error') {
      logApiUsage('doubaoSearch/result', 200, false);
      throw new Error(data.failReason || data.message || '豆包搜索任务失败');
    }
  }
  logApiUsage('doubaoSearch/result', 200, false);
  throw new Error('豆包搜索超时（已等待 60s），请稍后重试');
}

function formatDoubaoSearchResults(data) {
  // 兼容多种返回结构：{ answer, results: [{title, url, snippet}] } 或 { content } 或直接 { results: [...] }
  const results = Array.isArray(data?.results) ? data.results : (Array.isArray(data?.web_results) ? data.web_results : []);
  const answer = data?.answer || data?.summary || data?.content || '';
  let text = '';
  if (answer) text += `【AI 总结】\n${String(answer).slice(0, 1500)}\n\n`;
  if (results.length) {
    text += `【搜索结果】\n`;
    results.slice(0, 8).forEach((r, i) => {
      const title = r.title || r.name || '';
      const url = r.url || r.link || '';
      const snippet = r.snippet || r.content || r.description || '';
      if (title || snippet) {
        text += `${i + 1}. ${title}${url ? ` (${url})` : ''}\n${String(snippet).slice(0, 300)}\n\n`;
      }
    });
  }
  if (!text) text = JSON.stringify(data).slice(0, 2000);
  return text.slice(0, 4000);
}

function parseSkillFile(skillPath) {
  let content = fs.readFileSync(skillPath, 'utf8');
  // 去掉 UTF-8 BOM（部分 SKILL.md 文件头有 BOM，导致 frontmatter 正则匹配失败）
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/);
  const metadata = {};
  if (frontmatter) {
    for (const line of frontmatter[1].split(/\r?\n/)) {
      const match = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
      if (match && match[2]) metadata[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  const slug = path.basename(path.dirname(skillPath));
  // 标题优先取 frontmatter 后的第一个非代码块一级标题；若取到类似 shell 注释的内容则回退
  let title = metadata.title?.trim() || '';
  if (!title) {
    const bodyStart = frontmatter ? frontmatter[0].length : 0;
    const body = content.slice(bodyStart);
    const bodyNoCode = body.replace(/```[\s\S]*?```/g, '');
    const headingMatch = bodyNoCode.match(/^#\s+(.+)$/m);
    const rawTitle = headingMatch?.[1]?.trim() || '';
    title = /^#|export|追加到|\.sh\s*$|~\//i.test(rawTitle) ? '' : rawTitle;
  }
  if (!title) title = metadata.name || '';
  // 如果 name 就是 slug，尝试从 description 提取一个可读标题
  if (!title || title === slug) {
    const desc = metadata.description || '';
    let extracted = desc.split(/[。，！？；;]/)[0].trim();
    const cutIdx = Math.min(...['专注于', '是', '用于', '—', ' - ', '（', '：', ':'].map(marker => {
      const i = extracted.indexOf(marker);
      return i > 0 ? i : Infinity;
    }));
    if (cutIdx !== Infinity && cutIdx > 3) extracted = extracted.slice(0, cutIdx).trim();
    if (extracted && extracted.length >= 4 && extracted.length <= 40) title = extracted;
  }
  if (!title) title = slug;
  const text = `${slug} ${title} ${metadata.description || ''}`;
  let category = '综合工具';
  if (/douyin|抖音/i.test(text)) category = '抖音';
  else if (/xiaohongshu|小红书/i.test(text)) category = '小红书';
  else if (/wechat|gzh|公众号/i.test(text)) category = '公众号';
  else if (/hot|trend|热榜|热点/i.test(text)) category = '热点';
  else if (/write|rewrite|创作|改写/i.test(text)) category = '内容创作';
  return {
    slug,
    name: metadata.name || slug,
    title,
    description: metadata.description || '',
    category,
    path: path.relative(__dirname, skillPath),
    content,
  };
}

function skillUpdateState() {
  const state = getLocalData('skills', 'community-update') || {};
  const newSlugs = state.newUntil > Date.now() && Array.isArray(state.newSlugs)
    ? new Set(state.newSlugs)
    : new Set();
  return { ...state, newSlugs };
}

const LLM_SKILL_CATEGORIES = ['热点', '帐号', '信息源', '创作', '分析', '检索', '生成工具'];

// 硬编码 LLM 分类覆盖：优先于 LLM 结果，用于修已知误分类
const LLM_CATEGORY_OVERRIDES = {
  'douyin-works-crawler': '检索',     // 抖音作品爬取 → 数据抓取工具，不是榜单
  'douyin-search': '检索',             // 抖音搜索 → 搜索工具
  'playlet-bili-feed': '信息源',       // B站短剧信息源 → 内容聚合源
  'multi-rewrite': '创作',             // 多平台改写 → 内容创作工具
  'image-gen': '生成工具',             // 图片生成 → 媒体生成工具
  // ai-intelligence-investigator LLM 分类为 检索 是正确的，不覆盖
};

// Skill → 灵感熔炉 source 映射（"绑定到热榜"按钮用的）
// 仅映射已被灵感熔炉支持的 source；未映射的 skill 即使分类为热点也不会显示绑定按钮
const SKILL_TO_SOURCE = {
  // 基础热榜（默认显示，也可在 Skill 中心解绑/重新绑定）
  'douyin-daily-hot':     { sourceKey: 'dy',          label: '抖音 TOP50',  cronId: 'hot-daily-dy' },
  'xiaohongshu-dailytop': { sourceKey: 'xhs',         label: '小红书 TOP50', cronId: 'hot-daily-xhs' },
  'wechat-original-hot':  { sourceKey: 'gzh',         label: '公众号热门',  cronId: 'hot-daily-gzh' },
  // AI 信息源（绑定后才显示对应 tab）
  'gzh-ai-feed':          { sourceKey: 'ai-gzh',      label: 'AI 公众号',   cronId: 'hot-daily-ai-gzh' },
  'bili-ai-feed':         { sourceKey: 'ai-bili',     label: 'AI B站',      cronId: 'hot-daily-ai-bili' },
  'xiaohongshu-ai-feed':  { sourceKey: 'ai-xhs',      label: 'AI 小红书',   cronId: 'hot-daily-ai-xhs' },
  'douyin-ai-feed':       { sourceKey: 'ai-dy',       label: 'AI 抖音',     cronId: 'hot-daily-ai-dy' },
  'ks-ai-feed':           { sourceKey: 'ai-ks',       label: 'AI 快手',     cronId: 'hot-daily-ai-ks' },
  'wechat-channels-ai-feed': { sourceKey: 'ai-sph',   label: 'AI 视频号',   cronId: 'hot-daily-ai-sph' },
  // 短剧信息源
  'playlet-douyin-feed':  { sourceKey: 'playlet-dy',  label: '短剧抖音',    cronId: 'hot-daily-playlet-dy' },
  'playlet-wechat-feed':  { sourceKey: 'playlet-gzh', label: '短剧公众号',  cronId: 'hot-daily-playlet-gzh' },
  'playlet-bili-feed':       { sourceKey: 'playlet-bili', label: '短剧B站',     cronId: 'hot-daily-playlet-bili' },
  'playlet-xiaohongshu-feed': { sourceKey: 'playlet-xhs', label: '短剧小红书',  cronId: 'hot-daily-playlet-xhs' },
  // 文旅信息源
  'cultural-tourism-bilibili-feed':    { sourceKey: 'cultural-tourism-bili', label: '文旅B站',    cronId: 'hot-daily-cultural-tourism-bili' },
  'cultural-tourism-douyin-feed':      { sourceKey: 'cultural-tourism-dy',  label: '文旅抖音',    cronId: 'hot-daily-cultural-tourism-dy' },
  'cultural-tourism-wechat-feed':      { sourceKey: 'cultural-tourism-gzh', label: '文旅公众号',  cronId: 'hot-daily-cultural-tourism-gzh' },
  'cultural-tourism-xiaohongshu-feed': { sourceKey: 'cultural-tourism-xhs', label: '文旅小红书',  cronId: 'hot-daily-cultural-tourism-xhs' },
};

function getSkillSourceBinding(slug) {
  return SKILL_TO_SOURCE[slug] || null;
}

function bindSkillToSource(slug) {
  const binding = getSkillSourceBinding(slug);
  if (!binding) throw new Error(`Skill ${slug} 暂未配置绑定映射`);
  const cfg = HOT_SOURCE_CONFIG[binding.sourceKey];
  if (!cfg) throw new Error(`找不到热榜配置 ${binding.sourceKey}`);
  const cronRow = db.prepare('SELECT id, enabled FROM crontab WHERE id = ?').get(binding.cronId);
  if (cronRow) {
    // 已存在则解绑：删除 cron 记录并清除定时器
    db.prepare('DELETE FROM crontab WHERE id = ?').run(binding.cronId);
    const timer = cronTimers.get(binding.cronId);
    if (timer) { clearTimeout(timer); cronTimers.delete(binding.cronId); }
    return { sourceKey: binding.sourceKey, cronId: binding.cronId, enabled: false, wasEnabled: Boolean(cronRow.enabled) };
  }
  // 绑定：根据 HOT_SOURCE_CONFIG 动态创建 cron 并启用
  const now = Date.now();
  db.prepare(`
    INSERT INTO crontab (id, name, cron_expr, enabled, task_type, task_config, notify_on_failure, notify_on_success, created_at)
    VALUES (?, ?, ?, 1, 'hot-platform', ?, 1, 0, ?)
  `).run(
    binding.cronId,
    cfg.label,
    cfg.cronExpr,
    JSON.stringify({ platform: binding.sourceKey }),
    now,
  );
  scheduleCronJob(binding.cronId, cfg.cronExpr, 'hot-platform', { platform: binding.sourceKey });
  return { sourceKey: binding.sourceKey, cronId: binding.cronId, enabled: true, wasEnabled: false };
}

async function classifySkill(skill, retries = 3) {
  const signature = `${skill.slug}|${skill.title}|${String(skill.description || '').slice(0, 200)}`;
  const existing = db.prepare('SELECT * FROM skill_classifications WHERE slug = ?').get(skill.slug);
  if (existing && existing.skill_signature === signature) {
    return existing.llm_category;
  }
  const messages = [
    {
      role: 'system',
      content: `你是一个 Skill 分类器。根据 skill 信息把它归入以下七类之一：
- 热点：抓取/聚合某个主题的内容榜单、热榜、趋势追踪（无明确归属账号/平台）
- 帐号：热门账号榜单、推荐账号、黑马账号、账号排行（如"公众号大V"）
- 信息源：按主题/标签/关键词聚合的内容源（如"AI 公众号信息源"、"内容出海信息源"）
- 创作：辅助内容创作的工具（如文案改写、风格转换、标题生成）
- 分析：分析账号/内容/数据的工具（如账号诊断、爆款分析、趋势分析）
- 检索：搜索关键词/账号/文章/作品的工具（如关键词搜索、内容爬取）
- 生成工具：生成图片/视频/封面等媒体内容的工具

严格只输出：<slug>:<类别>（无空格，无其他内容）。禁止输出平台名、解释、XML 标签。`,
    },
    {
      role: 'user',
      content: `技能名：${skill.slug}\n标题：${skill.title}\n描述：${skill.description || '(无)'}`,
    },
  ];
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await callLlm(messages, { temperature: 0, maxTokens: 256 });
      const raw = String(result || '').replace(/<[^>]+>/g, '').trim();
      // 格式：<slug>:<类别>，取第一行
      const line = raw.split('\n')[0].trim();
      const colonIdx = line.lastIndexOf(':');
      let category = colonIdx >= 0 ? line.slice(colonIdx + 1).trim() : line.trim();
      // 验证类别合法性，允许模糊匹配
      if (!LLM_SKILL_CATEGORIES.includes(category)) {
        for (const c of LLM_SKILL_CATEGORIES) {
          if (category.includes(c) || c.includes(category)) { category = c; break; }
        }
      }
      if (LLM_SKILL_CATEGORIES.includes(category)) {
        // 硬编码 override 优先
        const finalCategory = LLM_CATEGORY_OVERRIDES[skill.slug] || category;
        const now = Date.now();
        db.prepare(`
          INSERT INTO skill_classifications (slug, llm_category, original_category, analyzed_at, skill_signature)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(slug) DO UPDATE SET
            llm_category = excluded.llm_category,
            original_category = excluded.original_category,
            analyzed_at = excluded.analyzed_at,
            skill_signature = excluded.skill_signature
        `).run(skill.slug, finalCategory, skill.category, now, signature);
        return finalCategory;
      }
      console.warn(`[skill] LLM 输出非法类别 ${skill.slug}: ${category}`);
      break;
    } catch (e) {
      const isRateLimit = e.message.includes('速率限制') || e.message.includes('429') || e.message.includes('rate limit');
      if (isRateLimit && attempt < retries) {
        const delay = 15 * 1000 * (attempt + 1);
        console.warn(`[skill] 分类限速 ${skill.slug}，${delay}ms 后重试…`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      console.warn(`[skill] 分类失败 ${skill.slug}:`, e.message);
      break;
    }
  }
  return existing?.llm_category || skill.category || '生成工具';
}

// 批量分类：一次 LLM 调用完成所有 skill，避免逐个调用触发限速
async function classifyAllSkills(skills, options = {}) {
  if (!skills.length) return 0;
  const force = options.force === true;
  const needsClassify = [];
  for (const skill of skills) {
    const signature = `${skill.slug}|${skill.title}|${String(skill.description || '').slice(0, 200)}`;
    if (!force) {
      const existing = db.prepare('SELECT * FROM skill_classifications WHERE slug = ?').get(skill.slug);
      if (existing && existing.skill_signature === signature) continue;
    }
    needsClassify.push({ skill, signature });
  }
  if (!needsClassify.length) return 0;

  // 分批：每批最多 20 个，减少 prompt 过长问题
  const BATCH = 20;
  let saved = 0;
  for (let i = 0; i < needsClassify.length; i += BATCH) {
    const batch = needsClassify.slice(i, i + BATCH);
    const lines = batch.map(({ skill }) =>
      `【${skill.slug}】标题：${skill.title}；描述：${(skill.description || '无').slice(0, 100)}`
    ).join('\n');

    const messages = [
      {
        role: 'system',
        content: `你是一个 Skill 分类器。根据每个 skill 的名称、标题、描述，从以下七类中选择最合适的一个：
- 热点：抓取/聚合某个主题的内容榜单、热榜、趋势追踪（无明确归属账号/平台）
- 帐号：热门账号榜单、推荐账号、黑马账号、账号排行（如"公众号大V"）
- 信息源：按主题/标签/关键词聚合的内容源（如"AI 公众号信息源"、"内容出海信息源"）
- 创作：辅助内容创作的工具（如文案改写、风格转换、标题生成）
- 分析：分析账号/内容/数据的工具（如账号诊断、爆款分析、趋势分析）
- 检索：搜索关键词/账号/文章/作品的工具（如关键词搜索、内容爬取）
- 生成工具：生成图片/视频/封面等媒体内容的工具

严格只按以下格式输出（每行一个，无其他内容）：
<slug>:<类别>
禁止输出：解释、XML 标签、JSON。`,
      },
      { role: 'user', content: lines },
    ];

    let raw = '';
    for (let attempt = 0; attempt <= 3; attempt++) {
      try {
        raw = await callLlm(messages, { temperature: 0, maxTokens: 4096 });
        break;
      } catch (e) {
        const isRateLimit = e.message.includes('速率限制') || e.message.includes('429') || e.message.includes('rate limit');
        if (isRateLimit && attempt < 3) {
          const delay = 15 * 1000 * (attempt + 1);
          console.warn(`[skill] 批量分类限速批次 ${i/BATCH+1}，${delay}ms 后重试…`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        console.warn(`[skill] 批量分类批次 ${i/BATCH+1} 失败:`, e.message);
        break;
      }
    }

    const resultMap = new Map();
    for (const line of raw.replace(/<[^>]+>/g, '').split('\n')) {
      const colonIdx = line.lastIndexOf(':');
      if (colonIdx < 0) continue;
      const slug = line.slice(0, colonIdx).trim();
      const cat = line.slice(colonIdx + 1).trim();
      if (slug) resultMap.set(slug, cat);
    }

    const now = Date.now();
    const upsert = db.prepare(`
      INSERT INTO skill_classifications (slug, llm_category, original_category, analyzed_at, skill_signature)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        llm_category = excluded.llm_category,
        original_category = excluded.original_category,
        analyzed_at = excluded.analyzed_at,
        skill_signature = excluded.skill_signature
    `);

    for (const { skill, signature } of batch) {
      let category = resultMap.get(skill.slug) || '';
      if (!LLM_SKILL_CATEGORIES.includes(category)) {
        for (const c of LLM_SKILL_CATEGORIES) {
          if (category.includes(c) || c.includes(category)) { category = c; break; }
        }
      }
      if (LLM_SKILL_CATEGORIES.includes(category)) {
        const finalCategory = LLM_CATEGORY_OVERRIDES[skill.slug] || category;
        upsert.run(skill.slug, finalCategory, skill.category, now, signature);
        saved++;
      }
    }
    if (i + BATCH < needsClassify.length) {
      await new Promise(r => setTimeout(r, 2000)); // 批次间稍作喘息
    }
  }
  console.log(`[skill] 批量分类完成：${saved}/${needsClassify.length}`);
  return saved;
}

// listSkills 内存缓存：以 SKILL.md mtimeMs 拼接 + skill_classifications 最新时间戳为指纹，60s 内直接复用
let _skillCache = { fingerprint: '', skills: null, ts: 0 };
const SKILL_CACHE_TTL_MS = 60 * 1000;

function listSkills() {
  if (!fs.existsSync(SKILLS_ROOT)) return [];
  // 快速指纹：所有 SKILL.md 的 mtimeMs 之和 + 分类表最新时间戳
  let fingerprint = '';
  try {
    const names = fs.readdirSync(SKILLS_ROOT, { withFileTypes: true });
    for (const entry of names) {
      if (!entry.isDirectory()) continue;
      const p = path.join(SKILLS_ROOT, entry.name, 'SKILL.md');
      if (fs.existsSync(p)) {
        const st = fs.statSync(p);
        fingerprint += `${entry.name}:${st.mtimeMs}|`;
      }
    }
  } catch {}
  try {
    const lastClassify = db.prepare('SELECT MAX(analyzed_at) AS t FROM skill_classifications').get();
    fingerprint += `cls:${lastClassify?.t || 0}`;
  } catch {}
  const now = Date.now();
  if (_skillCache.skills && _skillCache.fingerprint === fingerprint && now - _skillCache.ts < SKILL_CACHE_TTL_MS) {
    return _skillCache.skills;
  }
  const state = skillUpdateState();
  const rows = db.prepare('SELECT slug, llm_category FROM skill_classifications').all();
  const cache = new Map(rows.map(r => [r.slug, r.llm_category]));
  const skills = fs.readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const skillPath = path.join(SKILLS_ROOT, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillPath)) return null;
      const skill = parseSkillFile(skillPath);
      const stat = fs.statSync(skillPath);
      return {
        ...skill,
        isNew: state.newSlugs.has(skill.slug),
        llmCategory: LLM_CATEGORY_OVERRIDES[skill.slug] || cache.get(skill.slug) || null,
        updatedAt: stat.mtimeMs || stat.ctimeMs || 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  _skillCache = { fingerprint, skills, ts: now };
  return skills;
}

function invalidateSkillCache() {
  _skillCache = { fingerprint: '', skills: null, ts: 0 };
}

function getSkill(slug) {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return null;
  const skillPath = path.join(SKILLS_ROOT, slug, 'SKILL.md');
  if (!skillPath.startsWith(`${SKILLS_ROOT}${path.sep}`) || !fs.existsSync(skillPath)) return null;
  const skill = parseSkillFile(skillPath);
  return { ...skill, isNew: skillUpdateState().newSlugs.has(skill.slug) };
}

function localSkillManifest() {
  const files = new Map();
  if (!fs.existsSync(SKILLS_ROOT)) return files;
  const walk = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath, relative);
      else if (entry.isFile()) files.set(relative, gitBlobSha(fs.readFileSync(fullPath)));
    }
  };
  walk(SKILLS_ROOT);
  return files;
}

async function githubJson(apiPath) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'insprira',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  return response.json();
}

async function remoteSkillManifest() {
  const commit = await githubJson(`/repos/${SKILLS_GITHUB_REPO}/commits/main`);
  const treeSha = commit?.commit?.tree?.sha;
  if (!treeSha) throw new Error('无法读取 GitHub Skill 版本');
  const tree = await githubJson(`/repos/${SKILLS_GITHUB_REPO}/git/trees/${treeSha}?recursive=1`);
  const files = new Map();
  for (const entry of tree.tree || []) {
    if (entry.type !== 'blob' || !entry.path.startsWith('skills/')) continue;
    files.set(entry.path.slice('skills/'.length), entry.sha);
  }
  return {
    commitSha: commit.sha,
    commitTime: commit.commit?.committer?.date || commit.commit?.author?.date || '',
    message: String(commit.commit?.message || '').split('\n')[0],
    files,
  };
}

function compareSkillManifests(localFiles, remoteFiles) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const [file, sha] of remoteFiles) {
    if (!localFiles.has(file)) added.push(file);
    else if (localFiles.get(file) !== sha) changed.push(file);
  }
  for (const file of localFiles.keys()) {
    if (!remoteFiles.has(file)) removed.push(file);
  }
  const addedSlugs = [...new Set(added.map(file => file.split('/')[0]).filter(Boolean))];
  return {
    available: Boolean(added.length || changed.length || removed.length),
    added,
    changed,
    removed,
    addedSlugs,
  };
}

async function communitySkillUpdateStatus() {
  const remote = await remoteSkillManifest();
  const comparison = compareSkillManifests(localSkillManifest(), remote.files);
  const state = skillUpdateState();
  return {
    ...comparison,
    remoteSha: remote.commitSha,
    remoteTime: remote.commitTime,
    message: remote.message,
    localSha: state.remoteSha || '',
    localCount: listSkills().length,
    checkedAt: Date.now(),
  };
}

let activeSkillUpdate = null;

async function updateCommunitySkills() {
  if (activeSkillUpdate) return activeSkillUpdate;
  activeSkillUpdate = (async () => {
    const status = await communitySkillUpdateStatus();
    if (!status.available) return { ...status, updated: false, skills: listSkills() };
    const workRoot = path.join(SKILLS_REPO_ROOT, `.skill-update-${crypto.randomUUID()}`);
    const archivePath = path.join(workRoot, 'community.zip');
    const extractRoot = path.join(workRoot, 'extract');
    const backupPath = path.join(SKILLS_REPO_ROOT, `.skills-backup-${Date.now()}`);
    fs.mkdirSync(extractRoot, { recursive: true });
    try {
      const response = await fetch(
        `https://codeload.github.com/${SKILLS_GITHUB_REPO}/zip/${status.remoteSha}`,
        { signal: AbortSignal.timeout(60000) },
      );
      if (!response.ok) throw new Error(`Skill 下载失败：HTTP ${response.status}`);
      fs.writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
      // Python zipfile 支持 UTF-8 文件名，避免系统 unzip 中文名乱码
      await execFileAsync('python3', ['-c', `
import zipfile, sys
with zipfile.ZipFile(sys.argv[1], 'r') as z:
    z.extractall(sys.argv[2])
`, archivePath, extractRoot], {
        timeout: 60000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const extractedRepo = fs.readdirSync(extractRoot, { withFileTypes: true })
        .find(entry => entry.isDirectory());
      const nextSkills = extractedRepo
        ? path.join(extractRoot, extractedRepo.name, 'skills')
        : '';
      const nextCount = nextSkills && fs.existsSync(nextSkills)
        ? fs.readdirSync(nextSkills, { withFileTypes: true }).filter(entry => entry.isDirectory()).length
        : 0;
      if (!nextCount || !fs.existsSync(path.join(nextSkills, 'trending-hub', 'SKILL.md'))) {
        throw new Error('下载包校验失败，未替换本地 Skill');
      }
      if (fs.existsSync(SKILLS_ROOT)) fs.renameSync(SKILLS_ROOT, backupPath);
      try {
        fs.renameSync(nextSkills, SKILLS_ROOT);
      } catch (error) {
        if (fs.existsSync(backupPath) && !fs.existsSync(SKILLS_ROOT)) {
          fs.renameSync(backupPath, SKILLS_ROOT);
        }
        throw error;
      }
      fs.rmSync(backupPath, { recursive: true, force: true });
      const updatedAt = Date.now();
      setLocalData('skills', 'community-update', {
        remoteSha: status.remoteSha,
        remoteTime: status.remoteTime,
        updatedAt,
        newSlugs: status.addedSlugs,
        newUntil: updatedAt + SKILLS_NEW_BADGE_MS,
      });
      // 落库后批量 LLM 分类（已有缓存签名的 skill 会自动跳过）
      try {
        const currentSkills = listSkills();
        const targets = status.addedSlugs.length
          ? currentSkills.filter(skill => status.addedSlugs.includes(skill.slug))
          : currentSkills;
        await classifyAllSkills(targets);
      } catch (e) {
        console.warn('[skill] 落库自动分类异常:', e.message);
      }
      const result = {
        ...status,
        updated: true,
        updatedAt,
        localCount: listSkills().length,
        skills: listSkills().map(({ content, ...skill }) => skill),
      };
      logAction('update-community-skills', 'button', 'github', {
        remoteSha: status.remoteSha,
        added: status.added.length,
        changed: status.changed.length,
        removed: status.removed.length,
        newSlugs: status.addedSlugs,
      });
      return result;
    } finally {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  })();
  try {
    return await activeSkillUpdate;
  } finally {
    activeSkillUpdate = null;
  }
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ? { PATH: EXTENDED_PATH, ...options.env } : { ...process.env, PATH: EXTENDED_PATH },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const maxBuffer = options.maxBuffer || 5 * 1024 * 1024;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
      settled = true;
      reject(new Error(`${path.basename(command)} 执行超时`));
    }, options.timeout || 180000);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > maxBuffer) child.kill('SIGTERM');
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > maxBuffer) child.kill('SIGTERM');
    });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || stdout.trim() || `${path.basename(command)} 退出码 ${code}`));
    });
    child.stdin.end(options.input || '');
  });
}

const EXTRA_BIN_DIRS = (() => {
  const home = os.homedir();
  return [
    path.join(home, '.npm-global/bin'),
    path.join(home, '.npm-global/lib/node_modules/.bin'),
    path.join(home, '.local/bin'),
    path.join(home, '.kimi-code/bin'),
    path.join(home, '.bun/bin'),
    path.join(home, '.volta/bin'),
    path.join(home, '.cargo/bin'),
    path.join(home, '.yarn/bin'),
    path.join(home, '.deno/bin'),
    path.join(home, 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ].filter(Boolean);
})();

const EXTENDED_PATH = [
  ...String(process.env.PATH || '').split(path.delimiter),
  ...EXTRA_BIN_DIRS,
].filter(Boolean).join(path.delimiter);

function resolveExecutable(command) {
  if (!command) return null;
  if (command.includes(path.sep)) {
    return fs.existsSync(command) ? command : null;
  }
  const directories = [
    ...String(process.env.PATH || '').split(path.delimiter),
    ...EXTRA_BIN_DIRS,
  ];
  for (const directory of directories) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function locateExecutable(command) {
  const resolved = resolveExecutable(command);
  if (resolved) return { path: resolved, reason: '' };
  const home = os.homedir();
  const checkedDirs = [
    ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean),
    ...EXTRA_BIN_DIRS,
  ];
  return {
    path: null,
    reason: `未在 PATH 中找到「${command}」。已检查：${checkedDirs.slice(0, 8).join('、')}${checkedDirs.length > 8 ? ` 等 ${checkedDirs.length} 个目录` : ''}`,
  };
}

function findNestedString(value, key) {
  if (!value || typeof value !== 'object') return '';
  if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  for (const child of Object.values(value)) {
    const found = findNestedString(child, key);
    if (found) return found;
  }
  return '';
}


async function listLocalAgents() {
  const agents = [];
  for (const [id, name, family, bin] of [
    ['codex', 'Codex', 'Codex CLI', CODEX_BIN],
    ['claude', 'Claude Code', 'Claude Code', CLAUDE_BIN],
    ['kimi', 'Kimi', 'Kimi Code CLI', KIMI_BIN],
  ]) {
    const located = locateExecutable(bin);
    agents.push({
      id,
      name,
      family,
      available: Boolean(located.path),
      reason: located.reason,
      path: located.path || '',
    });
  }
  const openclawPath = resolveExecutable(OPENCLAW_BIN);
  if (openclawPath) {
    try {
      const { stdout } = await runProcess(openclawPath, ['agents', 'list', '--json'], {
        cwd: __dirname,
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const profiles = parseJson(stdout);
      if (Array.isArray(profiles) && profiles.length) {
        for (const profile of profiles) {
          agents.push({
            id: `openclaw:${profile.id}`,
            name: `OpenClaw · ${profile.identityName || profile.name || profile.id}`,
            family: 'OpenClaw',
            model: profile.model || '',
            available: true,
          });
        }
      } else {
        agents.push({ id: 'openclaw', name: 'OpenClaw', family: 'OpenClaw', available: true });
      }
    } catch (error) {
      agents.push({
        id: 'openclaw',
        name: 'OpenClaw',
        family: 'OpenClaw',
        available: false,
        reason: error.message,
      });
    }
  } else {
    agents.push({ id: 'openclaw', name: 'OpenClaw', family: 'OpenClaw', available: false, reason: '未检测到 CLI' });
  }
  const hermesLocated = locateExecutable(HERMES_BIN);
  agents.push({
    id: 'hermes',
    name: 'Hermes',
    family: 'Hermes Agent',
    available: Boolean(hermesLocated.path),
    reason: hermesLocated.path ? '' : hermesLocated.reason || '未检测到 Hermes CLI',
  });
  return agents;
}

async function executeAgent(agentId, prompt, mode, outputFile) {
  if (agentId === 'codex') {
    const executable = resolveExecutable(CODEX_BIN);
    if (!executable) throw new Error('未检测到 Codex CLI');
    await runProcess(executable, [
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      mode === 'workspace' ? 'workspace-write' : 'read-only',
      '-C',
      __dirname,
      '-o',
      outputFile,
      prompt,
    ], { cwd: __dirname, timeout: 180000, maxBuffer: 5 * 1024 * 1024 });
    return fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8').trim() : '';
  }
  if (agentId === 'claude') {
    const executable = resolveExecutable(CLAUDE_BIN);
    if (!executable) throw new Error('未检测到 Claude Code CLI');
    const { stdout } = await runProcess(executable, [
      '-p',
      '--no-session-persistence',
      '--permission-mode',
      mode === 'workspace' ? 'acceptEdits' : 'plan',
      prompt,
    ], { cwd: __dirname, timeout: 180000, maxBuffer: 5 * 1024 * 1024 });
    return stdout.trim();
  }
  if (agentId === 'kimi') {
    const executable = resolveExecutable(KIMI_BIN);
    if (!executable) throw new Error('未检测到 Kimi CLI');
    const args = ['--prompt', prompt, '--output-format', 'stream-json'];
    if (mode === 'workspace') args.push('--yolo');
    const { stdout } = await runProcess(executable, args, {
      cwd: __dirname,
      timeout: 180000,
      maxBuffer: 5 * 1024 * 1024,
    });
    return parseAgentJsonLines(stdout)
      || stdout.replace(/\nTo resume this session:[\s\S]*$/i, '').trim();
  }
  if (agentId === 'openclaw' || agentId.startsWith('openclaw:')) {
    const executable = resolveExecutable(OPENCLAW_BIN);
    if (!executable) throw new Error('未检测到 OpenClaw CLI');
    const profile = agentId.includes(':') ? agentId.slice(agentId.indexOf(':') + 1) : '';
    const args = ['agent'];
    if (profile) args.push('--agent', profile);
    args.push('--message', prompt, '--json', '--timeout', '180');
    const { stdout } = await runProcess(executable, args, {
      cwd: __dirname,
      timeout: 200000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const payload = parseJson(stdout);
    return findNestedString(payload, 'finalAssistantVisibleText')
      || findNestedString(payload, 'finalAssistantRawText')
      || findNestedString(payload, 'text');
  }
  if (agentId === 'hermes') {
    if (!resolveExecutable(HERMES_BIN)) throw new Error('当前机器未安装 Hermes CLI');
    throw new Error('已检测到 Hermes，但尚未识别其非交互调用协议，请配置兼容适配器');
  }
  throw new Error('不支持的本地 Agent');
}

async function runWechatDiagnosis(accountName) {
  if (diagnosisBusy) throw new Error('已有公众号诊断正在执行，请稍后重试');
  diagnosisBusy = true;
  try {
    const script = path.join(WECHAT_ANALYZER_ROOT, 'scripts', 'wechat_analyzer.py');
    if (!fs.existsSync(script)) throw new Error('本地公众号诊断 Skill 未安装');
    await execFileAsync('python3', [
      script,
      'query',
      '--account_names',
      accountName,
    ], {
      cwd: WECHAT_ANALYZER_ROOT,
      env: { ...process.env, PATH: EXTENDED_PATH, REDFOX_API_KEY: API_KEY },
      timeout: 60000,
      maxBuffer: 2 * 1024 * 1024,
    });
    logApiUsage('gzhUser/query', 200, false);
    const reportPath = path.join(WECHAT_ANALYZER_ROOT, 'output', 'report_data.json');
    const report = parseJson(fs.readFileSync(reportPath, 'utf8'));
    if (!report?.header) throw new Error('诊断 Skill 未返回有效报告');
    return report;
  } finally {
    diagnosisBusy = false;
  }
}

async function runPythonDiagnosis(root, code, input) {
  const { stdout } = await runProcess('python3', ['-c', code], {
    cwd: root,
    input: JSON.stringify(input),
    timeout: 60000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const result = parseJson(stdout.trim());
  if (!result) throw new Error('本地诊断 Skill 未返回有效结果');
  return result;
}

async function runDouyinDiagnosis(tracker) {
  const data = await redfoxData('dyUser/query', {
    accountIds: [tracker.accountId],
    source: '灵感熔炉-抖音账号诊断',
  });
  const raw = Array.isArray(data) ? data[0] : data;
  if (!raw?.nickname) throw new Error('RedFox 未返回该抖音账号的诊断数据');
  const result = await runPythonDiagnosis(DOUYIN_ANALYZER_ROOT, [
    'import json,sys',
    'sys.path.insert(0, "scripts")',
    'from generate_diagnosis_report import DouyinDiagnosisReportV3',
    'd=json.load(sys.stdin)',
    'g=DouyinDiagnosisReportV3(d)',
    'a=g._score_body()[0]; b=g._score_content()[0]; c=g._score_operation()[0]; e=g._score_platform()[0]',
    'total=a+b+c+e',
    'grade=g._get_grade(total)',
    'print(json.dumps({"score":total,"grade":grade[2]+" "+grade[1],"dimensions":[["账号体量",a,35],["内容表现",b,35],["运营活跃度",c,20],["平台指数",e,10]],"markdown":g.generate_report()},ensure_ascii=False))',
  ].join(';'), raw);
  return {
    platform: 'dy',
    header: {
      '账号名': raw.nickname,
      '账号标识': raw.uniqueId || raw.accountId || tracker.accountId,
      '账号类型': raw.category || '',
      '红狐指数': raw.redfoxIndex,
      '粉丝数': raw.followerCount,
      '数据更新时间': raw.crawlTime || '',
    },
    scores: { '综合评分': result.score, '综合等级': result.grade },
    dimensions: result.dimensions.map(([name, score, max]) => ({ name, score, max })),
    works: (raw.works || []).map(work => ({
      '标题': work.desc || work.title || '(无标题)',
      '发布时间': work.createTime || work.publishTime || '',
      '阅读数': work.playCount,
      '点赞数': work.diggCount,
      '评论数': work.commentCount,
      '链接': work.shareUrl || work.url || '',
    })),
    markdown: result.markdown,
    _raw: raw,
  };
}

async function runXhsDiagnosis(tracker, sourceData = null) {
  const data = sourceData || await redfoxData('xhsUser/query', {
    userIds: [tracker.accountId],
    source: '灵感熔炉-小红书账号诊断',
  });
  const raw = xhsTrackerAccounts(data)[0];
  if (!raw?.nickname) throw new Error('RedFox 未返回该小红书账号的诊断数据');
  const result = await runPythonDiagnosis(XHS_ANALYZER_ROOT, [
    'import json,sys',
    'sys.path.insert(0, "scripts")',
    'from xiaohongshu_analyzer import _analyze_single_account',
    'd=json.load(sys.stdin)',
    'print(json.dumps(_analyze_single_account(d, bool(d.get("works"))),ensure_ascii=False))',
  ].join(';'), raw);
  const scores = result.scores || {};
  const names = [
    ['账号定位', 10], ['粉丝画像与需求', 15], ['选题体系', 15], ['封面风格', 10],
    ['爆文能力', 15], ['互动规模', 20], ['更新产能', 15],
  ];
  return {
    ...result,
    platform: 'xhs',
    header: {
      ...(result.header || {}),
      '账号名': raw.nickname,
      '账号标识': raw.redId || tracker.accountId,
      '红狐指数': raw.recentIndex,
      '粉丝数': raw.fans,
      '数据更新时间': raw.gmtCreate || '',
    },
    dimensions: names.map(([name, max]) => ({
      name,
      score: scores[`${name}得分`],
      max: scores[`${name}满分`] || max,
    })),
    works: (raw.works || []).map(work => ({
      '标题': work.title || work.desc || '(无标题)',
      '发布时间': work.publishTime || work.createTime || '',
      '阅读数': work.viewCount,
      '点赞数': work.likedCount,
      '评论数': work.commentCount,
      '链接': work.url || work.workUrl || '',
    })),
    _raw: raw,
  };
}

function normalizeWechatDiagnosis(report) {
  const scores = report.scores || {};
  return {
    ...report,
    platform: 'gzh',
    dimensions: [
      ['内容健康度', scores['内容健康度得分']],
      ['用户活跃度', scores['用户活跃度得分']],
      ['核心数据表现', scores['内容核心数据表现得分']],
      ['运营规范性', scores['运营规范性得分']],
    ].map(([name, score]) => ({ name, score, max: 100 })),
  };
}

async function runPlatformDiagnosis(tracker, sourceData = null) {
  if (tracker.plat === 'gzh') return normalizeWechatDiagnosis(await runWechatDiagnosis(tracker.name));
  if (tracker.plat === 'dy') return runDouyinDiagnosis(tracker);
  if (tracker.plat === 'xhs') return runXhsDiagnosis(tracker, sourceData);
  throw new Error('当前平台不支持账号诊断');
}

async function runLocalAgent(body) {
  if (agentBusy) throw new Error('Agent 正在处理上一条消息，请稍后重试');
  let message = String(body.message || '').trim();
  if (!message) throw new Error('请输入对话内容');
  if (message.length > 10000) throw new Error('单次消息不能超过 10000 字');
  const slashCommand = message.match(/^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/i);
  const skill = slashCommand ? getSkill(slashCommand[1]) : null;
  if (slashCommand && !skill) throw new Error(`Skill /${slashCommand[1]} 不存在`);
  if (slashCommand) {
    message = String(slashCommand[2] || '').trim();
    if (!message) throw new Error(`请在 /${skill.slug} 后输入具体任务`);
  }
  const agentId = String(body.agent || 'codex');
  const agents = await listLocalAgents();
  const selectedAgent = agents.find(agent => agent.id === agentId);
  if (!selectedAgent) throw new Error('选择的 Agent 不存在');
  if (!selectedAgent.available) throw new Error(selectedAgent.reason || `${selectedAgent.name} 当前不可用`);
  const mode = body.mode === 'workspace' ? 'workspace' : 'read';
  const outputFile = path.join(os.tmpdir(), `insprira-agent-${crypto.randomUUID()}.txt`);
  const skillInstruction = skill
    ? `用户选择了本地 Skill：${skill.title}。你必须先读取 ${path.join(SKILLS_ROOT, skill.slug, 'SKILL.md')}，并按其中工作流执行。`
    : '用户未指定 Skill。请先判断是否需要读取 skills/redfox-community/skills 下的相关 SKILL.md。';
  const prompt = [
    '你是“灵感熔炉”的本地开发与自媒体数据 Agent。',
    `当前项目目录：${__dirname}`,
    skillInstruction,
    mode === 'workspace'
      ? '当前允许修改项目文件。修改后应执行必要验证，并在回答中列出改动。'
      : '当前为只读模式。不要修改任何文件，只进行查询、分析和回答。',
    '使用中文回答，结论要具体。不要泄露环境变量、API Key、Cookie 或其他密钥。',
    `用户请求：${message}`,
  ].join('\n\n');
  agentBusy = true;
  try {
    const answer = await executeAgent(agentId, prompt, mode, outputFile);
    if (!answer) throw new Error(`${selectedAgent.name} 未返回内容`);
    return { answer, agent: agentId, agentName: selectedAgent.name, skill: skill?.slug || null, mode };
  } catch (error) {
    if (/usage limit|rate limit|credits|quota|额度|限额/i.test(error.message)) {
      throw new Error(`${selectedAgent.name} 当前额度已用尽，请稍后重试或切换其他 Agent`);
    }
    if (/auth|login|credential|api key/i.test(error.message)) {
      throw new Error(`${selectedAgent.name} 尚未完成登录或凭证配置`);
    }
    throw error;
  } finally {
    agentBusy = false;
    fs.rmSync(outputFile, { force: true });
  }
}

async function getOfficialQuota() {
  if (!REDFOX_WEB_COOKIE) return { configured: false, error: '未配置 REDFOX_WEB_COOKIE' };
  try {
    const response = await fetch(`https://${REDFOX_HOST}/story/web/points/overview`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Cookie: REDFOX_WEB_COOKIE,
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


function hotBatchId(platform, dataDate, startedAt) {
  return `${platform}-${dataDate}-${startedAt}-${crypto.randomBytes(4).toString('hex')}`;
}

function saveHotBatch({
  platform,
  dataDate,
  snapshotKind,
  endpoint,
  request,
  response = null,
  items = [],
  status,
  error = null,
  startedAt,
  completedAt: providedCompletedAt = null,
}) {
  const completedAt = providedCompletedAt || Date.now();
  const batchId = hotBatchId(platform, dataDate, startedAt);
  db.transaction(() => {
    db.prepare(`
      INSERT INTO hot_batches
        (id, platform, data_date, snapshot_kind, endpoint, request_json, response_json,
         status, item_count, started_at, completed_at, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      batchId,
      platform,
      dataDate,
      snapshotKind,
      endpoint,
      JSON.stringify(request || {}),
      response == null ? null : JSON.stringify(response),
      status,
      items.length,
      startedAt,
      completedAt,
      error,
    );
    const insertItem = db.prepare(`
      INSERT INTO hot_batch_items
        (batch_id, rank, item_key, title, score, raw_data)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    items.forEach((item, index) => {
      insertItem.run(
        batchId,
        index + 1,
        String(item.key || `${index + 1}`),
        String(item.title || '(无标题)'),
        Number(item.score) || 0,
        JSON.stringify(item.raw || {}),
      );
    });
    db.prepare("DELETE FROM local_data WHERE module = 'hot' AND data_key LIKE 'trends:%'").run();
  })();
  return {
    id: batchId,
    platform,
    dataDate,
    status,
    itemCount: items.length,
    completedAt,
    error,
  };
}

function latestHotBatch(platform, expectedDate, snapshotKind) {
  const kindWhere = snapshotKind ? 'AND snapshot_kind = ?' : '';
  const params = snapshotKind ? [platform, snapshotKind] : [platform];
  const expectedAttemptParams = snapshotKind
    ? [platform, snapshotKind, expectedDate]
    : [platform, expectedDate];
  const latestAttempt = db.prepare(`
    SELECT *
    FROM hot_batches
    WHERE platform = ? ${kindWhere} AND data_date = ?
    ORDER BY completed_at DESC
    LIMIT 1
  `).get(...expectedAttemptParams) || db.prepare(`
    SELECT *
    FROM hot_batches
    WHERE platform = ? ${kindWhere}
    ORDER BY completed_at DESC
    LIMIT 1
  `).get(...params);
  const expectedSuccessParams = snapshotKind
    ? [platform, snapshotKind, expectedDate]
    : [platform, expectedDate];
  let selected = db.prepare(`
    SELECT *
    FROM hot_batches
    WHERE platform = ? ${kindWhere}
      AND data_date = ? AND status = 'success'
    ORDER BY completed_at DESC
    LIMIT 1
  `).get(...expectedSuccessParams);
  if (!selected) {
    selected = db.prepare(`
      SELECT *
      FROM hot_batches
      WHERE platform = ? ${kindWhere}
        AND status = 'success' AND data_date <= ?
      ORDER BY data_date DESC, completed_at DESC
      LIMIT 1
    `).get(...params, expectedDate);
  }
  if (!selected && snapshotKind) {
    selected = db.prepare(`
      SELECT *
      FROM hot_batches
      WHERE platform = ? AND status = 'success' AND data_date <= ?
      ORDER BY data_date DESC, completed_at DESC
      LIMIT 1
    `).get(platform, expectedDate);
  }
  if (!selected) return { batch: null, latestAttempt };
  const items = db.prepare(`
    SELECT rank, item_key, title, score, raw_data
    FROM hot_batch_items
    WHERE batch_id = ?
    ORDER BY rank ASC
  `).all(selected.id).map(row => ({
    rank: row.rank,
    key: row.item_key,
    title: row.title,
    score: row.score,
    raw: parseJson(row.raw_data),
    snapshotDate: selected.data_date,
  }));
  const current = selected.data_date === expectedDate
    && selected.snapshot_kind !== 'legacy'
    && latestAttempt?.id === selected.id
    && latestAttempt.status === 'success';
  return {
    batch: selected,
    latestAttempt,
    items,
    sourceMode: current ? 'api' : 'local-cache',
  };
}

function platformCronId(platform) {
  return platform === 'all' ? 'hot-realtime' : `hot-daily-${platform}`;
}

function hotListPayload(platform) {
  const realtime = platform === 'all';
  const expectedDate = realtime ? localDate() : dateDaysAgo(1);
  const snapshotKind = realtime ? 'realtime' : 'daily';
  const result = latestHotBatch(platform, expectedDate, snapshotKind);
  const cron = db.prepare('SELECT enabled, cron_expr, last_run FROM crontab WHERE id = ?')
    .get(platformCronId(platform));
  return {
    data: result.items || [],
    sourceMode: result.sourceMode || 'local-cache',
    sourceLabel: result.sourceMode === 'api'
      ? (realtime ? 'API 实时数据' : 'API 昨日日榜')
      : '本地缓存数据',
    dataDate: result.batch?.data_date || null,
    capturedAt: result.batch?.completed_at || null,
    expectedDate,
    latestAttempt: result.latestAttempt ? {
      status: result.latestAttempt.status,
      dataDate: result.latestAttempt.data_date,
      completedAt: result.latestAttempt.completed_at,
      error: result.latestAttempt.error,
    } : null,
    cronEnabled: Boolean(cron?.enabled),
    cronExpr: cron?.cron_expr || null,
    lastRun: cron?.last_run || null,
  };
}

function normalizeDailyPlatformItems(platform, data, dataDate) {
  let items = normalizeSnapshotItems(platform, data);
  if (platform === 'xhs') {
    const list = Array.isArray(data) ? data : data?.list || data?.records || data?.articles || [];
    items = list.map((item, index) => ({
      key: String(item.photoId || item.workId || item.id || item.photoJumpUrl || `${dataDate}-${index}`),
      title: item.title || item.workTitle || item.desc || '(无标题)',
      score: toNumber(item.anaAdd?.addInteractiveount ?? item.addInteractiveount
        ?? item.anaAdd?.interactiveCount ?? item.interactiveCount
        ?? item.anaAdd?.useLikeCount ?? item.useLikeCount) || 0,
      raw: item,
    }));
  }
  if (AI_FEED_PLATFORMS.includes(platform)) {
    items = items.filter(item => {
      const rawDate = item.raw?.gmtCreate || item.raw?.publishTime || item.raw?.publicTime || '';
      return String(rawDate).startsWith(dataDate);
    });
  }
  return items.slice(0, 50);
}

// 热榜 source 配置：platform key -> API、渲染、cron 配置
const HOT_SOURCE_CONFIG = {
  dy: {
    label: '抖音 TOP50',
    endpoint: 'dy/search/likesRank',
    method: 'redfoxData',
    buildRequest: (dataDate, source) => ({ source, type: '全部', startTime: dataDate, endTime: dataDate }),
    adapter: 'dy',
    cronExpr: '0 12 * * *',
    dateField: 'publishTime',
  },
  xhs: {
    label: '小红书 TOP50',
    endpoint: 'cozeSkill/getXhsCozeSkillDataOne',
    method: 'redfoxGetData',
    buildRequest: (dataDate, source) => ({ rankDate: dataDate, source: '小红书单日数据爆款文章-GitHub', category: '综合全部' }),
    adapter: 'xhs',
    cronExpr: '0 12,20 * * *',
    dateField: 'workPublishTime',
  },
  gzh: {
    label: '公众号热门',
    endpoint: 'gzh/search/hotArticle',
    method: 'redfoxData',
    buildRequest: (dataDate, source) => ({ source, keyword: '', startDate: dataDate, endDate: dataDate, pageNum: 1, pageSize: 50 }),
    adapter: 'gzh',
    cronExpr: '0 12 * * *',
    dateField: 'publicTime',
  },
  'ai-gzh': {
    label: 'AI 公众号',
    endpoint: 'parseWork/queryAiMsgs',
    method: 'redfoxData',
    buildRequest: (dataDate, source) => ({ source: 'AI公众号信息源-GitHub', keyword: 'AI', pageNum: 1, pageSize: 100, startDate: dataDate, endDate: dataDate }),
    adapter: 'aiFeed',
    cronExpr: '0 12 * * *',
    dateField: 'gmtCreate',
  },
  'ai-bili': {
    label: 'AI B站',
    endpoint: 'parseWork/queryBiliAiMsgs',
    method: 'redfoxData',
    buildRequest: (dataDate, source) => ({ source: 'B站AI信息源-GitHub', keyword: 'AI', pageNum: 1, pageSize: 100, startTime: `${dataDate} 00:00:00`, endTime: `${dataDate} 23:59:59` }),
    adapter: 'aiFeed',
    cronExpr: '0 12 * * *',
    dateField: 'gmtCreate',
  },
  'ai-xhs': {
    label: 'AI 小红书',
    endpoint: 'parseWork/queryXhsAiMsgs',
    method: 'redfoxData',
    buildRequest: (dataDate, source) => ({ source: 'AI小红书信息源-GitHub', keyword: 'AI', pageNum: 1, pageSize: 100, startTime: dataDate, endTime: dateFromYmd(dataDate, 1) }),
    adapter: 'aiFeed',
    cronExpr: '0 12 * * *',
    dateField: 'gmtCreate',
  },
  'ai-dy': {
    label: 'AI 抖音',
    endpoint: 'parseWork/queryDyAiMsgs',
    method: 'redfoxData',
    buildRequest: (dataDate, source) => ({ source: 'AI抖音信息源-GitHub', keyword: 'AI', pageNum: 1, pageSize: 100, startTime: `${dataDate} 00:00:00`, endTime: `${dataDate} 23:59:59` }),
    adapter: 'aiFeed',
    cronExpr: '0 12 * * *',
    dateField: 'gmtCreate',
  },
  'ai-ks': {
    label: 'AI 快手',
    endpoint: 'parseWork/queryKsAiMsgs/batch',
    method: 'redfoxData',
    buildRequest: (dataDate, source) => ({ source: 'AI快手信息源-GitHub', keywords: ['AI'], pageNum: 1, pageSize: 200, startTime: `${dataDate} 00:00:00`, endTime: `${dataDate} 23:59:59` }),
    adapter: 'aiFeed',
    cronExpr: '0 12 * * *',
    dateField: 'gmtCreate',
  },
  'ai-sph': {
    label: 'AI 视频号',
    endpoint: 'parseWork/querySphAiMsgs',
    method: 'redfoxData',
    buildRequest: (dataDate, source) => ({ source: 'AI视频号信息源-GitHub', keyword: 'AI', pageNum: 1, pageSize: 100, startTime: `${dataDate} 00:00:00`, endTime: `${dataDate} 23:59:59` }),
    adapter: 'aiFeed',
    cronExpr: '0 12 * * *',
    dateField: 'gmtCreate',
  },
  'playlet-dy': {
    label: '短剧抖音',
    endpoint: 'parseWork/queryPlayletMsgs',
    method: 'redfoxData',
    buildRequest: (dataDate, source) => ({ source: '短剧抖音信息源-GitHub', msgType: '短剧', platform: 1, pageNum: 1, pageSize: 100, startTime: `${dataDate} 00:00:00`, endTime: `${dataDate} 23:59:59` }),
    adapter: 'aiFeed',
    cronExpr: '0 12 * * *',
    dateField: 'gmtCreate',
  },
  'playlet-gzh': {
    label: '短剧公众号',
    endpoint: 'parseWork/queryPlayletMsgs',
    method: 'redfoxData',
    buildRequest: (dataDate, source) => ({ source: '短剧公众号信息源-GitHub', msgType: '短剧', platform: 2, pageNum: 1, pageSize: 100, startTime: `${dataDate} 00:00:00`, endTime: `${dataDate} 23:59:59` }),
    adapter: 'aiFeed',
    cronExpr: '0 12 * * *',
    dateField: 'gmtCreate',
  },
  'playlet-bili': {
    label: '短剧B站',
    endpoint: 'parseWork/queryBiliPlayletMsgs',
    method: 'redfoxData',
    buildRequest: (dataDate, source) => ({ source: '短剧B站信息源-GitHub', msgType: '短剧', pageNum: 1, pageSize: 100, startTime: `${dataDate} 00:00:00`, endTime: `${dataDate} 23:59:59` }),
    adapter: 'aiFeed',
    cronExpr: '0 12 * * *',
    dateField: 'gmtCreate',
  },
  'playlet-xhs': {
    label: '短剧小红书',
    endpoint: 'parseWork/queryXhsPlayletMsgs',
    method: 'redfoxData',
    buildRequest: (dataDate, source) => ({ source: '短剧小红书信息源-GitHub', msgType: '短剧', pageNum: 1, pageSize: 100, startTime: `${dataDate} 00:00:00`, endTime: `${dataDate} 23:59:59` }),
    adapter: 'aiFeed',
    cronExpr: '0 12 * * *',
    dateField: 'gmtCreate',
  },
  'cultural-tourism-bili': {
    label: '文旅B站',
    endpoint: 'parseWork/queryBiliPlayletMsgs',
    method: 'redfoxData',
    buildRequest: (dataDate, source) => ({ source: '文旅B站信息源-GitHub', msgType: '文旅', pageNum: 1, pageSize: 100, startTime: `${dataDate} 00:00:00`, endTime: `${dataDate} 23:59:59` }),
    adapter: 'aiFeed',
    cronExpr: '0 12 * * *',
    dateField: 'gmtCreate',
  },
  'cultural-tourism-dy': {
    label: '文旅抖音',
    endpoint: 'parseWork/queryDyPlayletMsgs',
    method: 'redfoxData',
    buildRequest: (dataDate, source) => ({ source: '文旅抖音信息源-GitHub', msgType: '文旅', pageNum: 1, pageSize: 100, startTime: `${dataDate} 00:00:00`, endTime: `${dataDate} 23:59:59` }),
    adapter: 'aiFeed',
    cronExpr: '0 12 * * *',
    dateField: 'gmtCreate',
  },
  'cultural-tourism-gzh': {
    label: '文旅公众号',
    endpoint: 'parseWork/queryGzhPlayletMsgs',
    method: 'redfoxData',
    buildRequest: (dataDate, source) => ({ source: '文旅公众号信息源-GitHub', msgType: '文旅', pageNum: 1, pageSize: 100, startTime: `${dataDate} 00:00:00`, endTime: `${dataDate} 23:59:59` }),
    adapter: 'aiFeed',
    cronExpr: '0 12 * * *',
    dateField: 'gmtCreate',
  },
  'cultural-tourism-xhs': {
    label: '文旅小红书',
    endpoint: 'parseWork/queryXhsPlayletMsgs',
    method: 'redfoxData',
    buildRequest: (dataDate, source) => ({ source: '文旅小红书信息源-GitHub', msgType: '文旅', pageNum: 1, pageSize: 100, startTime: `${dataDate} 00:00:00`, endTime: `${dataDate} 23:59:59` }),
    adapter: 'aiFeed',
    cronExpr: '0 12 * * *',
    dateField: 'gmtCreate',
  },
};

function latestAiGzhDataDate(data, expectedDate) {
  const list = Array.isArray(data) ? data : data?.list || data?.records || data?.articles || [];
  return list
    .map(item => String(item.gmtCreate || item.publishTime || item.publicTime || '').slice(0, 10))
    .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= expectedDate)
    .sort()
    .at(-1) || null;
}

function recoverAiGzhFallbackBatches() {
  const attempts = db.prepare(`
    SELECT *
    FROM hot_batches
    WHERE platform = 'ai-gzh' AND snapshot_kind = 'daily'
      AND status = 'empty' AND response_json IS NOT NULL
    ORDER BY completed_at DESC
  `).all();
  for (const attempt of attempts) {
    const response = parseJson(attempt.response_json);
    const actualDate = latestAiGzhDataDate(response, attempt.data_date);
    if (!actualDate || actualDate === attempt.data_date) continue;
    const existing = db.prepare(`
      SELECT id FROM hot_batches
      WHERE platform = 'ai-gzh' AND snapshot_kind = 'daily'
        AND data_date = ? AND status = 'success'
      LIMIT 1
    `).get(actualDate);
    if (existing) continue;
    const items = normalizeDailyPlatformItems('ai-gzh', response, actualDate);
    if (!items.length) continue;
    saveHotBatch({
      platform: 'ai-gzh',
      dataDate: actualDate,
      snapshotKind: 'daily',
      endpoint: attempt.endpoint,
      request: parseJson(attempt.request_json) || {},
      response,
      items,
      status: 'success',
      startedAt: attempt.started_at,
      completedAt: attempt.completed_at,
    });
  }
}

recoverAiGzhFallbackBatches();

const activePlatformSyncs = new Map();

async function syncDailyPlatform(platform, dataDate = dateDaysAgo(1), source = '灵感熔炉-平台昨日榜') {
  const lockKey = `${platform}:${dataDate}`;
  if (activePlatformSyncs.has(lockKey)) return activePlatformSyncs.get(lockKey);
  const promise = (async () => {
    const startedAt = Date.now();
    let endpoint;
    let request;
    try {
      const config = HOT_SOURCE_CONFIG[platform];
      if (!config) throw new Error(`不支持的平台：${platform}`);
      endpoint = config.endpoint;
      request = config.buildRequest(dataDate, source);
      const response = config.method === 'redfoxGetData'
        ? await redfoxGetData(endpoint, request)
        : await redfoxData(endpoint, request);
      const items = normalizeDailyPlatformItems(platform, response, dataDate);
      const aiFeedPlatforms = Object.keys(HOT_SOURCE_CONFIG).filter(k => HOT_SOURCE_CONFIG[k].adapter === 'aiFeed');
      if (aiFeedPlatforms.includes(platform) && !items.length) {
        const actualDate = latestAiGzhDataDate(response, dataDate);
        const fallbackItems = actualDate && actualDate !== dataDate
          ? normalizeDailyPlatformItems(platform, response, actualDate)
          : [];
        if (fallbackItems.length) {
          const fallbackBatch = saveHotBatch({
            platform,
            dataDate: actualDate,
            snapshotKind: 'daily',
            endpoint,
            request,
            response,
            items: fallbackItems,
            status: 'success',
            startedAt,
          });
          saveHotBatch({
            platform,
            dataDate,
            snapshotKind: 'daily',
            endpoint,
            request,
            response,
            items: [],
            status: 'empty',
            error: `${dataDate} 暂无榜单数据；API 最新返回 ${actualDate}`,
            startedAt,
          });
          return fallbackBatch;
        }
      }
      const status = items.length ? 'success' : 'empty';
      const batch = saveHotBatch({
        platform,
        dataDate,
        snapshotKind: 'daily',
        endpoint,
        request,
        response,
        items,
        status,
        error: items.length ? null : `${dataDate} 暂无榜单数据`,
        startedAt,
      });
      if (!items.length) throw new Error(`${dataDate} 暂无榜单数据，继续使用本地缓存`);
      return batch;
    } catch (error) {
      const alreadySaved = db.prepare(`
        SELECT id FROM hot_batches
        WHERE platform = ? AND started_at = ?
      `).get(platform, startedAt);
      if (!alreadySaved) {
        saveHotBatch({
          platform,
          dataDate,
          snapshotKind: 'daily',
          endpoint: endpoint || 'unknown',
          request: request || {},
          status: 'failed',
          error: error.message,
          startedAt,
        });
      }
      throw error;
    }
  })();
  activePlatformSyncs.set(lockKey, promise);
  try {
    return await promise;
  } finally {
    activePlatformSyncs.delete(lockKey);
  }
}

async function captureHotSnapshot() {
  const dataDate = dateDaysAgo(1);
  const platforms = [];
  // 只同步当前已创建 cron 的 platform（即 tab 栏中显示的）
  const rows = db.prepare("SELECT task_config FROM crontab WHERE task_type = 'hot-platform'").all();
  const platformKeys = [...new Set(rows.map(row => {
    const cfg = parseJson(row.task_config) || {};
    return cfg.platform;
  }).filter(Boolean))];
  for (const platform of platformKeys) {
    if (!HOT_SOURCE_CONFIG[platform]) continue;
    try {
      const batch = await syncDailyPlatform(platform, dataDate, '灵感熔炉-手动昨日榜');
      platforms.push({ platform, count: batch.itemCount, ok: true });
    } catch (error) {
      platforms.push({ platform, count: 0, ok: false, error: error.message });
    }
  }
  return { date: dataDate, platforms };
}

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

const NOTIFICATION_CHANNELS = new Set(['discord', 'bark', 'webhook', 'dingtalk', 'feishu', 'telegram']);

function notificationConfigs() {
  return getLocalData('settings', 'notifications') || {};
}

function publicNotificationConfigs() {
  return Object.fromEntries(Object.entries(notificationConfigs()).map(([channel, config]) => [
    channel,
    {
      enabled: Boolean(config.enabled),
      configured: Boolean(config.url || (config.botToken && config.chatId)),
      url: config.url || '',
      botToken: config.botToken || '',
      chatId: config.chatId || '',
    },
  ]));
}

function saveNotificationConfigs(input) {
  const current = notificationConfigs();
  for (const channel of NOTIFICATION_CHANNELS) {
    if (!input[channel]) continue;
    const value = input[channel];
    current[channel] = {
      enabled: Boolean(value.enabled),
      url: String(value.url || '').trim() || current[channel]?.url || '',
      botToken: String(value.botToken || '').trim() || current[channel]?.botToken || '',
      chatId: String(value.chatId || '').trim() || current[channel]?.chatId || '',
    };
  }
  setLocalData('settings', 'notifications', current);
  return publicNotificationConfigs();
}

function postJsonUrl(rawUrl, payload) {
  const target = new URL(rawUrl);
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = transport.request(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        if ((response.statusCode || 500) >= 300) reject(new Error(`通知 HTTP ${response.statusCode}`));
        else resolve(text);
      });
    });
    req.on('timeout', () => req.destroy(new Error('通知请求超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendNotification(channel, config, title, message) {
  if (!NOTIFICATION_CHANNELS.has(channel)) throw new Error('不支持的通知渠道');
  if (channel === 'telegram') {
    if (!config.botToken || !config.chatId) throw new Error('请配置 Bot Token 和 Chat ID');
    return postJsonUrl(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      chat_id: config.chatId,
      text: `${title}\n${message}`,
    });
  }
  if (!config.url) throw new Error('请配置通知地址');
  if (channel !== 'bark' && !config.url.startsWith('https:')) throw new Error('该通知地址必须使用 HTTPS');
  const payload = channel === 'discord'
    ? { content: `**${title}**\n${message}` }
    : channel === 'dingtalk'
      ? { msgtype: 'text', text: { content: `${title}\n${message}` } }
      : channel === 'feishu'
        ? { msg_type: 'text', content: { text: `${title}\n${message}` } }
        : channel === 'bark'
          ? { title, body: message }
          : { title, message, text: `${title}\n${message}` };
  return postJsonUrl(config.url, payload);
}

async function broadcastNotification(title, message) {
  const configs = notificationConfigs();
  const targets = [];
  for (const [channel, config] of Object.entries(configs)) {
    if (!config?.enabled) continue;
    if (channel === 'telegram') {
      if (config.botToken && config.chatId) targets.push([channel, config]);
    } else if (config.url) {
      targets.push([channel, config]);
    }
  }
  if (!targets.length) return { sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  await Promise.all(targets.map(async ([channel, config]) => {
    try {
      await sendNotification(channel, config, title, message);
      sent += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[notify] ${channel} 推送失败:`, error.message);
    }
  }));
  return { sent, failed };
}

function normalizeTrendKey(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function dailyHotSourceRows(dataDate) {
  return db.prepare(`
    SELECT b.platform, i.rank, i.title, i.score, i.raw_data
    FROM hot_batches b
    JOIN hot_batch_items i ON i.batch_id = b.id
    WHERE b.data_date = ?
      AND b.status = 'success'
      AND b.snapshot_kind IN ('realtime', 'daily')
    ORDER BY b.platform ASC, b.completed_at ASC, i.rank ASC
  `).all(dataDate).map(row => {
    const raw = parseJson(row.raw_data) || {};
    const platforms = row.platform === 'all' && Array.isArray(raw.plats) && raw.plats.length
      ? raw.plats.map(name => platCodeByDisplayName(name))
      : [row.platform];
    return { ...row, platforms: platforms.filter(Boolean) };
  });
}

function platCodeByDisplayName(name) {
  return {
    百度: 'bd', 知乎: 'zh', 微博: 'wb', 抖音: 'dy',
    B站: 'bz', 快手: 'ks', 头条: 'tt',
  }[name] || String(name || '');
}

async function analyzeDailyHotKeywords(dataDate = dateDaysAgo(1), force = false) {
  const rows = dailyHotSourceRows(dataDate);
  if (rows.length < 10) throw new Error(`${dataDate} 的真实热榜数据不足，暂不生成趋势`);

  const uniqueRows = [];
  const seen = new Set();
  for (const row of rows) {
    const key = `${row.platforms.join(',')}:${normalizeTrendKey(row.title)}`;
    if (!normalizeTrendKey(row.title) || seen.has(key)) continue;
    seen.add(key);
    uniqueRows.push(row);
  }
  const fingerprint = crypto.createHash('sha1').update(JSON.stringify(uniqueRows)).digest('hex');
  const cached = db.prepare('SELECT * FROM hot_daily_keywords WHERE data_date = ?').get(dataDate);
  if (!force && cached?.source_fingerprint === fingerprint) return parseJson(cached.result_json);
  const indexed = uniqueRows.slice(0, 320).map((row, index) => ({
    id: index + 1,
    platforms: row.platforms,
    rank: row.rank,
    title: row.title,
  }));
  const extracted = await callLlmJson([
    {
      role: 'system',
      content: `你负责从真实热榜标题中提取可跨天比较的实体或事件关键词。不得编造，不得输出泛词（热点、网友、视频、今日、宣布等）。每个主题必须引用输入标题 id。输出严格 JSON：
{"keywords":[{"name":"稳定且简短的主题名","aliases":["标题中出现的同义写法"],"titleIds":[1,2]}],"summary":"当天热点概述"}
最多20个主题；titleIds 必须真实存在；相同事件合并。`,
    },
    { role: 'user', content: `数据日期：${dataDate}\n${JSON.stringify(indexed)}` },
  ]);
  const keywords = (Array.isArray(extracted.keywords) ? extracted.keywords : []).slice(0, 20).map(keyword => {
    const titleIds = [...new Set((keyword.titleIds || []).map(Number))]
      .filter(id => id >= 1 && id <= indexed.length);
    const matched = titleIds.map(id => indexed[id - 1]);
    const platforms = [...new Set(matched.flatMap(item => item.platforms || []))];
    const rankScore = matched.reduce((sum, item) => sum + Math.max(1, 51 - item.rank), 0);
    return {
      name: String(keyword.name || '').trim(),
      aliases: [...new Set([keyword.name, ...(keyword.aliases || [])]
        .map(String)
        .map(v => v.trim())
        .filter(value => value && value.length <= 20))].slice(0, 8),
      mentions: matched.length,
      platforms,
      strength: matched.length * 10 + platforms.length * 15 + rankScore,
      topTitles: matched.sort((a, b) => a.rank - b.rank).slice(0, 4).map(item => item.title),
    };
  }).filter(item => item.name && item.mentions);
  const result = {
    dataDate,
    keywords,
    summary: String(extracted.summary || ''),
    sourceCount: indexed.length,
    generatedAt: Date.now(),
  };
  db.prepare(`
    INSERT INTO hot_daily_keywords (data_date, source_fingerprint, result_json, generated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(data_date) DO UPDATE SET
      source_fingerprint = excluded.source_fingerprint,
      result_json = excluded.result_json,
      generated_at = excluded.generated_at
  `).run(dataDate, fingerprint, JSON.stringify(result), result.generatedAt);
  return result;
}

function trendKeys(keyword) {
  return [...new Set([keyword.name, ...(keyword.aliases || [])].map(normalizeTrendKey).filter(Boolean))];
}

function getHotTrends(days) {
  const safeDays = days === 7 ? 7 : 14;
  const reports = db.prepare(`
    SELECT data_date, result_json, generated_at
    FROM hot_daily_keywords
    WHERE data_date >= ?
    ORDER BY data_date ASC
  `).all(dateDaysAgo(safeDays)).map(row => ({
    date: row.data_date,
    generatedAt: row.generated_at,
    report: parseJson(row.result_json),
  }));
  if (!reports.length) return { themes: [], summary: '', analyzedThrough: null, generatedAt: null };
  if (reports.length < 2) {
    return {
      themes: [],
      summary: `已完成 ${reports[0].date} 的真实关键词提取；至少积累 2 天后才计算增长或冷却趋势。`,
      analyzedThrough: reports[0].date,
      generatedAt: reports[0].generatedAt,
    };
  }
  const groups = [];
  for (const daily of reports) {
    for (const keyword of daily.report?.keywords || []) {
      const keys = trendKeys(keyword);
      let group = groups.find(candidate => candidate.keys.some(key =>
        keys.some(next => key === next || (key.length >= 3 && next.length >= 3 && (key.includes(next) || next.includes(key)))),
      ));
      if (!group) {
        group = { name: keyword.name, keys: [], points: [], titles: new Set(), platforms: new Set() };
        groups.push(group);
      }
      group.keys = [...new Set([...group.keys, ...keys])];
      group.points.push({
        date: daily.date,
        strength: Number(keyword.strength) || 0,
        mentions: Number(keyword.mentions) || 0,
      });
      (keyword.topTitles || []).forEach(title => group.titles.add(title));
      (keyword.platforms || []).forEach(platform => group.platforms.add(platform));
    }
  }
  const dates = reports.map(item => item.date);
  const latestDate = dates[dates.length - 1];
  const previousDate = dates[dates.length - 2] || null;
  const themes = groups.map(group => {
    const byDate = new Map(group.points.map(point => [point.date, point]));
    const latest = byDate.get(latestDate)?.strength || 0;
    const previous = previousDate ? byDate.get(previousDate)?.strength || 0 : 0;
    const change = previous ? ((latest - previous) / previous) * 100 : (latest ? 100 : 0);
    const trend = !previousDate ? '稳定'
      : latest === 0 && previous > 0 ? '冷却'
      : change >= 20 ? '增长'
      : change <= -20 ? '冷却'
      : '稳定';
    return {
      name: group.name,
      keywords: group.keys.slice(0, 6),
      trend,
      reason: `${latestDate} 强度 ${Math.round(latest)}，${previousDate || '前期'} ${Math.round(previous)}；按真实标题出现次数、平台覆盖和榜单排名计算`,
      daysSeen: new Set(group.points.map(point => point.date)).size,
      platforms: [...group.platforms],
      scoreChange: `${change >= 0 ? '+' : ''}${Math.round(change)}%`,
      topTitles: [...group.titles].slice(0, 4),
      history: dates.map(date => ({ date, strength: byDate.get(date)?.strength || 0 })),
      latestStrength: latest,
    };
  }).filter(item => item.daysSeen >= 2 || item.latestStrength > 0)
    .sort((a, b) => {
      const order = { 增长: 0, 稳定: 1, 冷却: 2 };
      return order[a.trend] - order[b.trend] || b.latestStrength - a.latestStrength;
    })
    .slice(0, 15);
  return {
    themes,
    summary: `趋势基于 ${reports.length} 个已完成的每日 LLM 关键词报告，数据截至 ${latestDate}。`,
    analyzedThrough: latestDate,
    generatedAt: Math.max(...reports.map(item => item.generatedAt || 0)),
  };
}

async function analyzeHotTrendsLlm() {
  await analyzeDailyHotKeywords(dateDaysAgo(1), true);
  return getHotTrends(14);
}

function buildDailyHotReport(dataDate = dateDaysAgo(1)) {
  const rows = dailyHotSourceRows(dataDate);
  const PLAT_LABEL = { dy: '抖音', xhs: '小红书', gzh: '公众号' };
  const byPlatform = new Map();
  for (const row of rows) {
    for (const plat of row.platforms) {
      if (!PLAT_LABEL[plat]) continue;
      if (!byPlatform.has(plat)) byPlatform.set(plat, new Map());
      const titleMap = byPlatform.get(plat);
      if (!titleMap.has(row.title)) titleMap.set(row.title, { title: row.title, rank: row.rank, score: row.score });
    }
  }
  const platformSummary = ['dy', 'xhs', 'gzh']
    .filter(plat => byPlatform.has(plat))
    .map(plat => {
      const items = [...byPlatform.get(plat).values()].sort((a, b) => (a.rank || 999) - (b.rank || 999)).slice(0, 5);
      if (!items.length) return null;
      const list = items.map((item, idx) => `${idx + 1}. ${String(item.title || '').slice(0, 40)}`).join('\n');
      return `【${PLAT_LABEL[plat]}】\n${list}`;
    })
    .filter(Boolean);
  let trendsSection = '';
  try {
    const trends = getHotTrends(7);
    const top = (trends.themes || []).slice(0, 5);
    if (top.length) {
      const list = top.map(item => `· ${item.name}（${item.trend || '-'}）`).join('\n');
      trendsSection = `\n\n【7 日趋势关键词】\n${list}`;
    }
  } catch {}
  const summary = platformSummary.length
    ? `${dataDate} 热榜速览\n\n${platformSummary.join('\n\n')}${trendsSection}`
    : `${dataDate} 暂无可用的热榜快照数据`;
  return { dataDate, platformCount: platformSummary.length, summary };
}

async function sendDailyHotReport() {
  const report = buildDailyHotReport(dateDaysAgo(1));
  await broadcastNotification('灵感熔炉 · 每日热榜日报', report.summary);
  return report;
}

function inspirationSearchTerms(config, keywords, limit = 2) {
  const typePriority = { white: 4, core: 3, alias: 2 };
  const configured = [...(config?.terms || [])]
    .filter(term => term.type !== 'black')
    .sort((a, b) =>
      (typePriority[b.type] || 0) - (typePriority[a.type] || 0)
      || b.weight - a.weight
    )
    .map(term => term.term) || [];
  return normalizeTerms([...configured, ...(keywords || [])]).slice(0, Math.max(0, limit));
}

function inspirationSearchPlan(config, keywords) {
  const mode = config?.searchMode === 'deep' ? 'deep' : 'combined';
  const terms = inspirationSearchTerms(config, keywords, 5);
  if (!terms.length) return [];
  if (mode === 'deep') {
    return terms.map(term => ({
      mode,
      query: term,
      terms: [term],
    }));
  }
  return [{
    mode,
    query: terms.join(','),
    terms,
  }];
}

function keywordSearchPlatform(keyword) {
  return `gzh-search:${crypto.createHash('sha1').update(keyword.toLowerCase()).digest('hex').slice(0, 12)}`;
}

function cachedKeywordHotArticles(keyword) {
  const row = db.prepare(`
    SELECT response_json, data_date, completed_at
    FROM hot_batches
    WHERE platform = ? AND snapshot_kind = 'inspiration-search'
      AND status = 'success' AND data_date >= ?
    ORDER BY data_date DESC, completed_at DESC
    LIMIT 1
  `).get(keywordSearchPlatform(keyword), dateDaysAgo(3));
  if (!row) return null;
  return {
    data: parseJson(row.response_json) || {},
    dataDate: row.data_date,
    completedAt: row.completed_at,
  };
}

function normalizeKeywordSearchItems(data) {
  const candidates = [...(data?.articles || []), ...(data?.latestHotArticles || [])];
  return candidates.map(article => ({
    key: String(article.id || article.url || article.title),
    title: article.title || '(无标题)',
    score: toNumber(article.totalScore) || toNumber(article.clicksCount) || 0,
    raw: article,
  }));
}

async function fetchKeywordHotArticles(keywords, options = {}) {
  const endDate = localDate();
  const maxApiCalls = Math.max(0, Math.min(Number(options.maxApiCalls) || 0, 5));
  const searchPlan = inspirationSearchPlan(options.config, keywords);
  const unique = new Map();
  const searched = [];
  let apiCalls = 0;
  for (const search of searchPlan) {
    const cached = cachedKeywordHotArticles(search.query);
    let data = cached?.data || null;
    let source = cached ? 'database' : '';
    if (!data && apiCalls < maxApiCalls) {
      const startedAt = Date.now();
      const request = {
        keyword: search.query,
        startDate: dateDaysAgo(14),
        endDate,
        source: '公众号爆款文章洞察-GitHub',
      };
      apiCalls += 1;
      if (typeof options.onApiCall === 'function') options.onApiCall(1);
      try {
        data = await redfoxData('gzh/search/hotArticle', request);
        source = 'api';
        saveHotBatch({
          platform: keywordSearchPlatform(search.query),
          dataDate: endDate,
          snapshotKind: 'inspiration-search',
          endpoint: 'gzh/search/hotArticle',
          request,
          response: data,
          items: normalizeKeywordSearchItems(data),
          status: 'success',
          startedAt,
        });
      } catch (error) {
        source = 'api-failed';
        saveHotBatch({
          platform: keywordSearchPlatform(search.query),
          dataDate: endDate,
          snapshotKind: 'inspiration-search',
          endpoint: 'gzh/search/hotArticle',
          request,
          status: 'failed',
          error: error.message,
          startedAt,
        });
        searched.push({
          keyword: search.query,
          keywords: search.terms,
          mode: search.mode,
          days: 14,
          count: 0,
          source,
          error: error.message,
          relatedSearches: [],
        });
        continue;
      }
    }
    if (!data) {
      searched.push({
        keyword: search.query,
        keywords: search.terms,
        mode: search.mode,
        days: 14,
        count: 0,
        source: 'skipped-budget',
        relatedSearches: [],
      });
      continue;
    }
    searched.push({
      keyword: search.query,
      keywords: search.terms,
      mode: search.mode,
      days: 14,
      count: (data?.articles || []).length,
      source,
      dataDate: cached?.dataDate || endDate,
      relatedSearches: data?.relatedSearches || [],
    });
    const candidates = [...(data?.articles || []), ...(data?.latestHotArticles || [])];
    for (const article of candidates) {
      const key = String(article.id || article.url || article.title);
      if (!unique.has(key)) unique.set(key, article);
    }
  }
  const articles = Array.from(unique.values()).sort((a, b) =>
    (toNumber(b.totalScore) || 0) - (toNumber(a.totalScore) || 0)
    || (toNumber(b.clicksCount) || 0) - (toNumber(a.clicksCount) || 0)
  );
  return { articles, searched, apiCalls };
}

const TOOL_FUNCTIONS = {
  web_search: async (args) => {
    const query = args?.query || args?.q || args?.search_query || '';
    if (!query) return JSON.stringify({ error: 'web_search 需要提供 query 参数' });
    try {
      const data = await doDoubaoWebSearch(query);
      logAction('web_search', 'function-call', 'redfox-api', { query }, 1, 0);
      return formatDoubaoSearchResults(data);
    } catch (e) {
      return JSON.stringify({ error: `web_search 失败: ${e.message}` });
    }
  },
};

async function callLlm(messages, options = {}) {
  const apiKey = process.env.LLM_API_KEY;
  const baseUrl = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const primaryModel = process.env.LLM_MODEL || 'gpt-4.1-mini';
  const fallbackModel = process.env.LLM_FALLBACK_MODEL || '';
  if (!apiKey) throw new Error('未配置 LLM_API_KEY');
  const tools = Array.isArray(options.tools) && options.tools.length ? options.tools : null;
  const maxToolRounds = options.maxToolRounds ?? 3;
  // 普通调用 30s，带 web_search 等工具要等搜索结果，超时放宽到 60s
  const baseTimeoutMs = tools ? 60000 : 30000;
  const timeoutMs = options.timeoutMs ?? baseTimeoutMs;

  // 单次 chat.completions 调用：主模型失败且配了 fallback，则切 fallback 重试
  const doCall = async (modelName, tMs) => {
    const body = {
      model: modelName,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
    };
    if (tools) {
      body.tools = tools;
      body.tool_choice = options.toolChoice || 'auto';
    } else if (options.json) {
      body.response_format = { type: 'json_object' };
    }
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(tMs),
    });
    const payload = await response.json();
    if (!response.ok) {
      const errMsg = payload?.error?.message || `LLM HTTP ${response.status}`;
      const err = new Error(errMsg);
      err.status = response.status;
      err.isLlmError = true;
      throw err;
    }
    return payload.choices?.[0]?.message || {};
  };

  // 单轮对话（无 tools）：主模型失败可回退 fallback
  if (!tools) {
    try {
      const msg = await doCall(primaryModel, timeoutMs);
      return msg.content || '';
    } catch (primaryErr) {
      if (!fallbackModel || fallbackModel === primaryModel) throw primaryErr;
      const retriable = primaryErr.name === 'TimeoutError' || primaryErr.name === 'AbortError'
        || /network|ECONN|fetch failed|429|rate/i.test(primaryErr.message);
      if (!retriable) throw primaryErr;
      logErr('[callLlm] 主模型失败切 fallback', `${primaryModel} -> ${fallbackModel}: ${primaryErr.message}`);
      const msg = await doCall(fallbackModel, timeoutMs * 2);
      return msg.content || '';
    }
  }

  // 带 tools：走多轮循环（每轮重试主模型，失败不切 fallback，避免中途切换破坏 tool_call 链）
  const currentMessages = [...messages];
  for (let round = 0; round <= maxToolRounds; round++) {
    let msg;
    try {
      msg = await doCall(primaryModel, timeoutMs);
    } catch (err) {
      logErr('[callLlm] tool round 失败', `round=${round} model=${primaryModel}: ${err.message}`);
      throw err;
    }
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!toolCalls.length) {
      return msg.content || '';
    }
    // 把 assistant 消息（含 tool_calls）推回 history
    currentMessages.push({
      role: 'assistant',
      content: msg.content || '',
      tool_calls: toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.function?.name, arguments: tc.function?.arguments },
      })),
    });
    // 逐个执行 tool_call
    for (const tc of toolCalls) {
      const fnName = tc.function?.name;
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
      const handler = TOOL_FUNCTIONS[fnName];
      let result;
      if (!handler) {
        result = JSON.stringify({ error: `未知工具 ${fnName}` });
      } else {
        try { result = await handler(args); } catch (e) { result = JSON.stringify({ error: e.message }); }
      }
      currentMessages.push({ role: 'tool', tool_call_id: tc.id, name: fnName, content: result });
    }
    // 工具调用也算 LLM 一次
  }
  logErr('[callLlm] 工具调用轮次超限', `rounds=${maxToolRounds}, finish=${lastFinishReason}`);
  throw new Error('工具调用轮次超限');
}

// 解析 LLM 输出的 JSON：去 code fence / <think> 块，截断时尝试找最后一个 } 修复
function parseLlmJson(content) {
  let cleaned = String(content || '')
    .trim()
    // 去掉 code fence
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    // 去掉 MiniMax 推理模型输出的 <think>...</think> 或 <think>...</think>
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
    .replace(/<think>[\s\S]*?<think>/gi, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    if (err.message.includes('Unterminated') || err.message.includes('Unexpected end')) {
      for (let i = cleaned.length - 1; i >= 0; i--) {
        if (cleaned[i] === '}') {
          try {
            const r = JSON.parse(cleaned.slice(0, i + 1));
            console.warn('[parseLlmJson] JSON 截断修复 pos=' + i);
            return r;
          } catch {}
        }
      }
    }
    throw new Error('JSON 解析失败: ' + err.message + ' | 内容片段: ' + cleaned.slice(0, 200));
  }
}

async function callLlmJson(messages, options = {}) {
  const callOptions = { ...options, json: true };
  // 如果开了联网，关掉 json_object 强制（与 tools 冲突）
  if (callOptions.tools) delete callOptions.json;
  const content = await callLlm(messages, callOptions);
  return parseLlmJson(content);
}

const WEB_SEARCH_TOOL = [{
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Use Doubao WebSearch to look up latest information. Call this whenever you need current data, product features, news, user reviews, or anything the LLM training data may not cover or that may be outdated.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords; be specific (e.g. product name + feature)' },
      },
      required: ['query'],
    },
  },
}];

function localDateTime(date = new Date()) {
  return `${localDate(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

let activeRealtimeHotspots = null;

async function syncRealtimeHotspots(source = '灵感熔炉-实时热榜') {
  if (activeRealtimeHotspots) return activeRealtimeHotspots;
  activeRealtimeHotspots = (async () => {
    const today = localDate();
    const startedAt = Date.now();
    const endpoint = 'hotSpot/getListByPlatformWithKeyword';
    const request = {
      source,
      platforms: [],
      keywords: [],
      startDate: `${today} 00:00:00`,
      endDate: localDateTime(),
    };
    try {
      const data = await redfoxData(endpoint, request);
      const items = normalizeRealtimeHotspots(data, today);
      const status = items.length ? 'success' : 'empty';
      const batch = saveHotBatch({
        platform: 'all',
        dataDate: today,
        snapshotKind: 'realtime',
        endpoint,
        request,
        response: data,
        items,
        status,
        error: items.length ? null : '当前时段暂无实时热点',
        startedAt,
      });
      if (!items.length) throw new Error('当前时段暂无实时热点，继续使用本地缓存');
      return batch;
    } catch (error) {
      const alreadySaved = db.prepare(`
        SELECT id FROM hot_batches WHERE platform = 'all' AND started_at = ?
      `).get(startedAt);
      if (!alreadySaved) {
        saveHotBatch({
          platform: 'all',
          dataDate: today,
          snapshotKind: 'realtime',
          endpoint,
          request,
          status: 'failed',
          error: error.message,
          startedAt,
        });
      }
      throw error;
    }
  })();
  try {
    return await activeRealtimeHotspots;
  } finally {
    activeRealtimeHotspots = null;
  }
}

async function findRewriteHotspots(body) {
  const text = String(body.text || '').trim();
  if (!text) throw new Error('请输入需要分析的文章');
  const today = localDate();
  let localItems = latestHotBatch('all', today, 'realtime');
  let dataSource = 'database';
  let apiCalls = 0;
  if (!localItems.batch || localItems.batch.data_date !== today || !localItems.items?.length) {
    if (!body.allowApi) {
      logAction('rewrite-hotspots', 'button', 'no-today-data', { dataDate: today }, 0, 0);
      return { needsApiConfirmation: true, dataDate: today, hotspots: [], keywords: [], source: 'none' };
    }
    await syncRealtimeHotspots('灵感熔炉-创作助手确认刷新');
    localItems = latestHotBatch('all', today, 'realtime');
    dataSource = 'redfox-api';
    apiCalls = 1;
  }
  const analysis = await callLlmJson([
    {
      role: 'system',
      content: '你是中文内容编辑。提取适合搜索实时热榜的短关键词，必须包含文章里的核心实体或行业词，避免完整长句和“介绍、方法、分享”等空词。中文词控制在2-8字，英文词控制在1-3个单词。例如“NAS本地AI Agent”应拆成“NAS”“AI Agent”“本地AI”。输出严格 JSON：{"topic":"","keywords":[""]}，关键词 3-5 个。',
    },
    { role: 'user', content: text.slice(0, 12000) },
  ]);
  const keywords = Array.isArray(analysis.keywords)
    ? [...new Set(analysis.keywords.map(value => String(value).trim()).filter(Boolean))].slice(0, 5)
    : [];
  if (!keywords.length) return { topic: analysis.topic || '', keywords: [], hotspots: [] };
  const searchKeywords = [...new Set(keywords.flatMap(keyword => {
    const englishTokens = keyword.match(/[a-z][a-z0-9.+#-]*/gi) || [];
    return [keyword, ...englishTokens.filter(token => token.length >= 2)];
  }))].slice(0, 8);
  const uniqueCandidates = new Map();
  for (const row of localItems.items || []) {
    const raw = row.raw || {};
    const sources = Array.isArray(raw.sources) ? raw.sources : [];
    const base = sources[0] || raw;
    const item = {
      id: row.key,
      title: row.title,
      hotCount: row.score,
      platform: base.platform || 'all',
      platformName: base.platformName || (raw.plats || []).join('、') || '全网',
      rank: row.rank,
      createdAt: base.createdAt || raw.latestAt || localItems.batch?.completed_at,
      raw,
    };
    const matched = searchKeywords.some(keyword =>
      item.title.toLowerCase().includes(keyword.toLowerCase())
    );
    if (matched && !uniqueCandidates.has(item.id)) uniqueCandidates.set(item.id, item);
  }
  const candidates = Array.from(uniqueCandidates.values()).slice(0, 50);
  if (!candidates.length) {
    logAction('rewrite-hotspots', 'button', dataSource, { keywords, candidates: 0, dataDate: today }, apiCalls, 1);
    return { topic: analysis.topic || '', keywords, hotspots: [], source: dataSource, apiCalls, llmCalls: 1 };
  }

  let matches = [];
  try {
    const ranked = await callLlmJson([
      {
        role: 'system',
        content: '判断热点能否自然用于文章标题和前言。禁止只因共享“AI”等宽泛词就强行关联。输出严格 JSON：{"matches":[{"index":1,"relevance":0,"angle":""}]}。只保留相关度不低于60的项目，最多12项。',
      },
      {
        role: 'user',
        content: `文章主题：${analysis.topic || ''}\n文章摘要：${text.slice(0, 2500)}\n\n候选热点：\n${candidates.map((item, index) => `${index + 1}. [${item.platformName}] ${item.title}（热度 ${item.hotCount}）`).join('\n')}`,
      },
    ]);
    matches = Array.isArray(ranked.matches) ? ranked.matches : [];
  } catch (error) {
    console.warn('热点相关度分析失败，使用关键词匹配：', error.message);
    matches = candidates.map((item, index) => ({
      index: index + 1,
      relevance: keywords.some(keyword => item.title.toLowerCase().includes(keyword.toLowerCase())) ? 70 : 0,
      angle: '',
    }));
  }
  const hotspots = matches
    .filter(match => Number(match.relevance) >= 60)
    .map(match => {
      const item = candidates[Number(match.index) - 1];
      return item ? { ...item, relevance: Number(match.relevance), angle: String(match.angle || '') } : null;
    })
    .filter(Boolean)
    .slice(0, 12);
  logAction('rewrite-hotspots', 'button', dataSource, {
    keywords, candidates: candidates.length, matches: hotspots.length, dataDate: today,
  }, apiCalls, 2);
  return {
    topic: String(analysis.topic || ''), keywords, hotspots,
    source: dataSource, apiCalls, llmCalls: 2, dataDate: today,
  };
}

async function rewriteForPlatform(body) {
  const text = String(body.text || '').trim();
  if (!text) throw new Error('请输入原文');
  const platform = String(body.platform || '小红书');
  const tone = String(body.tone || '专业、清晰、有观点');
  const mode = String(body.mode || 'rewrite');  // create / rewrite / adapt
  const hotspot = body.hotspot && typeof body.hotspot === 'object' ? {
    title: String(body.hotspot.title || '').slice(0, 200),
    platformName: String(body.hotspot.platformName || '').slice(0, 30),
    angle: String(body.hotspot.angle || '').slice(0, 300),
  } : null;
  const hotspotInstruction = hotspot?.title
    ? `选定热点：${hotspot.title}（${hotspot.platformName}）。可用关联角度：${hotspot.angle || '自行判断'}。热点主要用于标题和前言，正文不得为了关联而篡改原文事实；若关联牵强，应在标题和前言中弱化处理。`
    : '未选择热点，不要虚构或强行加入热点。';
  // 平台对应的 skill 映射：create 模式用 *-write（从零创作），rewrite/adapt 模式用 *-rewrite（改写）
  const writeSkillMap = {
    '小红书': 'xiaohongshu-write',
    '公众号': 'wechat-write',
    '知乎': 'zhihu-write',
    '抖音': 'multi-write',
    '视频号': 'multi-write',
    '快手': 'multi-write',
    '哔站': 'multi-write',
  };
  const rewriteSkillMap = {
    '小红书': 'xiaohongshu-rewrite',
    '公众号': 'wechat-rewrite',
    '知乎': 'zhihu-rewrite',
    '抖音': 'multi-rewrite',
    '视频号': 'multi-rewrite',
    '快手': 'multi-rewrite',
    '哔站': 'multi-rewrite',
  };
  const skillSlug = mode === 'create'
    ? (writeSkillMap[platform] || 'multi-write')
    : (rewriteSkillMap[platform] || 'multi-rewrite');
  // 兜底：如果 *-write skill 不存在，回退到 *-rewrite
  const finalSkillSlug = getSkill(skillSlug) ? skillSlug : (rewriteSkillMap[platform] || 'multi-rewrite');
  let skillInstruction = '';
  const skill = getSkill(finalSkillSlug);
  if (skill?.description) {
    skillInstruction = `\n\n参考 RedFox ${finalSkillSlug} skill 方法论（按此风格输出）：\n${String(skill.description).slice(0, 400)}`;
  }
  // 风格档案（来自「我的」账号）
  let styleInstruction = '';
  if (body.styleProfile && typeof body.styleProfile === 'object') {
    const p = body.styleProfile;
    const bits = [];
    if (p['标题DNA']?.典型句式?.length) bits.push(`标题参考句式：${p['标题DNA'].典型句式.slice(0, 3).join('；')}`);
    if (p['标题DNA']?.情绪钩子) bits.push(`标题情绪钩子：${p['标题DNA'].情绪钩子}`);
    if (p['表达风格']?.句式) bits.push(`句式偏好：${p['表达风格'].句式}`);
    if (p['表达风格']?.词汇偏好) bits.push(`词汇偏好：${p['表达风格'].词汇偏好}`);
    if (p['表达风格']?.节奏) bits.push(`节奏：${p['表达风格'].节奏}`);
    if (p['表达风格']?.幽默度) bits.push(`幽默度：${p['表达风格'].幽默度}`);
    if (p['创作边界']?.length) bits.push(`避免：${p['创作边界'].join('、')}`);
    if (bits.length) styleInstruction = `\n\n参考风格档案（仅作为风格指引，不得编造新事实）：\n${bits.join('\n')}`;
  }
  // 模式不同，system prompt 不同
  const modeInstruction = mode === 'create'
    ? `基于用户给定的主题/大纲/结构要求，创作一篇全新的${platform}内容。用户素材中已明确提到的具体内容（如产品名称、功能点、推荐人群等）必须如实呈现；用户要求介绍/对比的主体可按其提供的要点扩展结构与表达，但不得无中生有地补充用户未提及的功能细节、数据、时间表。`
    : mode === 'adapt'
      ? `直接把素材改写为${platform}风格（不补充新事实，仅风格转换、句式重组）。`
      : `将素材重构为${platform}内容（在原素材基础上扩展结构和打磨）。`;
  let userInstructionPriority = mode === 'create'
    ? `

【用户指令优先级最高】用户在原始素材中已明确写出的内容（标题、对比对象、核心定位、推荐人群、文章结构如"前言+内容+总结"等）必须严格遵循，不要用 skill 方法论覆盖用户的明确要求。skill 风格仅作为参考润色手段。`
    : '';
  // create 模式下若用户素材较短（<300字），自动开启联网以避免 LLM 瞎编
  const useWebSearch = mode === 'create' && String(text || '').length < 300;
  const toolOption = useWebSearch ? { tools: WEB_SEARCH_TOOL } : {};
  if (useWebSearch) {
    userInstructionPriority += '\n\n你可以使用 web_search 工具查询最新的产品、功能点、热点等信息，需要时就调用，不要直接瞎编。';
  }
  const result = await callLlmJson([
    {
      role: 'system',
      content: `你是中文自媒体编辑。${modeInstruction}风格：${tone}。${userInstructionPriority}热点只用于标题和前言的自然切入，不能借热点编造正文事实。输出严格 JSON：{"title":"","intro":"","content":""}。title 是成稿标题，intro 是独立前言，content 是不重复标题和前言的正文。${skillInstruction}${styleInstruction}`,
    },
    {
      role: 'user',
      content: `${hotspotInstruction}

原始素材：
${text}`,
    },
  ], toolOption);
  let validated = result;
  // 事实校对：rewrite/adapt 模式强校对（保留原文事实）；create 模式只有在开了 web_search 时才轻校对
  // （避免 AI 把联网结果当事实输出，但放行用户素材中已有的合理内容）
  const needFactCheck = mode !== 'create' || useWebSearch;
  if (needFactCheck) {
    try {
      const factCheckInstruction = useWebSearch
        ? '你是事实校对编辑。create 模式下用户开了联网搜索，AI 可能引用了搜索结果。规则：（1）用户原始素材中明确出现过的内容全部保留；（2）从联网搜索得到的内容可保留，但删除凭空编造的具体数字、时间、价格、统计百分比、版本号、产品参数（除非这些信息来自素材或搜索结果可验证）；（3）保留 JSON 字段不变。'
        : '你是严格的事实校对编辑。逐句检查草稿，只保留能从"原始素材"或"允许使用的热点标题"直接推出的内容。删除所有新增的原因、功能细节、时间判断、法规推测、产品示例和数据，不得用常识补全。素材信息少时允许成稿很短。保持 JSON 字段不变，只输出 {"title":"","intro":"","content":""}。';
      validated = await callLlmJson([
        {
          role: 'system',
          content: factCheckInstruction,
        },
        {
          role: 'user',
          content: `原始素材：
${text}

允许使用的热点标题：
${hotspot?.title || '无'}

待校对草稿：
${JSON.stringify(result)}`,
        },
      ]);
    } catch (error) {
      console.warn('重构事实校对失败，返回初稿：', error.message);
    }
  }
  return {
    title: String(validated.title || '').trim(),
    intro: String(validated.intro || '').trim(),
    content: String(validated.content || '').trim(),
    model: process.env.LLM_MODEL || 'LLM',
    hotspot,
  };
}

const DEFAULT_INSPIRATION_SOURCES = [
  'hot', 'dy', 'xhs', 'gzh', 'ai-gzh', 'ai-bili', 'ai-xhs', 'tracked',
];

const FIXED_INSPIRATION_SOURCE_META = [
  { key: 'hot', label: '全网热榜', category: 'hotlist', description: '综合各平台实时热榜' },
  { key: 'tracked', label: '关注账号', category: 'local', description: '已追踪账号的最新作品' },
  { key: 'gzh-search', label: '公众号关键词搜索', category: 'search', description: '按关键词搜索公众号文章（占用 API 预算）' },
  { key: 'wechat-10w', label: '公众号 10W+', category: 'external', description: '公众号 10W+ 阅读榜' },
  { key: 'wechat-growth', label: '公众号黑马', category: 'external', description: '公众号阅读增长榜' },
  { key: 'xhs-low', label: '小红书低粉爆款', category: 'external', description: '小红书低粉账号爆款' },
  { key: 'dy-surge', label: '抖音点赞飙升', category: 'external', description: '抖音每日点赞飙升榜' },
  { key: 'wersss', label: 'WeRss（we-mp-rss）', category: 'local', description: '本地同步的 we-mp-rss 公众号文章' },
];

function getConfiguredHotPlatforms() {
  const rows = db.prepare("SELECT task_config FROM crontab WHERE task_type = 'hot-platform'").all();
  return new Set(
    rows.map(row => {
      const cfg = parseJson(row.task_config) || {};
      return cfg.platform;
    }).filter(Boolean)
  );
}

function getDynamicInspirationSources() {
  const configuredPlatforms = getConfiguredHotPlatforms();
  return Object.entries(HOT_SOURCE_CONFIG)
    .filter(([key]) => configuredPlatforms.has(key))
    .map(([key, cfg]) => ({
      key,
      label: cfg.label,
      category: 'hotlist',
      description: `从 ${cfg.label} 获取热点证据`,
    }));
}

function getInspirationSourceMeta() {
  return [...getDynamicInspirationSources(), ...FIXED_INSPIRATION_SOURCE_META];
}

function getInspirationSourceKeys() {
  return new Set(getInspirationSourceMeta().map(s => s.key));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function normalizeTerms(values) {
  return [...new Set((Array.isArray(values) ? values : String(values || '').split(/[,，、\n]/))
    .map(value => String(value).trim())
    .filter(Boolean))];
}

function listInspirationConfigs() {
  const configs = db.prepare(`
    SELECT * FROM inspiration_keyword_configs ORDER BY created_at DESC
  `).all();
  const termQuery = db.prepare(`
    SELECT id, term, term_type, manual_weight, learned_weight
    FROM inspiration_keyword_terms WHERE config_id = ?
    ORDER BY term_type, created_at
  `);
  return configs.map(row => ({
    id: row.id,
    name: row.name,
    domain: row.domain || '',
    targetPlatforms: parseJson(row.target_platforms) || [],
    cronExpr: row.cron_expr,
    enabled: Boolean(row.enabled),
    sources: parseJson(row.sources) || [],
    sourceWeights: parseJson(row.source_weights) || {},
    ideaCount: row.idea_count,
    evidenceLimit: row.evidence_limit,
    dailyApiBudget: row.daily_api_budget,
    searchMode: row.search_mode === 'deep' ? 'deep' : 'combined',
    lastRunAt: row.last_run_at,
    lastSuccessAt: row.last_success_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terms: termQuery.all(row.id).map(term => ({
      id: term.id,
      term: term.term,
      type: term.term_type,
      manualWeight: term.manual_weight,
      learnedWeight: term.learned_weight,
      weight: clamp(term.manual_weight + term.learned_weight, -5, 5),
    })),
  }));
}

function getInspirationConfig(id) {
  return listInspirationConfigs().find(config => config.id === id) || null;
}

function saveInspirationConfig(input, existingId = null) {
  const id = existingId || crypto.randomUUID();
  const name = String(input.name || '').trim();
  const cronExpr = String(input.cronExpr || '0 9 * * *').trim();
  if (!name) throw new Error('配置名称不能为空');
  if (!parseCronExpr(cronExpr)) throw new Error('Cron 表达式无效');
  const now = Date.now();
  const current = db.prepare('SELECT created_at FROM inspiration_keyword_configs WHERE id = ?').get(id);
  const validKeys = getInspirationSourceKeys();
  const sources = (Array.isArray(input.sources) ? input.sources : DEFAULT_INSPIRATION_SOURCES)
    .filter(source => validKeys.has(source));
  const sourceWeights = Object.fromEntries(Object.entries(input.sourceWeights || {})
    .map(([key, value]) => [key, clamp(value, 0, 3)]));
  db.transaction(() => {
    db.prepare(`
      INSERT INTO inspiration_keyword_configs
        (id, name, domain, target_platforms, cron_expr, enabled, sources, source_weights,
         idea_count, evidence_limit, daily_api_budget, search_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, domain=excluded.domain, target_platforms=excluded.target_platforms,
        cron_expr=excluded.cron_expr, enabled=excluded.enabled, sources=excluded.sources,
        source_weights=excluded.source_weights, idea_count=excluded.idea_count,
        evidence_limit=excluded.evidence_limit, daily_api_budget=excluded.daily_api_budget,
        search_mode=excluded.search_mode,
        updated_at=excluded.updated_at
    `).run(
      id, name, String(input.domain || '').trim(),
      JSON.stringify(normalizeTerms(input.targetPlatforms)),
      cronExpr, input.enabled === false ? 0 : 1,
      JSON.stringify(sources), JSON.stringify(sourceWeights),
      clamp(input.ideaCount || 6, 1, 12),
      clamp(input.evidenceLimit || 20, 6, 60),
      clamp(input.dailyApiBudget ?? 3, 0, 30),
      input.searchMode === 'deep' ? 'deep' : 'combined',
      current?.created_at || now, now,
    );
    if (Array.isArray(input.terms)) {
      const previous = new Map(db.prepare(`
        SELECT term, learned_weight FROM inspiration_keyword_terms WHERE config_id = ?
      `).all(id).map(row => [row.term, row.learned_weight]));
      db.prepare('DELETE FROM inspiration_keyword_terms WHERE config_id = ?').run(id);
      const insert = db.prepare(`
        INSERT INTO inspiration_keyword_terms
          (id, config_id, term, term_type, manual_weight, learned_weight, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const term of input.terms) {
        const value = String(term.term || '').trim();
        const type = String(term.type || 'core');
        if (!value || !['core', 'alias', 'white', 'black'].includes(type)) continue;
        insert.run(
          crypto.randomUUID(), id, value, type,
          clamp(term.manualWeight, -5, 5),
          clamp(previous.get(value) || term.learnedWeight, -5, 5),
          now, now,
        );
      }
    }
  })();
  syncInspirationConfigCron(id);
  return getInspirationConfig(id);
}

function effectiveConfigTerms(config) {
  const black = new Set(config.terms.filter(term => term.type === 'black').map(term => term.term.toLowerCase()));
  const typePriority = { white: 4, core: 3, alias: 2 };
  return config.terms
    .filter(term => term.type !== 'black' && !black.has(term.term.toLowerCase()))
    .map(term => ({
      term: term.term,
      type: term.type,
      weight: term.type === 'white' ? Math.max(3, term.weight) : term.weight,
    }))
    .sort((a, b) =>
      (typePriority[b.type] || 0) - (typePriority[a.type] || 0)
      || b.weight - a.weight
    );
}

function evidenceMatches(title, terms) {
  const normalized = String(title || '').toLowerCase();
  const matches = terms.filter(term => normalized.includes(term.term.toLowerCase()));
  return {
    matches,
    score: matches.reduce((sum, term) => sum + 10 + term.weight * 4, 0),
  };
}

function evidenceIdentity(item) {
  return normalizeTrendKey(item.title).slice(0, 80);
}

const EXTERNAL_INSPIRATION_SOURCES = {
  'wechat-10w': {
    platform: 'wechat-10w',
    endpoint: 'cozeSkill/getWxDataByCategoryAndTime',
    method: 'GET',
    request: date => ({
      type: '总排名',
      source: '公众号10w+阅读文章推荐',
      startDate: date,
      endDate: localDate(new Date(new Date(`${date}T12:00:00+08:00`).getTime() + 86400000)),
    }),
  },
  'wechat-growth': {
    platform: 'wechat-growth',
    endpoint: 'cozeSkill/getGzhCozeSkillDataRaise',
    method: 'GET',
    request: date => ({ rankDate: date, source: '公众号阅读增长榜-GitHub' }),
  },
  'xhs-low': {
    platform: 'xhs-low',
    endpoint: 'cozeSkill/getXhsCozeSkillDataLowFans',
    method: 'GET',
    request: date => ({ rankDate: date, source: '小红书冷门账号爆款文章', category: '综合全部' }),
  },
  'dy-surge': {
    platform: 'dy-surge',
    endpoint: 'dy/search/hotContentRank',
    method: 'POST',
    request: date => ({ source: '抖音每日点赞飙升榜', startTime: date }),
  },
};

function normalizeExternalInspirationItems(source, data) {
  let list = Array.isArray(data) ? data : data?.list || [];
  if (source === 'wechat-10w') list = data?.tenWReadingRank || list;
  if (source === 'wechat-growth') {
    return list.map(item => {
      const work = item.maxWork || {};
      return {
        key: String(work.photoId || item.accountId || item.userName),
        title: work.title || `${item.userName || '公众号'}阅读增长`,
        score: toNumber(item.growthRate) || toNumber(work.clicksCount) || 0,
        raw: { ...work, userName: item.userName, growthRate: item.growthRate, rankPosition: item.rankPosition },
      };
    });
  }
  return list.map(item => ({
    key: String(item.photoId || item.workId || item.id || item.title),
    title: item.title || item.content || item.desc || '(无标题)',
    score: toNumber(
      item.interactiveCount ?? item.likeCount ?? item.useLikeCount
      ?? item.clicksCount ?? item.pred_readnum
    ) || (String(item.clicksCount || '').toLowerCase().includes('10w') ? 100000 : 0),
    raw: item,
  }));
}

async function syncExternalInspirationSources(
  config,
  maxApiCalls = config.dailyApiBudget,
  onApiCall = null,
) {
  const dataDate = dateDaysAgo(1);
  const selected = config.sources.filter(source => EXTERNAL_INSPIRATION_SOURCES[source]);
  const budget = Math.max(0, Math.min(Number(maxApiCalls) || 0, selected.length));
  let apiCalls = 0;
  for (const source of selected) {
    const definition = EXTERNAL_INSPIRATION_SOURCES[source];
    const existing = db.prepare(`
      SELECT id FROM hot_batches
      WHERE platform = ? AND data_date = ? AND snapshot_kind = 'inspiration-source'
        AND status = 'success'
      ORDER BY completed_at DESC LIMIT 1
    `).get(definition.platform, dataDate);
    if (existing) continue;
    if (apiCalls >= budget) break;
    const request = definition.request(dataDate);
    const startedAt = Date.now();
    apiCalls += 1;
    if (typeof onApiCall === 'function') onApiCall(1);
    try {
      const data = definition.method === 'GET'
        ? await redfoxGetData(definition.endpoint, request)
        : await redfoxData(definition.endpoint, request);
      const items = normalizeExternalInspirationItems(source, data);
      saveHotBatch({
        platform: definition.platform,
        dataDate,
        snapshotKind: 'inspiration-source',
        endpoint: definition.endpoint,
        request,
        response: data,
        items,
        status: 'success',
        startedAt,
      });
    } catch (error) {
      saveHotBatch({
        platform: definition.platform,
        dataDate,
        snapshotKind: 'inspiration-source',
        endpoint: definition.endpoint,
        request,
        status: 'failed',
        error: error.message,
        startedAt,
      });
    }
  }
  return apiCalls;
}

function collectLocalInspirationEvidence(config) {
  const terms = effectiveConfigTerms(config);
  if (!terms.length) return [];
  const sources = new Set(config.sources);
  const platformMap = {
    hot: 'all', dy: 'dy', xhs: 'xhs', gzh: 'gzh', 'ai-gzh': 'ai-gzh',
    'ai-bili': 'ai-bili', 'ai-xhs': 'ai-xhs',
    'wechat-10w': 'wechat-10w', 'wechat-growth': 'wechat-growth',
    'xhs-low': 'xhs-low', 'dy-surge': 'dy-surge', wersss: 'wersss',
  };
  const evidence = [];
  for (const [source, platform] of Object.entries(platformMap)) {
    if (!sources.has(source)) continue;
    const rows = db.prepare(`
      SELECT b.id AS batch_id, b.data_date, b.completed_at, i.rank, i.item_key,
             i.title, i.score, i.raw_data
      FROM hot_batches b
      JOIN hot_batch_items i ON i.batch_id = b.id
      WHERE b.platform = ? AND b.status = 'success'
        AND b.data_date >= ?
      ORDER BY b.data_date DESC, b.completed_at DESC, i.rank ASC
      LIMIT 300
    `).all(platform, dateDaysAgo(7));
    for (const row of rows) {
      const match = evidenceMatches(row.title, terms);
      if (!match.matches.length) continue;
      const raw = parseJson(row.raw_data) || {};
      const weight = clamp(config.sourceWeights[source] ?? 1, 0, 3);
      evidence.push({
        id: `${source}:${row.batch_id}:${row.item_key}`,
        sourceType: source,
        platform,
        articleKey: row.item_key,
        title: row.title,
        author: raw.author || raw.userName || raw.accountName || raw.sourceUsernickname || '',
        url: raw.url || raw.oriUrl || raw.workUrl || raw.photoJumpUrl || '',
        readCount: toNumber(raw.readCount ?? raw.clicksCount ?? raw.likeCount ?? raw.useLikeCount ?? raw.interactiveCount) || 0,
        publishTime: raw.publishTime || raw.publicTime || raw.gmtCreate || row.data_date,
        dataDate: row.data_date,
        rank: row.rank,
        matchedTerms: match.matches.map(term => term.term),
        score: match.score * weight + Math.max(1, 51 - row.rank),
        batchId: row.batch_id,
      });
    }
  }
  if (sources.has('tracked')) {
    const rows = db.prepare(`
      SELECT w.account_id, w.plat, w.work_id, w.work_data, w.publish_at, a.name
      FROM account_works w
      JOIN tracked_accounts a ON a.id = w.account_id
      ORDER BY w.publish_at DESC, w.synced_at DESC
      LIMIT 500
    `).all();
    for (const row of rows) {
      const raw = parseJson(row.work_data) || {};
      const title = raw.title || raw.content || '';
      const match = evidenceMatches(`${title} ${row.name}`, terms);
      if (!match.matches.length) continue;
      evidence.push({
        id: `tracked:${row.account_id}:${row.work_id}`,
        sourceType: 'tracked',
        platform: row.plat,
        articleKey: row.work_id,
        title,
        author: row.name,
        url: raw.url || raw.workUrl || '',
        readCount: toNumber(raw.readCount ?? raw.clicksCount ?? raw.likeCount) || 0,
        publishTime: raw.publishTime || raw.publicTime || '',
        dataDate: row.publish_at ? localDate(new Date(row.publish_at)) : '',
        rank: 0,
        matchedTerms: match.matches.map(term => term.term),
        score: match.score * clamp(config.sourceWeights.tracked ?? 1, 0, 3) + 15,
        batchId: null,
      });
    }
  }
  if (sources.has('wersss')) {
    const rows = db.prepare(`
      SELECT a.id, a.title, a.summary, a.url, a.cover, a.publish_time, s.mp_name, s.mp_alias
      FROM wersss_articles a
      JOIN wersss_subscriptions s ON s.mp_id = a.mp_id
      WHERE a.publish_time >= ?
      ORDER BY a.publish_time DESC
      LIMIT 500
    `).all(Date.now() - 7 * 24 * 60 * 60 * 1000);
    for (const row of rows) {
      const title = row.title || '';
      const match = evidenceMatches(`${title} ${row.summary || ''} ${row.mp_name || ''} ${row.mp_alias || ''}`, terms);
      if (!match.matches.length) continue;
      evidence.push({
        id: `wersss:${row.id}`,
        sourceType: 'wersss',
        platform: 'wersss',
        articleKey: row.id,
        title,
        author: row.mp_name || row.mp_alias || '',
        url: row.url || '',
        readCount: 0,
        publishTime: row.publish_time || '',
        dataDate: row.publish_time ? localDate(new Date(row.publish_time)) : '',
        rank: 0,
        matchedTerms: match.matches.map(term => term.term),
        score: match.score * clamp(config.sourceWeights.wersss ?? 1, 0, 3) + 10,
        batchId: null,
      });
    }
  }
  const unique = new Map();
  for (const item of evidence) {
    const key = `${item.platform}:${item.articleKey || evidenceIdentity(item)}`;
    if (!unique.has(key) || unique.get(key).score < item.score) unique.set(key, item);
  }
  return [...unique.values()];
}

function groupInspirationEvidence(items) {
  const groups = [];
  for (const item of items.sort((a, b) => b.score - a.score)) {
    const key = evidenceIdentity(item);
    let group = groups.find(candidate => {
      if (!key || !candidate.key) return false;
      return key === candidate.key
        || (key.length >= 6 && candidate.key.length >= 6 && (key.includes(candidate.key) || candidate.key.includes(key)));
    });
    if (!group) {
      group = { id: crypto.randomUUID(), key, topic: item.title, items: [], platforms: new Set(), authors: new Set(), score: 0 };
      groups.push(group);
    }
    group.items.push(item);
    group.platforms.add(item.platform);
    if (item.author) group.authors.add(item.author);
    group.score = Math.max(group.score, item.score);
  }
  return groups.map(group => ({
    ...group,
    platformCount: group.platforms.size,
    authorCount: group.authors.size,
    score: group.score + Math.log2(1 + group.platforms.size) * 15 + Math.log2(1 + group.authors.size) * 8,
  })).sort((a, b) => b.score - a.score);
}

function selectDiverseEvidence(groups, limit) {
  const selected = [];
  const platformCounts = new Map();
  const authors = new Set();
  for (const group of groups) {
    const representative = group.items.find(item =>
      (!item.author || !authors.has(item.author))
      && (platformCounts.get(item.platform) || 0) < Math.max(2, Math.ceil(limit * 0.4)),
    ) || group.items[0];
    if (!representative) continue;
    selected.push({ ...representative, groupId: group.id, groupScore: group.score, platformCount: group.platformCount, authorCount: group.authorCount });
    if (representative.author) authors.add(representative.author);
    platformCounts.set(representative.platform, (platformCounts.get(representative.platform) || 0) + 1);
    if (selected.length >= limit) break;
  }
  return selected;
}

function normalizeInspirationTitle(value) {
  return normalizeTrendKey(value)
    .replace(/[一壹]/g, '1')
    .replace(/[二两贰]/g, '2')
    .replace(/[三叁]/g, '3')
    .replace(/[四肆]/g, '4')
    .replace(/[五伍]/g, '5')
    .replace(/[六陆]/g, '6')
    .replace(/[七柒]/g, '7')
    .replace(/[八捌]/g, '8')
    .replace(/[九玖]/g, '9')
    .replace(/[的了]/g, '')
    .replace(/第[一二三四五六七八九十\d]+期/g, '')
    .replace(/\d+天/g, '');
}

function inspirationTitleBigrams(value) {
  const normalized = normalizeInspirationTitle(value);
  if (normalized.length < 2) return new Set(normalized ? [normalized] : []);
  return new Set(Array.from({ length: normalized.length - 1 }, (_, index) => normalized.slice(index, index + 2)));
}

function inspirationTitleSimilarity(left, right) {
  const a = normalizeInspirationTitle(left);
  const b = normalizeInspirationTitle(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  if (shorter.length >= 8 && longer.includes(shorter) && shorter.length / longer.length >= 0.72) return 0.9;
  const aPairs = inspirationTitleBigrams(a);
  const bPairs = inspirationTitleBigrams(b);
  let overlap = 0;
  for (const pair of aPairs) if (bPairs.has(pair)) overlap += 1;
  return (2 * overlap) / Math.max(1, aPairs.size + bPairs.size);
}

function recentInspirationTitles(configId, limit = 100) {
  const rows = configId
    ? [
      ...db.prepare(`
      SELECT title FROM inspirations
      WHERE deleted_at IS NULL AND config_id = ?
      ORDER BY created_at DESC LIMIT ?
      `).all(configId, limit),
      ...db.prepare(`
        SELECT title FROM inspirations
        WHERE deleted_at IS NULL AND (config_id IS NULL OR config_id <> ?)
        ORDER BY created_at DESC LIMIT ?
      `).all(configId, limit),
    ]
    : db.prepare(`
      SELECT title FROM inspirations
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC LIMIT ?
    `).all(limit);
  return [...new Set(rows.map(row => row.title).filter(Boolean))].slice(0, limit * 2);
}

function dedupeInspirationIdeas(ideas, historicalTitles) {
  const accepted = [];
  const rejected = [];
  const comparisonTitles = [...historicalTitles];
  for (const idea of ideas || []) {
    const title = String(idea?.title || '').trim();
    if (!title) {
      rejected.push({ title: '', reason: '标题为空' });
      continue;
    }
    const duplicate = comparisonTitles.find(existing =>
      inspirationTitleSimilarity(title, existing) >= 0.84
    );
    if (duplicate) {
      rejected.push({ title, reason: `与已有选题相似：${duplicate}` });
      continue;
    }
    accepted.push(idea);
    comparisonTitles.push(title);
  }
  return { accepted, rejected };
}

async function generateInspirations(body) {
  const count = Math.max(1, Math.min(Number(body.count) || 6, 12));
  let config = body.configId ? getInspirationConfig(String(body.configId)) : null;
  const domain = String(body.domain || config?.domain || '').trim();
  let keywords = Array.isArray(body.keywords) ? body.keywords.map(String).filter(Boolean).slice(0, 12) : [];
  const adHocSources = !config && Array.isArray(body.sources) && body.sources.length ? body.sources : null;
  if (adHocSources) {
    config = {
      id: null,
      domain,
      sources: adHocSources.filter(source => getInspirationSourceKeys().has(source)),
      terms: keywords.map(term => ({ term, type: 'core', weight: 0 })),
      dailyApiBudget: 3,
      evidenceLimit: 20,
      searchMode: 'combined',
      sourceWeights: {},
    };
  }
  if (!keywords.length && config) keywords = effectiveConfigTerms(config).map(term => term.term).slice(0, 12);
  if (!keywords.length) {
    keywords = getHotTrends(7).themes.slice(0, 8).map(item => item.name);
  }
  if (!keywords.length) {
    keywords = hotListPayload('all').data.slice(0, 8).map(item => item.title);
  }

  const totalBudget = config ? config.dailyApiBudget : 2;
  const usedBudget = Math.max(0, Number(body.usedApiCalls) || 0);
  const externalApiCalls = config && !body.externalSourcesSynced
    ? await syncExternalInspirationSources(
      config,
      Math.max(0, totalBudget - usedBudget),
      body.onApiCall,
    )
    : Number(body.externalApiCalls) || 0;
  const localGroups = config ? groupInspirationEvidence(collectLocalInspirationEvidence(config)) : [];
  const localEvidence = selectDiverseEvidence(localGroups, config?.evidenceLimit || 20);
  let hotResearch = { articles: [], searched: [], apiCalls: 0 };
  if (keywords.length && (!config || config.sources.includes('gzh-search'))) {
    const remainingBudget = Math.max(0, totalBudget - usedBudget - externalApiCalls);
    hotResearch = await fetchKeywordHotArticles(keywords, {
      config,
      maxApiCalls: Math.min(config?.searchMode === 'deep' ? 5 : 1, remainingBudget),
      onApiCall: body.onApiCall,
    });
  }
  const sourceItems = [
    ...localEvidence,
    ...hotResearch.articles.slice(0, 30).map(article => ({
    id: article.id,
    sourceType: 'gzh-search',
    platform: 'gzh',
    title: article.title,
    author: article.author || article.sourceUsernickname,
    readCount: article.clicksCount,
    publishTime: article.publicTime,
    relevanceScore: article.relevanceScore,
    popularityScore: article.popularityScore,
    recencyScore: article.recencyScore,
    totalScore: article.totalScore,
    url: article.url,
    score: article.totalScore || article.relevanceScore || 0,
  })),
  ].sort((a, b) => (b.groupScore || b.score || 0) - (a.groupScore || a.score || 0)).slice(0, config?.evidenceLimit || 30);
  const evidenceText = sourceItems.map((article, index) =>
    `${index + 1}. ${article.title}｜${article.author || '未知作者'}｜阅读${article.readCount || 0}｜总分${article.totalScore || 0}｜${article.publishTime || ''}`
  ).join('\n');

  if (!process.env.LLM_API_KEY) {
    throw new Error('未配置 LLM_API_KEY；系统不再使用内置选题模板，无法生成选题');
  }
  if (!keywords.length) throw new Error('没有可用于生成选题的关键词');

  const sourceMode = sourceItems.length ? 'hot-evidence' : 'llm-reasoning';
  const generationNote = sourceMode === 'hot-evidence'
    ? '基于本地热榜、平台榜单、关注账号或关键词搜索证据生成。'
    : '本轮未检索到可用热点信息；选题仅来自大模型结合赛道与关键词的推理，不代表当前热点或事实趋势。';
  const historicalTitles = recentInspirationTitles(config?.id || null);
  const historyText = historicalTitles.length
    ? historicalTitles.slice(0, 80).map((title, index) => `${index + 1}. ${title}`).join('\n')
    : '（暂无历史选题）';
  let llmCalls = 0;
  let parsed;
  try {
    const systemContent = sourceMode === 'hot-evidence'
      ? '你是中文自媒体选题编辑。必须基于提供的真实证据归纳，不得脱离证据编造热点。输出严格 JSON：{"ideas":[{"title":"","summary":"","angle":"","targetPlatform":"","sourceKeywords":[""],"sourceIndexes":[1]}]}。sourceIndexes 必须引用输入证据序号，不输出 Markdown。'
      : '你是中文自媒体选题编辑。本轮没有可用热点证据，只能根据账号赛道、关键词和通用内容方法进行大模型推理。不得声称某话题正在爆发、属于当前热点、未来必然上涨或引用不存在的数据。输出严格 JSON：{"ideas":[{"title":"","summary":"","angle":"","targetPlatform":"","sourceKeywords":[""],"sourceIndexes":[]}]}。sourceIndexes 必须为空数组，不输出 Markdown。';
    const userContent = sourceMode === 'hot-evidence'
      ? `账号赛道：${domain || '未指定'}\n搜索关键词：${keywords.join('、')}\n真实证据：\n${evidenceText}\n\n近期已有选题，禁止重复或近义改写：\n${historyText}\n\n跨平台数和独立作者数越多，信号越强。生成 ${count} 个彼此不重复、可执行的选题，摘要必须说明引用了哪些证据信号。`
      : `账号赛道：${domain || '未指定'}\n关键词：${keywords.join('、')}\n\n近期已有选题，禁止重复或近义改写：\n${historyText}\n\n生成 ${count} 个彼此不重复、可执行的常青型或方法型选题。每条摘要必须明确写出“无热点证据，本选题为模型推理”，并说明推理角度。不要使用“突然爆发”“最近大火”“接下来几天会怎样”等暗示实时趋势的表达。`;
    llmCalls += 1;
    const content = await callLlm([
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent },
    ], { json: true });
    try {
      parsed = parseLlmJson(content);
    } catch {
      llmCalls += 1;
      const repaired = await callLlm([
        {
          role: 'system',
          content: '你是 JSON 修复器。只修复语法并输出合法 JSON，不改变字段含义，不输出 Markdown。',
        },
        { role: 'user', content },
      ], { json: true, temperature: 0, maxTokens: 4096 });
      parsed = parseLlmJson(repaired);
    }
  } catch (error) {
    throw new Error(`LLM 选题生成失败：${error.message}`);
  }
  if (!Array.isArray(parsed?.ideas) || !parsed.ideas.length) {
    throw new Error('LLM 未返回有效选题，且系统不再使用内置模板');
  }
  const deduped = dedupeInspirationIdeas(parsed.ideas, historicalTitles);
  const ideas = deduped.accepted;

  const insert = db.prepare(`
    INSERT INTO inspirations
      (id, title, summary, angle, target_platform, source_keywords, source_items, status,
       config_id, run_id, generation_type, source_mode, generation_note, generated_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '待研究', ?, ?, ?, ?, ?, ?, ?)
  `);
  const runId = body.runId || null;
  const created = ideas.slice(0, count).map(idea => {
    const indexes = Array.isArray(idea.sourceIndexes) ? idea.sourceIndexes : [];
    const referencedItems = indexes
      .map(index => sourceItems[Number(index) - 1])
      .filter(Boolean)
      .slice(0, 5);
    const record = {
      id: crypto.randomUUID(),
      title: String(idea.title || '').trim(),
      summary: String(idea.summary || '').trim(),
      angle: String(idea.angle || '').trim(),
      targetPlatform: String(idea.targetPlatform || '').trim(),
      sourceKeywords: Array.isArray(idea.sourceKeywords) ? idea.sourceKeywords.map(String) : keywords.slice(0, 1),
      sourceItems: referencedItems.length ? referencedItems : sourceItems.slice(0, 3),
      status: '待研究',
      configId: config?.id || null,
      runId,
      generationType: config ? (body.triggerType || 'manual') : 'manual',
      sourceMode,
      generationNote,
      generatedBy: process.env.LLM_MODEL || 'LLM',
      createdAt: Date.now(),
    };
    insert.run(
      record.id,
      record.title,
      record.summary,
      record.angle,
      record.targetPlatform,
      JSON.stringify(record.sourceKeywords),
      JSON.stringify(record.sourceItems),
      record.configId,
      record.runId,
      record.generationType,
      record.sourceMode,
      record.generationNote,
      record.generatedBy,
      record.createdAt,
    );
    return record;
  });
  return {
    ideas: created,
    generatedBy: process.env.LLM_MODEL || 'LLM',
    sourceMode,
    generationNote,
    duplicateCount: deduped.rejected.length,
    duplicates: deduped.rejected,
    keywords,
    research: {
      articleCount: sourceItems.length,
      apiCalls: externalApiCalls + (hotResearch.apiCalls || 0),
      sources: config?.sources || [],
      apiBudget: {
        limit: totalBudget,
        usedBeforeRun: usedBudget,
        usedThisRun: externalApiCalls + (hotResearch.apiCalls || 0),
        remaining: Math.max(0, totalBudget - usedBudget - externalApiCalls - (hotResearch.apiCalls || 0)),
      },
      searches: hotResearch.searched,
      articles: sourceItems,
      localGroupCount: localGroups.length,
      llmCalls,
    },
  };
}

function listInspirations(includeDeleted = false) {
  return db.prepare(`
    SELECT * FROM inspirations
    WHERE deleted_at IS ${includeDeleted ? 'NOT NULL' : 'NULL'}
    ORDER BY ${includeDeleted ? 'deleted_at' : 'created_at'} DESC
    LIMIT 200
  `).all().map(row => ({
    id: row.id,
    title: row.title,
    summary: row.summary,
    angle: row.angle,
    targetPlatform: row.target_platform,
    sourceKeywords: parseJson(row.source_keywords) || [],
    sourceItems: parseJson(row.source_items) || [],
    kbLink: parseJson(row.kb_link) || null,
    status: row.status,
    isFavorite: Boolean(row.is_favorite),
    feedbackState: row.feedback_state || '',
    configId: row.config_id || null,
    runId: row.run_id || null,
    generationType: row.generation_type || 'manual',
    sourceMode: row.source_mode || 'legacy',
    generationNote: row.generation_note || '',
    generatedBy: row.generated_by || '',
    deletedAt: row.deleted_at || null,
    createdAt: row.created_at,
  }));
}

function trashInspiration(id) {
  const result = db.prepare('UPDATE inspirations SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(Date.now(), id);
  if (!result.changes) throw new Error('选题不存在或已在回收站');
}

function restoreInspiration(id) {
  const result = db.prepare('UPDATE inspirations SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL')
    .run(id);
  if (!result.changes) throw new Error('回收站中没有该选题');
}

function permanentlyDeleteInspiration(id) {
  const result = db.prepare('DELETE FROM inspirations WHERE id = ? AND deleted_at IS NOT NULL').run(id);
  if (!result.changes) throw new Error('只能永久删除回收站中的选题');
}

function inspirationCronId(configId) {
  return `inspiration-config:${configId}`;
}

function isInspirationCronId(id) {
  return typeof id === 'string' && id.startsWith('inspiration-config:');
}

function syncInspirationConfigCron(configId) {
  const config = getInspirationConfig(configId);
  const cronId = inspirationCronId(configId);
  if (!config) {
    deleteCronJob(cronId);
    return;
  }
  saveCronJob(
    cronId,
    `自动选题：${config.name}`,
    config.cronExpr,
    config.enabled,
    'inspiration-generate',
    { configId },
    { notifyOnFailure: true, notifyOnSuccess: true },
  );
}

function deleteInspirationConfig(id) {
  const result = db.prepare('DELETE FROM inspiration_keyword_configs WHERE id = ?').run(id);
  deleteCronJob(inspirationCronId(id));
  return result.changes > 0;
}

const activeInspirationRuns = new Set();

function inspirationApiBudget(config) {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const used = db.prepare(`
    SELECT COALESCE(SUM(api_calls), 0) AS count
    FROM inspiration_runs
    WHERE config_id = ? AND started_at >= ?
  `).get(config.id, dayStart.getTime()).count;
  return {
    limit: config.dailyApiBudget,
    used,
    remaining: Math.max(0, config.dailyApiBudget - used),
  };
}

async function runInspirationConfig(configId, triggerType = 'manual') {
  const config = getInspirationConfig(configId);
  if (!config) throw new Error('主题配置不存在');
  if (activeInspirationRuns.has(configId)) throw new Error('该主题已有生成任务正在运行');
  activeInspirationRuns.add(configId);
  const runId = crypto.randomUUID();
  const startedAt = Date.now();
  db.prepare(`
    INSERT INTO inspiration_runs
      (id, config_id, trigger_type, status, started_at)
    VALUES (?, ?, ?, 'running', ?)
  `).run(runId, configId, triggerType, startedAt);
  db.prepare('UPDATE inspiration_keyword_configs SET last_run_at = ?, updated_at = ? WHERE id = ?')
    .run(startedAt, startedAt, configId);
  let runApiCalls = 0;
  const recordApiCall = count => {
    runApiCalls += Math.max(0, Number(count) || 0);
    db.prepare('UPDATE inspiration_runs SET api_calls = ? WHERE id = ?').run(runApiCalls, runId);
  };
  try {
    const budget = inspirationApiBudget(config);
    const externalApiCalls = await syncExternalInspirationSources(
      config,
      budget.remaining,
      recordApiCall,
    );
    const localEvidence = selectDiverseEvidence(
      groupInspirationEvidence(collectLocalInspirationEvidence(config)),
      config.evidenceLimit,
    );
    const fingerprint = crypto.createHash('sha1').update(JSON.stringify({
      config: {
        id: config.id,
        domain: config.domain,
        sources: config.sources,
        sourceWeights: config.sourceWeights,
        ideaCount: config.ideaCount,
        evidenceLimit: config.evidenceLimit,
        searchMode: config.searchMode,
        terms: config.terms.map(term => [term.term, term.type, term.weight]),
      },
      evidence: localEvidence.map(item => [item.id, item.batchId, item.score]),
    })).digest('hex');
    const previous = db.prepare(`
      SELECT id FROM inspiration_runs
      WHERE config_id = ? AND status = 'success' AND evidence_fingerprint = ?
      ORDER BY completed_at DESC LIMIT 1
    `).get(configId, fingerprint);
    if (previous && triggerType === 'cron') {
      db.prepare(`
        UPDATE inspiration_runs
        SET evidence_fingerprint = ?, status = 'skipped', completed_at = ?
        WHERE id = ?
      `).run(fingerprint, Date.now(), runId);
      return { runId, skipped: true, ideas: [] };
    }
    db.prepare('UPDATE inspiration_runs SET evidence_fingerprint = ? WHERE id = ?').run(fingerprint, runId);
    const result = await generateInspirations({
      configId,
      count: config.ideaCount,
      runId,
      triggerType,
      externalSourcesSynced: true,
      externalApiCalls,
      usedApiCalls: budget.used,
      onApiCall: recordApiCall,
    });
    const completedAt = Date.now();
    db.prepare(`
      UPDATE inspiration_runs
      SET status = ?, idea_count = ?, api_calls = ?, completed_at = ?
      WHERE id = ?
    `).run(
      result.ideas.length ? 'success' : 'empty',
      result.ideas.length,
      runApiCalls,
      completedAt,
      runId,
    );
    db.prepare(`
      UPDATE inspiration_keyword_configs
      SET last_success_at = ?, updated_at = ?
      WHERE id = ?
    `).run(completedAt, completedAt, configId);
    broadcastNotification(
      '灵感选题生成完成',
      `主题「${config.name}」生成完成，本次新增 ${result.ideas.length} 条选题。`
        + (result.generatedBy ? `\n生成方式：${result.generatedBy}` : '')
        + (result.sourceMode === 'llm-reasoning' ? '\n数据依据：无热点信息，仅大模型推理' : '\n数据依据：热点证据')
        + (result.duplicateCount ? `\n去重过滤：${result.duplicateCount} 条` : '')
        + (runApiCalls ? `\n消耗 API 调用：${runApiCalls}` : '')
    ).catch(err => console.warn('[notify] 灵感选题完成通知异常:', err.message));
    logAction('generate-inspirations', triggerType, 'database+api', {
      configId,
      configName: config.name,
      keywords: result.keywords,
      articleCount: result.research?.articleCount || 0,
      searches: result.research?.searches || [],
      apiBudget: {
        limit: budget.limit,
        usedBeforeRun: budget.used,
        usedThisRun: runApiCalls,
        remaining: Math.max(0, budget.limit - budget.used - runApiCalls),
      },
    }, runApiCalls, result.research?.llmCalls || 1);
    return { runId, skipped: false, ...result };
  } catch (error) {
    db.prepare(`
      UPDATE inspiration_runs
      SET status = 'failed', api_calls = ?, completed_at = ?, error = ?
      WHERE id = ?
    `).run(runApiCalls, Date.now(), error.message, runId);
    throw error;
  } finally {
    activeInspirationRuns.delete(configId);
  }
}

function listInspirationRuns(configId = null) {
  const rows = configId
    ? db.prepare('SELECT * FROM inspiration_runs WHERE config_id = ? ORDER BY started_at DESC LIMIT 100').all(configId)
    : db.prepare('SELECT * FROM inspiration_runs ORDER BY started_at DESC LIMIT 100').all();
  return rows.map(row => ({
    id: row.id,
    configId: row.config_id,
    triggerType: row.trigger_type,
    status: row.status,
    ideaCount: row.idea_count,
    apiCalls: row.api_calls,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
  }));
}

function setInspirationFavorite(id, favorite) {
  const result = db.prepare('UPDATE inspirations SET is_favorite = ? WHERE id = ?')
    .run(favorite ? 1 : 0, id);
  if (!result.changes) throw new Error('选题不存在');
}

function applyInspirationFeedback(id, feedbackType) {
  if (!['like', 'dislike', 'block', 'none'].includes(feedbackType)) throw new Error('反馈类型无效');
  const inspiration = db.prepare('SELECT * FROM inspirations WHERE id = ?').get(id);
  if (!inspiration) throw new Error('选题不存在');
  const now = Date.now();
  const active = db.prepare(`
    SELECT * FROM inspiration_feedback
    WHERE inspiration_id = ? AND revoked_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(id);
  db.transaction(() => {
    if (active) {
      db.prepare('UPDATE inspiration_feedback SET revoked_at = ? WHERE id = ?').run(now, active.id);
      const terms = parseJson(active.affected_terms) || [];
      for (const term of terms) {
        db.prepare(`
          UPDATE inspiration_keyword_terms
          SET learned_weight = MAX(-5, MIN(5, learned_weight - ?)), updated_at = ?
          WHERE config_id = ? AND term = ?
        `).run(active.weight_delta, now, inspiration.config_id, term);
      }
    }
    if (feedbackType === 'none') {
      db.prepare('UPDATE inspirations SET feedback_state = NULL WHERE id = ?').run(id);
      return;
    }
    const terms = normalizeTerms(parseJson(inspiration.source_keywords) || []).slice(0, 8);
    const delta = feedbackType === 'like' ? 0.5 : feedbackType === 'dislike' ? -0.5 : -2;
    db.prepare(`
      INSERT INTO inspiration_feedback
        (id, inspiration_id, feedback_type, affected_terms, weight_delta, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), id, feedbackType, JSON.stringify(terms), delta, now);
    if (inspiration.config_id) {
      for (const term of terms) {
        const existing = db.prepare(`
          SELECT id FROM inspiration_keyword_terms WHERE config_id = ? AND term = ?
        `).get(inspiration.config_id, term);
        if (existing) {
          db.prepare(`
            UPDATE inspiration_keyword_terms
            SET term_type = CASE WHEN ? = 'block' THEN 'black' ELSE term_type END,
                learned_weight = MAX(-5, MIN(5, learned_weight + ?)),
                updated_at = ?
            WHERE id = ?
          `).run(feedbackType, delta, now, existing.id);
        } else {
          db.prepare(`
            INSERT INTO inspiration_keyword_terms
              (id, config_id, term, term_type, manual_weight, learned_weight, created_at, updated_at)
            VALUES (?, ?, ?, ?, 0, ?, ?, ?)
          `).run(
            crypto.randomUUID(), inspiration.config_id, term,
            feedbackType === 'block' ? 'black' : 'alias',
            clamp(delta, -5, 5), now, now,
          );
        }
      }
    }
    db.prepare('UPDATE inspirations SET feedback_state = ? WHERE id = ?').run(feedbackType, id);
  })();
  return getInspirationConfig(inspiration.config_id);
}

function listTrackers() {
  return db.prepare('SELECT * FROM tracked_accounts ORDER BY created_at DESC').all().map(row => {
    const raw = parseJson(row.raw_info) || {};
    if (String(raw.authorFans || '').startsWith('红狐指数')) delete raw.authorFans;
    return {
      ...raw,
      id: row.id,
      plat: row.plat,
      name: row.name,
      group: row.group_name,
      syncedAt: row.synced_at,
      createdAt: row.created_at,
    };
  });
}

function saveTracker(body) {
  const plat = String(body.plat || '');
  const name = String(body.name || '').trim();
  if (!['dy', 'xhs', 'gzh'].includes(plat) || !name) throw new Error('平台或账号名称无效');
  const accountId = normalizeTrackerAccountId(plat, body.accountId || '');
  if (['dy', 'xhs'].includes(plat) && !accountId) {
    throw new Error(plat === 'dy' ? '请填写抖音号或账号 ID' : '请填写小红书号（redId）');
  }
  const id = String(body.id || `${plat}:${accountId || name}`);
  const now = Date.now();
  const raw = { ...body, accountId };
  if (String(raw.authorFans || '').startsWith('红狐指数')) delete raw.authorFans;
  const existing = db.prepare('SELECT plat, raw_info FROM tracked_accounts WHERE id = ?').get(id);
  const existingRaw = parseJson(existing?.raw_info) || {};
  const identifierChanged = Boolean(existing) && (
    existing.plat !== plat
    || normalizeTrackerAccountId(existing.plat, existingRaw.accountId || '') !== accountId
  );
  delete raw.id;
  delete raw.plat;
  delete raw.name;
  delete raw.group;
  delete raw.syncedAt;
  delete raw.createdAt;
  db.prepare(`
    INSERT INTO tracked_accounts (id, plat, name, group_name, raw_info, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      plat = excluded.plat,
      name = excluded.name,
      group_name = excluded.group_name,
      raw_info = excluded.raw_info
  `).run(id, plat, name, body.group || '其他', JSON.stringify(raw), now);
  if (identifierChanged) {
    db.prepare('DELETE FROM account_works WHERE account_id = ?').run(id);
    db.prepare('UPDATE tracked_accounts SET synced_at = NULL WHERE id = ?').run(id);
  }
  return listTrackers().find(item => item.id === id);
}

const activeTrackerSyncs = new Map();
const trackerRetryTimers = new Map();
const TRACKER_COLLECTION_WAIT_MS = 30 * 60 * 1000;

function normalizeTrackerAccountId(plat, value) {
  const input = String(value || '').trim();
  if (!input) return '';
  try {
    const url = new URL(input);
    if (plat === 'dy') {
      const match = url.pathname.match(/\/user\/([^/]+)/);
      if (match) return decodeURIComponent(match[1]);
    }
    if (plat === 'xhs') {
      const match = url.pathname.match(/\/user\/profile\/([^/]+)/);
      if (match) return decodeURIComponent(match[1]);
    }
  } catch {}
  return input;
}

function trackerQuerySpec(tracker) {
  const accountId = normalizeTrackerAccountId(tracker.plat, tracker.accountId || '');
  if (tracker.plat === 'gzh') {
    return {
      endpoint: 'gzhData/queryWorkList',
      body: {
        account: tracker.gzhAccount || undefined,
        accountName: tracker.name,
        offset: 0,
        sortType: '_2',
        publishTimeStart: dateDaysAgo(90),
        publishTimeEnd: localDate(),
        source: '灵感熔炉-账号追踪',
      },
    };
  }
  if (tracker.plat === 'dy') {
    if (!accountId) throw new Error('该订阅缺少抖音号或账号 ID，请先编辑账号信息');
    return {
      endpoint: 'dyData/queryUserWithWorks',
      body: { accountId, source: '灵感熔炉-账号追踪' },
    };
  }
  if (tracker.plat === 'xhs') {
    if (!accountId) throw new Error('该订阅缺少小红书号（redId），请先编辑账号信息');
    return {
      endpoint: 'xhsUser/query',
      body: { userIds: [accountId], source: '灵感熔炉-账号追踪' },
    };
  }
  throw new Error(`不支持的平台：${tracker.plat}`);
}

function trackerCollectionSpec(tracker) {
  const accountId = normalizeTrackerAccountId(tracker.plat, tracker.accountId || '');
  if (tracker.plat === 'xhs') {
    return {
      endpoint: 'xhsUser/syncUserNotes',
      body: { redId: accountId, source: '灵感熔炉-账号追踪' },
    };
  }
  throw new Error(`当前不支持提交 ${tracker.plat} 账号采集`);
}

function xhsTrackerAccounts(data) {
  return Array.isArray(data)
    ? data
    : Array.isArray(data?.list) ? data.list
      : data && typeof data === 'object' ? [data] : [];
}

function normalizeTrackerResult(tracker, data) {
  if (tracker.plat === 'gzh') {
    return { works: data?.list || data?.articles || [], trackerPatch: {} };
  }
  if (tracker.plat === 'dy') {
    if (!data || !data.nickname) {
      throw new Error('未查询到该抖音账号，请检查抖音号；未收录账号需先在 RedFox 同步');
    }
    const accountId = data.accountId || data.uniqueId || tracker.accountId;
    const works = (Array.isArray(data.workList) ? data.workList : []).map(work => ({
      ...work,
      accountName: work.accountName || data.nickname,
      accountId: work.accountId || accountId,
      avatarUrl: work.avatarUrl || data.avatar,
      followerCount: work.followerCount ?? data.followerCount,
    }));
    return {
      works,
      trackerPatch: {
        name: data.nickname || tracker.name,
        accountId,
        avatar: data.avatar || tracker.avatar,
        authorFans: data.followerCount ?? tracker.authorFans,
        redfoxIndex: data.redfoxIndex ?? tracker.redfoxIndex,
        secUid: data.secUid || tracker.secUid,
      },
    };
  }
  const accounts = xhsTrackerAccounts(data);
  const expectedId = normalizeTrackerAccountId('xhs', tracker.accountId || '');
  const account = accounts.find(item => String(item.redId || item.userId || '') === expectedId)
    || accounts[0];
  if (!account || !account.nickname) {
    throw new Error('未查询到该小红书账号，请检查小红书号（redId）；昵称不能用于稳定追踪');
  }
  const accountId = account.redId || account.userId || expectedId;
  const works = (Array.isArray(account.works) ? account.works : []).map(work => ({
    ...work,
    accountNickname: work.accountNickname || account.nickname,
    authorNickname: work.authorNickname || account.nickname,
    accountUserid: work.accountUserid || accountId,
    authorId: work.authorId || accountId,
    authorFans: work.authorFans ?? account.fans,
    cover: work.cover || work.coverUrl,
  }));
  return {
    works,
    trackerPatch: {
      name: account.nickname || tracker.name,
      accountId,
      avatar: account.avatar || tracker.avatar,
      description: account.desc || tracker.description,
      authorFans: account.fans ?? tracker.authorFans,
      redfoxIndex: account.recentIndex ?? tracker.redfoxIndex,
    },
  };
}

function trackerWorkId(work) {
  return work.workId || work.workUuid || work.id || work.awemeId
    || crypto.createHash('sha1').update([
      String(work.title || work.desc || ''),
      String(work.publishTime || work.workPublishTime || work.createTime || work.publicTime || ''),
      String(work.workUrl || work.url || ''),
    ].join('\n')).digest('hex');
}

function trackerPendingResult(tracker, message) {
  return {
    tracker,
    works: [],
    count: 0,
    newCount: 0,
    pending: true,
    retryAt: tracker.syncRetryAt || null,
    message: message || tracker.syncMessage || 'RedFox 正在采集账号数据',
  };
}

function scheduleTrackerRetry(id, retryAt) {
  const existing = trackerRetryTimers.get(id);
  if (existing) clearTimeout(existing);
  const delay = Math.max(1000, Number(retryAt) - Date.now());
  const timer = setTimeout(async () => {
    trackerRetryTimers.delete(id);
    try {
      await syncTracker(id, { automatic: true });
    } catch (error) {
      console.warn(`[tracker] 自动回查 ${id} 失败:`, error.message);
    }
  }, delay);
  timer.unref?.();
  trackerRetryTimers.set(id, timer);
}

function restoreTrackerRetries() {
  for (const tracker of listTrackers()) {
    if (tracker.plat === 'xhs' && tracker.syncStatus === 'pending' && tracker.syncRetryAt) {
      scheduleTrackerRetry(tracker.id, tracker.syncRetryAt);
    }
  }
}

async function submitTrackerCollection(tracker) {
  const request = trackerCollectionSpec(tracker);
  await redfoxData(request.endpoint, request.body);
  const now = Date.now();
  const retryAt = now + TRACKER_COLLECTION_WAIT_MS;
  const updated = saveTracker({
    ...tracker,
    syncStatus: 'pending',
    syncRequestedAt: now,
    syncRetryAt: retryAt,
    syncMessage: '已提交 RedFox 采集，预计约 30 分钟后可查询',
    syncAttempts: Number(tracker.syncAttempts || 0) + 1,
  });
  scheduleTrackerRetry(tracker.id, retryAt);
  logAction('tracker-collection-submit', 'sync-button', 'redfox', {
    trackerId: tracker.id,
    platform: tracker.plat,
    accountId: tracker.accountId,
    retryAt,
  }, 1, 0);
  return trackerPendingResult(updated);
}

async function syncTracker(id, options = {}) {
  if (activeTrackerSyncs.has(id)) return activeTrackerSyncs.get(id);
  const promise = syncTrackerOnce(id, options);
  activeTrackerSyncs.set(id, promise);
  try {
    return await promise;
  } finally {
    activeTrackerSyncs.delete(id);
  }
}

async function syncTrackerOnce(id, options = {}) {
  let tracker = listTrackers().find(item => item.id === id);
  if (!tracker) throw new Error('账号不存在');
  if (
    tracker.plat === 'xhs'
    && tracker.syncStatus === 'pending'
    && Number(tracker.syncRetryAt) > Date.now()
    && !options.automatic
  ) {
    return trackerPendingResult(tracker);
  }
  const query = trackerQuerySpec(tracker);
  const data = await redfoxData(query.endpoint, query.body);
  if (tracker.plat === 'xhs' && !xhsTrackerAccounts(data).some(account => account?.nickname)) {
    if (!tracker.syncRequestedAt) return submitTrackerCollection(tracker);
    const updated = saveTracker({
      ...tracker,
      syncStatus: 'waiting',
      syncRetryAt: null,
      syncCheckedAt: Date.now(),
      syncMessage: 'RedFox 已接受采集，但暂未返回账号数据。请稍后再次同步；也请确认填写的是主页显示的小红书号。',
    });
    logAction('tracker-collection-pending', options.automatic ? 'automatic-retry' : 'sync-button', 'redfox', {
      trackerId: tracker.id,
      platform: tracker.plat,
      accountId: tracker.accountId,
    }, 1, 0);
    return trackerPendingResult(updated);
  }
  const normalized = normalizeTrackerResult(tracker, data);
  if (tracker.plat === 'xhs' && !normalized.works.length) {
    if (!tracker.syncRequestedAt) return submitTrackerCollection(tracker);
    const updated = saveTracker({
      ...tracker,
      ...normalized.trackerPatch,
      syncStatus: 'waiting',
      syncRetryAt: null,
      syncCheckedAt: Date.now(),
      syncMessage: '账号资料已匹配，但作品仍在 RedFox 入库中，请稍后再次同步。',
    });
    return trackerPendingResult(updated);
  }
  if (Object.keys(normalized.trackerPatch).length) {
    tracker = saveTracker({
      ...tracker,
      ...normalized.trackerPatch,
      syncStatus: 'ready',
      syncRetryAt: null,
      syncCheckedAt: Date.now(),
      syncMessage: '',
    });
  }
  const works = normalized.works.sort((a, b) => workPublishAt(b) - workPublishAt(a));
  const now = Date.now();
  const existingStmt = db.prepare(`
    SELECT 1 FROM account_works WHERE account_id = ? AND plat = ? AND work_id = ?
  `);
  const newWorks = works.filter(work => {
    const workId = trackerWorkId(work);
    if (!workId) return false;
    return !existingStmt.get(id, tracker.plat, String(workId));
  });
  const upsertWork = db.prepare(`
    INSERT INTO account_works (account_id, plat, work_id, work_data, synced_at, publish_at, content_key)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, plat, work_id) DO UPDATE SET
      work_data = excluded.work_data,
      synced_at = excluded.synced_at,
      publish_at = excluded.publish_at,
      content_key = excluded.content_key
  `);
  db.transaction(() => {
    for (const work of works) {
      const workId = trackerWorkId(work);
      if (!workId) continue;
      const key = workContentKey(work);
      db.prepare(`
        DELETE FROM account_works
        WHERE account_id = ? AND plat = ? AND content_key = ? AND work_id <> ?
      `).run(id, tracker.plat, key, String(workId));
      upsertWork.run(
        id,
        tracker.plat,
        String(workId),
        JSON.stringify(work),
        now,
        workPublishAt(work),
        key,
      );
    }
    db.prepare('UPDATE tracked_accounts SET synced_at = ? WHERE id = ?').run(now, id);
  })();
  if (newWorks.length) {
    const top = newWorks.slice(0, 3).map(work => {
      const title = (work.title || work.desc || '').toString().slice(0, 60);
      return `· ${title || '(无标题)'}`;
    }).join('\n');
    broadcastNotification(
      `追踪账号「${tracker.name}」有新作品`,
      `本次同步新增 ${newWorks.length} 条作品${newWorks.length > 3 ? '（仅显示前 3 条）' : ''}：\n${top}`
    ).catch(err => console.warn('[notify] 追踪账号新作品通知异常:', err.message));
  }
  return {
    tracker: { ...tracker, syncedAt: now },
    works,
    count: works.length,
    newCount: newWorks.length,
    ...(options.includeSourceData ? { _sourceData: data } : {}),
  };
}

function listTrackerWorks(id) {
  const seen = new Set();
  return db.prepare(`
    SELECT work_data, publish_at, synced_at
    FROM account_works
    WHERE account_id = ?
    ORDER BY COALESCE(publish_at, 0) DESC, synced_at DESC
    LIMIT 200
  `).all(id).map(row => parseJson(row.work_data)).filter(work => {
    if (!work) return false;
    const key = `${String(work.title || '').trim().toLowerCase()}\n${
      work.publishTime || work.workPublishTime || work.createTime || work.publicTime || ''
    }`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 100);
}

function diagnosisMetrics(report) {
  const raw = report._raw || {};
  const header = report.header || {};
  return {
    followerCount: toNumber(raw.followerCount ?? raw.fans ?? header['粉丝数']),
    redfoxIndex: toNumber(raw.redfoxIndex ?? raw.recentIndex ?? header['红狐指数']),
    score: toNumber(report.scores?.['综合评分']),
    workCount: toNumber(raw.awemeCount ?? raw.totalWork ?? raw.workCount) || (report.works || []).length,
  };
}

function listAccountSnapshots(accountId, limit = 30) {
  return db.prepare(`
    SELECT snapshot_date, follower_count, redfox_index, work_count, score, analysis, raw_data, captured_at
    FROM account_snapshots
    WHERE account_id = ?
    ORDER BY snapshot_date DESC, captured_at DESC
    LIMIT ?
  `).all(accountId, limit).map(row => ({
    snapshotDate: row.snapshot_date,
    followerCount: row.follower_count,
    redfoxIndex: row.redfox_index,
    workCount: row.work_count,
    score: row.score,
    analysis: parseJson(row.analysis) || row.analysis || null,
    report: parseJson(row.raw_data) || null,
    capturedAt: row.captured_at,
  }));
}

async function buildAccountTrendAnalysis(tracker, report, snapshotDate) {
  const history = listAccountSnapshots(tracker.id, 14).reverse().map(item => ({
    date: item.snapshotDate,
    followers: item.followerCount,
    redfoxIndex: item.redfoxIndex,
    score: item.score,
    works: item.workCount,
  }));
  const current = diagnosisMetrics(report);
  if (!history.length) {
    return {
      summary: `已建立 ${snapshotDate} 的首个账号基线快照，后续刷新后可比较趋势。`,
      changes: [],
      risks: [],
      actions: ['保持每日快照，至少积累 7 天后再判断稳定趋势。'],
      generatedBy: '基线规则',
    };
  }
  const previous = history.at(-1);
  const currentValues = [current.followerCount, current.redfoxIndex, current.score, current.workCount];
  const previousValues = [previous.followers, previous.redfoxIndex, previous.score, previous.works];
  if (currentValues.every((value, index) => value === previousValues[index])) {
    return {
      summary: `与 ${previous.date} 相比，粉丝、红狐指数、综合评分和作品数均无变化。`,
      changes: ['核心指标无变化，本次未调用 LLM。'],
      risks: [],
      actions: ['继续观察下一次数据更新。'],
      generatedBy: '无变化规则',
    };
  }
  if (!process.env.LLM_API_KEY) {
    return {
      summary: `截至 ${snapshotDate}，综合评分 ${current.score ?? '--'}，红狐指数 ${current.redfoxIndex ?? '--'}。`,
      changes: [
        `粉丝变化：${(current.followerCount ?? 0) - (previous.followers ?? 0)}`,
        `红狐指数变化：${(current.redfoxIndex ?? 0) - (previous.redfoxIndex ?? 0)}`,
      ],
      actions: ['保持每日快照，至少积累 7 天后再判断稳定趋势。'],
      generatedBy: '规则分析',
    };
  }
  try {
    return await callLlmJson([
      {
        role: 'system',
        content: '你是自媒体账号数据分析师。只基于给定的真实快照和本次 Skill 评分做趋势解读，不得编造。输出 JSON：{"summary":"","changes":[""],"risks":[""],"actions":[""]}。',
      },
      {
        role: 'user',
        content: `平台：${tracker.plat}\n账号：${tracker.name}\n当前日期：${snapshotDate}\n历史快照：${JSON.stringify(history)}\n本次指标：${JSON.stringify(current)}\n本次维度评分：${JSON.stringify(report.dimensions || [])}`,
      },
    ]);
  } catch (error) {
    return {
      summary: `评分已保存，但 LLM 趋势解读失败：${error.message}`,
      changes: [],
      risks: [],
      actions: ['可在 LLM 服务恢复后重新运行评分详情。'],
      generatedBy: '规则降级',
    };
  }
}

async function diagnoseAndStoreTracker(tracker, options = {}) {
  const report = await runPlatformDiagnosis(tracker, options.sourceData);
  const metrics = diagnosisMetrics(report);
  const snapshotDate = options.snapshotDate || localDate();
  const analysis = tracker.group === '自己'
    ? await buildAccountTrendAnalysis(tracker, report, snapshotDate)
    : null;
  const raw = report._raw || {};
  const updated = saveTracker({
    ...tracker,
    name: report.header?.['账号名'] || tracker.name,
    avatar: raw.avatar || raw.avatarUrl || tracker.avatar,
    gzhAvatar: tracker.plat === 'gzh' ? (raw.avatar || tracker.gzhAvatar) : tracker.gzhAvatar,
    authorFans: metrics.followerCount ?? tracker.authorFans,
    redfoxIndex: metrics.redfoxIndex ?? tracker.redfoxIndex,
    gzhRedfoxIndex: tracker.plat === 'gzh' ? (metrics.redfoxIndex ?? tracker.gzhRedfoxIndex) : tracker.gzhRedfoxIndex,
  });
  db.prepare(`
    INSERT INTO account_snapshots
      (account_id, snapshot_date, follower_count, redfox_index, work_count, raw_data, captured_at, score, analysis)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, snapshot_date) DO UPDATE SET
      follower_count = excluded.follower_count,
      redfox_index = excluded.redfox_index,
      work_count = excluded.work_count,
      raw_data = excluded.raw_data,
      captured_at = excluded.captured_at,
      score = excluded.score,
      analysis = excluded.analysis
  `).run(
    tracker.id,
    snapshotDate,
    metrics.followerCount,
    metrics.redfoxIndex,
    metrics.workCount,
    JSON.stringify(report),
    Date.now(),
    metrics.score,
    analysis ? JSON.stringify(analysis) : null,
  );
  setLocalData('diagnosis', tracker.id, report, Date.now() + 7 * 24 * 60 * 60 * 1000);
  return { report, tracker: updated, analysis };
}

async function refreshTrackedAccounts() {
  const trackers = listTrackers().filter(tracker => tracker.autoSync === true);
  const result = { selected: trackers.length, synced: 0, diagnosed: 0, apiCalls: 0, failed: [] };
  for (const tracker of trackers) {
    try {
      const synced = await syncTracker(tracker.id, {
        automatic: true,
        includeSourceData: tracker.plat === 'xhs',
      });
      result.synced += 1;
      result.apiCalls += 1;
      await diagnoseAndStoreTracker(listTrackers().find(item => item.id === tracker.id) || tracker, {
        snapshotDate: dateDaysAgo(1),
        sourceData: tracker.plat === 'xhs' ? synced._sourceData : null,
      });
      result.diagnosed += 1;
      if (tracker.plat !== 'xhs') result.apiCalls += 1;
    } catch (error) {
      result.failed.push({ id: tracker.id, name: tracker.name, error: error.message });
    }
  }
  logAction('tracker-refresh', 'cron', 'redfox+llm', result, result.apiCalls, 0);
  return result;
}

async function handleLocalApi(req, res, url) {
  if (await require('./lib/routes/auth').tryRoute(req, res, url, { APP_VERSION, ENABLE_SCHEDULER, ENV_FILE })) {
    return true;
  }
  if (await require('./lib/routes/misc').tryRoute(req, res, url, {
    listActionLogs, usageSummary, getOfficialQuota,
    publicNotificationConfigs, saveNotificationConfigs, notificationConfigs,
    NOTIFICATION_CHANNELS, sendNotification,
    listLocalAgents, runLocalAgent,
    captureHotSnapshot, findRewriteHotspots, rewriteForPlatform,
  })) {
    return true;
  }
  if (await require('./lib/routes/skills').tryRoute(req, res, url, {
    listSkills, getSkill, getSkillSourceBinding, bindSkillToSource,
    classifyAllSkills, communitySkillUpdateStatus, updateCommunitySkills,
  })) {
    return true;
  }
  if (await require('./lib/routes/hot').tryRoute(req, res, url, {
    getHotTrends, analyzeHotTrendsLlm, hotListPayload,
    syncRealtimeHotspots, syncDailyPlatform, HOT_SOURCE_CONFIG,
  })) {
    return true;
  }
  if (await require('./lib/routes/inspiration').tryRoute(req, res, url, {
    getInspirationSourceMeta, listInspirationConfigs, saveInspirationConfig,
    getInspirationConfig, deleteInspirationConfig, runInspirationConfig,
    listInspirationRuns, listInspirations, generateInspirations,
    setInspirationFavorite, applyInspirationFeedback,
    trashInspiration, restoreInspiration, permanentlyDeleteInspiration,
    logAction,
  })) {
    return true;
  }
  if (await require('./lib/routes/trackers').tryRoute(req, res, url, {
    listTrackers, saveTracker, syncTracker, listTrackerWorks,
    diagnoseAndStoreTracker, listAccountSnapshots, getLocalData,
  })) {
    return true;
  }

  // ==========知识库 KB ==========
  if (await require('./lib/routes/kb').tryRoute(req, res, url, {
    callLlmJson, getHotTrends, hotListPayload,
    getKbEntryFromCache, setKbEntryToCache,
    invalidateKbListCache, invalidateKbEntryCache,
    getKbEntriesFromCache, setKbEntriesToCache,
    getLocalData, setLocalData,
  })) {
    return true;
  }

  if (await require('./lib/routes/wersss').tryRoute(req, res, url, {
    getWersssConfigRow, getWersssConfig, getValidWersssToken,
    getWersssAuthStatus, syncWersssArticles, prefetchWersssContent,
  })) {
    return true;
  }

  if (await require('./lib/routes/accounts').tryRoute(req, res, url, {
    listMyAccounts, saveMyAccount, getMyAccount,
    extractAccountTracks, extractAccountStyleProfile, generatePresetInspirations,
    suggestInspirationConfigs, createInspirationConfigFromSuggestion,
  })) {
    return true;
  }

  // ========== CRON ==========
  if (await require('./lib/routes/crons').tryRoute(req, res, url, {
    listCronJobs, saveCronJob, deleteCronJob, runCronJob, isInspirationCronId,
  })) {
    return true;
  }

  return false;
}

function serveStatic(res, pathname) {
  serveStaticFromLib(__dirname, res, pathname);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  try {
    const publicApi = url.pathname === '/api/_/login' || url.pathname === '/api/_/status' || url.pathname === '/api/_/version';
    if (url.pathname.startsWith('/api/') && !publicApi && !isAuthorized(req)) {
      json(res, 401, { ok: false, error: '请先登录' });
      return;
    }
    if (url.pathname.startsWith('/api/_/')) {
      const handled = await handleLocalApi(req, res, url);
      if (!handled) json(res, 404, { ok: false, error: '接口不存在' });
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'POST') {
        json(res, 405, { code: 405, msg: '仅支持 POST' });
        return;
      }
      const endpoint = decodeURIComponent(url.pathname.slice('/api/'.length));
      if (!REDFOX_ENDPOINTS.has(endpoint)) {
        json(res, 403, { code: 403, msg: '该端点未加入允许列表' });
        return;
      }
      const { text, data } = await readBody(req);
      const query = url.search;
      const cacheKey = getCacheKey(endpoint, query, data);
      const cached = getCached(cacheKey, endpoint);
      if (cached) {
        logApiUsage(endpoint, cached.status_code, true);
        res.writeHead(cached.status_code, {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Cache': 'HIT',
        });
        res.end(cached.response);
        return;
      }
      const response = await redfoxRequest(endpoint, data, query);
      logApiUsage(endpoint, response.status, false);
      setCache(cacheKey, endpoint, data, response.status, response.body);
      res.writeHead(response.status, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Cache': 'MISS',
      });
      res.end(response.body);
      return;
    }

    if (!['GET', 'HEAD'].includes(req.method)) {
      json(res, 405, { ok: false, error: 'Method not allowed' });
      return;
    }
    serveStatic(res, url.pathname);
  } catch (error) {
    console.error(`${req.method} ${url.pathname}:`, error);
    json(res, 500, { ok: false, error: error.message });
  }
});

setInterval(sessionClean, 60 * 60 * 1000).unref();

// ========== CRON 调度器 ==========
const cronTimers = new Map(); // id -> timeout ref
const activeCronRuns = new Map();

function describeCronResult(taskType, result) {
  if (!result || typeof result !== 'object') return '';
  if (taskType === 'hot-realtime' || taskType === 'hot-platform') {
    const count = result.count ?? result.itemCount;
    return count != null ? `\n抓取 ${count} 条热榜数据（数据日期 ${result.dataDate || '-'}）。` : '';
  }
  if (taskType === 'hot-trend-analysis') {
    const themes = Array.isArray(result?.themes) ? result.themes : null;
    return themes ? `\n本次分析聚合 ${themes.length} 个主题关键词。` : '';
  }
  if (taskType === 'inspiration-generate') {
    const ideas = Array.isArray(result?.ideas) ? result.ideas : null;
    return `\n本次生成 ${ideas ? ideas.length : 0} 条选题。`;
  }
  if (taskType === 'daily-hot-report') {
    return `\n已向 ${result?.platformCount || 0} 个平台推送热榜日报。`;
  }
  if (taskType === 'tracker-refresh') {
    return `\n勾选 ${result.selected || 0} 个账号，同步成功 ${result.synced || 0} 个，“自己”账号诊断 ${result.diagnosed || 0} 个，失败 ${result.failed?.length || 0} 个。`;
  }
  if (taskType === 'wersss-sync') {
    const status = result.ok ? '成功' : '部分失败';
    const tokenInfo = result.tokenRefreshed ? '（token 已刷新）' : '';
    const prefetchInfo = result.prefetch ? `，预抓取正文 ${result.prefetch.done || 0}/${result.prefetch.total || 0}` : '';
    return `\nWeRss 同步${status}${tokenInfo}：订阅 ${result.synced || 0} 个，新增文章 ${result.articles || 0} 条，失败 ${result.failed || 0} 个${prefetchInfo}。`;
  }
  if (taskType === 'cache-clean' || taskType === 'usage-clean') {
    return result?.deleted != null ? `\n本次清理 ${result.deleted} 条记录。` : '';
  }
  return '';
}

async function runCronTask(taskType, taskConfig = {}) {
  if (taskType === 'hot-realtime') {
    const batch = await syncRealtimeHotspots('灵感熔炉-定时实时热点');
    return { count: batch.itemCount, dataDate: batch.dataDate };
  }
  if (taskType === 'hot-platform') {
    const platform = String(taskConfig.platform || '');
    const batch = await syncDailyPlatform(platform, dateDaysAgo(1), '灵感熔炉-定时昨日榜');
    return { platform, count: batch.itemCount, dataDate: batch.dataDate };
  }
  if (taskType === 'hot-trend-analysis') {
    return analyzeDailyHotKeywords(dateDaysAgo(1));
  }
  if (taskType === 'inspiration-generate') {
    return runInspirationConfig(String(taskConfig.configId || ''), 'cron');
  }
  if (taskType === 'cache-clean') {
    const threshold = Date.now() - 24 * 60 * 60 * 1000;
    const result = db.prepare('DELETE FROM api_cache WHERE updated_at < ?').run(threshold);
    if (result.changes) console.log(`[cron] 清理 ${result.changes} 条过期缓存`);
    try {
      const ck = db.pragma('wal_checkpoint(PASSIVE)');
      if (ck && ck.checkpointed > 0) console.log(`[cron] WAL checkpoint: ${ck.checkpointed} 页已写入主库`);
    } catch (e) {
      console.warn('[cron] WAL checkpoint 失败:', e.message);
    }
    return { deleted: result.changes };
  }
  if (taskType === 'usage-clean') {
    const result = db.prepare('DELETE FROM api_usage WHERE created_at < ?').run(Date.now() - 90 * 24 * 60 * 60 * 1000);
    console.log(`[cron] 清理 ${result.changes} 条90天前用量日志`);
    return { deleted: result.changes };
  }
  if (taskType === 'daily-hot-report') {
    return sendDailyHotReport();
  }
  if (taskType === 'tracker-refresh') {
    return refreshTrackedAccounts();
  }
  if (taskType === 'wersss-sync') {
    return runWersssSyncCron();
  }
  throw new Error(`不支持的任务类型：${taskType}`);
}

async function runCronJob(id, taskType, taskConfig = {}) {
  if (activeCronRuns.has(id)) return activeCronRuns.get(id);
  const promise = runCronTask(taskType, taskConfig);
  activeCronRuns.set(id, promise);
  try {
    return await promise;
  } finally {
    activeCronRuns.delete(id);
  }
}

function scheduleCronJob(id, cronExpr, taskType, taskConfig = {}) {
  const existing = cronTimers.get(id);
  if (existing) { clearTimeout(existing); cronTimers.delete(id); }
  if (!ENABLE_SCHEDULER) return;
  const next = nextCronTime(cronExpr);
  if (!next) return;
  const delay = next.getTime() - Date.now();
  console.log(`[cron] ${id} 下次运行: ${next.toLocaleString('zh-CN')} (${Math.round(delay / 60000)}分钟后)`);
  const timer = setTimeout(async () => {
    const cronRow = (() => {
      try {
        return db.prepare('SELECT name, notify_on_failure, notify_on_success FROM crontab WHERE id = ?').get(id);
      } catch { return null; }
    })();
    const cronName = cronRow?.name || id;
    const notifyFailure = cronRow?.notify_on_failure !== 0;
    const notifySuccess = cronRow?.notify_on_success === 1;
    try {
      const result = await runCronJob(id, taskType, taskConfig);
      db.prepare('UPDATE crontab SET last_run = ? WHERE id = ?').run(Date.now(), id);
      if (notifySuccess) {
        const summary = describeCronResult(taskType, result);
        broadcastNotification(
          `定时任务执行成功：${cronName}`,
          `任务「${cronName}」于 ${new Date().toLocaleString('zh-CN')} 执行完成。${summary}`
        ).catch(err => console.warn('[notify] cron 成功通知异常:', err.message));
      }
    } catch (error) {
      console.error(`[cron] ${id} 执行失败:`, error.message);
      if (notifyFailure) {
        broadcastNotification(
          `定时任务执行失败：${cronName}`,
          `任务「${cronName}」(${id}) 在 ${new Date().toLocaleString('zh-CN')} 执行失败：\n${error.message}`
        ).catch(err => console.warn('[notify] cron 失败通知异常:', err.message));
      }
    } finally {
      scheduleCronJob(id, cronExpr, taskType, taskConfig);
    }
  }, delay);
  cronTimers.set(id, timer);
}

function loadAllCronJobs() {
  const rows = db.prepare('SELECT id, cron_expr, enabled, task_type, task_config FROM crontab').all();
  for (const row of rows) {
    if (row.enabled) {
      scheduleCronJob(row.id, row.cron_expr, row.task_type, parseJson(row.task_config) || {});
    }
  }
}

function listCronJobs() {
  return db.prepare('SELECT id, name, cron_expr, enabled, task_type, task_config, notify_on_failure, notify_on_success, last_run, sort_order, created_at FROM crontab ORDER BY sort_order ASC, created_at ASC').all()
    .filter(row => !isInspirationCronId(row.id))
    .map(row => ({
      id: row.id, name: row.name, cronExpr: row.cron_expr, enabled: Boolean(row.enabled),
      taskType: row.task_type, taskConfig: row.task_config ? JSON.parse(row.task_config) : null,
      notifyOnFailure: row.notify_on_failure !== 0,
      notifyOnSuccess: Boolean(row.notify_on_success),
      lastRun: row.last_run, sortOrder: row.sort_order, createdAt: row.created_at,
    }));
}

async function saveCronJob(id, name, cronExpr, enabled, taskType, taskConfig, opts = {}) {
  const now = Date.now();
  const config = taskConfig ? JSON.stringify(taskConfig) : null;
  const notifyFailure = opts.notifyOnFailure === false ? 0 : 1;
  const notifySuccess = opts.notifyOnSuccess ? 1 : 0;
  const existing = db.prepare('SELECT sort_order FROM crontab WHERE id = ?').get(id);
  let sortOrder = existing ? existing.sort_order : 0;
  if (!existing) {
    const maxRow = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM crontab').get();
    sortOrder = (maxRow?.max_order || 0) + 1;
  }
  db.prepare(`INSERT INTO crontab (id, name, cron_expr, enabled, task_type, task_config, notify_on_failure, notify_on_success, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, cron_expr=excluded.cron_expr, enabled=excluded.enabled,
      task_type=excluded.task_type, task_config=excluded.task_config,
      notify_on_failure=excluded.notify_on_failure, notify_on_success=excluded.notify_on_success,
      sort_order=excluded.sort_order`
  ).run(id, name, cronExpr, enabled ?1 : 0, taskType, config, notifyFailure, notifySuccess, sortOrder, now);
  if (enabled) scheduleCronJob(id, cronExpr, taskType, taskConfig || {});
  else {
    const t = cronTimers.get(id);
    if (t) { clearTimeout(t); cronTimers.delete(id); }
  }
  return listCronJobs();
}

function deleteCronJob(id) {
  const t = cronTimers.get(id);
  if (t) { clearTimeout(t); cronTimers.delete(id); }
  db.prepare('DELETE FROM crontab WHERE id = ?').run(id);
  return listCronJobs();
}

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`灵感熔炉已启动：http://${HOST}:${PORT}`);
    console.log(`RedFox API：${API_KEY ? '已配置' : '未配置 REDFOX_API_KEY'}`);
    console.log(`LLM：${process.env.LLM_API_KEY ? `已配置 ${process.env.LLM_MODEL || ''}` : '未配置，选题生成功能不可用'}`);
    console.log('访问控制：已启用 SQLite 账号登录');
    loadAllCronJobs();
    restoreTrackerRetries();
  });
}

module.exports = {
  server,
  db,
  getHotTrends,
  normalizeSnapshotItems,
  normalizeDailyPlatformItems,
  latestAiGzhDataDate,
  normalizeHotspots,
  normalizeRealtimeHotspots,
  stableObject,
  listSkills,
  parseCronExpr,
  validateCronField,
  nextCronTime,
  matchesCronField,
  getCacheKey,
  workPublishAt,
  workContentKey,
  normalizeExternalInspirationItems,
  groupInspirationEvidence,
  selectDiverseEvidence,
  normalizeInspirationTitle,
  inspirationTitleSimilarity,
  dedupeInspirationIdeas,
  isCacheableRedfoxResponse,
  inspirationSearchTerms,
  inspirationSearchPlan,
  inspirationApiBudget,
  gitBlobSha,
  compareSkillManifests,
  communitySkillUpdateStatus,
  updateCommunitySkills,
  normalizeTrackerAccountId,
  trackerQuerySpec,
  trackerCollectionSpec,
  xhsTrackerAccounts,
  normalizeTrackerResult,
  trackerWorkId,
  parseAgentJsonLines,
  hashPassword,
  verifyPassword,
  validateUsername,
  validatePassword,
};
