import { app, BrowserWindow, nativeTheme } from 'electron';
import path from 'node:path';
import { registerIpc, setMainWindow } from './ipc';
import { createTray } from './tray';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'Routine',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d1117' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  setMainWindow(mainWindow);

  mainWindow.webContents.on(
    'console-message',
    (_e, _level, message, _line, sourceId) => {
      console.log(`[renderer] ${message} ${sourceId ?? ''}`);
    }
  );
  mainWindow.webContents.on(
    'did-fail-load',
    (_e, code, desc, url) => {
      console.log(`[fail-load] ${code} ${desc} ${url}`);
    }
  );

  const devMode = process.env.ROUTINE_DEV === '1' && !app.isPackaged;
  if (devMode) {
    void mainWindow.loadURL('http://localhost:5173');
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../../dist-renderer/index.html'));
  }
}

app.whenReady().then(() => {
  // 开发模式下 Dock 默认是 Electron 图标，显式换成 R 图标（打包版由构建配置注入）
  if (!app.isPackaged && process.platform === 'darwin') {
    app.dock?.setIcon(path.join(app.getAppPath(), 'build/icon.png'));
  }
  registerIpc();
  createTray();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
