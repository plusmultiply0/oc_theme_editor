/**
 * 真实 Electron 主进程下的端到端闭环（R1 验收、R7 启动恢复）。
 *
 * 为什么必须单独跑在 Electron 里：
 * Node 下 `fs` 与 Electron 下被包装过的 `fs` 语义不同（`app.asar` 会被当成虚拟目录）。
 * P0 审查 R1 的缺陷正是「Node 测试全绿、真实 Electron 一跑就识别不到目标」，
 * 只在 Node 里加测试永远抓不到它。
 *
 * 本脚本：
 *   1. 在临时目录构造合成安装（含一层原型时代的 snow-theme.css，用于验证旧主题迁移）；
 *   2. 用打包产物 out/ 里的真实服务层跑 识别 → 生成 → 准备 → 应用 → 恢复；
 *   3. 另起一个实例检查启动恢复扫描能读到未完成事务；
 *   4. 全程只碰临时目录，**不触碰任何真实安装**。
 *
 * 不创建窗口（无显示会话也能跑），结果落 JSON 文件供测试断言，退出码非 0 即有用例失败。
 *
 * 用法：
 *   npm run build
 *   node tools/electron-fixture-e2e.cjs            # 普通 Node 下会提示需要 Electron
 *   npm run test:e2e:electron
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

// 无显示会话下 GPU 进程会反复重启并 FATAL，直接关掉硬件加速
app.disableHardwareAcceleration();

const OUT = path.join(__dirname, '..', 'out', 'main');
const RESULT = path.join(__dirname, 'electron-fixture-e2e-result.json');

/** 1x1 PNG，够跑通导入与取色，不依赖任何外部素材 */
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const LEGACY_CSS = [
  '/* 原型时代注入的雪景主题，用于验证旧主题迁移 */',
  'html, body, #root {',
  '  --snow-primary: #a0a7c9;',
  '  --background-base: #404558;',
  '}',
].join('\n');

const LEGACY_HTML = [
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <meta charset="utf-8" />',
  '    <title>OpenCode</title>',
  '    <link rel="stylesheet" crossorigin href="./assets/main-fixture.css">',
  '    <link rel="stylesheet" href="./snow-theme.css" data-local-theme="snowfield">',
  '  </head>',
  '  <body><div id="root"></div></body>',
  '</html>',
  '',
].join('\n');

function makeSyntheticInstall(base) {
  const srcDir = path.join(base, '_src');
  const root = path.join(base, 'install');
  const write = (p, c) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c);
  };
  write(
    path.join(srcDir, 'package.json'),
    JSON.stringify({ name: '@opencode-ai/desktop', version: '1.18.29', main: './out/main/index.js' }, null, 2),
  );
  write(path.join(srcDir, 'out/main/index.js'), 'console.log(1);');
  write(path.join(srcDir, 'out/renderer/index.html'), LEGACY_HTML);
  write(path.join(srcDir, 'out/renderer/snow-theme.css'), LEGACY_CSS);
  write(path.join(srcDir, 'out/renderer/snow-background.jpg'), 'fake-jpg');
  write(path.join(srcDir, 'out/renderer/assets/main-fixture.css'), ':root{--x:1}');
  write(path.join(srcDir, 'node_modules/native/x.node'), 'native-binary');

  fs.mkdirSync(path.join(root, 'resources'), { recursive: true });
  const archivePath = path.join(root, 'resources', 'app.asar');
  fs.writeFileSync(path.join(root, 'OpenCode.exe'), 'MZ-placeholder');

  const { createPackageWithOptions } = require('@electron/asar');
  // 造 fixture 时也临时关掉 asar 解释：否则包装 fs 会把归档路径注册进 Electron 的
  // 进程级 asar 缓存并长期持有文件句柄，导致后续 rename 覆盖失败（真机表现为 FILE_LOCKED）。
  const prevNoAsar = process.noAsar;
  process.noAsar = true;
  try {
    return createPackageWithOptions(srcDir, archivePath, { unpack: '*.node' }).then(() => ({
      root,
      archivePath,
    }));
  } finally {
    process.noAsar = prevNoAsar;
  }
}

function loadCore() {
  return {
    physicalFs: require(path.join(__dirname, '..', 'out', 'core', 'patch', 'physical-fs')),
    archiveIo: require(path.join(__dirname, '..', 'out', 'core', 'patch', 'archive-io')),
    asar: require(path.join(__dirname, '..', 'out', 'core', 'patch', 'asar')),
    apply: require(path.join(__dirname, '..', 'out', 'core', 'patch', 'apply')),
    restore: require(path.join(__dirname, '..', 'out', 'core', 'patch', 'restore')),
    recovery: require(path.join(__dirname, '..', 'out', 'core', 'patch', 'recovery')),
    layout: require(path.join(__dirname, '..', 'out', 'core', 'patch', 'layout')),
    ImageStore: require(path.join(OUT, 'services', 'image-store')).ImageStore,
    TargetService: require(path.join(OUT, 'services', 'target-service')).TargetService,
    ThemeService: require(path.join(OUT, 'services', 'theme-service')).ThemeService,
    OperationService: require(path.join(OUT, 'services', 'operation-service')).OperationService,
    OperationEventBus: require(path.join(OUT, 'services', 'events')).OperationEventBus,
  };
}

/** 全流程共用一个记录器：即使中途抛错，已经跑过的断言也要落盘 */
const CASES = [];
function check(name, ok, detail) {
  CASES.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
  return Boolean(ok);
}

async function run() {
  const core = loadCore();

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-e2e-'));
  const runtimeRoot = path.join(base, 'runtime');
  // asar 库会按路径缓存文件句柄，不释放的话 Windows 上删不掉临时目录
  const cleanup = () => {
    try {
      core.archiveIo.uncacheArchive(path.join(base, 'install', 'resources', 'app.asar'));
    } catch {
      /* 忽略 */
    }
    try {
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch (e) {
      // 清理失败不属于产品缺陷：临时目录会由系统回收，只记一条提示
      console.log(`CLEANUP_WARN ${base} 未删除：${e.message.split('\n')[0]}`);
    }
  };

  try {
    // ---------- 0. 物理 I/O 层确实生效 ----------
    check(
      '物理 I/O 层使用 original-fs',
      core.physicalFs.physicalFsSource() === 'original-fs',
      core.physicalFs.physicalFsSource(),
    );

    const inst = await makeSyntheticInstall(base);

    /*
     * Electron 包装 fs 会把 app.asar 当虚拟目录，物理层必须纠正它。
     * 注意：这里**故意用另一个归档**做对照，不能拿真正要提交的目标做实验 ——
     * 一旦包装 fs 碰过某个 .asar，Electron 会把它连同打开的文件句柄一起缓存进进程，
     * 于是该文件在进程存活期间无法被 rename 覆盖（真机表现为提交阶段 FILE_LOCKED）。
     * 这也是产品侧必须一律走物理层的原因之一。
     */
    const probeAsar = path.join(base, 'probe-copy.asar');
    core.physicalFs.physicalFs.copyFileSync(inst.archivePath, probeAsar);
    const wrapped = fs.statSync(probeAsar);
    const physical = core.physicalFs.physicalFs.statSync(probeAsar);
    check('包装 fs 把归档误判为目录', wrapped.isFile() === false && wrapped.size === 0, `isFile=${wrapped.isFile()} size=${wrapped.size}`);
    check('物理层正确识别归档为文件', physical.isFile() === true && physical.size > 0, `isFile=${physical.isFile()} size=${physical.size}`);

    // ---------- 1. 识别 ----------
    // localAppData 传空串：候选根目录只保留本 fixture，绝不把真实安装拉进来
    const targets = new core.TargetService({
      useRegistry: false,
      localAppData: '',
      extraRoots: [inst.root],
    });
    const discovered = await targets.discover();
    check('Electron 下能识别合成安装', discovered.success && discovered.data.targets.length === 1, JSON.stringify(discovered).slice(0, 300));
    if (!discovered.success || discovered.data.targets.length === 0) throw new Error('识别失败，后续步骤无法继续');
    const target = discovered.data.targets[0];
    // 硬保险：目标必须落在临时目录里，否则立刻停手，绝不碰真实安装
    if (!target.installPath.toLowerCase().startsWith(base.toLowerCase())) {
      throw new Error(`隔离检查失败：识别到的目标不在临时目录内 → ${target.installPath}`);
    }
    check('目标被限制在临时目录内（隔离保险）', true, target.installPath);
    check('识别为 supported', target.support === 'supported', `${target.version} ${target.support}`);

    // ---------- 2. 生成主题（验证 sharp 在 Electron 下可加载） ----------
    const imagePath = path.join(base, 'wallpaper.png');
    fs.writeFileSync(imagePath, ONE_PX_PNG);
    const images = new core.ImageStore({ runtimeRoot, picker: async () => [imagePath] });
    const themes = new core.ThemeService(images);
    const picked = await images.pick();
    check('在 Electron 下读取图片', picked.success, picked.success ? '' : picked.error.code);
    const imported = picked.success ? await images.import(picked.data.imageId) : null;
    const importedOk = Boolean(imported && imported.success);
    check(
      'sharp 在 Electron 下可解码并取色',
      importedOk && imported.data.palette.length > 0,
      importedOk ? imported.data.palette.join(',') : imported ? imported.error.message : 'no import',
    );
    const imageId = importedOk ? picked.data.imageId : 'missing';

    const spec = {
      schemaVersion: 1,
      imageId,
      mode: 'dark',
      palette: importedOk ? imported.data.palette : ['#1d2433'],
      overlayOpacity: 0.35,
      panelOpacity: 0.86,
      blurPx: 0,
      reducedTransparency: false,
    };
    const generated = await themes.generate({ imageId: spec.imageId, spec });
    check('Electron 下生成主题 CSS', generated.success, generated.success ? `${generated.data.css.length} bytes` : generated.error.message);

    // ---------- 3. 准备 + 应用（走真实服务层，含旧主题迁移） ----------
    const bus = new core.OperationEventBus();
    const operations = new core.OperationService({ runtimeRoot, targets, images, bus, probe: async () => 'idle' });

    const beforeHash = await core.asar.sha256File(inst.archivePath);
    const staged = await operations.stage({ targetId: target.targetId, imageId: spec.imageId, spec });
    check('准备阶段成功', staged.success, staged.success ? staged.data.summary.operationId : `${staged.error.code}: ${staged.error.message}`);
    if (!staged.success) throw new Error('准备失败，后续步骤无法继续');
    check(
      '准备阶段列出会撤下的旧主题层',
      staged.data.summary.legacyThemes.some((l) => l.id === 'prototype-local-theme'),
      JSON.stringify(staged.data.summary.legacyThemes),
    );
    check(
      '准备阶段一个字节都没动目标',
      (await core.asar.sha256File(inst.archivePath)) === beforeHash,
      '',
    );

    const applied = await operations.apply({ operationId: staged.data.operationId });
    check(
      '应用成功',
      applied.success,
      applied.success
        ? applied.data.status
        : `${applied.error.code}: ${applied.error.message} | detail=${applied.error.detail ?? ''}`,
    );
    if (!applied.success) throw new Error('应用失败');
    const afterHash = await core.asar.sha256File(inst.archivePath);
    check('应用后归档指纹变化', afterHash !== beforeHash, `${beforeHash.slice(0, 12)} → ${afterHash.slice(0, 12)}`);

    // 归档库开关必须已经恢复
    check('归档操作窗口已关闭（noAsar 无泄漏）', core.archiveIo.archiveIoNoAsarOpen() === false, '');
    check('归档操作深度已归零', core.archiveIo.archiveIoDepth() === 0, '');

    // ---------- 4. 写入结果复核 ----------
    const snap = await core.asar.readAsar(inst.archivePath);
    check('应用后仍能解析归档头', snap.success, snap.success ? `${snap.data.size} bytes` : snap.error.code);
    if (snap.success) {
      const files = core.asar.listAsarFiles(snap.data.header);
      check('归档条目含本工具 CSS', files.includes('out/renderer/oc-theme-custom.css'), '');
      check('归档条目含本工具背景图', files.includes('out/renderer/oc-theme-background.jpg'), '');
      check('旧主题文件保留在归档中（可恢复）', files.includes('out/renderer/snow-theme.css'), '');
      const html = await core.asar.readAsarText(snap.data, 'out/renderer/index.html');
      if (html.success) {
        check('HTML 已撤下旧主题链接', !html.data.includes('snow-theme.css'), '');
        check('HTML 含本工具主题链接', html.data.includes('oc-theme-custom.css'), '');
      } else {
        check('读取 HTML', false, html.error.code);
      }
      const stage = require(path.join(__dirname, '..', 'out', 'core', 'patch', 'stage'));
      const unpacked = stage.collectUnpacked(snap.data.header);
      check('unpacked 标记被保留', unpacked.size > 0, `unpacked=${unpacked.size}`);
    }

    // 备份语义：无出厂证据 → takeover 而不是 original
    const backups = await operations.listBackups(target.targetId);
    check('能列出备份', backups.success, '');
    if (backups.success) {
      const kinds = backups.data.map((b) => b.kind);
      check('不冒充原版：给出 takeover 而非 original', kinds.includes('takeover') && !kinds.includes('original'), kinds.join(','));
      check('上一主题备份存在', kinds.includes('previous'), kinds.join(','));
    }

    // ---------- 5. 恢复闭环 ----------
    const restorePrev = await operations.restore({ targetId: target.targetId, kind: 'previous' });
    check('恢复上一主题成功', restorePrev.success, restorePrev.success ? '' : `${restorePrev.error.code}`);
    check('恢复上一主题后回到应用前指纹', (await core.asar.sha256File(inst.archivePath)) === beforeHash, '');

    const restoreOriginal = await operations.restore({ targetId: target.targetId, kind: 'original' });
    check(
      '无出厂证据时「恢复原版」被拒绝',
      !restoreOriginal.success && restoreOriginal.error.code === 'BACKUP_MISSING',
      restoreOriginal.success ? 'unexpected success' : restoreOriginal.error.message,
    );

    const restoreSnap = await operations.restore({ targetId: target.targetId, kind: 'takeover' });
    check('恢复首次接管快照成功', restoreSnap.success, restoreSnap.success ? '' : `${restoreSnap.error.code}`);
    check('快照恢复后指纹与最初一致', (await core.asar.sha256File(inst.archivePath)) === beforeHash, '');
    check(
      '快照恢复后旧主题链接回到 HTML（说明恢复到的是接管时状态）',
      await (async () => {
        const s = await core.asar.readAsar(inst.archivePath);
        if (!s.success) return false;
        const h = await core.asar.readAsarText(s.data, 'out/renderer/index.html');
        return h.success && h.data.includes('snow-theme.css');
      })(),
      '',
    );

    // ---------- 6. 启动恢复扫描（R7） ----------
    const layout = core.layout.runtimeDirs(runtimeRoot, require(path.join(__dirname, '..', 'out', 'core', 'patch', 'paths')).instanceIdFromPath(target.installPath));
    await core.layout.ensureDirs(layout);
    const { writeTx } = require(path.join(__dirname, '..', 'out', 'core', 'patch', 'txlog'));
    const currentHash = await core.asar.sha256File(inst.archivePath);
    await writeTx(layout.txDir, {
      schema: 1,
      operationId: 'op-e2e-interrupted',
      targetId: target.targetId,
      version: target.version,
      adapterId: target.adapterId,
      beforeHash: currentHash,
      afterHash: currentHash,
      backupHash: currentHash,
      backupPath: inst.archivePath,
      themeSummary: '模拟中断的操作',
      status: 'committing',
      createdAt: new Date().toISOString(),
      kind: 'apply',
      phases: [{ phase: 'committing', at: new Date().toISOString() }],
      targetPath: inst.archivePath,
    });
    const scans = await core.recovery.scanAllPending(runtimeRoot);
    const pendingCount = scans.reduce((n, s) => n + s.pending.length, 0);
    check('启动恢复扫描能读到未完成事务', pendingCount === 1, `pending=${pendingCount}`);
    check(
      '未完成事务被判定为「已应用但未记账」',
      pendingCount === 1 && scans[0].pending[0].state === 'applied',
      pendingCount === 1 ? scans[0].pending[0].state : '',
    );
    const cleaned = await core.recovery.cleanAllStages(runtimeRoot);
    check('启动清理遗留准备区', cleaned >= 1, `cleaned=${cleaned}`);

    return { cases: CASES };
  } finally {
    cleanup();
  }
}

app.whenReady().then(async () => {
  let payload;
  try {
    const { cases } = await run();
    payload = {
      electron: process.versions.electron,
      node: process.versions.node,
      ranAt: new Date().toISOString(),
      cases,
      failed: cases.filter((c) => !c.ok).length,
      total: cases.length,
    };
  } catch (e) {
    payload = {
      electron: process.versions.electron,
      fatal: String(e && e.stack ? e.stack : e),
      cases: CASES,
      failed: CASES.filter((c) => !c.ok).length + 1,
      total: CASES.length,
    };
  }
  fs.writeFileSync(RESULT, JSON.stringify(payload, null, 2), 'utf8');
  const code = payload.failed === 0 ? 0 : 1;
  console.log(`ELECTRON_FIXTURE_E2E ${payload.failed === 0 ? 'PASS' : 'FAIL'} ${RESULT}`);
  /*
   * 直接 process.exit，不用 app.exit()：
   * 结果文件是同步写盘的，这里已经没有需要 flush 的东西；
   * 而无显示会话下 GPU 子进程会反复重启，曾把 app.exit() 的退出流程拖住 3 分钟，
   * 调用方（测试与发布门禁）不能为它等。
   */
  process.exit(code);
});

app.on('window-all-closed', () => app.quit());
