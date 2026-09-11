#!/usr/bin/env node
/**
 * 生成界面截图（文档用），全部在临时目录里跑，不触碰任何真实安装。
 *
 * 用法：
 *   npm run build
 *   node tools/capture-ui.cjs            # 输出 docs/images/ui-preview.png
 *
 * 隔离手段与 E2E 一致：LOCALAPPDATA 指向临时目录、关掉注册表扫描、
 * 运行数据目录也放临时目录；截图前断言目标路径在临时目录内。
 */
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ARGS = process.argv.slice(2);
// 放在 handoff/：截图是本地诊断素材（含本机路径），不是交付文档
const OUT = ARGS[0] ? path.resolve(ARGS[0]) : path.join(ROOT, 'handoff', 'images', 'ui-preview.png');

function electronBinary() {
  const candidates =
    process.platform === 'win32'
      ? [path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')]
      : [
          path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron'),
          path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
        ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function main() {
  if (!fs.existsSync(path.join(ROOT, 'out', 'main', 'index.js'))) {
    console.error('缺少 out/ 构建产物：请先 npm run build');
    process.exit(1);
  }
  const bin = electronBinary();
  if (!bin) {
    console.error('找不到 electron 可执行文件：请先 npm install');
    process.exit(1);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-capture-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.OTS_CAPTURE_WORK = work;
  env.OTS_CAPTURE_OUT = OUT;
  env.LOCALAPPDATA = path.join(work, 'localappdata');
  env.THEME_SWITCHER_DATA_DIR = path.join(work, 'runtime');
  env.THEME_SWITCHER_NO_REGISTRY = '1';

  const script = path.join(__dirname, 'capture-ui-main.cjs');
  const r = spawnSync(bin, ['--disable-gpu', '--no-sandbox', '--disable-gpu-compositing', '--disable-software-rasterizer', '--in-process-gpu', '--disable-dev-shm-usage', script], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    windowsHide: true,
    timeout: 180000,
  });

  try {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  } catch {
    console.log(`CLEANUP_WARN ${work} 未删除（临时目录由系统回收）`);
  }

  if (r.status !== 0) {
    console.error(`截图失败：exit=${r.status}`);
    process.exit(1);
  }
  console.log(`截图已写出：${OUT}`);
}

main();
