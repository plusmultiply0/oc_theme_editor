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
 *   - **任务 C**：带 --skip-gui/--skip-e2e 的开发构建只能得到 `DEV_BUILD_COMPLETE`
 *     且 `releaseEligible=false`，**不得**打印发布 `ALL_GREEN`；`--strict` 下非 0；
 *   - **任务 C**：测试注入环境（OTS_STEP_STUB）不得取得发布资格；
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
 *  默认测试传 --skip-gui（开发构建），此时步骤里不含 smoke:gui；
 *  releaseMode 时不加 skip，步骤含 smoke:gui。 */
const STEP_ORDER = [
  'typecheck', 'lint', 'test:unit', 'test:integration', 'build',
  'test:e2e', 'test:e2e:electron', 'audit', 'dist', 'verify-package',
  'zip', 'register', 'verify:release',
];
/** 发布模式（不跳任何步骤）下的完整步骤顺序 */
const STEP_ORDER_RELEASE = [
  'typecheck', 'lint', 'test:unit', 'test:integration', 'build',
  'test:e2e', 'test:e2e:electron', 'audit', 'dist', 'smoke:gui', 'verify-package',
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
function runOrch(root, args, { stepStub, releaseMode, allowStubEnv, ...env } = {}) {
  const baseEnv = { ...process.env };
  // P3：清除继承的绑定变量，避免外层环境干扰
  delete baseEnv.GATE_MANIFEST;
  delete baseEnv.GATE_CANDIDATE_DIR;
  delete baseEnv.GATE_BUILD_ID;
  if (stepStub) baseEnv.OTS_STEP_STUB = JSON.stringify(stepStub);
  else delete baseEnv.OTS_STEP_STUB;
  if (allowStubEnv === false) delete baseEnv.OTS_NODE_BIN;
  const argv = [BUILD, '--root', root, ...args];
  if (!releaseMode) argv.push('--skip-gui');
  const r = spawnSync(process.execPath, argv, {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000,
    env: { ...baseEnv, ...env },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** 解析 `=== name ===` 段（按行切分）。
 *  **不要**改用 `^=== (.+) ===$` 之类的多行正则：段标题可能含全角括号等
 *  多字节字符，此时 `m` 标志下的 `^` 会在行中途误判为行首，导致
 *  1) 相邻段被 `(.+)` 贪婪吞并，或 2) 含全角字符的段整段匹配不上。
 *  逐行 `trim()` + 前后缀剥离是唯一稳定的解析方式。 */
function sections(stdout) {
  const out = [];
  for (const raw of String(stdout).split('\n')) {
    const line = raw.trim();
    if (line.length >= 8 && line.startsWith('===') && line.endsWith('===')) {
      const name = line.slice(3, -3).trim();
      if (name) out.push(name);
    }
  }
  return out;
}

/** 从输出里解析实际执行的步骤序列（`=== name ===` 段）。 */
function executedSteps(stdout) {
  return sections(stdout);
}

/** 解析 `=== name ===` 段的**出现顺序**（含 prepare:out 这类非闸门段）。 */
function allSections(stdout) {
  return sections(stdout);
}

/** 前置准备段（P4-F2）：非发布闸门步骤，断言「闸门步骤序列」时须剔除。
 *  它只在 `test:integration` 前补齐 `out/`，本身不计入 build-record 的必需步骤。 */
const PREREQ_SECTIONS = ['prepare:out（集成测试前置）'];

/** 只保留闸门步骤（剔除前置准备段），用于与 STEP_ORDER* 做顺序比对。 */
function gateSteps(stdout) {
  return sections(stdout).filter((s) => !PREREQ_SECTIONS.includes(s));
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
  console.log('\n== 全绿路径（开发构建，--skip-gui）==');
  const root = makeFixture('orch-green-');
  const stub = {};
  for (const s of STEP_ORDER) stub[s] = 0;
  const r = runOrch(root, ['build', 'b-green'], { stepStub: stub });
  const steps = gateSteps(r.stdout);
  expect(r.status === 0, '全绿时退出 0', `实际 ${r.status}`);
  expect(steps.join(',') === STEP_ORDER.join(','), '步骤顺序与预期完全一致', `实际 ${steps.join(',')}`);
  // 任务 C：带 --skip-gui 属开发构建 → 只能 DEV_BUILD_COMPLETE，不得发布 ALL_GREEN
  expect(r.stdout.includes('DEV_BUILD_COMPLETE'), '开发构建打印 DEV_BUILD_COMPLETE');
  expect(!r.stdout.includes('ALL_GREEN'), '开发构建不打印发布 ALL_GREEN');
  const rec = JSON.parse(fs.readFileSync(path.join(root, 'candidate-b-green', 'build-record.json'), 'utf8'));
  expect(rec.releaseEligible === false, '开发构建 releaseEligible=false', `实际 ${rec.releaseEligible}`);
  expect(Array.isArray(rec.missingRequiredSteps) && rec.missingRequiredSteps.includes('smoke:gui'),
    '缺失步骤显式列出 smoke:gui', JSON.stringify(rec.missingRequiredSteps));
  rmDir(root);
}

// ---------- 5b3) 任务 F / P4-F2：集成测试前必须补齐 out/ 前置 ----------
{
  console.log('\n== P4-F2：集成测试前置构建（无 out/ 时补 build:main）==');
  const root = makeFixture('orch-prereq-');
  const stub = {};
  for (const s of STEP_ORDER_RELEASE) stub[s] = 0;
  // 夹具里没有 out/（makeFixture 不建），编排器应在 test:integration 前
  // 打 prepare:out 段；由于这是测试桩环境，build:main 也会被桩接住。
  const r = runOrch(root, ['build', 'b-prereq'], { stepStub: stub, releaseMode: true });
  const sections = allSections(r.stdout);
  const idxPrepare = sections.indexOf('prepare:out（集成测试前置）');
  const idxIntegration = sections.indexOf('test:integration');
  expect(idxPrepare >= 0, '无 out/ 时出现 prepare:out 段', sections.join(','));
  expect(
    idxPrepare >= 0 && idxIntegration >= 0 && idxPrepare < idxIntegration,
    'prepare:out 出现在 test:integration 之前',
    `prepare@${idxPrepare} integration@${idxIntegration}`,
  );
  // 它是前置准备，不是发布必需步骤：不得出现在步骤顺序断言里
  expect(!STEP_ORDER_RELEASE.includes('prepare:out'), 'prepare:out 不进入发布必需步骤集合');
  rmDir(root);
}

// ---------- 5b2) 任务 D：smoke:gui 失败必须传播（不得被当成「界面可用」放行）----------
{
  console.log('\n== 任务 D：smoke:gui 失败传播 ==');
  const root = makeFixture('orch-smoke-');
  const stub = {};
  for (const s of STEP_ORDER_RELEASE) stub[s] = 0;
  stub['smoke:gui'] = 61; // 冒烟判定界面不可用 → 非 0
  const r = runOrch(root, ['build', 'b-smokefail'], { stepStub: stub, releaseMode: true });
  const steps = executedSteps(r.stdout);
  expect(r.status === 61, 'smoke:gui=61 时整体退出码为 61', `实际 ${r.status}`);
  expect(steps.includes('smoke:gui'), 'smoke:gui 步骤确实执行');
  expect(steps.indexOf('verify-package') === -1, 'smoke:gui 失败后不再执行 verify-package');
  expect(!r.stdout.includes('ALL_GREEN'), 'smoke:gui 失败时不打印 ALL_GREEN');
  // STOPPED 走 stderr（console.error）
  expect(/STOPPED at smoke:gui/.test(r.stdout + r.stderr), 'smoke:gui 失败时打印 STOPPED');
  // 在 smoke 处即终止，未走到步骤 9（register）→ 不应留下发布记录
  expect(
    !fs.existsSync(path.join(root, 'candidate-b-smokefail', 'build-record.json')),
    'smoke:gui 失败时不写出可发布构建记录',
  );
  rmDir(root);
}

// ---------- 5b) 任务 C：发布模式（不跳步骤）→ 步骤齐全；测试注入下仍不可发布 ----------
{
  console.log('\n== 发布模式（不跳任何步骤）==');
  const root = makeFixture('orch-release-green-');
  const stub = {};
  for (const s of STEP_ORDER_RELEASE) stub[s] = 0;
  const r = runOrch(root, ['build', 'b-relgreen'], { stepStub: stub, releaseMode: true });
  const steps = gateSteps(r.stdout);
  expect(r.status === 0, '发布模式全绿退出 0', `实际 ${r.status}`);
  expect(steps.join(',') === STEP_ORDER_RELEASE.join(','), '发布模式步骤含 smoke:gui 且顺序一致', `实际 ${steps.join(',')}`);
  const rec = JSON.parse(fs.readFileSync(path.join(root, 'candidate-b-relgreen', 'build-record.json'), 'utf8'));
  // 任务 C 第 4 条的核心：本测试注入了 OTS_STEP_STUB（测试注入环境），
  // 因此即便步骤齐全，也**必须**判为不可发布——不得让 mock 成功伪装真实通过。
  expect(rec.testInjectedEnvironment === true, '测试注入环境被标记', `实际 ${rec.testInjectedEnvironment}`);
  expect(rec.releaseEligible === false, '测试注入环境下 releaseEligible=false', `实际 ${rec.releaseEligible}`);
  expect(!r.stdout.includes('ALL_GREEN'), '测试注入环境不打印发布 ALL_GREEN');
  expect(r.stdout.includes('DEV_BUILD_COMPLETE'), '测试注入环境打印 DEV_BUILD_COMPLETE');
  expect(/测试注入环境/.test(r.stdout), '输出说明不可发布原因是测试注入');
  rmDir(root);
}

// ---------- 5b2) 任务 C：无注入 + 步骤齐全 → 真正的发布 ALL_GREEN ----------
//   用 releaseMode 且**不注入** OTS_STEP_STUB 无法在无依赖夹具里跑真实步骤，
//   故这里改为直接构造一份「步骤齐全且无注入」的构建记录，验证资格判定的正例路径：
//   release-build 的判定函数与 verify-release 的校验函数共用同一常量，此处校验后者。
{
  console.log('\n== verify-release：齐全且无注入的构建记录 → 通过发布资格校验 ==');
  const root = makeFixture('orch-elig-ok-');
  const br = path.join(root, 'build-record.json');
  const REQ = require(path.join(ROOT, 'tools', 'release-build.cjs')).RELEASE_REQUIRED_STEPS;
  fs.writeFileSync(br, JSON.stringify({
    schema: 'build-record/1', buildId: 'b-ok', version: '0.1.0-alpha.1',
    sourceCommit: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64),
    out: { fileCount: 0, files: {} },
    steps: REQ.map((n) => ({ step: n, status: 'passed', exit: 0, seconds: 1 })),
    releaseEligible: true, releaseRequiredSteps: REQ, missingRequiredSteps: [],
  }, null, 2));
  const checkElig = require(path.join(ROOT, 'tools', 'release-eligibility.cjs')).checkReleaseEligibility;
  const ok = checkElig(JSON.parse(fs.readFileSync(br, 'utf8')));
  expect(ok.ok === true, '齐全 + releaseEligible=true 且无注入 → 资格校验通过', ok.problems.join('；'));
  rmDir(root);
}

// ---------- 5c) 任务 C：--strict 下不可发布 → 非 0 ----------
{
  console.log('\n== --strict：不可发布时非 0 ==');
  const root = makeFixture('orch-strict-');
  const stub = {};
  for (const s of STEP_ORDER) stub[s] = 0;
  const r = runOrch(root, ['build', 'b-strict', '--strict'], { stepStub: stub });
  expect(r.status === 1, '--strict 且不可发布时退出 1', `实际 ${r.status}`);
  expect(/要求发布资格/.test(r.stdout + r.stderr), '给出 --strict 失败原因');
  rmDir(root);
}

// ---------- 5d) 任务 C：负例 —— skip-gui / skip-e2e / 步骤非 0 / 测试注入 均不可通过 ----------
{
  console.log('\n== 任务 C 负例：发布资格校验必须拒绝各种「跳检查」形态 ==');
  const REQ = require(path.join(ROOT, 'tools', 'release-build.cjs')).RELEASE_REQUIRED_STEPS;
  const { checkReleaseEligibility } = require(path.join(ROOT, 'tools', 'release-eligibility.cjs'));
  const base = (mut) => Object.assign({
    schema: 'build-record/1', buildId: 'b', version: '0.1.0-alpha.1',
    sourceCommit: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64),
    out: { fileCount: 0, files: {} },
    steps: REQ.map((n) => ({ step: n, status: 'passed', exit: 0, seconds: 1 })),
    releaseEligible: true, releaseRequiredSteps: REQ, missingRequiredSteps: [],
  }, mut);

  // 缺 smoke:gui（=skip-gui 的后果）
  const noGui = base({});
  noGui.steps = noGui.steps.filter((s) => s.step !== 'smoke:gui');
  noGui.missingRequiredSteps = ['smoke:gui'];
  noGui.releaseEligible = false;
  expect(checkReleaseEligibility(noGui).ok === false, 'skip-gui（缺 smoke:gui）被拒');

  // 缺两类 E2E（=skip-e2e 的后果）
  const noE2e = base({});
  noE2e.steps = noE2e.steps.filter((s) => !s.step.startsWith('test:e2e'));
  noE2e.missingRequiredSteps = ['test:e2e', 'test:e2e:electron'];
  noE2e.releaseEligible = false;
  expect(checkReleaseEligibility(noE2e).ok === false, 'skip-e2e（缺两类 E2E）被拒');

  // 步骤显式 skipped
  const skipped = base({});
  skipped.steps = skipped.steps.map((s) => (s.step === 'smoke:gui' ? { ...s, status: 'skipped' } : s));
  expect(checkReleaseEligibility(skipped).ok === false, '步骤被标 skipped 被拒');

  // 步骤非 0
  const nonZero = base({});
  nonZero.steps = nonZero.steps.map((s) => (s.step === 'audit' ? { ...s, exit: 7, status: 'failed' } : s));
  expect(checkReleaseEligibility(nonZero).ok === false, '步骤退出码非 0 被拒');

  // 测试注入
  expect(checkReleaseEligibility(base({ testInjectedEnvironment: true })).ok === false,
    '测试注入环境被拒');

  // releaseEligible 缺失
  const noFlag = base({});
  delete noFlag.releaseEligible;
  expect(checkReleaseEligibility(noFlag).ok === false, 'releaseEligible 缺失被拒（不乐观放行）');

  // 正例对照
  expect(checkReleaseEligibility(base({})).ok === true, '齐全且无注入的正例通过');
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
