import type { ThemeMode } from '../shared/types';

const STORAGE_KEY = 'routine.theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

let current: ThemeMode = 'system';

function isMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return media.matches ? 'dark' : 'light';
}

/** 立即应用并写入 localStorage 镜像，供下次启动首帧使用 */
export function setThemeMode(mode: ThemeMode): void {
  current = mode;
  document.documentElement.dataset.theme = resolveTheme(mode);
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // localStorage 不可用时仅影响首帧，不影响运行期
  }
}

/**
 * 渲染前调用：先用 localStorage 镜像出首帧，避免等待 IPC 设置加载导致闪白/闪黑。
 * 设置加载完成后由 store 以 Settings.appearance 为准对账。
 */
export function initTheme(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    saved = null;
  }
  current = isMode(saved) ? saved : 'system';
  document.documentElement.dataset.theme = resolveTheme(current);

  media.addEventListener('change', () => {
    if (current === 'system') {
      document.documentElement.dataset.theme = resolveTheme('system');
    }
  });
}
