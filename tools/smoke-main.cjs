/**
 * 冒烟脚本：在真实 Electron 运行时里装配服务层，只做只读识别然后退出。
 * 用来验证「主进程能起来、IPC 依赖能加载、目标识别可用」，
 * 不做任何写入，不启动窗口，不改动安装。
 *
 * 用法：npm run build && npx electron tools/smoke-main.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

app.whenReady().then(async () => {
  const out = path.join(__dirname, '..', 'out', 'main');
  const { ImageStore } = require(path.join(out, 'services', 'image-store'));
  const { TargetService } = require(path.join(out, 'services', 'target-service'));
  const { ThemeService } = require(path.join(out, 'services', 'theme-service'));
  const { OperationService } = require(path.join(out, 'services', 'operation-service'));
  const { OperationEventBus } = require(path.join(out, 'services', 'events'));

  const runtimeRoot = path.join(app.getPath('userData'), 'runtime');
  const targets = new TargetService({ useRegistry: true });
  const images = new ImageStore({ runtimeRoot, picker: async () => null });
  const themes = new ThemeService(images);
  const operations = new OperationService({ runtimeRoot, targets, images, bus: new OperationEventBus() });

  const discovered = await targets.discover();
  const summary = {
    electron: process.versions.electron,
    runtimeRoot,
    scanned: discovered.success ? discovered.data.scanned : [],
    targets: discovered.success
      ? discovered.data.targets.map((t) => ({
          targetId: t.targetId,
          version: t.version,
          support: t.support,
          installPath: t.installPath,
          fingerprint: t.fingerprint.slice(0, 12),
        }))
      : [],
    rejected: discovered.success ? discovered.data.rejected : [],
    servicesLoaded: Boolean(themes && operations),
  };
  // Windows 上 Electron 是 GUI 子系统进程，stdout 不一定能回传到终端，统一落文件
  const outFile = path.join(__dirname, 'smoke-result.json');
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2), 'utf8');
  console.log('SMOKE_RESULT ' + outFile);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
