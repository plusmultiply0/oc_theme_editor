import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { registerHandlers } from './ipc';
import { ImageStore } from './services/image-store';
import { TargetService } from './services/target-service';
import { ThemeService } from './services/theme-service';
import { OperationService } from './services/operation-service';
import { OperationEventBus } from './services/events';
import { runtimeRoot as resolveRuntimeRoot } from '../core/patch/precheck';

/**
 * 窗口安全基线（T11）：
 * - contextIsolation 开启，renderer 与 Node 隔离
 * - nodeIntegration 关闭
 * - sandbox 开启
 * - 只加载本地页面（本机 dev server 或打包后的本地 html），不加载远程页面
 */
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 960,
    minHeight: 640,
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

function bootstrap(): void {
  const runtimeRoot = process.env.THEME_SWITCHER_DATA_DIR || resolveRuntimeRoot();
  const bus = new OperationEventBus();

  const images = new ImageStore({
    runtimeRoot,
    picker: async () => {
      const win = BrowserWindow.getFocusedWindow();
      const options: Electron.OpenDialogOptions = {
        title: '选择背景图片',
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      };
      const res = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      if (res.canceled || res.filePaths.length === 0) return null;
      return res.filePaths;
    },
  });

  const targets = new TargetService({ useRegistry: true });
  const themes = new ThemeService(images);
  const operations = new OperationService({ runtimeRoot, targets, images, bus });

  registerHandlers(ipcMain, {
    images,
    targets,
    themes,
    operations,
    bus,
    openExternal: async (url) => {
      await shell.openExternal(url);
    },
  });

  // 进度事件推给所有窗口；renderer 不轮询（T15）
  bus.subscribe((event) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('operation-event', event);
    }
  });

  createWindow();
}

app.whenReady().then(() => {
  bootstrap();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
