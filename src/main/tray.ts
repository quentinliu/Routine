import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron';
import { getScheduler } from './services/scheduler';

// 16px / 32px 圆环 template 图标（黑色+alpha，随系统深浅色自适应）
const ICON_16 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANElEQVR4nGNgGKzgPw5MtkaiDcKniKABxNiAVw26BC5njwQDyA5EQgpITgdkJSRCBg1CAACYM1epw0LjjAAAAABJRU5ErkJggg==';
const ICON_32 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAR0lEQVR4nO3UQQoAIAhEUe9/adsHagU6EP+B22aQ0AwA8MaDkQWPFclC2gucBLSW2B+O1k6B/wvIPmEVMH4HJIeoKgIAuLYAcIJXqWpKY2sAAAAASUVORK5CYII=';

let tray: Tray | null = null;
let quitting = false;

export function isQuitting(): boolean {
  return quitting;
}

export function markQuitting(): void {
  quitting = true;
}

function showMainWindow(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    win.show();
    win.focus();
  }
}

function rebuildMenu(): void {
  if (!tray) return;
  const paused = getScheduler().isPaused();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: showMainWindow },
      {
        label: paused ? '恢复定时任务' : '暂停定时任务',
        click: () => {
          getScheduler().setPaused(!paused);
          rebuildMenu();
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          markQuitting();
          app.quit();
        }
      }
    ])
  );
}

export function createTray(): void {
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${ICON_16}`);
  icon.addRepresentation({ scaleFactor: 2, dataURL: `data:image/png;base64,${ICON_32}` });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Routine');
  rebuildMenu();
}
