import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  nativeTheme,
  Tray,
  type NativeImage
} from 'electron';
import { getScheduler } from './services/scheduler';

// 字母 R 的 16/32px 位图（脚本 scripts/generate-icons.js 生成）
// macOS 走 template image（只用 alpha，系统按菜单栏明暗自适应）；
// Windows/Linux 无 template 能力，按当前主题选择黑/白字形。
const ICON_16_BLACK =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAt0lEQVR42mNgoCLQYmBgSMCBAxgYGDgJGVDAwMDwHw9+yMDAoE2KAVlILuhjYGD4x8DAcI4UAwTQ5LdAxWXJNWAXVFyKWAMqoWIgvBAqdoSSQLwENEiRWAPmQKPuIpJYEynRWICUNr5Cxf4wMDA4kGoACKQhiT9mYGAQJtUAEFiFJLeBgYGBkVQDBIEJ6gGSfDapBoCANQMDw2+o/FsGBgZefJlJC4c3a6Exo0VujmVmYGDgQBYAAOQGVHvuSMq9AAAAAElFTkSuQmCC';
const ICON_16_WHITE =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAvUlEQVR42qWTsQ4BQRCGTzQUEqKTKLTrETQe4R5BpaC5VqHxAJ5Ao1UpVGq15DwBUStVxOc2mWIi7uy4Tf5iv9l8mezsRkBUJnrjgFFOYqD+S5BQvC5A3yKYqA6WwAs4WgTNj8M74d1/BXvhnVDBTJjPWtihzCWeMlEvVLCS0aWKLSxjTNTbuAt7AkOrwGes+BVoWwU+G1XbAhWroJU9qLOqT60CnwHwkPoNaBR9Jpfz++YyGfetg5BUgZpmb6WyUajIJV52AAAAAElFTkSuQmCC';
const ICON_32_BLACK =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABSElEQVR42u2XPUsDQRCGHz/AQsTGysbYqFjZClZiIWLqVAElfX6ApSiC2NgfCOmsJZWInYUWKVMETJXKRtBCET9uYAMy3B4kOHMpfGGqew+e2517dwf+NaJqAq0B6xo4Apb/AqALfA9ZH8ApMFEUQL8awJgFwANwm1GdDO+eBcBaznvVsAV9b8cbQHSm/KveABvKX/YG2FL+HW+AhvIveAHMACfKe2/RhL3wXNe78n0B20UG0WFRSfgE7FucBS9pQ138qucIwKXVYdRVnkrOKtQ8AERJBOAVWPEAmE5Xoh2BkDvClDUAIRfeIhDnHgCiegRAsmDXA0AuHlc5v+W8NYBoLqRkFsRNGkzj1gCiTeAzAnHgASA6zrmsrnsATAJ3EYhHYNYaQLQYiWrJjKVhB5PmgI2sozoJweWqJKxEpagRT764NNJD6A8c0FM/eOQyXgAAAABJRU5ErkJggg==';
const ICON_32_WHITE =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABS0lEQVR42u2Xr0sEURSFxx9gELGYLGpRMVkFkxhENG8SFLt/gFEUQSz2AWGbWTaJ2AwajIYFN5m2CBoU0c+58BbkMm9gl733Gbxw0jsM39x5c967GZClVPYPEFloAA9d6go4BOb6AdCi9/oEToChVACdqgMDFgD3wE2JmiXebQuAxYoHboVP0KmmN4DoVPkXvAGWlX/TG2BV+de9AerKP+UFMAYcK++dxSZ8DutaH8r3DaylDKKDVEnYBnYszoLXYkOd/9JLBODC6jBqKU+togu7HgCiPALwBsx7AIwWnXiMQMgdYcQaIAu58B6BOPMAEO1FACQLNjwA5OJxWfFbTloDiCZCSpbVdRFMg9YAohXgKwKx7wEgOqq4rC55AAwDtxGIJ2DcGkA0E4lqyYzZXgeTRpdTj47qPASX62iWh07UUs2G8sbTf3o4/QH9BkfzHlsafAAAAABJRU5ErkJggg==';

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

function buildTrayIcon(): NativeImage {
  const useWhite = process.platform !== 'darwin' && nativeTheme.shouldUseDarkColors;
  const icon = nativeImage.createFromDataURL(
    `data:image/png;base64,${useWhite ? ICON_16_WHITE : ICON_16_BLACK}`
  );
  icon.addRepresentation({
    scaleFactor: 2,
    dataURL: `data:image/png;base64,${useWhite ? ICON_32_WHITE : ICON_32_BLACK}`
  });
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  return icon;
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
  tray = new Tray(buildTrayIcon());
  tray.setToolTip('Routine');
  rebuildMenu();
  // Windows/Linux 任务栏明暗变化时换用黑/白字形（macOS 由 template 自动处理）
  nativeTheme.on('updated', () => {
    if (tray) tray.setImage(buildTrayIcon());
  });
}
