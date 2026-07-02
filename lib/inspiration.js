// 灵感选题系统：配置 + 关键词搜索 + 证据聚合 + LLM 生成 + 反馈学习
// make(deps) 工厂注入业务依赖，避免循环
const crypto = require('crypto');
const { db } = require('./db');
const { parseJson, toNumber, localDate, dateDaysAgo } = require('./utils');
const { clamp, logAction } = require('./observability');
const { redfoxData, redfoxGetData } = require('./redfox');
const { parseLlmJson } = require('./llm');

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

function normalizeTerms(values) {
  return [...new Set((Array.isArray(values) ? values : String(values || '').split(/[,，、\n]/))
    .map(value => String(value).trim())
    .filter(Boolean))];
}

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

function make(deps) {
  const {
    HOT_SOURCE_CONFIG, hotListPayload, getHotTrends, saveHotBatch,
    callLlm, broadcastNotification, saveCronJob, deleteCronJob,
  } = deps;

  const activeInspirationRuns = new Set();

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
      return terms.map(term => ({ mode, query: term, terms: [term] }));
    }
    return [{ mode, query: terms.join(','), terms }];
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
            request, response: data,
            items: normalizeKeywordSearchItems(data),
            status: 'success', startedAt,
          });
        } catch (error) {
          source = 'api-failed';
          saveHotBatch({
            platform: keywordSearchPlatform(search.query),
            dataDate: endDate,
            snapshotKind: 'inspiration-search',
            endpoint: 'gzh/search/hotArticle',
            request, status: 'failed',
            error: error.message, startedAt,
          });
          searched.push({
            keyword: search.query, keywords: search.terms, mode: search.mode,
            days: 14, count: 0, source, error: error.message, relatedSearches: [],
          });
          continue;
        }
      }
      if (!data) {
        searched.push({
          keyword: search.query, keywords: search.terms, mode: search.mode,
          days: 14, count: 0, source: 'skipped-budget', relatedSearches: [],
        });
        continue;
      }
      searched.push({
        keyword: search.query, keywords: search.terms, mode: search.mode,
        days: 14, count: (data?.articles || []).length,
        source, dataDate: cached?.dataDate || endDate,
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

  function saveInspirationConfig(input, existingId = null) {
    const id = existingId || crypto.randomUUID();
    const name = String(input.name || '').trim();
    const cronExpr = String(input.cronExpr || '0 9 * * *').trim();
    if (!name) throw new Error('配置名称不能为空');
    const { parseCronExpr } = require('./cron-parser');
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

  function deleteInspirationConfig(id) {
    const result = db.prepare('DELETE FROM inspiration_keyword_configs WHERE id = ?').run(id);
    deleteCronJob(inspirationCronId(id));
    return result.changes > 0;
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

  const { normalizeTrendKey } = require('./hot');

  function evidenceIdentity(item) {
    return normalizeTrendKey(item.title).slice(0, 80);
  }

  async function syncExternalInspirationSources(config, maxApiCalls = config.dailyApiBudget, onApiCall = null) {
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
          platform: definition.platform, dataDate,
          snapshotKind: 'inspiration-source',
          endpoint: definition.endpoint, request, response: data,
          items, status: 'success', startedAt,
        });
      } catch (error) {
        saveHotBatch({
          platform: definition.platform, dataDate,
          snapshotKind: 'inspiration-source',
          endpoint: definition.endpoint, request,
          status: 'failed', error: error.message, startedAt,
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
          sourceType: source, platform, articleKey: row.item_key,
          title: row.title,
          author: raw.author || raw.userName || raw.accountName || raw.sourceUsernickname || '',
          url: raw.url || raw.oriUrl || raw.workUrl || raw.photoJumpUrl || '',
          readCount: toNumber(raw.readCount ?? raw.clicksCount ?? raw.likeCount ?? raw.useLikeCount ?? raw.interactiveCount) || 0,
          publishTime: raw.publishTime || raw.publicTime || raw.gmtCreate || row.data_date,
          dataDate: row.data_date, rank: row.rank,
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
          sourceType: 'tracked', platform: row.plat, articleKey: row.work_id,
          title, author: row.name,
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
          sourceType: 'wersss', platform: 'wersss', articleKey: row.id,
          title, author: row.mp_name || row.mp_alias || '',
          url: row.url || '', readCount: 0,
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
        id: null, domain,
        sources: adHocSources.filter(source => getInspirationSourceKeys().has(source)),
        terms: keywords.map(term => ({ term, type: 'core', weight: 0 })),
        dailyApiBudget: 3, evidenceLimit: 20, searchMode: 'combined', sourceWeights: {},
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
        sourceType: 'gzh-search', platform: 'gzh',
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
        : `账号赛道：${domain || '未指定'}\n关键词：${keywords.join('、')}\n\n近期已有选题，禁止重复或近义改写：\n${historyText}\n\n生成 ${count} 个彼此不重复、可执行的常青型或方法型选题。每条摘要必须明确写出"无热点证据，本选题为模型推理"，并说明推理角度。不要使用"突然爆发""最近大火""接下来几天会怎样"等暗示实时趋势的表达。`;
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
          { role: 'system', content: '你是 JSON 修复器。只修复语法并输出合法 JSON，不改变字段含义，不输出 Markdown。' },
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
        sourceMode, generationNote,
        generatedBy: process.env.LLM_MODEL || 'LLM',
        createdAt: Date.now(),
      };
      insert.run(
        record.id, record.title, record.summary, record.angle,
        record.targetPlatform, JSON.stringify(record.sourceKeywords),
        JSON.stringify(record.sourceItems),
        record.configId, record.runId, record.generationType,
        record.sourceMode, record.generationNote, record.generatedBy,
        record.createdAt,
      );
      return record;
    });
    return {
      ideas: created,
      generatedBy: process.env.LLM_MODEL || 'LLM',
      sourceMode, generationNote,
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
      id: row.id, title: row.title, summary: row.summary, angle: row.angle,
      targetPlatform: row.target_platform,
      sourceKeywords: parseJson(row.source_keywords) || [],
      sourceItems: parseJson(row.source_items) || [],
      kbLink: parseJson(row.kb_link) || null,
      status: row.status, isFavorite: Boolean(row.is_favorite),
      feedbackState: row.feedback_state || '',
      configId: row.config_id || null, runId: row.run_id || null,
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
        config, budget.remaining, recordApiCall,
      );
      const localEvidence = selectDiverseEvidence(
        groupInspirationEvidence(collectLocalInspirationEvidence(config)),
        config.evidenceLimit,
      );
      const fingerprint = crypto.createHash('sha1').update(JSON.stringify({
        config: {
          id: config.id, domain: config.domain, sources: config.sources,
          sourceWeights: config.sourceWeights, ideaCount: config.ideaCount,
          evidenceLimit: config.evidenceLimit, searchMode: config.searchMode,
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
        configId, count: config.ideaCount, runId, triggerType,
        externalSourcesSynced: true, externalApiCalls,
        usedApiCalls: budget.used, onApiCall: recordApiCall,
      });
      const completedAt = Date.now();
      db.prepare(`
        UPDATE inspiration_runs
        SET status = ?, idea_count = ?, api_calls = ?, completed_at = ?
        WHERE id = ?
      `).run(
        result.ideas.length ? 'success' : 'empty',
        result.ideas.length, runApiCalls, completedAt, runId,
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
        configId, configName: config.name,
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
      id: row.id, configId: row.config_id, triggerType: row.trigger_type,
      status: row.status, ideaCount: row.idea_count, apiCalls: row.api_calls,
      startedAt: row.started_at, completedAt: row.completed_at, error: row.error,
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

  return {
    getInspirationSourceMeta, getInspirationSourceKeys,
    listInspirationConfigs, getInspirationConfig, saveInspirationConfig,
    deleteInspirationConfig, isInspirationCronId, inspirationCronId,
    syncInspirationConfigCron, generateInspirations,
    listInspirations, trashInspiration, restoreInspiration,
    permanentlyDeleteInspiration, runInspirationConfig,
    listInspirationRuns, setInspirationFavorite, applyInspirationFeedback,
    getConfiguredHotPlatforms, getDynamicInspirationSources,
    DEFAULT_INSPIRATION_SOURCES,
  };
}

module.exports = { make, normalizeTerms, normalizeExternalInspirationItems };
