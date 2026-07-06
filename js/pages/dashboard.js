import { localApi } from '../api.js';
import { LS, getSortedTrackers } from '../state.js';
import { esc, fmt, proxyImage } from '../utils.js';
import { platName } from '../config.js';
import { skeleton, rankBadge } from '../components.js';
import { initIcons } from '../icons.js';
import { adaptDY, adaptXHS, adaptGZH } from '../core/adapters.js';

export async function renderDashboard() {
  const view = Object.fromEntries([
    'dash-dy', 'dash-xhs', 'dash-gzh', 'dash-dy-status', 'dash-xhs-status',
    'dash-gzh-status', 'stat-hot', 'stat-track', 'stat-track-sub',
  ].map(id => [id, document.getElementById(id)]));
  if (!view['dash-dy']) return;
  ['dash-dy','dash-xhs','dash-gzh'].forEach(id => { if (view[id]) view[id].innerHTML = skeleton(5); });
  if (view['dash-dy-status']) view['dash-dy-status'].textContent = '加载中…';
  if (view['dash-xhs-status']) view['dash-xhs-status'].textContent = '加载中…';
  if (view['dash-gzh-status']) view['dash-gzh-status'].textContent = '加载中…';

  try {
    const [dyResult, xhsResult, gzhResult, kwResult] = await Promise.all([
      localApi('hot/list?platform=dy'),
      localApi('hot/list?platform=xhs'),
      localApi('hot/list?platform=gzh'),
      localApi('hot/keywords'),
    ]);
    if (!view['dash-dy'] || !view['dash-dy'].isConnected) return;

    const fill = (containerId, statusId, result, adapt, emoji) => {
      const c = view[containerId];
      const s = view[statusId];
      if (!c) return;
      const items = Array.isArray(result?.data) ? result.data : [];
      if (items.length) {
        const list = items.slice(0, 5).map(item => adapt(item.raw));
        list.forEach((it, i) => it._rank = i + 1);
        c.innerHTML = list.map(it => `
          <a class="flex items-center gap-2.5 hover:bg-white/[0.03] -mx-2 px-2 py-1.5 rounded cursor-pointer" data-action="showDetail" data-plat="${esc(it.plat)}" data-work-id="${esc(it.workId)}">
            ${rankBadge(it._rank)}
            <div class="flex-1 min-w-0 text-xs">
              <div class="truncate font-medium">${esc(it.title)}</div>
              <div class="text-gray-500 mt-0.5">${emoji} ${esc(it.like || it.read)} · ${esc(it.author || '')}</div>
            </div>
          </a>`).join('');
        if (s) s.innerHTML = `${list.length} 条 · ${esc(result.sourceLabel || '本地缓存数据')}`;
      } else {
        c.innerHTML = '<div class="text-xs text-gray-500 py-4 text-center">暂无数据</div>';
        if (s) s.textContent = '无数据';
      }
    };

    fill('dash-dy', 'dash-dy-status', dyResult, adaptDY, '🔥');
    fill('dash-xhs', 'dash-xhs-status', xhsResult, adaptXHS, '❤️');
    fill('dash-gzh', 'dash-gzh-status', gzhResult, adaptGZH, '👁');

    if (view['stat-hot']) view['stat-hot'].textContent = kwResult?.data?.length || '—';

    const trackers = getSortedTrackers();
    if (view['stat-track']) view['stat-track'].textContent = trackers.length;
    if (view['stat-track-sub']) view['stat-track-sub'].textContent = trackers.length ? '点击查看' : '点击添加';
    renderFeedAndHistory();

    initIcons(document.getElementById('content-area'));
  } catch (e) {
    if (view['dash-dy']?.isConnected) {
      ['dash-dy','dash-xhs','dash-gzh'].forEach(id => {
        if (view[id]) view[id].innerHTML = `<div class="text-xs text-red-400 py-4 text-center">${esc(e.message || '加载失败')}</div>`;
      });
    }
  }
}

export async function renderFeedAndHistory() {
  const trackers = getSortedTrackers();
  const feedEl = document.getElementById('dash-feed');
  const hisEl = document.getElementById('dash-history');
  const searchStat = document.getElementById('stat-search');
  if (!feedEl || !hisEl || !searchStat) return;
  if (trackers.length === 0) {
    feedEl.innerHTML = `<div class="text-center py-8 text-sm text-gray-500">
      <i data-lucide="users" class="w-8 h-8 mx-auto mb-2 opacity-30"></i>
      <div>还没有关注账号</div>
      <button class="btn btn-primary mt-3 py-1.5 text-xs" data-action="openAddAccountModal">添加账号</button>
    </div>`;
  } else {
    const top = trackers.slice(0, 4);
    // 先渲染账号卡片骨架，作品位置占位（用 index 而非 tracker.id 做 hook，避免特殊字符）
    feedEl.innerHTML = top.map((t, i) => renderFeedAccountShell(t, i)).join('');
    initIcons(feedEl);
    // 并发拉每个账号最近 3 篇作品
    top.forEach(async (t, i) => {
      const host = feedEl.querySelector(`[data-feed-idx="${i}"]`);
      if (!host) return;
      try {
        const works = await localApi(`trackers/${encodeURIComponent(t.id)}/works`);
        if (!host.isConnected) return;
        host.innerHTML = renderFeedWorks(t, Array.isArray(works) ? works.slice(0, 3) : []);
        initIcons(host);
      } catch (e) {
        host.innerHTML = `<div class="text-[11px] text-gray-500 pl-9 py-1.5 flex items-center gap-1"><i data-lucide="alert-circle" class="w-3 h-3"></i>加载失败</div>`;
        initIcons(host);
      }
    });
  }

  // 搜索历史
  const history = LS.get('searchHistory', []);
  if (history.length === 0) {
    hisEl.innerHTML = '<div class="text-xs text-gray-500 text-center py-4">还没有搜索记录</div>';
  } else {
    hisEl.innerHTML = history.slice(0, 6).map(h => `
      <a class="flex items-center gap-2.5 p-2 -mx-2 rounded hover:bg-white/[0.03] cursor-pointer" data-action="doSearchWith" data-kw="${esc(h.kw)}">
        <i data-lucide="search" class="w-3.5 h-3.5 text-gray-500"></i>
        <div class="flex-1 min-w-0">
          <div class="text-sm truncate">${esc(h.kw)}</div>
          <div class="text-[10px] text-gray-500">${esc(h.at)} · ${esc(h.plats.join('/'))}</div>
        </div>
        <i data-lucide="arrow-up-right" class="w-3 h-3 text-gray-600"></i>
      </a>`).join('');
  }
  searchStat.textContent = history.length;
}

function renderFeedAccountShell(t, idx) {
  const avatar = proxyImage(t.gzhAvatar || t.avatar);
  const fans = t.authorFans || t.followerCount;
  const redfoxIdx = t.gzhRedfoxIndex || t.redfoxIndex;
  return `
    <div class="p-3 bg-white/[0.02] rounded-lg">
      <div class="flex items-center gap-3">
        <div class="account-avatar" style="width:40px;height:40px;font-size:13px;">${esc((t.name||'?')[0])}${avatar ? `<img src="${avatar}" alt="" data-image-error="remove" />` : ''}</div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-0.5">
            <span class="font-medium text-sm truncate">${esc(t.name)}</span>
            <span class="pill ${t.plat==='dy'?'pill-hot':t.plat==='xhs'?'pill-brand':'pill-green'} flex-shrink-0">${platName(t.plat)}</span>
            ${redfoxIdx ? `<span class="pill pill-amber flex-shrink-0" title="红狐指数">红狐 ${parseFloat(redfoxIdx).toFixed(0)}</span>` : ''}
            ${fans ? `<span class="pill pill-gray flex-shrink-0" title="粉丝数">👥 ${fmt(fans)}</span>` : ''}
          </div>
          <div class="text-[11px] text-gray-500 truncate">${esc(t.gzhVerify || t.gzhDescription || t.id)} · ${esc(t.group || '其他')}</div>
        </div>
        <button class="btn btn-ghost text-xs py-1 flex-shrink-0" data-action="removeTracker" data-id="${esc(t.id)}">移除</button>
      </div>
      <div data-feed-idx="${idx}" class="mt-2 pl-9 space-y-0.5">
        <div class="text-[10px] text-gray-600 py-1">加载作品中…</div>
      </div>
    </div>`;
}

function renderFeedWorks(t, works) {
  if (!works.length) {
    return `
      <div class="text-[11px] text-gray-500 pl-0 py-1.5 flex items-center gap-1.5">
        <i data-lucide="inbox" class="w-3 h-3"></i>
        <span>暂无作品（在账号追踪页点「查看作品」同步）</span>
      </div>`;
  }
  return works.map(w => {
    const item = t.plat === 'dy' ? adaptDY(w) : t.plat === 'xhs' ? adaptXHS(w) : adaptGZH(w);
    const heat = item.read || item.like || (w.diggCount || w.likeCount || 0);
    const heatStr = heat ? fmt(heat) : '--';
    return `
      <a class="flex items-center gap-2 py-1 text-[11px] rounded hover:bg-white/[0.04] cursor-pointer group" data-action="showDetail" data-plat="${esc(item.plat)}" data-work-id="${esc(item.workId)}">
        <i data-lucide="${t.plat==='dy'?'video':t.plat==='xhs'?'image':'file-text'}" class="w-3 h-3 text-gray-500 flex-shrink-0"></i>
        <span class="flex-1 truncate text-gray-300 group-hover:text-white">${esc(item.title || '(无标题)')}</span>
        <span class="text-emerald-400/80 flex-shrink-0">${heatStr}</span>
      </a>`;
  }).join('');
}
