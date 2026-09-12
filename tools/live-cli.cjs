/**
 * 真实安装驱动脚本（T62、T63 用）。
 *
 * 与 GUI 走完全相同的服务层与事务逻辑，只是没有窗口，
 * 便于在真机上按步骤执行「预检 → 应用 → 观察 → 换主题 → 恢复」，
 * 也便于把每一步的真实输出贴进验收记录。
 *
 * 用法（先 npm run build）：
 *   node tools/live-cli.cjs status
 *   node tools/live-cli.cjs precheck
 *   node tools/live-cli.cjs apply --image D:\path\to\wallpaper.jpg [--mode auto] [--overlay 0.35] [--panel 0.86] [--blur 0] [--primary #3b6fd4]
 *   node tools/live-cli.cjs restore previous
 *   node tools/live-cli.cjs restore original
 *
 * 退出码：0 成功；1 失败；2 被安全规则拒绝（例如目标正在运行）。
 *
 * 注意：apply 会改写真实安装的应用归档。执行前必须确认目标应用已完全退出。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const OUT = path.join(__dirname, '..', 'out', 'main');
if (!fs.existsSync(path.join(OUT, 'index.js'))) {
  console.error('未找到 out/main，请先执行 npm run build');
  process.exit(1);
}

const { ImageStore } = require(path.join(OUT, 'services', 'image-store'));
const { TargetService } = require(path.join(OUT, 'services', 'target-service'));
const { ThemeService } = require(path.join(OUT, 'services', 'theme-service'));
const { OperationService } = require(path.join(OUT, 'services', 'operation-service'));
const { OperationEventBus } = require(path.join(OUT, 'services', 'events'));

function runtimeRoot() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'OpenCodeThemeSwitcher');
  }
  return path.join(os.homedir(), '.opencode-theme-switcher');
}

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out.flags[key] = next;
        i += 1;
      } else {
        out.flags[key] = 'true';
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function printResult(label, r) {
  if (r.success) {
    console.log(`  [OK] ${label}`);
    return true;
  }
  console.log(`  [FAIL] ${label}: ${r.error.code}`);
  console.log(`         发生了什么：${r.error.message}`);
  console.log(`         该怎么办：${r.error.recoveryHint}`);
  if (r.error.detail) console.log(`         细节：${r.error.detail}`);
  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command) {
    console.error('缺少命令：status | precheck | apply | restore');
    process.exit(1);
  }

  const root = runtimeRoot();
  // 与桌面应用一致：THEME_SWITCHER_NO_REGISTRY=1 时跳过 Windows 卸载登记表
  // （受限环境下查询登记表会被安全策略拦截）
  const targets = new TargetService({
    useRegistry: process.env.THEME_SWITCHER_NO_REGISTRY !== '1',
  });
  const images = new ImageStore({
    runtimeRoot: root,
    picker: async () => (args.flags.image ? [args.flags.image] : null),
  });
  const themes = new ThemeService(images);
  const bus = new OperationEventBus();
  bus.subscribe((e) => console.log(`  … ${e.phase}：${e.message}${e.percent === undefined ? '' : `（${e.percent}%）`}`));
  const operations = new OperationService({ runtimeRoot: root, targets, images, bus });

  console.log(`运行数据目录：${root}`);

  const discovered = await targets.discover();
  if (!printResult('识别安装目标', discovered)) process.exit(1);
  const supported = discovered.data.targets.filter((t) => t.support === 'supported');
  if (supported.length === 0) {
    console.log('  [FAIL] 没有已验证的目标，拒绝继续。已识别到的候选：');
    for (const t of discovered.data.targets) {
      console.log(`         ${t.version} ${t.support} ${t.installPath} ${t.rejectReason ?? ''}`);
    }
    process.exit(2);
  }
  const target = supported[0];
  console.log(`  目标：${target.installPath}  版本 ${target.version}  ${target.support}`);

  if (command === 'status') {
    const backups = await operations.listBackups(target.targetId);
    if (backups.success) {
      console.log('  备份：');
      for (const b of backups.data) {
        console.log(`        ${b.kind}  ${b.createdAt}  版本 ${b.applicableVersion}  pristine=${b.pristine}  ${b.themeSummary}`);
      }
    }
    return;
  }

  if (command === 'precheck') {
    const { precheckTarget } = require(path.join(OUT, '..', 'core', 'patch', 'precheck'));
    const r = await precheckTarget(target);
    if (!printResult('环境预检', r)) process.exit(r.error.code === 'TARGET_RUNNING' ? 2 : 1);
    const d = r.data;
    console.log(`  归档：${d.archivePath}（${(d.archiveSize / 1024 / 1024).toFixed(1)} MB）`);
    console.log(`  进程：${d.processState}　可写：${d.writable}`);
    console.log(`  磁盘：可用 ${(d.freeBytes / 1024 / 1024).toFixed(0)} MB，需要 ${(d.requiredBytes / 1024 / 1024).toFixed(0)} MB`);
    return;
  }

  if (command === 'apply') {
    if (!args.flags.image) {
      console.error('缺少 --image <图片路径>');
      process.exit(1);
    }
    const picked = await images.pick();
    if (!printResult('读取图片', picked)) process.exit(1);
    const imported = await images.import(picked.data.imageId);
    if (!printResult('导入并取色', imported)) process.exit(1);

    const spec = {
      schemaVersion: 1,
      imageId: picked.data.imageId,
      mode: args.flags.mode ?? 'auto',
      palette: imported.data.palette,
      overlayOpacity: Number(args.flags.overlay ?? 0.35),
      panelOpacity: Number(args.flags.panel ?? 0.86),
      blurPx: Number(args.flags.blur ?? 0),
      reducedTransparency: Boolean(args.flags['reduce-transparency']),
      ...(args.flags.primary ? { primary: args.flags.primary } : {}),
    };

    const staged = await operations.stage({ targetId: target.targetId, imageId: spec.imageId, spec });
    if (!printResult('准备（预检 + 生成产物）', staged)) {
      process.exit(staged.error.code === 'TARGET_RUNNING' ? 2 : 1);
    }
    const s = staged.data.summary;
    console.log(`  将变更：${s.changedFiles.join('、')}`);
    console.log(`  备份位置：${s.backupDir}`);
    console.log(`  需要空间：约 ${(s.requiredBytes / 1024 / 1024).toFixed(0)} MB`);
    console.log(`  目标指纹（提交前）：${s.beforeHash.slice(0, 16)}…`);

    const applied = await operations.apply({ operationId: staged.data.operationId });
    if (!printResult('应用', applied)) process.exit(1);
    console.log(`  操作 ID：${applied.data.operationId}`);
    console.log(`  状态：${applied.data.status}　主题：${applied.data.themeSummary}`);
    console.log(`  提交后指纹：${applied.data.afterHash.slice(0, 16)}…`);
    console.log('  下一步：请手动启动 OpenCode 观察效果，确认后完全退出，再执行下一次操作。');
    return;
  }

  if (command === 'restore') {
    const kind = args._[1] === 'original' ? 'original' : 'previous';
    const r = await operations.restore({ targetId: target.targetId, kind });
    if (!printResult(`恢复（${kind}）`, r)) process.exit(r.error.code === 'TARGET_RUNNING' ? 2 : 1);
    console.log(`  操作 ID：${r.data.operationId}　状态：${r.data.status}`);
    console.log(`  提交后指纹：${r.data.afterHash.slice(0, 16)}…`);
    return;
  }

  console.error(`未知命令：${command}`);
  process.exit(1);
}

main().catch((e) => {
  console.error('未预期的错误：', e);
  process.exit(1);
});
