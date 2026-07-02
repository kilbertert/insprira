// 热榜系统：实时热点 + 平台日榜 + 关键词趋势分析 + 日报推送
// make(deps) 工厂注入 callLlmJson / broadcastNotification
const crypto = require('crypto');
const { db } = require('./db');
const { parseJson, toNumber, localDate, dateDaysAgo, dateFromYmd } = require('./utils');
const { AI_FEED_PLATFORMS, redfoxData, redfoxGetData } = require('./redfox');
const { normalizeSnapshotItems, normalizeRealtimeHotspots } = require('./normalize');

function localDateTime(date = new Date()) {
  return `${localDate(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
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

function hotBatchId(platform, dataDate, startedAt) {
  return `${platform}-${dataDate}-${startedAt}-${crypto.randomBytes(4).toString('hex')}`;
}

function saveHotBatch({
  platform, dataDate, snapshotKind, endpoint, request, response = null,
  items = [], status, error = null, startedAt, completedAt: providedCompletedAt = null,
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
      batchId, platform, dataDate, snapshotKind, endpoint,
      JSON.stringify(request || {}),
      response == null ? null : JSON.stringify(response),
      status, items.length, startedAt, completedAt, error,
    );
    const insertItem = db.prepare(`
      INSERT INTO hot_batch_items
        (batch_id, rank, item_key, title, score, raw_data)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    items.forEach((item, index) => {
      insertItem.run(
        batchId, index + 1,
        String(item.key || `${index + 1}`),
        String(item.title || '(无标题)'),
        Number(item.score) || 0,
        JSON.stringify(item.raw || {}),
      );
    });
    db.prepare("DELETE FROM local_data WHERE module = 'hot' AND data_key LIKE 'trends:%'").run();
  })();
  return {
    id: batchId, platform, dataDate, status,
    itemCount: items.length, completedAt, error,
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
      platform: 'ai-gzh', dataDate: actualDate, snapshotKind: 'daily',
      endpoint: attempt.endpoint,
      request: parseJson(attempt.request_json) || {},
      response, items, status: 'success',
      startedAt: attempt.started_at, completedAt: attempt.completed_at,
    });
  }
}

function make(deps) {
  const { callLlmJson, broadcastNotification } = deps;
  const activePlatformSyncs = new Map();
  let activeRealtimeHotspots = null;

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
              platform, dataDate: actualDate, snapshotKind: 'daily',
              endpoint, request, response, items: fallbackItems,
              status: 'success', startedAt,
            });
            saveHotBatch({
              platform, dataDate, snapshotKind: 'daily',
              endpoint, request, response, items: [],
              status: 'empty',
              error: `${dataDate} 暂无榜单数据；API 最新返回 ${actualDate}`,
              startedAt,
            });
            return fallbackBatch;
          }
        }
        const status = items.length ? 'success' : 'empty';
        const batch = saveHotBatch({
          platform, dataDate, snapshotKind: 'daily',
          endpoint, request, response, items, status,
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
            platform, dataDate, snapshotKind: 'daily',
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

  function trendKeys(keyword) {
    return [...new Set([keyword.name, ...(keyword.aliases || [])].map(normalizeTrendKey).filter(Boolean))];
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
      dataDate, keywords,
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
          platform: 'all', dataDate: today, snapshotKind: 'realtime',
          endpoint, request, response: data, items, status,
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
            platform: 'all', dataDate: today, snapshotKind: 'realtime',
            endpoint, request, status: 'failed', error: error.message, startedAt,
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

  return {
    syncDailyPlatform,
    captureHotSnapshot,
    analyzeDailyHotKeywords,
    getHotTrends,
    analyzeHotTrendsLlm,
    buildDailyHotReport,
    sendDailyHotReport,
    syncRealtimeHotspots,
  };
}

module.exports = {
  HOT_SOURCE_CONFIG,
  hotBatchId,
  saveHotBatch,
  latestHotBatch,
  platformCronId,
  hotListPayload,
  normalizeDailyPlatformItems,
  latestAiGzhDataDate,
  recoverAiGzhFallbackBatches,
  localDateTime,
  make,
};
