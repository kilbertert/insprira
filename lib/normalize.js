// 纯 normalize 函数：把各平台原始数据转成统一结构
// 依赖：lib/utils（toNumber / localDate）、lib/redfox（AI_FEED_PLATFORMS）、crypto
const crypto = require('crypto');
const { toNumber, localDate } = require('./utils');
const { AI_FEED_PLATFORMS } = require('./redfox');

const HOTSPOT_LISTS = {
  bdList: ['bd', '百度'],
  bzList: ['bz', 'B站'],
  dyList: ['dy', '抖音'],
  ksList: ['ks', '快手'],
  ttList: ['tt', '头条'],
  wbList: ['wb', '微博'],
  zhList: ['zh', '知乎'],
};

function normalizeSnapshotItems(platform, data) {
  if (platform === 'all') {
    return (Array.isArray(data) ? data : []).map(item => ({
      key: item.keyword,
      title: item.keyword,
      score: Array.isArray(item.plats) ? item.plats.length : 0,
      raw: item,
    }));
  }
  if (AI_FEED_PLATFORMS.includes(platform)) {
    const list = Array.isArray(data) ? data : data?.list || [];
    return list.map(item => ({
      key: String(item.photoId || item.id || item.title),
      title: item.title || '(无标题)',
      score: platform === 'ai-gzh' || platform === 'playlet-gzh'
        ? toNumber(item.readCount) || 0
        : (toNumber(item.likeCount) || 0)
          + (toNumber(item.shareCount) || 0)
          + (toNumber(item.commentCount) || 0),
      raw: item,
    }));
  }
  const list = Array.isArray(data) ? data : data?.list || data?.articles || [];
  return list.map(item => {
    if (platform === 'dy') {
      return {
        key: String(item.workId || item.id || item.title),
        title: item.title || item.content || '(无标题)',
        score: toNumber(item.likeCount) || 0,
        raw: item,
      };
    }
    if (platform === 'xhs') {
      return {
        key: String(item.workId || item.id || item.workTitle || item.title),
        title: item.workTitle || item.title || item.workDesc || item.desc || '(无标题)',
        score: toNumber(item.workLikedCount ?? item.likedCount ?? item.interactiveCount) || 0,
        raw: item,
      };
    }
    return {
      key: String(item.workUuid || item.id || item.title),
      title: item.title || item.summary || '(无标题)',
      score: toNumber(item.readCount ?? item.clicksCount) || 0,
      raw: item,
    };
  });
}

function normalizeHotspots(data) {
  const items = [];
  for (const [key, [platform, platformName]] of Object.entries(HOTSPOT_LISTS)) {
    for (const item of data?.[key] || []) {
      const title = String(item.title || '').trim();
      if (!title) continue;
      items.push({
        id: crypto.createHash('sha1').update(`${platform}:${title}`).digest('hex').slice(0, 16),
        title,
        platform,
        platformName,
        hotCount: String(item.hotCount || '0'),
        rank: Number(item.index) || 0,
        createdAt: item.gmtCreate || '',
        url: item.url || '',
      });
    }
  }
  const hotNumber = value => Number(String(value || '').replace(/[^\d.]/g, '')) || 0;
  return items.sort((a, b) => hotNumber(b.hotCount) - hotNumber(a.hotCount) || a.rank - b.rank);
}

function normalizeRealtimeHotspots(data, snapshotDate = localDate()) {
  const groups = new Map();
  for (const item of normalizeHotspots(data)) {
    if (item.createdAt && !String(item.createdAt).startsWith(snapshotDate)) continue;
    const canonical = item.title.toLowerCase().replace(/[\s·,，。！？!?：:、"'""''（）()【】[\]-]/g, '');
    const key = canonical || `${item.platform}:${item.title}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        title: item.title,
        score: 0,
        bestRank: item.rank || 50,
        platforms: new Set(),
        sources: [],
        latestAt: '',
      });
    }
    const group = groups.get(key);
    group.platforms.add(item.platformName);
    group.score += Math.max(1, 51 - (item.rank || 50));
    group.bestRank = Math.min(group.bestRank, item.rank || 50);
    if (item.createdAt > group.latestAt) group.latestAt = item.createdAt;
    group.sources.push(item);
  }
  return Array.from(groups.values())
    .sort((a, b) =>
      b.platforms.size - a.platforms.size
      || b.score - a.score
      || a.bestRank - b.bestRank
      || b.latestAt.localeCompare(a.latestAt)
    )
    .slice(0, 20)
    .map(group => ({
      key: group.key,
      title: group.title,
      score: group.score,
      raw: {
        realtime: true,
        plats: Array.from(group.platforms),
        bestRank: group.bestRank,
        latestAt: group.latestAt,
        sources: group.sources,
      },
    }));
}

module.exports = {
  HOTSPOT_LISTS,
  normalizeSnapshotItems,
  normalizeHotspots,
  normalizeRealtimeHotspots,
};
