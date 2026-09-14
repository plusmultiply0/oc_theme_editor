#!/usr/bin/env node
/**
 * P3 统一发布编排入口（tools/release-build.cjs）的链路行为测试。
 *
 * 设计：编排器支持**仅测试**的 OTS_STEP_STUB 接口（JSON 步骤→退出码），命中时
 * 该步不执行真实子进程、直接返回给定码。这样可在无 npm/打包依赖的独立夹具里
 * 覆盖「每步失败、退出码保留、后续不执行、无 ALL_GREEN」，而无需真实构建。
 *
 * 覆盖：
 *   - 冻结预检：源码改脏 / 新增未跟踪源码 → 构建前拒绝（一步不跑）；
 *   - 候选目录已存在 → 拒绝覆盖；
 *   - 逐步失败：typecheck/lint/test:unit/test:integration/build/audit/dist/zip/
 *     verify-package/register/verify:release —— 退出码原样保留、后续未执行；
 *   - 全绿路径：步骤顺序与预期一致、打印 ALL_GREEN；
 *   - verify 模式：缺 buildId → exit 2；manifest 缺失 → 失败关闭不构建；
 *   - 未知模式 → exit 2；
 *   - mock 清除继承的绑定变量（GATE_*），再按场景注入。
 *
 * 用法：node tools/test-release-gate.cjs
 * 退出码：0 全部通过；1 有失败。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'tools', 'release-build.cjs');

const rmDir = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

/** 步骤顺序（含 node 侧步骤），用于断言「后续未执行」。
 *  测试统一传 --skip-gui，故不含 smoke:gui。 */
const STEP_ORDER = [
  'typecheck', 'lint', 'test:unit', 'test:integration', 'build',
  'test:e2e', 'test:e2e:electron', 'audit', 'dist', 'verify-package',
  'zip', 'register', 'verify:release',
];

/** 建立独立 Git 夹具仓库（已提交一次，工作树干净）。 */
function makeFixture(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const v = 1;\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.1.0-alpha.1' }, null, 2));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }, null, 2));
  fs.writeFileSync(path.join(root, '.gitignore'), 'out/\ndist/\ncandidate-*/\nnode_modules/\n');
  const g = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@example.invalid']);
  g(['config', 'user.name', 't']);
  g(['config', 'commit.gpgsign', 'false']);
  g(['add', '.']);
  g(['commit', '-q', '-m', 'init']);
  return root;
}

/** 执行编排器（夹具内；清除继承绑定变量后按场景注入 OTS_STEP_STUB）。 */
function runOrch(root, args, { stepStub, ...env } = {}) {
  const baseEnv = { ...process.env };
  // P3：清除继承的绑定变量，避免外层环境干扰
  delete baseEnv.GATE_MANIFEST;
  delete baseEnv.GATE_CANDIDATE_DIR;
  delete baseEnv.GATE_BUILD_ID;
  if (stepStub) baseEnv.OTS_STEP_STUB = JSON.stringify(stepStub);
  else delete baseEnv.OTS_STEP_STUB;
  const r = spawnSync(process.execPath, [BUILD, '--root', root, ...args, '--skip-gui'], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000,
    env: { ...baseEnv, ...env },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** 从输出里解析实际执行的步骤序列（`=== name ===` 段）。 */
function executedSteps(stdout) {
  return [...stdout.matchAll(/^=== (.+) ===$/gm)].map((m) => m[1]);
}

const failures = [];
function expect(cond, label, detail) {
  if (cond) console.log(`  PASS  ${label}`);
  else { console.error(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); failures.push(label); }
}

// ---------- 1) 冻结预检：源码改脏 ----------
{
  console.log('\n== 冻结预检：源码改脏 → 构建前拒绝 ==');
  const root = makeFixture('orch-dirty-');
  fs.appendFileSync(path.join(root, 'src', 'index.ts'), '// dirty\n');
  const r = runOrch(root, ['build', 'b-dirty']);
  expect(r.status === 1, '源码改脏时退出 1', `实际 ${r.status}`);
  expect(executedSteps(r.stdout).length === 0, '源码改脏时一步都不执行', `实际 ${executedSteps(r.stdout).join(',')}`);
  expect(!r.stdout.includes('ALL_GREEN'), '源码改脏时不打印 ALL_GREEN');
  expect(/源码未冻结/.test(r.stdout + r.stderr), '给出「源码未冻结」原因');
  rmDir(root);
}

// ---------- 2) 冻结预检：新增未跟踪源码 ----------
{
  console.log('\n== 冻结预检：新增未跟踪源码 → 拒绝 ==');
  const root = makeFixture('orch-untracked-');
  fs.writeFileSync(path.join(root, 'src', 'extra.ts'), 'export const x = 1;\n');
  const r = runOrch(root, ['build', 'b-untracked']);
  expect(r.status === 1, '新增未跟踪源码时退出 1', `实际 ${r.status}`);
  expect(executedSteps(r.stdout).length === 0, '一步都不执行');
  expect(/未跟踪源码/.test(r.stdout + r.stderr), '明确指认未跟踪源码');
  rmDir(root);
}

// ---------- 3) 候选目录已存在 → 拒绝覆盖 ----------
{
  console.log('\n== 候选目录已存在 → 拒绝覆盖 ==');
  const root = makeFixture('orch-exists-');
  fs.mkdirSync(path.join(root, 'candidate-b-exists'), { recursive: true });
  const r = runOrch(root, ['build', 'b-exists']);
  expect(r.status === 1, '候选目录已存在时退出 1', `实际 ${r.status}`);
  expect(/已存在，禁止覆盖/.test(r.stdout + r.stderr), '给出「禁止覆盖」原因');
  expect(executedSteps(r.stdout).length === 0, '禁止覆盖时一步都不执行');
  rmDir(root);
}

// ---------- 4) 逐步失败：退出码保留、后续未执行、无 ALL_GREEN ----------
const FAIL_STEPS = ['typecheck', 'lint', 'test:unit', 'test:integration', 'build',
  'audit', 'dist', 'zip', 'verify-package', 'register', 'verify:release'];
for (const name of FAIL_STEPS) {
  const code = 41 + FAIL_STEPS.indexOf(name);
  console.log(`\n== 失败传播：${name} 返回 ${code} ==`);
  const root = makeFixture(`orch-fail-${name.replace(/[:.]/g, '_')}-`);
  // 前置步骤全部桩 0（避免真实 npm/tsc/vitest 在夹具里跑），只让目标步骤失败
  const stub = {};
  for (const s of STEP_ORDER) stub[s] = 0;
  stub[name] = code;
  const r = runOrch(root, ['build', 'b-fail'], { stepStub: stub });
  const steps = executedSteps(r.stdout);
  const combined = r.stdout + r.stderr;
  expect(r.status === code, `${name}=${code} 时整体退出码为 ${code}`, `实际 ${r.status}`);
  expect(steps.includes(name), `${name} 步骤确实执行`, `实际 ${steps.join(',')}`);
  const idx = steps.indexOf(name);
  const after = steps.slice(idx + 1);
  expect(after.length === 0, `${name} 失败后无后续步骤`, `后来还跑了 ${after.join(',')}`);
  expect(!combined.includes('ALL_GREEN'), `${name} 失败时不打印 ALL_GREEN`);
  expect(new RegExp(`STOPPED at ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(combined),
    `${name} 失败时打印 STOPPED`, `尾部：${combined.split('\n').slice(-3).join(' | ')}`);
  rmDir(root);
}

// ---------- 5) 全绿路径（全部步骤桩 0）：步骤齐全、ALL_GREEN ----------
{
  console.log('\n== 全绿路径 ==');
  const root = makeFixture('orch-green-');
  const stub = {};
  for (const s of STEP_ORDER) stub[s] = 0;
  const r = runOrch(root, ['build', 'b-green'], { stepStub: stub });
  const steps = executedSteps(r.stdout);
  expect(r.status === 0, '全绿时退出 0', `实际 ${r.status}`);
  expect(steps.join(',') === STEP_ORDER.join(','), '步骤顺序与预期完全一致', `实际 ${steps.join(',')}`);
  expect(r.stdout.includes('ALL_GREEN'), '全绿时打印 ALL_GREEN');
  rmDir(root);
}

// ---------- 6) verify 模式：缺 buildId → exit 2 ----------
{
  console.log('\n== verify 模式缺 buildId → exit 2 ==');
  const root = makeFixture('orch-verify-nobid-');
  const r = runOrch(root, ['verify']);
  expect(r.status === 2, 'verify 缺 buildId 时退出 2', `实际 ${r.status}`);
  expect(/用法/.test(r.stdout + r.stderr), '给出用法提示');
  expect(executedSteps(r.stdout).length === 0, '一步都不执行');
  rmDir(root);
}

// ---------- 7) verify 模式：manifest 缺失 → 失败关闭（不构建） ----------
{
  console.log('\n== verify 模式 manifest 缺失 → 失败关闭（不构建） ==');
  const root = makeFixture('orch-verify-nomanifest-');
  const r = runOrch(root, ['verify', 'b-missing']);
  expect(r.status === 1, 'manifest 缺失时退出 1', `实际 ${r.status}`);
  expect(!r.stdout.includes('ALL_GREEN') && !r.stdout.includes('RELEASE_VERIFY_GREEN'), '不打印全绿');
  expect(executedSteps(r.stdout).length === 0, '缺 manifest 时一步都不执行（不构建）');
  expect(/找不到登记/.test(r.stdout + r.stderr), '明确报告找不到登记');
  rmDir(root);
}

// ---------- 8) 未知模式 → exit 2 ----------
{
  console.log('\n== 未知模式 → exit 2 ==');
  const root = makeFixture('orch-badmode-');
  const r = runOrch(root, ['frobnicate']);
  expect(r.status === 2, '未知模式退出 2', `实际 ${r.status}`);
  rmDir(root);
}

if (failures.length) {
  console.error(`\n${failures.length} 项断言失败`);
  process.exit(1);
}
console.log('\nP3 发布编排链路行为测试：全部通过');
