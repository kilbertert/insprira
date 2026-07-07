// 主题切换：dark / light；持久化到 localStorage；首次访问跟随系统 prefers-color-scheme
import { LS } from './state.js';

const KEY = 'furnace.theme';
const VALID = ['dark', 'light'];

function detectSystem() {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function getTheme() {
  const stored = LS.get(KEY);
  return VALID.includes(stored) ? stored : detectSystem();
}

export function applyTheme(theme) {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;
  // 给内置 select / 滚动条等 UA 控件也跟随
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute('content', theme);
}

export function setTheme(theme) {
  if (!VALID.includes(theme)) return;
  LS.set(KEY, theme);
  applyTheme(theme);
}

export function toggleTheme() {
  setTheme(getTheme() === 'dark' ? 'light' : 'dark');
  return getTheme();
}

// 在 body 还没渲染前就要写好 data-theme，避免首次 paint 闪烁
export function initTheme() {
  applyTheme(getTheme());
  // 系统主题变更时，仅在用户没显式选过时跟随
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const handler = () => {
      if (LS.get(KEY) == null) applyTheme(detectSystem());
    };
    if (mq.addEventListener) mq.addEventListener('change', handler);
    else if (mq.addListener) mq.addListener(handler);
  }
}