import { BrowserWindow, Notification } from 'electron';
import { getStorage } from './storage';

const DEFAULT_DEDUPE_WINDOW_MS = 6 * 3600_000;
const lastNotified = new Map<string, number>();

function focusMainWindow(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    win.show();
    win.focus();
  }
}

/** 系统通知统一入口；notifications.enabled 关闭或不支持时静默跳过 */
export function notify(
  title: string,
  body: string,
  opts?: { dedupeKey?: string; dedupeWindowMs?: number }
): void {
  const enabled = getStorage().loadSettings().notifications?.enabled ?? true;
  if (!enabled || !Notification.isSupported()) return;

  if (opts?.dedupeKey) {
    const windowMs = opts.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    const last = lastNotified.get(opts.dedupeKey);
    if (last !== undefined && Date.now() - last < windowMs) return;
    lastNotified.set(opts.dedupeKey, Date.now());
  }

  const n = new Notification({ title, body });
  n.on('click', focusMainWindow);
  n.show();
}
