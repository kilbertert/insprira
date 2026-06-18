import { localApi } from '../api.js';
import { esc, proxyImage } from '../utils.js';
import { platName } from '../config.js';
import { toast } from '../components.js';
import { initIcons } from '../icons.js';

export async function renderMyAccounts() {
  await loadMyAccounts();
}

async function loadMyAccounts() {
  const list = document.getElementById('my-account-list');
  const empty = document.getElementById('my-empty');
  const sub = document.getElementById('my-sub');
  if (!list) return;
  try {
    const accounts = await localApi('my-accounts');
    if (!accounts.length) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      if (sub) sub.textContent = '管理个人账号、提炼赛道与创作风格档案';
      return;
    }
    empty.classList.add('hidden');
    if (sub) sub.textContent = `共 ${accounts.length} 个账号`;
    list.innerHTML = accounts.map(renderAccountCard).join('');
    initIcons(list);
  } catch (e) {
    list.innerHTML = `<div class="text-red-400 text-sm">${esc(e.message)}</div>`;
  }
}

function renderAccountCard(a) {
  const tracks = (a.tracks || []);
  const profile = a.styleProfile;
  const profileHint = profile
    ? `✓ 已提炼（${a.styleUpdatedAt ? new Date(a.styleUpdatedAt).toLocaleDateString('zh-CN') : ''}）`
    : '未提炼';
  const avatar = proxyImage(a.avatar);
  return `
  <div class="glass rounded-xl p-4 flex flex-col gap-3" data-account-id="${esc(a.id)}">
    <div class="flex items-start gap-3">
      <div class="account-avatar" style="width:48px;height:48px;font-size:15px;">${esc((a.name || '?')[0])}${avatar ? `<img src="${avatar}" alt="" data-image-error="remove" />` : ''}</div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span class="font-semibold text-sm truncate">${esc(a.name)}</span>
          <span class="pill ${a.plat === 'dy' ? 'pill-hot' : a.plat === 'xhs' ? 'pill-brand' : 'pill-green'}">${platName(a.plat)}</span>
        </div>
        <div class="text-[11px] text-gray-500 mt-0.5 truncate">${esc(a.styleSource === 'kb' ? '来源：知识库' : a.styleSource === 'redfox' ? '来源：RedFox' : '未指定数据源')}</div>
      </div>
      <button class="btn btn-ghost py-0.5 px-1.5 text-xs text-gray-500 hover:text-red-400" data-action="removeMyAccount" data-id="${esc(a.id)}" title="删除"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
    </div>

    <div>
      <div class="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">赛道</div>
      <div class="flex items-center gap-1 flex-wrap">
        ${tracks.length ? tracks.map(t => `<span class="tag">${esc(t)}</span>`).join('') : '<span class="text-[11px] text-gray-600">未提炼</span>'}
        <button class="btn btn-ghost py-0.5 px-1.5 text-[10px] ml-auto" data-action="extractMyTracks" data-id="${esc(a.id)}" title="基于作品标题提炼赛道">
          <i data-lucide="sparkles" class="w-3 h-3"></i>${tracks.length ? '重提炼' : '提炼赛道'}
        </button>
      </div>
    </div>

    <div>
      <div class="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">风格档案</div>
      <div class="flex items-center gap-2">
        <span class="text-[11px] ${profile ? 'text-emerald-400' : 'text-gray-600'}">${profileHint}</span>
        <div class="ml-auto flex gap-1">
          ${profile ? `<button class="btn btn-ghost py-0.5 px-1.5 text-[10px]" data-action="viewMyStyle" data-id="${esc(a.id)}" title="查看风格档案"><i data-lucide="eye" class="w-3 h-3"></i></button>` : ''}
          <button class="btn btn-ghost py-0.5 px-1.5 text-[10px]" data-action="extractMyStyle" data-id="${esc(a.id)}" title="${profile ? '重新提炼风格档案' : '提炼风格档案'}">
            <i data-lucide="wand-2" class="w-3 h-3"></i>${profile ? '重提炼' : '提炼'}
          </button>
        </div>
      </div>
    </div>

    <div class="pt-2 border-t border-white/5 flex items-center gap-1">
      <button class="btn btn-primary py-1 px-2 text-xs flex-1 justify-center" data-action="presetMyInspirations" data-id="${esc(a.id)}" title="基于赛道和热点生成预设选题">
        <i data-lucide="lightbulb" class="w-3 h-3"></i>生成预设选题
      </button>
      <button class="btn btn-ghost py-1 px-2 text-xs" data-action="editMyAccount" data-id="${esc(a.id)}" title="编辑">
        <i data-lucide="pencil" class="w-3 h-3"></i>
      </button>
    </div>
  </div>`;
}

export async function addMyAccount() {
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  modal.innerHTML = `<div class="modal" style="max-width:520px" data-action="stopPropagation">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-lg font-bold">添加我的账号</h2>
      <button class="btn btn-ghost py-1 px-2" data-action="closeModal"><i data-lucide="x" class="w-4 h-4"></i></button>
    </div>
    <div class="space-y-3">
      <label class="block">
        <span class="text-xs text-gray-400">平台</span>
        <select class="input mt-1" id="my-add-plat">
          <option value="gzh">公众号</option>
          <option value="dy">抖音</option>
          <option value="xhs">小红书</option>
        </select>
      </label>
      <label class="block">
        <span class="text-xs text-gray-400">账号名称</span>
        <input class="input mt-1" id="my-add-name" placeholder="账号昵称">
      </label>
      <div>
        <span class="text-xs text-gray-400">数据源</span>
        <div class="mt-1 space-y-2">
          <label class="flex items-start gap-2 p-2 rounded-lg bg-white/[0.02] cursor-pointer hover:bg-white/[0.04]">
            <input type="radio" name="my-source" value="redfox" class="mt-0.5" checked>
            <div class="text-xs">
              <div class="font-medium">关联账号追踪（RedFox）</div>
              <div class="text-gray-500 mt-0.5">从「账号追踪」选择已添加的账号，自动用 RedFox 抓取的作品作为风格源</div>
            </div>
          </label>
          <label class="flex items-start gap-2 p-2 rounded-lg bg-white/[0.02] cursor-pointer hover:bg-white/[0.04]">
            <input type="radio" name="my-source" value="kb" class="mt-0.5">
            <div class="text-xs">
              <div class="font-medium">关联知识库（Obsidian / Notion）</div>
              <div class="text-gray-500 mt-0.5">手动选择知识库条目（逗号分隔 entry key）作为风格源</div>
            </div>
          </label>
        </div>
      </div>
      <div id="my-add-source-redfox" class="space-y-1">
        <label class="block">
          <span class="text-xs text-gray-400">关联追踪账号</span>
          <select class="input mt-1" id="my-add-tracker">
            <option value="">（请先在「账号追踪」添加）</option>
          </select>
        </label>
      </div>
      <div id="my-add-source-kb" class="space-y-1 hidden">
        <label class="block">
          <span class="text-xs text-gray-400">知识库条目 key（逗号分隔，最多 5 个）</span>
          <input class="input mt-1" id="my-add-kb-keys" placeholder="例：path/to/note1.md, page-id-2">
        </label>
      </div>
    </div>
    <div class="flex justify-end gap-2 mt-5">
      <button class="btn btn-ghost py-1.5" data-action="closeModal">取消</button>
      <button class="btn btn-primary py-1.5" data-action="submitMyAccount">添加</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
  initIcons(modal);
  // 动态加载 tracker 列表
  try {
    const trackers = await localApi('trackers');
    const sel = modal.querySelector('#my-add-tracker');
    sel.innerHTML = '<option value="">（不关联）</option>' + trackers.map(t =>
      `<option value="${esc(t.id)}" data-name="${esc(t.name)}" data-plat="${esc(t.plat)}" data-avatar="${esc(t.gzhAvatar || t.avatar || '')}">${esc(t.name)} · ${platName(t.plat)}</option>`
    ).join('');
  } catch {}
  // 切换数据源时显示对应区域
  modal.querySelectorAll('input[name="my-source"]').forEach(r => {
    r.addEventListener('change', () => {
      modal.querySelector('#my-add-source-redfox').classList.toggle('hidden', r.value !== 'redfox' && !Array.from(modal.querySelectorAll('input[name="my-source"]:checked')).some(x => x.value === 'redfox'));
      modal.querySelector('#my-add-source-kb').classList.toggle('hidden', !Array.from(modal.querySelectorAll('input[name="my-source"]:checked')).some(x => x.value === 'kb'));
    });
  });
}

export async function submitMyAccount() {
  const plat = document.getElementById('my-add-plat').value;
  const name = document.getElementById('my-add-name').value.trim();
  if (!name) { toast('请填写账号名称', 'error'); return; }
  const source = document.querySelector('input[name="my-source"]:checked')?.value || 'redfox';
  const trackerSel = document.getElementById('my-add-tracker');
  const trackerId = trackerSel?.value || '';
  const trackerOpt = trackerSel?.selectedOptions[0];
  const kbKeys = document.getElementById('my-add-kb-keys')?.value.trim() || '';
  const body = {
    plat,
    name,
    trackerId: trackerId || null,
    avatar: trackerOpt?.dataset.avatar || '',
    styleSource: source,
    styleSourceRef: source === 'kb' ? kbKeys : '',
  };
  try {
    await localApi('my-accounts', { method: 'POST', body });
    toast('已添加', 'success');
    document.querySelector('.modal-mask')?.remove();
    loadMyAccounts();
  } catch (e) { toast(e.message, 'error'); }
}

export async function removeMyAccount(el, d) {
  if (!confirm('删除此账号？关联的风格档案也会清除。')) return;
  try {
    await localApi(`my-accounts/${encodeURIComponent(d.id)}`, { method: 'DELETE' });
    toast('已删除', 'success');
    loadMyAccounts();
  } catch (e) { toast(e.message, 'error'); }
}

export async function editMyAccount(el, d) {
  try {
    const accounts = await localApi('my-accounts');
    const a = accounts.find(x => x.id === d.id);
    if (!a) return;
    // 复用添加弹窗，预填值
    await addMyAccount();
    document.getElementById('my-add-plat').value = a.plat;
    document.getElementById('my-add-name').value = a.name;
    if (a.trackerId) document.getElementById('my-add-tracker').value = a.trackerId;
    if (a.styleSource === 'kb') {
      document.querySelector('input[name="my-source"][value="kb"]').checked = true;
      document.getElementById('my-add-source-kb').classList.remove('hidden');
      document.getElementById('my-add-kb-keys').value = a.styleSourceRef || '';
    }
    // 改提交逻辑为更新
    const submitBtn = document.querySelector('[data-action="submitMyAccount"]');
    submitBtn.dataset.editId = a.id;
  } catch (e) { toast(e.message, 'error'); }
}

export async function extractMyTracks(el, d) {
  toast('正在提炼赛道…', 'info');
  try {
    const result = await localApi(`my-accounts/${encodeURIComponent(d.id)}/extract-tracks`, { method: 'POST' });
    if (!result.tracks?.length) { toast('未能提炼出赛道，请确认数据源有作品', 'error'); return; }
    // 让用户编辑确认
    const confirmed = prompt(`已提炼出赛道（可编辑，逗号分隔）：`, result.tracks.join('、'));
    if (confirmed === null) return;
    const tracks = confirmed.split(/[、,，]/).map(s => s.trim()).filter(Boolean);
    await localApi('my-accounts', { method: 'POST', body: { ...result.account, tracks } });
    toast(`已保存 ${tracks.length} 个赛道`, 'success');
    loadMyAccounts();
  } catch (e) { toast(e.message, 'error'); }
}

export async function extractMyStyle(el, d) {
  if (!confirm('开始提炼风格档案？（会调用 LLM，约 5-15 秒）')) return;
  toast('正在提炼风格档案…', 'info');
  try {
    const result = await localApi(`my-accounts/${encodeURIComponent(d.id)}/extract-style`, { method: 'POST' });
    toast('已提炼完成', 'success');
    loadMyAccounts();
    viewMyStyle(d);
  } catch (e) { toast(e.message, 'error'); }
}

export async function viewMyStyle(el, d) {
  const id = d?.id || (typeof el === 'string' ? el : el?.id);
  try {
    const accounts = await localApi('my-accounts');
    const a = accounts.find(x => x.id === id);
    if (!a?.styleProfile) { toast('该账号尚未提炼风格档案', 'error'); return; }
    const p = a.styleProfile;
    const renderList = (items) => Array.isArray(items) ? items.map(i => `<div class="text-xs text-gray-300">• ${esc(String(i))}</div>`).join('') : '';
    const renderObj = (obj) => obj ? Object.entries(obj).map(([k, v]) => `<div class="text-xs"><span class="text-gray-500">${esc(k)}：</span><span class="text-gray-300">${esc(Array.isArray(v) ? v.join('、') : String(v))}</span></div>`).join('') : '';
    const modal = document.createElement('div');
    modal.className = 'modal-mask';
    modal.innerHTML = `<div class="modal" style="max-width:640px;max-height:85vh;overflow:auto" data-action="stopPropagation">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-bold">${esc(a.name)} · 风格档案</h2>
        <button class="btn btn-ghost py-1 px-2" data-action="closeModal"><i data-lucide="x" class="w-4 h-4"></i></button>
      </div>
      <div class="space-y-3 text-sm">
        ${p['创作心智'] ? `<div><div class="text-[10px] uppercase tracking-wider text-purple-300 mb-1">创作心智</div>${renderObj(p['创作心智'])}</div>` : ''}
        ${p['标题DNA'] ? `<div><div class="text-[10px] uppercase tracking-wider text-purple-300 mb-1">标题 DNA</div>${renderObj(p['标题DNA'])}</div>` : ''}
        ${p['表达风格'] ? `<div><div class="text-[10px] uppercase tracking-wider text-purple-300 mb-1">表达风格</div>${renderObj(p['表达风格'])}</div>` : ''}
        ${p['创作边界'] ? `<div><div class="text-[10px] uppercase tracking-wider text-purple-300 mb-1">创作边界</div>${renderList(p['创作边界'])}</div>` : ''}
        ${p['诚实边界'] ? `<div class="text-[10px] text-gray-500 italic">${esc(p['诚实边界'])}</div>` : ''}
      </div>
    </div>`;
    document.body.appendChild(modal);
    initIcons(modal);
  } catch (e) { toast(e.message, 'error'); }
}

export async function presetMyInspirations(el, d) {
  toast('正在生成预设选题…', 'info');
  try {
    const ideas = await localApi(`my-accounts/${encodeURIComponent(d.id)}/preset-inspirations`, { method: 'POST' });
    if (!ideas?.length) { toast('未生成选题，请确认赛道已提炼且有热点数据', 'error'); return; }
    const modal = document.createElement('div');
    modal.className = 'modal-mask';
    modal.innerHTML = `<div class="modal" style="max-width:720px;max-height:85vh;overflow:auto" data-action="stopPropagation">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-bold">预设选题（${ideas.length}）</h2>
        <button class="btn btn-ghost py-1 px-2" data-action="closeModal"><i data-lucide="x" class="w-4 h-4"></i></button>
      </div>
      <div class="space-y-2">
        ${ideas.map((idea, i) => `
          <div class="p-3 bg-white/[0.02] rounded-lg">
            <div class="flex items-start gap-2">
              <span class="pill pill-amber flex-shrink-0">${i + 1}</span>
              <div class="flex-1 min-w-0">
                <div class="font-medium text-sm">${esc(idea.title || '')}</div>
                ${idea.angle ? `<div class="text-[11px] text-gray-500 mt-1">角度：${esc(idea.angle)}</div>` : ''}
                ${idea.platform ? `<div class="text-[10px] text-purple-300 mt-1">${esc(platName(idea.platform === 'all' ? '' : idea.platform) || idea.platform)}</div>` : ''}
              </div>
            </div>
          </div>`).join('')}
      </div>
      <div class="text-[11px] text-gray-500 mt-3">可手动添加到「灵感库」开始创作</div>
    </div>`;
    document.body.appendChild(modal);
    initIcons(modal);
  } catch (e) { toast(e.message, 'error'); }
}
