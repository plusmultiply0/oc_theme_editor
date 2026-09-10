import path from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { registerMockHandlers } from './handlers.mock';

/**
 * 窗口安全基线（T11）：
 * - contextIsolation 开启，renderer 与 Node 隔离
 * - nodeIntegration 关闭
 * - sandbox 开启
 * - 只加载本地页面（index.html / 本机 dev server），不加载远程页面
 */
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }

  win.once('ready-to-show', () => win.show());
  return win;
}

app.whenReady().then(() => {
  registerMockHandlers(ipcMain);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
