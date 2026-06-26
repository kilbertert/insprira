import { api, localApi } from '../api.js';
import { LS, currentPage, getSortedTrackers, setTrackerOrder } from '../state.js';
import { esc, fmt, proxyImage, copyToClipboard, renderMarkdown, genUUID } from '../utils.js';
import { platName } from '../config.js';
import { toast } from '../components.js';
import { initIcons } from '../icons.js';
import { adaptDY, adaptXHS, adaptGZH } from '../core/adapters.js';
import { renderFeedAndHistory } from './dashboard.js';

let currentGroup = 'all';
let sortMode = false;

export function toggleTrackerSortMode() {
  sortMode = !sortMode;
  renderTracker();
}

// HTML5 原生拖拽排序
let dragSrcId = null;
export function bindTrackerDrag() {
  const listEl = document.getElementById('tracker-list');
  if (!listEl || listEl.dataset.dragBound) return;
  listEl.dataset.dragBound = '1';
  listEl.addEventListener('dragstart', (e) => {
    const card = e.target.closest('[data-drag-id]');
    if (!card) return;
    dragSrcId = card.dataset.dragId;
    card.classList.add('tracker-dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dragSrcId); } catch {}
  });
  listEl.addEventListener('dragend', (e) => {
    const card = e.target.closest('[data-drag-id]');
    if (card) card.classList.remove('tracker-dragging');
    listEl.querySelectorAll('.tracker-drop-target').forEach(el => el.classList.remove('tracker-drop-target'));
    dragSrcId = null;
  });
  listEl.addEventListener('dragover', (e) => {
    if (!dragSrcId) return;
    const card = e.target.closest('[data-drag-id]');
    if (!card || card.dataset.dragId === dragSrcId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    listEl.querySelectorAll('.tracker-drop-target').forEach(el => el.classList.remove('tracker-drop-target'));
    card.classList.add('tracker-drop-target');
  });
  listEl.addEventListener('dragleave', (e) => {
    const card = e.target.closest('[data-drag-id]');
    if (card) card.classList.remove('tracker-drop-target');
  });
  listEl.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!dragSrcId) return;
    const target = e.target.closest('[data-drag-id]');
    if (!target || target.dataset.dragId === dragSrcId) return;
    const ids = getSortedTrackers().map(t => String(t.id));
    const from = ids.indexOf(dragSrcId);
    const to = ids.indexOf(target.dataset.dragId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, dragSrcId);
    setTrackerOrder(ids);
    renderTracker();
  });
}

export async function syncTrackersFromServer() {
  try {
    const remote = await localApi('trackers');
    const local = LS.get('trackers', []);
    if (remote.length) {
      LS.set('trackers', remote);
    } else if (local.length) {
      await Promise.all(local.map(tracker => localApi('trackers', { method: 'POST', body: tracker })));
    }
    return remote.length ? remote : local;
  } catch (e) {
    console.warn('账号列表同步失败：', e.message);
    return LS.get('trackers', []);
  }
}

export function renderTracker() {
  const trackers = getSortedTrackers();
  const counts = { all: trackers.length, 自己: 0, 竞品: 0, 灵感来源: 0, 同赛道: 0, other: 0 };
  trackers.forEach(t => {
    if (counts[t.group] != null) counts[t.group]++;
    else counts.other++;
  });
  Object.entries(counts).forEach(([k, v]) => {
    const el = document.getElementById('g-' + (k === 'all' ? 'all' : k === '自己' ? 'self' : k === '竞品' ? 'jingpin' : k === '灵感来源' ? 'linggan' : k === '同赛道' ? 'tongsaid' : 'other'));
    if (el) el.textContent = v;
  });
  document.getElementById('tracker-sub').textContent = `${trackers.length} 个关注账号 · ${currentGroup === 'all' ? '全部' : currentGroup}`;
  document.getElementById('nav-tracker-count').textContent = trackers.length;

  const knownGroups = new Set(['自己', '竞品', '灵感来源', '同赛道']);
  const filtered = currentGroup === 'all'
    ? trackers
    : currentGroup === 'other'
      ? trackers.filter(t => !knownGroups.has(t.group))
      : trackers.filter(t => t.group === currentGroup);
  const listEl = document.getElementById('tracker-list');
  const emptyEl = document.getElementById('tracker-empty');

  if (filtered.length === 0) {
    listEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
  } else {
    emptyEl.classList.add('hidden');
    listEl.innerHTML = filtered.map((t, idx) => {
      const isGzh = t.plat === 'gzh' && t.gzhAccount;
      const avatarSrc = t.gzhAvatar || t.avatar;
      const avatar = proxyImage(avatarSrc);
      const missingPlatformId = ['dy', 'xhs'].includes(t.plat) && !t.accountId;
      const collectionPending = t.plat === 'xhs' && ['pending', 'waiting'].includes(t.syncStatus);
      const extra = isGzh ? `
        <div class="text-[11px] text-gray-400 line-clamp-2 mb-2">${esc(t.gzhDescription || '')}</div>
        <div class="flex items-center gap-1.5 flex-wrap mb-2">
          ${t.gzhVerify ? `<span class="pill pill-green">✓ ${esc(t.gzhVerify.replace('微信认证：',''))}</span>` : ''}
          ${t.gzhRedfoxIndex ? `<span class="pill pill-amber">红狐 ${parseFloat(t.gzhRedfoxIndex).toFixed(0)}</span>` : ''}
          ${t.gzhAccountType ? `<span class="tag">${esc(t.gzhAccountType)}</span>` : ''}
        </div>` : '';
      return `
      <div class="glass rounded-xl p-4 card ${sortMode ? 'tracker-draggable' : ''}" style="cursor:${sortMode ? 'grab' : 'default'}" ${sortMode ? `draggable="true" data-drag-id="${esc(t.id)}" data-drag-idx="${idx}"` : ''}>
        <div class="flex items-start gap-3 mb-3">
          ${sortMode ? '<i data-lucide="grip-vertical" class="w-4 h-4 text-gray-500 flex-shrink-0 mt-1"></i>' : ''}
          <div class="account-avatar">${esc((t.name || '?')[0])}${avatar ? `<img src="${avatar}" alt="" referrerpolicy="no-referrer" data-image-error="remove" />` : ''}</div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <span class="font-semibold text-sm truncate">${esc(t.name)}</span>
              <span class="pill ${t.plat==='dy'?'pill-hot':t.plat==='xhs'?'pill-brand':'pill-green'}">${platName(t.plat)}</span>
            </div>
            <div class="text-[11px] text-gray-500">${esc(t.gzhAccount || t.accountId || (missingPlatformId ? '缺少平台账号 ID' : t.id))}</div>
          </div>
        </div>
        ${extra}
        <div class="flex items-center gap-1.5 mb-2 flex-wrap">
          <span class="tag">📁 ${esc(t.group || '其他')}</span>
          ${t.authorFans != null && t.authorFans !== '' && t.authorFans !== '--' && !String(t.authorFans).startsWith('红狐指数') ? `<span class="tag">粉丝 ${fmt(t.authorFans)}</span>` : ''}
          ${t.redfoxIndex != null || t.gzhRedfoxIndex != null ? `<span class="tag">红狐 ${Number(t.redfoxIndex ?? t.gzhRedfoxIndex).toFixed(0)}</span>` : ''}
          ${t.autoSync ? '<span class="pill pill-sky">07:00 自动更新</span>' : ''}
          <span class="tag">+${esc(t.addedAt || '—')}</span>
          ${missingPlatformId ? `<span class="pill pill-hot">${t.plat === 'dy' ? '需补充抖音号' : '需补充小红书号'}</span>` : ''}
          ${collectionPending ? `<span class="pill pill-amber">${t.syncStatus === 'pending' ? 'RedFox 采集中' : '等待数据入库'}</span>` : ''}
        </div>
        ${collectionPending ? `<div class="text-[10px] text-amber-300/80 mb-2">${esc(t.syncMessage || 'RedFox 正在采集账号数据')}${t.syncRetryAt ? ` · 预计 ${new Date(t.syncRetryAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 回查` : ''}</div>` : ''}
        ${sortMode ? '' : `
        <div class="flex gap-1 mt-2">
          ${t.plat === 'gzh' ? `<button class="btn btn-primary flex-1 justify-center text-[11px] py-1" data-action="viewTracker" data-id="${t.id}"><i data-lucide="file-text" class="w-3 h-3"></i>查看作品</button>`
            : `<button class="btn btn-ghost flex-1 justify-center text-[11px] py-1" data-action="viewTracker" data-id="${t.id}"><i data-lucide="eye" class="w-3 h-3"></i>查看</button>`}
          <button class="btn btn-ghost flex-1 justify-center text-[11px] py-1" data-action="diagnoseTracker" data-id="${t.id}"><i data-lucide="activity" class="w-3 h-3"></i>评分详情</button>
          <button class="btn btn-ghost text-[11px] py-1" data-action="viewTrackerTrend" data-id="${t.id}" title="账号趋势"><i data-lucide="line-chart" class="w-3 h-3"></i></button>
          <button class="btn btn-ghost text-[11px] py-1" data-action="editTracker" data-id="${t.id}" title="编辑账号"><i data-lucide="pencil" class="w-3 h-3"></i></button>
          <button class="btn btn-ghost text-[11px] py-1" data-action="removeTracker" data-id="${t.id}" title="移除"><i data-lucide="trash-2" class="w-3 h-3"></i></button>
        </div>`}
      </div>`;
    }).join('');
  }
  initIcons(document.getElementById('content-area'));
  bindTrackerGroups();
  bindTrackerDrag();
  const sortBtn = document.getElementById('tracker-sort-btn');
  if (sortBtn) {
    if (sortMode) {
      sortBtn.classList.add('btn-primary');
      sortBtn.classList.remove('btn-ghost');
      sortBtn.innerHTML = '<i data-lucide="check" class="w-4 h-4"></i>完成排序';
      initIcons(sortBtn.parentElement);
    } else {
      sortBtn.classList.remove('btn-primary');
      sortBtn.classList.add('btn-ghost');
      sortBtn.innerHTML = '<i data-lucide="arrow-up-down" class="w-4 h-4"></i>排序';
      initIcons(sortBtn.parentElement);
    }
  }
}

export function bindTrackerGroups() {
  document.querySelectorAll('[data-group]').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('[data-group]').forEach(b => { b.classList.remove('active'); b.style.background = 'transparent'; b.style.color = ''; });
      btn.classList.add('active');
      btn.style.background = 'rgba(139,92,246,.15)';
      btn.style.color = '#c4b5fd';
      currentGroup = btn.dataset.group;
      renderTracker();
    };
    if (btn.classList.contains('active')) { btn.style.background = 'rgba(139,92,246,.15)'; btn.style.color = '#c4b5fd'; }
  });
}

export function openAddAccountModal(prefill = {}) {
  const editing = Boolean(prefill.editing);
  const alreadyTracked = Boolean(prefill.existing);
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  modal.innerHTML = `
    <div class="modal" data-action="stopPropagation">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold text-base">${alreadyTracked ? '账号已在追踪中' : editing ? '编辑关注账号' : '添加关注账号'}</h3>
        <button class="btn btn-ghost py-1 px-2" data-action="closeModal"><i data-lucide="x" class="w-4 h-4"></i></button>
      </div>
      ${alreadyTracked ? `<p class="text-sm text-gray-400 mb-4">"${esc(prefill.name)}" 已在你的追踪列表中</p>
        <button class="btn btn-ghost w-full justify-center" data-action="closeModal">关闭</button>`
      : `<div class="space-y-3">
        <input type="hidden" id="addTrackerId" value="${esc(editing ? prefill.id || '' : '')}" />
        <div>
          <label class="text-xs text-gray-400 mb-1.5 block">平台</label>
          <select class="input" id="addPlat" ${editing ? 'disabled' : ''}>
            <option value="dy" ${prefill.plat === 'dy' ? 'selected' : ''}>抖音</option>
            <option value="xhs" ${prefill.plat === 'xhs' ? 'selected' : ''}>小红书</option>
            <option value="gzh" ${prefill.plat === 'gzh' ? 'selected' : ''}>公众号</option>
          </select>
        </div>
        <div>
          <label class="text-xs text-gray-400 mb-1.5 block">账号名称</label>
          <input class="input" id="addName" placeholder="如：户外老炮儿" value="${esc(prefill.name || '')}" />
        </div>
        <div>
          <label class="text-xs text-gray-400 mb-1.5 block" id="addIdLabel">平台账号 ID</label>
          <input class="input" id="addId" value="${esc(prefill.accountId || (!editing ? prefill.id || '' : ''))}" />
          <p class="text-[10px] text-gray-600 mt-1" id="addIdHelp"></p>
        </div>
        <div>
          <label class="text-xs text-gray-400 mb-1.5 block">分组</label>
          <select class="input" id="addGroup">
            <option value="自己" ${prefill.group === '自己' ? 'selected' : ''}>自己</option>
            <option value="竞品" ${prefill.group === '竞品' ? 'selected' : ''}>竞品</option>
            <option value="灵感来源" ${prefill.group === '灵感来源' ? 'selected' : ''}>灵感来源</option>
            <option value="同赛道" ${prefill.group === '同赛道' ? 'selected' : ''}>同赛道作者</option>
            <option value="other" ${!prefill.group || ['其他', 'other'].includes(prefill.group) ? 'selected' : ''}>其他</option>
          </select>
        </div>
        <label class="flex items-start gap-2 text-sm cursor-pointer rounded-lg bg-white/[0.025] p-3">
          <input type="checkbox" id="addAutoSync" class="mt-0.5 accent-purple-500" ${prefill.autoSync ? 'checked' : ''} />
          <span><span class="block">每日 07:00 自动更新</span><span class="block text-[10px] text-gray-500 mt-0.5">仅勾选账号会调用 RedFox API；“自己”账号还会保存评分快照并生成趋势解读。</span></span>
        </label>
        <button class="btn btn-primary w-full justify-center py-2.5 mt-2" data-action="submitAddAccount">
          <i data-lucide="${editing ? 'save' : 'plus'}" class="w-4 h-4"></i>${editing ? '保存修改' : '添加'}
        </button>
      </div>`}
    </div>
  `;
  modal.addEventListener('click', event => {
    if (event.target === modal) modal.remove();
  });
  document.getElementById('modal-host').appendChild(modal);
  if (!alreadyTracked) {
    const platformSelect = modal.querySelector('#addPlat');
    const updateIdHelp = () => {
      const plat = platformSelect.value;
      const label = modal.querySelector('#addIdLabel');
      const input = modal.querySelector('#addId');
      const help = modal.querySelector('#addIdHelp');
      if (plat === 'dy') {
        label.textContent = '抖音号 / 账号 ID';
        input.placeholder = '必填，可粘贴抖音主页链接';
        help.textContent = '账号追踪必须使用抖音号或 uid；昵称可能重名，不能稳定订阅。';
      } else if (plat === 'xhs') {
        label.textContent = '小红书号（redId）';
        input.placeholder = '必填，可粘贴小红书个人主页链接';
        help.textContent = '请填写主页显示的小红书号，不是昵称。';
      } else {
        label.textContent = '公众号微信号';
        input.placeholder = '可选，系统会优先按名称查找';
        help.textContent = '公众号支持只填写名称；提供微信号可提高匹配精度。';
      }
    };
    platformSelect.addEventListener('change', updateIdHelp);
    updateIdHelp();
  }
  initIcons(modal);
}

export async function submitAddAccount() {
  const plat = document.getElementById('addPlat').value;
  const name = document.getElementById('addName').value.trim();
  const trackerId = document.getElementById('addTrackerId')?.value || '';
  const accountId = document.getElementById('addId').value.trim();
  const group = document.getElementById('addGroup').value;
  const autoSync = document.getElementById('addAutoSync').checked;
  if (!name) { toast('请输入账号名称', 'error'); return; }
  if (['dy', 'xhs'].includes(plat) && !accountId) {
    toast(plat === 'dy' ? '请填写抖音号或主页链接' : '请填写小红书号（redId）或主页链接', 'error');
    return;
  }
  const trackers = LS.get('trackers', []);
  if (trackers.some(t => t.id !== trackerId && t.plat === plat && (
    accountId ? t.accountId === accountId : t.name === name
  ))) {
    toast('该账号已在追踪中', 'error');
    return;
  }
  let extra = {};
  if (plat === 'gzh') {
    toast('正在拉取公众号信息…', 'info');
    try {
      const data = await api('gzhSearchUser', { keyword: name });
      if (data && data.list && data.list.length) {
        const found = data.list[0];
        extra = {
          gzhAccount: found.account,
          gzhAccountType: found.accountType,
          gzhAvatar: found.avatarUrl,
          gzhDescription: found.description,
          gzhTags: found.tags,
          gzhVerify: found.verifyInfo,
          gzhRedfoxIndex: found.redfoxIndex,
          gzhLastPublish: found.lastPublishTime,
          authorFans: found.followerCount || undefined,
        };
        toast('已找到公众号：' + found.accountName, 'success');
      } else {
        toast('未找到该公众号，请检查名称', 'error');
      }
    } catch (e) {
      toast(e.message || '拉取公众号信息失败', 'error');
    }
  }
  const existing = trackers.find(item => item.id === trackerId);
  const tracker = {
    ...existing,
    plat,
    name,
    id: trackerId || genUUID(),
    accountId,
    group: group === 'other' ? '其他' : group,
    autoSync,
    addedAt: existing?.addedAt || new Date().toLocaleDateString('zh-CN'),
    ...extra,
  };
  const nextTrackers = trackerId
    ? trackers.map(item => item.id === trackerId ? tracker : item)
    : [tracker, ...trackers];
  LS.set('trackers', nextTrackers);
  try {
    const saved = await localApi('trackers', { method: 'POST', body: tracker });
    LS.set('trackers', LS.get('trackers', []).map(item => item.id === tracker.id ? { ...item, ...saved } : item));
  } catch (e) {
    toast('本地保存失败：' + e.message, 'error');
    LS.set('trackers', trackers);
    return;
  }
  document.querySelector('.modal-mask')?.remove();
  toast(trackerId ? '账号信息已更新' : '账号已加入追踪', 'success');
  if (currentPage === 'tracker') renderTracker();
  if (currentPage === 'dashboard') renderFeedAndHistory();
}

export function addToTracker(plat, name, id) {
  if (!name) { toast('该作品无作者信息', 'error'); return; }
  const trackers = LS.get('trackers', []);
  if (trackers.some(t => t.plat === plat && (id ? t.accountId === id : t.name === name))) {
    openAddAccountModal({ existing: true, name, id, fans: '--' });
    return;
  }
  openAddAccountModal({ plat, name, id: plat === 'xhs' ? '' : id });
}

export function editTracker(id) {
  const tracker = LS.get('trackers', []).find(item => item.id === id);
  if (!tracker) return;
  openAddAccountModal({ ...tracker, editing: true });
}

export async function removeTracker(id) {
  if (!confirm('确定要移除这个追踪账号吗？')) return;
  const trackers = LS.get('trackers', []).filter(t => t.id !== id);
  LS.set('trackers', trackers);
  try {
    await localApi(`trackers/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (e) {
    toast('服务端删除失败：' + e.message, 'error');
  }
  toast('已移除', 'success');
  if (currentPage === 'tracker') renderTracker();
  if (currentPage === 'dashboard') renderFeedAndHistory();
}

export async function viewTracker(id) {
  const t = LS.get('trackers', []).find(x => x.id === id);
  if (!t) return;
  try {
    const works = await localApi(`trackers/${encodeURIComponent(id)}/works`);
    if (works && works.length) {
      if (works.stale) toast('当前显示的是超过 24 小时的本地数据，可手动刷新', 'info');
      showTrackerWorksModal(t, works);
    } else {
      showTrackerWorksEmpty(t);
    }
  } catch (e) {
    showTrackerWorksEmpty(t, e.message);
  }
}

export function showTrackerWorksEmpty(t, errorMsg) {
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  modal.innerHTML = `
    <div class="modal" style="max-width:480px" data-action="stopPropagation">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold text-base">${esc(t.name)} 的作品</h3>
        <button class="btn btn-ghost py-1 px-2" data-action="closeModal"><i data-lucide="x" class="w-4 h-4"></i></button>
      </div>
      <div class="text-center py-8 text-gray-400 text-sm">
        ${errorMsg ? `<div class="text-red-400 mb-3">加载失败：${esc(errorMsg)}</div>` : '<div class="mb-3">暂无本地作品数据</div>'}
        <button class="btn btn-primary" data-action="syncTrackerWorksAndClose" data-id="${t.id}"><i data-lucide="refresh-cw" class="w-4 h-4"></i>同步作品</button>
      </div>
    </div>`;
  modal.addEventListener('click', event => {
    if (event.target === modal) modal.remove();
  });
  document.getElementById('modal-host').appendChild(modal);
  initIcons(modal);
}

export async function syncTrackerWorks(id) {
  const t = LS.get('trackers', []).find(x => x.id === id);
  if (!t) return;
  toast('正在同步 ' + t.name + ' 的作品…', 'info');
  try {
    const result = await localApi(`trackers/${encodeURIComponent(id)}/sync`, { method: 'POST', body: {} });
    if (result.tracker) {
      LS.set('trackers', LS.get('trackers', []).map(item => item.id === id ? { ...item, ...result.tracker } : item));
    }
    if (result.pending) {
      toast(result.message || '已提交 RedFox 采集，请稍后再查看', 'info');
      if (currentPage === 'tracker') renderTracker();
      return;
    }
    if (result.works?.length) {
      toast(`已同步 ${result.works.length} 个作品`, 'success');
      showTrackerWorksModal(t, result.works);
    } else {
      toast('账号已匹配，但暂未返回近期作品；未收录账号可能需要等待 RedFox 同步', 'info');
      if (currentPage === 'tracker') renderTracker();
    }
  } catch (e) {
    toast('同步失败：' + e.message, 'error');
  }
}

export function showTrackerWorksModal(t, works) {
  const sorted = [...works].sort((a, b) => {
    const ta = t.plat === 'dy' ? (a.publishTime || a.createTime || '') : t.plat === 'xhs' ? (a.createTime || a.workPublishTime || '') : (a.publicTime || a.publishTime || '');
    const tb = t.plat === 'dy' ? (b.publishTime || b.createTime || '') : t.plat === 'xhs' ? (b.createTime || b.workPublishTime || '') : (b.publicTime || b.publishTime || '');
    return trackerTimeValue(tb) - trackerTimeValue(ta);
  });
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  modal.innerHTML = `
    <div class="modal flex flex-col" style="max-width:680px;max-height:80vh" data-action="stopPropagation">
      <div class="flex items-center justify-between px-6 py-3 border-b border-white/5 flex-shrink-0 sticky top-0 z-10" style="background:var(--bg-2)">
        <h3 class="font-semibold text-base">${esc(t.name)} 的作品 · ${sorted.length} 篇</h3>
        <div class="flex items-center gap-1">
          <button class="btn btn-ghost py-1 px-2" data-action="syncTrackerWorksInModal" data-id="${t.id}" data-plat="${t.plat}" title="刷新作品"><i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i></button>
          <button class="btn btn-ghost py-1 px-2" data-action="closeModal"><i data-lucide="x" class="w-4 h-4"></i></button>
        </div>
      </div>
      <div class="flex-1 overflow-y-auto px-6 py-4 space-y-2">
        ${sorted.slice(0, 30).map((w, i) => {
          const item = t.plat === 'dy' ? adaptDY(w) : t.plat === 'xhs' ? adaptXHS(w) : adaptGZH(w);
          return `
          <div class="bg-white/[0.02] rounded-lg p-3 hover:bg-white/[0.05] cursor-pointer" data-action="showDetailAndCloseModal" data-plat="${item.plat}" data-work-id="${item.workId}">
            <div class="font-medium text-sm line-clamp-2 mb-1">${i+1}. ${esc(item.title || '(无标题)')}</div>
            <div class="flex items-center gap-3 text-[11px] text-gray-500">
             <span>📅 ${esc(item.publishTime || item.createTime || item.publicTime || '--')}</span>
              <span class="text-emerald-400">热度 ${item.read || item.like || '--'}</span>
              <span>评论 ${item.comment || '--'}</span>
              <span>分享 ${item.share || '--'}</span>
              ${w.isOriginal ? '<span class="pill pill-amber">原创</span>' : ''}
            </div>
          </div>
        `}).join('')}
      </div>
    </div>`;
  modal.addEventListener('click', event => {
    if (event.target === modal) modal.remove();
  });
  document.getElementById('modal-host').appendChild(modal);
  initIcons(modal);
}

function trackerTimeValue(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== '') return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value || '').replace(/-/g, '/'));
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function syncTrackerWorksInModal(id, plat) {
  toast('正在同步作品…', 'info');
  try {
    const result = await localApi(`trackers/${encodeURIComponent(id)}/sync`, { method: 'POST' });
    if (result.tracker) {
      LS.set('trackers', LS.get('trackers', []).map(item => item.id === id ? { ...item, ...result.tracker } : item));
    }
    toast(result.pending ? (result.message || 'RedFox 正在采集账号数据') : '同步成功', result.pending ? 'info' : 'success');
    document.querySelector('.modal-mask')?.remove();
    if (currentPage === 'tracker') renderTracker();
  } catch (e) {
    toast('同步失败：' + e.message, 'error');
  }
}

export async function diagnoseTracker(id) {
  const tracker = LS.get('trackers', []).find(item => item.id === id);
  if (!tracker) return;
  try {
    const result = await localApi(`trackers/${encodeURIComponent(id)}/diagnose`, { method: 'GET' });
    if (result.cached && result.report) {
      showDiagnosisModal(result.report, true, id);
    } else if (result.stale) {
      showDiagnosisEmpty(tracker);
    } else {
      runDiagnosis(id, tracker);
    }
  } catch (e) {
    showDiagnosisEmpty(tracker, e.message);
  }
}

export function showDiagnosisEmpty(tracker, errorMsg) {
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  modal.innerHTML = `
    <div class="modal" style="max-width:480px" data-action="stopPropagation">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold text-base">${esc(tracker.name)} 诊断</h3>
        <button class="btn btn-ghost py-1 px-2" data-action="closeModal"><i data-lucide="x" class="w-4 h-4"></i></button>
      </div>
      <div class="text-center py-8 text-gray-400 text-sm">
        ${errorMsg ? `<div class="text-red-400 mb-3">加载失败：${esc(errorMsg)}</div>` : '<div class="mb-3">暂无本地诊断数据</div>'}
        <button class="btn btn-primary" data-action="runDiagnosisAndClose" data-id="${tracker.id}"><i data-lucide="activity" class="w-4 h-4"></i>运行诊断</button>
      </div>
    </div>`;
  modal.addEventListener('click', event => {
    if (event.target === modal) modal.remove();
  });
  document.getElementById('modal-host').appendChild(modal);
  initIcons(modal);
}

export async function runDiagnosis(id, tracker) {
  if (!tracker) tracker = LS.get('trackers', []).find(item => item.id === id);
  if (!tracker) return;
  toast(`正在运行 ${tracker.name} 的官方诊断 Skill…`, 'info');
  try {
    const result = await localApi(`trackers/${encodeURIComponent(id)}/diagnose`, { method: 'POST', body: {} });
    if (result.tracker) {
      LS.set('trackers', LS.get('trackers', []).map(item => item.id === id ? result.tracker : item));
      if (currentPage === 'tracker') renderTracker();
    }
    showDiagnosisModal(result.report, false, id);
  } catch (e) {
    toast('诊断失败：' + e.message, 'error');
  }
}

export function showDiagnosisModal(report, cached = false, trackerId = '') {
  const header = report.header || {};
  const scores = report.scores || {};
  const dimensions = report.dimensions || [
    ['内容健康度', scores['内容健康度得分']],
    ['用户活跃度', scores['用户活跃度得分']],
    ['核心数据表现', scores['内容核心数据表现得分']],
    ['运营规范性', scores['运营规范性得分']],
  ].map(([name, score]) => ({ name, score, max: 100 }));
  const latestWork = report.works?.[0]?.['发布时间'] || '--';
  const avatar = proxyImage(report._raw?.avatar || report._raw?.avatarUrl);
  const redfoxIndex = header['红狐指数'];
  const skillName = report.platform === 'dy'
    ? 'douyin-account-diagnosis'
    : report.platform === 'xhs'
      ? 'xiaohongshu-account-analyzer'
      : 'wechat-account-analyzer';
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  modal.innerHTML = `
    <div class="modal flex flex-col" style="max-width:900px;max-height:88vh" data-action="stopPropagation">
      <div class="flex items-center justify-between px-6 py-4 border-b border-white/5 flex-shrink-0 sticky top-0 z-10" style="background:var(--bg-2)">
        <div class="flex items-center gap-3">
          <div class="account-avatar">${esc((header['账号名'] || '?')[0])}${avatar ? `<img src="${avatar}" alt="" referrerpolicy="no-referrer" data-image-error="remove" />` : ''}</div>
          <div>
            <h3 class="font-semibold text-base">${esc(header['账号名'])}</h3>
            <div class="text-[11px] text-gray-500">${esc(header['账号类型'] || '')} · 最新作品 ${esc(latestWork)}</div>
            ${cached ? '<span class="pill pill-sky text-[10px]">来自缓存</span>' : ''}
          </div>
        </div>
        <div class="flex items-center gap-2">
          ${trackerId ? `<button class="btn btn-ghost py-1.5 text-xs" data-action="reRunDiagnosis" data-id="${trackerId}"><i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i>重新诊断</button>` : ''}
          <button class="btn btn-ghost py-1 px-2" data-action="closeModal"><i data-lucide="x" class="w-4 h-4"></i></button>
        </div>
      </div>
      <div class="flex-1 overflow-y-auto px-6 py-5">
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
          <div class="glass rounded-xl p-4"><div class="text-[11px] text-gray-500">综合评分</div><div class="text-2xl font-bold text-purple-300">${esc(scores['综合评分'] ?? '--')}</div><div class="text-[11px] text-gray-500">${esc(scores['综合等级'] || '')}</div></div>
          <div class="glass rounded-xl p-4"><div class="text-[11px] text-gray-500">红狐指数</div><div class="text-2xl font-bold text-amber-300">${redfoxIndex == null ? '--' : Number(redfoxIndex).toFixed(0)}</div><div class="text-[11px] text-gray-500">${esc(header['账号标识'] || '')}</div></div>
          <div class="glass rounded-xl p-4"><div class="text-[11px] text-gray-500">${header['粉丝数'] != null ? '粉丝数' : '平均阅读'}</div><div class="text-2xl font-bold">${fmt(header['粉丝数'] ?? header['平均阅读数'])}</div></div>
          <div class="glass rounded-xl p-4"><div class="text-[11px] text-gray-500">报告数据时间</div><div class="text-sm font-semibold mt-2">${esc(header['数据更新时间'] || '--')}</div></div>
        </div>
        <h4 class="text-sm font-semibold mb-3">四维评分</h4>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-5">
          ${dimensions.map(item => `<div class="glass rounded-xl p-4">
            <div class="flex justify-between text-xs mb-2"><span>${esc(item.name)}</span><span class="text-purple-300">${esc(item.score ?? '--')} / ${esc(item.max ?? 100)}</span></div>
            <div class="progress-bar"><div style="width:${Math.max(0, Math.min(100, (Number(item.score) || 0) / (Number(item.max) || 100) * 100))}%"></div></div>
          </div>`).join('')}
        </div>
        <h4 class="text-sm font-semibold mb-3">近期作品</h4>
        <div class="space-y-2 mb-5">
          ${(report.works || []).slice(0, 7).map(work => {
            const rawTitle = work['标题'] || '';
            const urlMatch = rawTitle.match(/^\[(.+?)\]\((.+?)\)$/);
            const title = urlMatch ? urlMatch[1] : rawTitle;
            const url = work['链接'] || work['url'] || (urlMatch ? urlMatch[2] : '');
            const workId = work['workUuid'] || work['id'] || '';
            const biz = work['biz'] || '';
            const mid = work['mid'] || '';
            const canDetail = !!(workId || (biz && mid));
            const date = esc(work['发布时间'] || '--');
            const read = fmt(work['阅读数']) || '0';
            const like = fmt(work['点赞数']) || '0';
            const comment = fmt(work['评论数']) || '0';
            return `<div class="glass rounded-xl p-3">
              <div class="flex items-center gap-3">
                <div class="flex-1 min-w-0">
                  <div class="text-sm font-medium line-clamp-2">${esc(title)}</div>
                  <div class="text-[11px] text-gray-500 mt-0.5">${date} · 阅读 ${read} · 点赞 ${like} · 评论 ${comment}</div>
                </div>
                <div class="flex items-center gap-1.5 flex-shrink-0">
                  ${canDetail ? `<button class="btn btn-ghost py-1 px-2" data-action="openGzhWork" data-work-id="${workId}" data-biz="${biz}" data-mid="${mid}" data-url="${encodeURIComponent(url)}" title="查看详情"><i data-lucide="eye" class="w-3 h-3"></i></button>` : ''}
                  ${url ? `<button class="btn btn-ghost py-1 px-2" data-action="copyToClipboard" data-text="${encodeURIComponent(url)}" title="复制链接"><i data-lucide="link" class="w-3 h-3"></i></button>` : ''}
                </div>
              </div>
            </div>`;
          }).join('') || '<div class="text-xs text-gray-500">暂无作品数据</div>'}
        </div>
        <h4 class="text-sm font-semibold mb-3">相似账号</h4>
        <div class="flex flex-wrap gap-2">
          ${(report.similar_accounts || []).map(item => `<span class="tag">${esc(item['账号名称'])} · 红狐 ${Number(item['红狐指数'] || 0).toFixed(0)} · 均读 ${fmt(item['平均阅读数'])}</span>`).join('') || '<span class="text-xs text-gray-500">暂无相似账号</span>'}
        </div>
        ${report.markdown ? `<details class="mt-5 glass rounded-xl p-4"><summary class="text-sm font-semibold cursor-pointer">完整 Skill 报告</summary><div class="markdown-body mt-4">${renderMarkdown(report.markdown)}</div></details>` : ''}
        <p class="text-[11px] text-gray-600 mt-5">评分由本地 ${skillName} Skill 生成；原始数据来自 RedFox API。</p>
      </div>
    </div>`;
  modal.addEventListener('click', event => {
    if (event.target === modal) modal.remove();
  });
  document.getElementById('modal-host').appendChild(modal);
  initIcons(modal);
}

export async function reRunDiagnosis(id) {
  if (!id) return;
  document.querySelector('.modal-mask')?.remove();
  await runDiagnosis(id);
}

export async function viewTrackerTrend(id) {
  try {
    const data = await localApi(`trackers/${encodeURIComponent(id)}/trend?limit=30`);
    const snapshots = (data.snapshots || []).slice().reverse();
    const latest = data.snapshots?.[0];
    const analysis = latest?.analysis || {};
    const modal = document.createElement('div');
    modal.className = 'modal-mask';
    const chartId = 'tracker-trend-chart-' + Date.now();
    const hasData = snapshots.length > 0;
    modal.innerHTML = `
      <div class="modal flex flex-col" style="max-width:880px;max-height:88vh" data-action="stopPropagation">
        <div class="flex items-center justify-between px-6 py-4 border-b border-white/5">
          <div><h3 class="font-semibold">${esc(data.tracker.name)} · 账号趋势</h3><p class="text-[11px] text-gray-500 mt-1">每日 07:00 保存前一日数据；当前共 ${snapshots.length} 个快照</p></div>
          <button class="btn btn-ghost py-1 px-2" data-action="closeModal"><i data-lucide="x" class="w-4 h-4"></i></button>
        </div>
        <div class="overflow-y-auto p-6">
          ${latest ? `<div class="glass rounded-xl p-4 mb-5">
            <div class="text-xs text-gray-500 mb-2">最新趋势解读 · ${esc(latest.snapshotDate)}</div>
            <div class="text-sm">${esc(analysis.summary || '当前快照尚无趋势解读')}</div>
            ${[...(analysis.changes || []), ...(analysis.risks || []), ...(analysis.actions || [])].length ? `<ul class="mt-3 text-xs text-gray-400 space-y-1">${[...(analysis.changes || []), ...(analysis.risks || []), ...(analysis.actions || [])].map(item => `<li>· ${esc(item)}</li>`).join('')}</ul>` : ''}
          </div>` : '<div class="text-sm text-gray-500 mb-5">尚无快照，请先运行评分详情或等待每日任务。</div>'}
          ${hasData ? `<div class="glass rounded-xl p-4 mb-5"><canvas id="${chartId}" height="220"></canvas></div>` : ''}
          <div class="overflow-x-auto"><table class="w-full text-xs">
            <thead><tr class="text-left text-gray-500 border-b border-white/10"><th class="py-2">日期</th><th>粉丝</th><th>红狐指数</th><th>综合评分</th><th>作品数</th></tr></thead>
            <tbody>${data.snapshots?.map(item => `<tr class="border-b border-white/5"><td class="py-2">${esc(item.snapshotDate)}</td><td>${fmt(item.followerCount)}</td><td>${fmt(item.redfoxIndex)}</td><td>${fmt(item.score)}</td><td>${fmt(item.workCount)}</td></tr>`).join('') || ''}</tbody>
          </table></div>
        </div>
      </div>`;
    modal.addEventListener('click', event => {
      if (event.target === modal) modal.remove();
    });
    document.getElementById('modal-host').appendChild(modal);
    initIcons(modal);
    if (hasData && typeof window.Chart !== 'undefined') {
      const ctx = document.getElementById(chartId)?.getContext('2d');
      if (ctx) {
        const labels = snapshots.map(s => s.snapshotDate.slice(5));
        const commonOptions = {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { labels: { color: '#9ca3af', font: { size: 11 } } } },
          scales: {
            x: { ticks: { color: '#6b7280', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
            y: { type: 'linear', display: true, position: 'left', ticks: { color: '#6b7280', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: '粉丝数', color: '#60a5fa' } },
            y1: { type: 'linear', display: true, position: 'right', ticks: { color: '#6b7280', font: { size: 10 } }, grid: { drawOnChartArea: false }, title: { display: true, text: '指数/评分/作品', color: '#f472b6' } },
          },
        };
        new window.Chart(ctx, {
          type: 'line',
          data: {
            labels,
            datasets: [
              { label: '粉丝', data: snapshots.map(s => s.followerCount), borderColor: '#60a5fa', backgroundColor: 'rgba(96,165,250,0.1)', yAxisID: 'y', tension: 0.3, fill: true },
              { label: '红狐指数', data: snapshots.map(s => s.redfoxIndex), borderColor: '#34d399', backgroundColor: 'transparent', yAxisID: 'y1', tension: 0.3 },
              { label: '综合评分', data: snapshots.map(s => s.score), borderColor: '#f472b6', backgroundColor: 'transparent', yAxisID: 'y1', tension: 0.3 },
              { label: '作品数', data: snapshots.map(s => s.workCount), borderColor: '#fbbf24', backgroundColor: 'transparent', yAxisID: 'y1', tension: 0.3 },
            ],
          },
          options: commonOptions,
        });
      }
    }
  } catch (e) {
    toast(`趋势加载失败：${e.message}`, 'error');
  }
}

export async function openGzhWork(workId, biz, mid, url) {
  const { showDetail } = await import('./detail.js');
  if (workId) {
    showDetail('gzh', workId);
  } else if (biz && mid) {
    showDetail('gzh', `${biz}:${mid}`);
  } else if (url) {
    window.open(decodeURIComponent(url), '_blank', 'noopener,noreferrer');
  }
}
