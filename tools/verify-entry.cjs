#!/usr/bin/env node
/**
 * 普通（开发）验证入口（复审 N3）。
 *
 * 问题：旧的 `npm run verify` 顺序是
 *   typecheck → lint → test:unit → test:integration → build → test:e2e
 * 而集成测试明确要求 `out/main/index.js` 存在（`pack.ts` 也要
 * `out/core/patch/pack-worker.js`）。于是：
 *   - 新克隆/无 out 时，先在集成步骤失败，根本走不到 build；
 *   - 有旧 out 时，会先拿**旧产物**验证、再构建新产物——测试与产物不同源。
 * R4 只把发布链（tools/release-build.cjs）的顺序修好了，这个公开入口没有跟上。
 *
 * 现在与发布链保持同一形状：类型/lint/单元 → **一次干净构建** → 集成 → E2E。
 *
 * 为什么单独一个脚本而不是继续用一条 `&&` 长串：
 * 顺序是这次修复的**内容**本身，散落在 package.json 的一行字符串里没法被断言，
 * 也没法让「只跑一次构建」这件事显式。这里把步骤表写成数据，既能被测试读取，
 * 又能保证 build 只出现一次。
 *
 * 用法：
 *   node tools/verify-entry.cjs          # 依次执行全部步骤
 *   node tools/verify-entry.cjs --list   # 只打印步骤表（供测试与排查）
 *   node tools/verify-entry.cjs --from integration   # 从某步开始（排查用，非发布路径）
 *
 * 说明：这只是**开发验证入口**，不是发布验收。发布链见 tools/release-build.cjs，
 * 它还有冻结预检、out 快照复核、候选登记与发布级终检，本脚本不做那些。
 */
'use strict';
const { spawnSync } = require('node:child_process');

const isWin = process.platform === 'win32';
const npmBin = isWin ? 'npm.cmd' : 'npm';

/**
 * 步骤表（顺序即契约）。`requiresOut: true` 表示该步依赖编译产物，
 * 必须排在唯一一次 build 之后 —— N3 的回归测试直接断言这一点。
 */
const STEPS = [
  { name: 'typecheck', cmd: [npmBin, ['run', 'typecheck']], requiresOut: false },
  { name: 'lint', cmd: [npmBin, ['run', 'lint']], requiresOut: false },
  { name: 'unit', cmd: [npmBin, ['run', 'test:unit']], requiresOut: false },
  // 唯一一次干净构建：build:main 会先删 out，再编译主进程与 worker
  { name: 'build', cmd: [npmBin, ['run', 'build']], requiresOut: false, isBuild: true },
  { name: 'integration', cmd: [npmBin, ['run', 'test:integration']], requiresOut: true },
  { name: 'e2e', cmd: [npmBin, ['run', 'test:e2e']], requiresOut: true },
];

function printSteps() {
  for (const [i, s] of STEPS.entries()) {
    const tags = [s.isBuild ? 'BUILD(唯一)' : '', s.requiresOut ? 'needs-out' : ''].filter(Boolean).join(' ');
    console.log(`${String(i + 1).padStart(2)}. ${s.name.padEnd(12)} ${tags}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--list')) {
    printSteps();
    return;
  }

  // 步骤表自检：build 必须恰好一次，且所有 requiresOut 的步骤都在它之后。
  // 这是 N3 的核心不变量，放在运行时也检查一遍（不只靠测试）。
  const buildIdx = [];
  STEPS.forEach((s, i) => {
    if (s.isBuild) buildIdx.push(i);
  });
  if (buildIdx.length !== 1) {
    console.error(`[FAIL] 步骤表必须恰好有一次构建，实际 ${buildIdx.length} 次；顺序本身不可信，拒绝执行。`);
    process.exit(2);
  }
  const buildAt = buildIdx[0];
  const early = STEPS.filter((s, i) => s.requiresOut && i < buildAt).map((s) => s.name);
  if (early.length) {
    console.error(`[FAIL] 依赖 out 的步骤排在构建之前：${early.join('、')}；拒绝执行。`);
    process.exit(2);
  }

  let fromIdx = 0;
  const fromAt = argv.indexOf('--from');
  if (fromAt >= 0) {
    const want = argv[fromAt + 1];
    const idx = STEPS.findIndex((s) => s.name === want);
    if (idx < 0) {
      console.error(`[FAIL] --from 未知步骤：${want}`);
      process.exit(2);
    }
    fromIdx = idx;
    console.log(`[提示] 从步骤「${want}」开始，之前步骤未执行 —— 仅用于排查，不是完整验证。`);
  }

  for (let i = fromIdx; i < STEPS.length; i++) {
    const step = STEPS[i];
    console.log(`\n=== verify/${step.name} ===`);
    // Windows 下 npm 是 .cmd：Node ≥18.20/20.12 出于安全不允许不带 shell 直接
    // spawn .cmd（EINVAL）。这与 release-build.cjs 的 runStep 同一处置。
    const isNpmCmd = isWin && step.cmd[0].toLowerCase().endsWith('.cmd');
    const r = spawnSync(step.cmd[0], step.cmd[1], {
      stdio: 'inherit', windowsHide: true, shell: isNpmCmd,
    });
    if (r.error) {
      console.error(`\nSTOPPED at verify/${step.name}：无法启动（${r.error.message}）`);
      process.exit(1);
    }
    if (r.status !== 0) {
      console.error(`\nSTOPPED at verify/${step.name}（exit=${r.status}）`);
      process.exit(r.status ?? 1);
    }
  }
  console.log('\nVERIFY_OK（开发验证通过；这不是发布验收——发布链见 tools/release-build.cjs）');
}

if (require.main === module) main();

module.exports = { STEPS, printSteps };
