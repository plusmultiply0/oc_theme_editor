#!/usr/bin/env node
/**
 * P3 统一发布编排入口：一条链只跑一次，产物唯一、可追溯。
 *
 * 为什么需要它：此前「门禁」是 shell 脚本 tools/release-gate.sh，把
 * typecheck/lint/test/build/dist/verify 串起来，但**构建与打包不止一次**
 * （`npm run build` 跑一遍、`npm run dist` 里 `electron-builder` 又 `npm run
 * build` 一遍），且 dist 输出目录与核验目标目录可能不是同一个（只给 verify
 * 传新目录、dist 仍写旧目录），登记又在打包前生成——manifest 记录的是
 * 「打包前」的 out 清单，无法证明 zip 与候选同源。本脚本把顺序固定为：
 *
 *   冻结源码 → 类型/lint/单元/集成（注入项目临时目录策略）
 *   → 干净构建（唯一一次）→ GUI/运行期测试
 *   → 打包到唯一目录（唯一一次）→ 包结构/依赖核验（verify-package）
 *   → 生成 zip（从候选目录内容）
 *   → 登记（candidate-manifest register，绑定构建记录 + out 清单）
 *   → 发布身份核验（verify-release）
 *
 * 两种模式（互斥）：
 *   build  <buildId>   完整链：会 build/dist/打包/写登记，产出新候选。
 *                      输出到候选目录 candidate-<buildId>/（不覆盖已存在目录）。
 *   verify <buildId>   只读核验既有候选：不 build、不 dist、不写任何产物，
 *                      manifest 与候选目录必须已存在。供真实闭环后再次核验。
 *
 * 为什么 build 与 verify 分开：真实闭环（P5）之后要能**只核验不重建**，
 * 且核验前后的产物 hash 不得改变。verify 模式连 build 都不调用。
 *
 * 任一非门禁相关步骤失败立即停止，保留原始退出码；不续跑到 ALL_GREEN。
 *
 * Windows 说明：本脚本用 node 执行子命令，不依赖 PATH 里的 bash；
 * 打包与 Electron 相关步骤走 npm.cmd / npx.cmd，由 npm 前缀解析（见 runNpm）。
 */

'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT_ROOT = path.resolve(__dirname, '..');
let ROOT = SCRIPT_ROOT;
const CANDIDATE_MANIFEST = path.join(__dirname, 'candidate-manifest.cjs');
const VERIFY_RELEASE = path.join(__dirname, 'verify-release.cjs');
const VERIFY_PACKAGE = path.join(__dirname, 'verify-package.cjs');

const isWin = process.platform === 'win32';
/** Windows 下 npm/npx 是 .cmd，直接 spawnSync('npm') 会 ENOENT；CI（Linux）用裸名 */
const npmBin = isWin ? 'npm.cmd' : 'npm';
const npxBin = isWin ? 'npx.cmd' : 'npx';

/**
 * 运行 node 子进程用的解释器。默认是当前 node（nodeBin）；
 * 允许 OTS_NODE_BIN 覆盖——**仅供测试**注入 node 桩以覆盖「被调脚本失败」场景，
 * 生产发布链不需要设置它。生产不设该变量时行为完全一致。
 */
const nodeBin = process.env.OTS_NODE_BIN || process.execPath;

const EXE_NAME = 'OpenCodeThemeSwitcher.exe';

function sha256File(f) {
  return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
}

/**
 * 集成测试专用受控并发（任务 B）：
 * `--pool=forks --maxWorkers=1 --no-file-parallelism`
 * —— 不用 `singleFork`（避免把所有文件长期塞进同一 worker 状态）。
 * 并行资源竞争会造成大量超时/假失败；受控并发是可审计的保守默认。
 * **注意**：单靠并发参数不解决 RPC 回执超时，必须配合任务 A 的异步化。
 */
const INTEGRATION_CONCURRENCY_ARGS = ['--pool=forks', '--maxWorkers=1', '--no-file-parallelism'];

/**
 * 项目临时目录策略（R5/S5；任务 B 改为**每次运行独立**子目录）：
 * 把 TEMP/TMP 指向项目盘安全根下的唯一运行目录，避免 %TEMP% 下新建的 *.asar
 * 被安全进程持久锁住，同时让 safe-delete-shim 的 rmSync 获得临时目录豁免，
 * 且不同运行之间不互相干扰。根可用 OTS_TEST_TMP 覆盖，不硬编码个人路径。
 */
function testEnv() {
  const tmpRoot = process.env.OTS_TEST_TMP || path.join(ROOT, 'node_modules', '.cache', 'ots-test-tmp');
  const runDir = path.join(tmpRoot, `run-${process.pid}-${Date.now()}`);
  fs.mkdirSync(runDir, { recursive: true });
  return { ...process.env, TEMP: runDir, TMP: runDir };
}

/**
 * 测试专用步骤桩（**仅测试注入**，生产链不设置）：
 * OTS_STEP_STUB 是 JSON 形如 {"typecheck":31,"dist":35}，命中时该步不执行真实
 * 子进程、直接返回给定退出码；未命中则正常执行。用于在无 npm/打包依赖的夹具里
 * 覆盖「每步失败、退出码保留、后续不执行」的链路行为，不影响生产语义。
 */
function stepStub(name) {
  const raw = process.env.OTS_STEP_STUB;
  if (!raw) return null;
  try {
    const map = JSON.parse(raw);
    return Object.prototype.hasOwnProperty.call(map, name) ? Number(map[name]) : null;
  } catch {
    return null;
  }
}

/** 逐行透传子进程输出并保留退出码（不吞失败）。
 *  Windows 下 npm/npx 是 .cmd：Node ≥18.20/20.12 出于安全不允许不带 shell 直接
 *  spawn .cmd（EINVAL），必须 shell:true；node 与 git 是 .exe，无需 shell。 */
function runStep(name, cmd, args, opts = {}) {
  const stub = stepStub(name);
  if (stub !== null) {
    console.log(`\n=== ${name} ===`);
    console.log(`[stub] OTS_STEP_STUB 注入 ${name} = ${stub}`);
    console.log(`EXIT ${name} = ${stub} (0.0s)`);
    return { name, code: stub, secs: 0 };
  }
  console.log(`\n=== ${name} ===`);
  const started = Date.now();
  const isNpm = cmd === npmBin || cmd === npxBin;
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
    shell: isWin && isNpm,
    env: opts.env || process.env,
  });
  const code = typeof r.status === 'number' ? r.status : 1;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`EXIT ${name} = ${code} (${secs}s)`);
  return { name, code, secs: Number(secs) };
}

const gitsha = () => {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  return (r.stdout || '').trim();
};

/** 冻结判定：已跟踪文件有未提交改动 / 新增未跟踪源码 即拒绝（与工具同一策略） */
function freezeProblems() {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return [`无法读取 Git 状态：${(r.stderr || '').trim() || 'git 查询失败'}`];
  const problems = [];
  for (const line of (r.stdout || '').split('\n').filter(Boolean)) {
    const code = line.slice(0, 2);
    const rel = line.slice(3).trim().replace(/^"|"$/g, '');
    if (code.startsWith('??')) {
      // 未跟踪：豁免构建产物/证据/工作区目录，其余视为「新增未跟踪源码」拒绝
      const exempt = [
        'candidate-', 'release', 'out/', 'dist/', 'node_modules/', 'backups/',
        'handoff/', '.workbuddy/', 'test-results/', 'playwright-report/', 'build-record.json',
      ].some((p) => rel === p.replace(/\/$/, '') || rel.startsWith(p));
      if (!exempt) problems.push(`新增未跟踪源码/脚本：${rel}`);
    } else {
      problems.push(`已跟踪文件有未提交改动：${rel}`);
    }
  }
  return problems;
}

/**
 * 发布必需步骤集合（任务 C）—— **唯一事实来源在 `tools/release-eligibility.cjs`**。
 * 这里重新导出以便测试与外部引用。校验逻辑同样复用该共享模块，
 * 保证「构建端判定」与「核验端校验」用同一把尺子。
 */
const { RELEASE_REQUIRED_STEPS, checkReleaseEligibility } = require('./release-eligibility.cjs');

/** 生成并写入构建记录（build-record/1），返回路径。
 *  任务 C：逐步记录 `passed/failed/skipped` + 退出码，不以缺字段隐含跳过；
 *  并给出 `releaseEligible` 与缺失步骤清单，供 register/verify-release 校验。 */
function writeBuildRecord(candidateDir, buildId, steps) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = fs.readFileSync(path.join(ROOT, 'package-lock.json'));
  // out 清单来自 verify-release 的共享实现，保证与核验端同一规范。
  const outDir = path.join(ROOT, 'out');
  const hasOut = fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0;
  if (!hasOut && stepStub('build') === null) {
    throw new Error(`构建记录要求 out/ 有内容，但 ${path.relative(ROOT, outDir)} 为空或不存在（先 npm run build）`);
  }
  const outFiles = hasOut ? require(VERIFY_RELEASE).outManifestOfDir(outDir).files : {};

  const stepRecords = steps.map((s) => ({
    step: s.name,
    // 状态显式三态：不得以缺字段隐含 skipped
    status: s.name === 'register' || s.name === 'verify:release' ? 'pending' : s.code === 0 ? 'passed' : 'failed',
    exit: s.code,
    seconds: s.secs,
  }));

  // 缺哪些「发布必需步骤」：显式列出，而不是让读者从字段缺失去推断
  const recorded = new Set(steps.map((s) => s.name));
  const missingRequired = RELEASE_REQUIRED_STEPS.filter((n) => !recorded.has(n));
  // 测试注入环境（OTS_STEP_STUB/OTS_NODE_BIN）一律不可发布
  const testInjected = Boolean(process.env.OTS_STEP_STUB || process.env.OTS_NODE_BIN);
  const releaseEligible = missingRequired.length === 0 && !testInjected;

  const record = {
    schema: 'build-record/1',
    buildId,
    version: pkg.version,
    sourceCommit: gitsha(),
    lockfileSha256: crypto.createHash('sha256').update(lock).digest('hex'),
    out: { fileCount: Object.keys(outFiles).length, files: outFiles },
    steps: stepRecords,
    releaseEligible,
    releaseRequiredSteps: RELEASE_REQUIRED_STEPS,
    missingRequiredSteps: missingRequired,
    ...(testInjected ? { testInjectedEnvironment: true } : {}),
  };
  const recordPath = path.join(candidateDir, 'build-record.json');
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
  return recordPath;
}

/** 从候选目录内容生成 zip（排除 manifest / build-record / evidence，避免自引用） */
function makeZip(candidateDir, zipPath) {
  const psScript = [
    '$ErrorActionPreference = "Stop"',
    `Compress-Archive -Path (Join-Path '${candidateDir.replace(/'/g, "''")}' '*') -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
  ].join('; ');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
    cwd: ROOT, stdio: 'inherit', windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`生成 zip 失败（exit=${r.status}）`);
}

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--skip-e2e') opts.skipE2e = true;
    else if (a === '--skip-gui') opts.skipGui = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--root') opts.root = argv[++i];
    else positional.push(a);
  }
  opts.mode = positional[0];
  opts.buildId = positional[1];
  return opts;
}

/** 生成唯一 buildId：时间 + 源码短 SHA + 随机后缀（禁止只用日期） */
function newBuildId() {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const sha = (gitsha() || 'nogit').slice(0, 7);
  const rand = crypto.randomBytes(3).toString('hex');
  return `${ts}-${sha}-${rand}`;
}

function usage() {
  console.error('用法：');
  console.error('  node tools/release-build.cjs build  <buildId>   # 完整链：构建+打包+登记+核验');
  console.error('  node tools/release-build.cjs verify <buildId>   # 只读核验既有候选（不构建）');
  console.error('  buildId 省略时自动生成（时间-源码短SHA-随机后缀）。');
  console.error('  可选：--skip-e2e / --skip-gui（仅开发构建，发布链不得省略）');
  console.error('  可选：--strict（要求发布资格；不可发布则非 0 退出）');
}

// ---------------- verify（只读） ----------------
function runVerify(buildId) {
  const candidateDir = path.join(ROOT, `candidate-${buildId}`, 'win-unpacked');
  const manifest = path.join(ROOT, `candidate-${buildId}`, 'candidate-manifest.json');
  if (!fs.existsSync(manifest)) {
    console.error(`[FAIL] 找不到登记：${path.relative(ROOT, manifest)}（verify 不构建，请先 build）`);
    process.exit(1);
  }
  if (!fs.existsSync(candidateDir)) {
    console.error(`[FAIL] 找不到候选目录：${path.relative(ROOT, candidateDir)}`);
    process.exit(1);
  }
  console.log(`RELEASE_VERIFY（只读）buildId=${buildId}`);
  // 1) 包结构/依赖可用性（verify-package，--manifest 显式绑定）
  const vp = runStep('verify-package', nodeBin, [VERIFY_PACKAGE, candidateDir, '--manifest', manifest]);
  if (vp.code !== 0) { console.error('STOPPED at verify-package'); process.exit(vp.code); }
  // 2) 来源/内容/zip 绑定（verify-release，三元显式绑定）
  const vr = runStep('verify:release', nodeBin, [
    VERIFY_RELEASE, '--manifest', manifest, '--candidate-dir', candidateDir, '--build-id', buildId,
  ]);
  if (vr.code !== 0) { console.error('STOPPED at verify:release'); process.exit(vr.code); }
  console.log('\nRELEASE_VERIFY_GREEN（只读核验，产物未改动）');
}

// ---------------- build（完整链） ----------------
function runBuild(buildId, opts) {
  console.log(`RELEASE_BUILD buildId=${buildId}`);

  // 0) 冻结预检：用唯一目录，禁止覆盖已有构建
  const candRoot = path.join(ROOT, `candidate-${buildId}`);
  if (fs.existsSync(candRoot)) {
    console.error(`[FAIL] 候选目录已存在，禁止覆盖：${path.relative(ROOT, candRoot)}（换一个 buildId）`);
    process.exit(1);
  }
  const freeze0 = freezeProblems();
  if (freeze0.length) {
    console.error('[FAIL] 源码未冻结，拒绝构建：');
    for (const p of freeze0) console.error(`  - ${p}`);
    process.exit(1);
  }
  const sourceCommit = gitsha();
  console.log(`  源码提交：${sourceCommit}`);

  const steps = [];
  const step = (name, cmd, args, o) => {
    const r = runStep(name, cmd, args, o);
    steps.push(r);
    if (r.code !== 0) { console.error(`STOPPED at ${name}`); process.exit(r.code); }
    return r;
  };

  // 1) 静态检查
  step('typecheck', npmBin, ['run', 'typecheck']);
  step('lint', npmBin, ['run', 'lint']);

  // 2) 测试（注入项目临时目录策略，不直接调不带策略的 npm run test:integration）
  step('test:unit', nodeBin, [path.join(__dirname, 'r5-run-suite.cjs'), 'run', 'tests/unit'], { env: testEnv() });
  // 集成测试用受控并发（任务 B）：并行资源竞争会造成超时/假失败
  step(
    'test:integration',
    nodeBin,
    [path.join(__dirname, 'r5-run-suite.cjs'), 'run', 'tests/integration', ...INTEGRATION_CONCURRENCY_ARGS],
    { env: testEnv() },
  );

  // 3) 干净构建（唯一一次）
  step('build', npmBin, ['run', 'build']);

  // 4) 运行期测试
  if (!opts.skipE2e) {
    step('test:e2e', npmBin, ['run', 'test:e2e']);
    step('test:e2e:electron', npmBin, ['run', 'test:e2e:electron']);
  }
  step('audit', npmBin, ['run', 'audit']);

  // 5) 打包到唯一目录（唯一一次，且不重复 build）。
  //    刻意不用 `npm run dist`——它内部会再跑一次 `npm run build`，违反「只构建一次」；
  //    这里直接调用 electron-builder，并用 --config 把输出目录固定为本次唯一目录，
  //    避免「只给 verify 传新目录、dist 仍写旧目录」。
  const outDir = path.join(candRoot, 'win-unpacked');
  const distStub = stepStub('dist');
  const builderBin = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
  step('dist', nodeBin, [builderBin, '--win', '--dir', `--config.directories.output=${path.join(candRoot, 'builder-out')}`], {
    env: {
      ...process.env,
      ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
      ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
    },
  });
  if (distStub === null) {
    // electron-builder --dir 在 <output>/win-unpacked 产出 → 收拢到候选目录
    const builtDir = path.join(candRoot, 'builder-out', 'win-unpacked');
    if (!fs.existsSync(builtDir)) {
      console.error(`[FAIL] 打包输出不存在：${path.relative(ROOT, builtDir)}`);
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    fs.cpSync(builtDir, outDir, { recursive: true });
    console.log(`  候选目录：${path.relative(ROOT, outDir)}`);
  } else {
    // 测试桩：造一个最小候选目录，让后续步骤有目标（仅当注入了 dist 桩）
    fs.mkdirSync(path.join(outDir, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(outDir, EXE_NAME), 'stub-exe');
    fs.writeFileSync(path.join(outDir, 'resources', 'app.asar'), 'stub-asar');
  }

  // 6) 打包 GUI 冒烟（Playwright 启动候选 exe，与真实双击同一机制）。
  //    脚本内已 delete ELECTRON_RUN_AS_NODE；不修改系统全局变量、不关 sandbox。
  if (!opts.skipGui) {
    step('smoke:gui', npxBin, ['tsx', path.join(__dirname, 'smoke-packaged.ts'), outDir]);
  }

  // 7) 包结构/依赖可用性（verify-package 的包可用性检查，早于登记）
  step('verify-package', nodeBin, [VERIFY_PACKAGE, outDir, '--no-identity']);

  // 8) 生成 zip（从候选目录内容；manifest 在其后生成，避免自引用）
  const zipPath = path.join(ROOT, `candidate-${buildId}.zip`);
  const zipStub = stepStub('zip');
  if (zipStub === null) {
    console.log(`\n=== zip ===\n  生成 ${path.relative(ROOT, zipPath)}`);
    try { makeZip(outDir, zipPath); } catch (e) { console.error(`[FAIL] ${e.message}`); process.exit(1); }
  } else {
    console.log(`\n=== zip ===\n[stub] OTS_STEP_STUB 注入 zip = ${zipStub}`);
  }
  steps.push({ name: 'zip', code: zipStub === null ? 0 : zipStub, secs: 0 });
  if (zipStub !== null && zipStub !== 0) { console.error('STOPPED at zip'); process.exit(zipStub); }

  // 9) 登记（绑定构建记录 + out 清单 + 锁文件）
  const record = writeBuildRecord(candRoot, buildId, steps);
  const manifest = path.join(candRoot, 'candidate-manifest.json');
  step('register', nodeBin, [
    CANDIDATE_MANIFEST, 'register',
    '--manifest', manifest,
    '--candidate-dir', outDir,
    '--build-record', record,
    '--zip', zipPath,
    '--build-id', buildId,
  ]);

  // 10) 发布身份核验（verify-release 三元显式绑定）
  step('verify:release', nodeBin, [
    VERIFY_RELEASE, '--manifest', manifest, '--candidate-dir', outDir, '--build-id', buildId,
  ]);

  // 11) 构建后冻结复核：源码提交必须未变
  const headAfter = gitsha();
  if (headAfter !== sourceCommit) {
    console.error(`[FAIL] 构建过程中源码提交发生变化：${sourceCommit} → ${headAfter}，候选身份作废`);
    process.exit(1);
  }

  // 12) 发布资格判定（任务 C）：缺必需步骤 / 测试注入环境 → 不得输出发布 ALL_GREEN。
  //     注意步骤 9/10 的 register/verify:release 已在 record 写成后执行，
  //     这里读回转成 passed，再做最终判定。
  finalizeStepStatuses(candRoot);
  const eligibility = readReleaseEligibility(candRoot);
  const skipped = [...(opts.skipE2e ? ['test:e2e', 'test:e2e:electron'] : []), ...(opts.skipGui ? ['smoke:gui'] : [])];

  console.log(`\nmanifest: ${path.relative(ROOT, manifest)}`);
  if (fs.existsSync(zipPath)) {
    console.log(`zip:      ${path.relative(ROOT, zipPath)} (sha256=${sha256File(zipPath).slice(0, 16)}…)`);
  }
  const exePath = path.join(outDir, EXE_NAME);
  if (fs.existsSync(exePath)) {
    console.log(`exe:      sha256=${sha256File(exePath).slice(0, 16)}…`);
  }

  if (eligibility.ok) {
    console.log(`\nALL_GREEN buildId=${buildId}`);
  } else {
    // 开发构建：明确区别于发布 ALL_GREEN，且标注不可发布
    console.log(`\nDEV_BUILD_COMPLETE buildId=${buildId}（不可发布，releaseEligible=false）`);
    if (skipped.length) console.log(`  本次跳过（开发构建允许）：${skipped.join('、')}`);
    for (const p of eligibility.problems) console.log(`  原因：${p}`);
    if (opts.strict) {
      console.error('[FAIL] --strict 模式下要求发布资格，但本次构建不可发布');
      process.exit(1);
    }
  }
}

/** 构建全程结束后，把 register/verify:release 从 pending 落成 passed（已完成则不再改） */
function finalizeStepStatuses(candRoot) {
  const p = path.join(candRoot, 'build-record.json');
  if (!fs.existsSync(p)) return;
  try {
    const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const s of rec.steps) {
      if (s.status === 'pending' && s.exit === 0) s.status = 'passed';
    }
    fs.writeFileSync(p, JSON.stringify(rec, null, 2));
  } catch (e) {
    console.error(`[WARN] 无法回写构建记录步骤状态：${e.message}`);
  }
}

/**
 * 读取构建记录的发布资格。
 * **必须**复用共享实现 `checkReleaseEligibility`（与 verify-release 同一把尺子）；
 * 不得在此另写一套判定，否则会出现「构建放行、核验拒绝」的不一致。
 * @returns {ReturnType<typeof checkReleaseEligibility>}
 */
function readReleaseEligibility(candRoot) {
  const p = path.join(candRoot, 'build-record.json');
  const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
  return checkReleaseEligibility(rec);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.root) ROOT = path.resolve(opts.root);
  if (opts.mode === 'build') {
    const buildId = opts.buildId || newBuildId();
    runBuild(buildId, opts);
  } else if (opts.mode === 'verify') {
    if (!opts.buildId) { usage(); process.exit(2); }
    runVerify(opts.buildId);
  } else {
    usage();
    process.exit(2);
  }
}

if (require.main === module) main();

module.exports = {
  newBuildId,
  freezeProblems,
  testEnv,
  RELEASE_REQUIRED_STEPS,
  INTEGRATION_CONCURRENCY_ARGS,
};
