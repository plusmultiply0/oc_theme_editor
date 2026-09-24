import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { registerHandlers } from './ipc';
import { ImageStore } from './services/image-store';
import { TargetService } from './services/target-service';
import { ThemeService } from './services/theme-service';
import { OperationService } from './services/operation-service';
import { RecoveryService } from './services/recovery-service';
import { OperationEventBus } from './services/events';
import { runtimeRoot as resolveRuntimeRoot } from '../core/patch/precheck';
import { DIALOG_EXTENSIONS } from '../shared/image-formats';

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

  // 工具窗口无菜单需求：彻底去掉默认 File/Edit/View/Window/Help 菜单栏
  win.setMenu(null);

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }

  win.once('ready-to-show', () => win.show());
  return win;
}

/**
 * 测试/自动化用的环境开关。
 * GUI 端到端测试必须保证「只看得见合成安装」，否则一旦误选真实安装，
 * 点一下应用就会改写用户的 OpenCode。因此禁用注册表扫描、把候选根目录限定在临时目录。
 */
function targetServiceOptions(): ConstructorParameters<typeof TargetService>[0] {
  const extraRaw = process.env.THEME_SWITCHER_EXTRA_ROOTS ?? '';
  const extraRoots = extraRaw
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
  const useRegistry = process.env.THEME_SWITCHER_NO_REGISTRY !== '1';
  return { useRegistry, ...(extraRoots.length > 0 ? { extraRoots } : {}) };
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
        // 扩展名列表来自共享声明，别名（jfif/jpe）与主进程校验保持同步
        filters: [{ name: '图片', extensions: [...DIALOG_EXTENSIONS] }],
      };
      const res = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      if (res.canceled || res.filePaths.length === 0) return null;
      return res.filePaths;
    },
  });

  const targets = new TargetService(targetServiceOptions());
  const themes = new ThemeService(images);
  const recovery = new RecoveryService({ runtimeRoot });
  const operations = new OperationService({
    runtimeRoot,
    targets,
    images,
    bus,
    // R7：有待人工处理的未完成事务时，后端直接拒绝继续写入
    recoveryGuard: () => recovery.assertClear(),
  });

  registerHandlers(ipcMain, {
    images,
    targets,
    themes,
    operations,
    recovery,
    bus,
    openExternal: async (url) => {
      await shell.openExternal(url);
    },
    pickDirectory: async () => {
      const win = BrowserWindow.getFocusedWindow();
      const options: Electron.OpenDialogOptions = {
        title: '选择 OpenCode 安装目录（应包含 resources 文件夹）',
        properties: ['openDirectory'],
      };
      const res = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      if (res.canceled || res.filePaths.length === 0) return null;
      return res.filePaths[0] ?? null;
    },
  });

  // 进度事件推给所有窗口；renderer 不轮询（T15）
  bus.subscribe((event) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('operation-event', event);
    }
  });

  /*
   * R7：启动即扫描本工具登记过的未完成事务，并清理残留准备区。
   * 界面在挂载时通过 getRecoveryStatus 读取，不依赖这条广播。
   *
   * A2：清理孤儿图片副本要在 bootstrap **之前**先取引用集合
   * （bootstrap 会清掉准备区目录，之后就读不到了）。
   * 顺序：读引用 → bootstrap（清准备区）→ 清没人引用的副本与缩略图。
   * 清理只动本工具自己的 content/ 与 thumbnails/，不递归、不碰用户目录。
   */
  void (async () => {
    const referenced = await operations.stagedImageIds().catch(() => new Set<string>());
    await recovery.bootstrap().catch(() => undefined);
    await images.cleanOrphanCaches(referenced).catch(() => undefined);
  })();

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
