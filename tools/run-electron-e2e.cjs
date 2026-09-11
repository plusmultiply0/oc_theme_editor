#!/usr/bin/env node
/**
 * 真实 Electron 主进程端到端闭环的启动器（R1 验收、R8 门禁）。
 *
 * 单独做成脚本的原因：
 * - 必须清掉 `ELECTRON_RUN_AS_NODE`，否则 electron 会以纯 Node 身份启动，主进程根本不跑；
 * - Windows 上 Electron 是 GUI 子系统进程，stdout 不一定回传终端，所以结果统一看 JSON；
 * - 退出码必须体现真实结论：0 通过，1 有失败用例或环境不具备。
 *
 * 用法：npm run build && npm run test:e2e:electron
 * 也可以直接跑：node tools/run-electron-e2e.cjs
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HARNESS = path.join(__dirname, 'electron-fixture-e2e.cjs');
const RESULT = path.join(__dirname, 'electron-fixture-e2e-result.json');
const TIMEOUT_MS = 150_000;

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

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out', 'main', 'index.js'))) {
    console.error('缺少 out/ 构建产物：请先 npm run build');
    process.exit(1);
  }
  const bin = electronBinary();
  if (!bin) {
    console.error('找不到 electron 可执行文件：请先 npm install');
    process.exit(1);
  }

  fs.rmSync(RESULT, { force: true });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(
    bin,
    [
      // 无显示会话下 GPU 子进程会反复重启，必须关掉相关子进程
      '--disable-gpu',
      '--no-sandbox',
      '--disable-gpu-compositing',
      '--disable-software-rasterizer',
      '--in-process-gpu',
      '--disable-dev-shm-usage',
      HARNESS,
    ],
    { cwd: ROOT, env, stdio: 'ignore', windowsHide: true },
  );
  child.on('error', (e) => {
    console.error(`启动 Electron 失败：${e.message}`);
    process.exit(1);
  });

  // 等结果文件落盘，而不是等子进程退出（它的退出流程不可靠，见 docs/acceptance.md 6.1）
  const started = Date.now();
  for (;;) {
    if (fs.existsSync(RESULT)) break;
    if (Date.now() - started > TIMEOUT_MS) {
      child.kill();
      console.error(`等待 Electron 闭环结果超时（${Math.round(TIMEOUT_MS / 1000)}s），${RESULT} 未生成`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();

  const report = JSON.parse(fs.readFileSync(RESULT, 'utf8'));
  for (const c of report.cases ?? []) {
    console.log(`${c.ok ? '[OK]  ' : '[FAIL]'} ${c.name}${c.detail ? ` | ${c.detail}` : ''}`);
  }
  if (report.fatal) console.error(`致命错误：${report.fatal}`);
  const cases = report.cases ?? [];
  console.log(`\nElectron ${report.electron ?? '?'}：${cases.length - (report.failed ?? 0)}/${cases.length} 通过`);
  process.exit((report.failed ?? 1) === 0 && !report.fatal ? 0 : 1);
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
