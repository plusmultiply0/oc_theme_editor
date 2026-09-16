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
 *   冻结源码 → 类型/lint/单元（注入项目临时目录策略）
 *   → 干净构建（唯一一次，R4 提前）→ out 快照（R4）
 *   → 集成/GUI/运行期测试（共用同一份新构建产物）
 *   → 打包前 out 复核（R4：测试期间被更改则拒绝）→ 打包到唯一目录（唯一一次）
 *   → 包结构/依赖核验（verify-package）
 *   → 生成 zip（从候选目录内容）
 *   → 写 build-record/2（**登记前事实**，登记后不可变，不含 register/verify:release）
 *   → 登记（candidate-manifest register，绑定构建记录 + out 清单）
 *   → 发布身份核验（verify-release，core 层：事实/产物/来源绑定，不要求资格）
 *   → 写 release-receipt/1（完成回执：register + core 核验均真实退出 0 才写）
 *   → 资格终判（按可信策略重算 + 回执在场）→ ALL_GREEN / DEV_BUILD_COMPLETE
 *
 *   R1 修订（2026-09-14）：旧 /1 记录把尚未发生的 register/verify:release
 *   写成 pending（自引用），正常链永远拿不到发布资格；且 finalize 回写会改变
 *   已被 manifest 绑定的记录 hash。现改为「事实（build-record/2，不可变）+
 *   回执（release-receipt/1，登记核验完成后另写）」分离，删除 finalize 回写路径。
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

/** HEAD 提交 hash。root 显式可传（夹具测试传夹具根；默认编排根 ROOT）。 */
const gitsha = (root = ROOT) => {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
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
const {
  RELEASE_POLICY_VERSION,
  RELEASE_REQUIRED_STEPS,
  POST_REGISTER_STEPS,
  RECORD_SCHEMA,
  checkReleaseEligibility,
} = require('./release-eligibility.cjs');

/** 生成并写入构建记录（build-record/2，登记后**不可变**），返回路径。
 *  R1：只记录登记前真实完成的步骤事实（typecheck…zip，共 12 项发布事实），
 *  **不含 register / verify:release**——登记时它们尚未发生，写进去必然
 *  「记录要求自己尚未发生的完成回执」（旧 /1 记录的死锁根源）；
 *  它们的完成由独立 release-receipt/1 证明（见 writeReleaseReceipt）。
 *  R2：releaseEligible / missingRequiredSteps 由可信策略重算后写入，
 *  校验端做一致性核对（不信任自报，只认一致）。
 *  @param {string} root 构建根（默认调用方传 ROOT；测试可传夹具根） */
function writeBuildRecord(root, candidateDir, buildId, steps) {
  // 防御：登记后步骤不得混入记录（其完成回执属于 release-receipt/1）
  const intruders = steps.filter((s) => POST_REGISTER_STEPS.includes(s.name)).map((s) => s.name);
  if (intruders.length) {
    throw new Error(`build-record/2 只记录登记前步骤，混入了登记后步骤：${intruders.join('、')}`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = fs.readFileSync(path.join(root, 'package-lock.json'));
  // out 清单来自 verify-release 的共享实现，保证与核验端同一规范。
  const outDir = path.join(root, 'out');
  const hasOut = fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0;
  if (!hasOut && stepStub('build') === null) {
    throw new Error(`构建记录要求 out/ 有内容，但 ${path.relative(root, outDir)} 为空或不存在（先 npm run build）`);
  }
  const outFiles = hasOut ? require(VERIFY_RELEASE).outManifestOfDir(outDir).files : {};

  const stepRecords = steps.map((s) => ({
    step: s.name,
    // 状态显式：passed/failed（没有 pending——记录不预填任何「未来成功」）
    status: s.code === 0 ? 'passed' : 'failed',
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
    schema: RECORD_SCHEMA,
    policyVersion: RELEASE_POLICY_VERSION,
    buildId,
    version: pkg.version,
    sourceCommit: gitsha(root),
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

/**
 * 写独立完成回执 release-receipt/1（R1）。**仅当** register 与 core 核验都
 * 真实退出 0 后由编排器调用——任一失败链路已在此前 STOPPED，回执不会被写出
 * （失败即阻断回执）。回执只绑定既有产物的身份 hash（manifest / 构建记录），
 * **不回写 manifest**，避免「回执 hash 进 manifest、manifest hash 进回执」再成环。
 * 缺回执的候选不得给发布绿色结果（verify-release --require-release-eligibility）。
 * @param {string} candidateDir 候选根目录（回执写在其下 release-receipt.json）
 */
function writeReleaseReceipt(candidateDir, buildId, sourceCommit, manifestPath, recordPath) {
  const receipt = {
    schema: 'release-receipt/1',
    buildId,
    sourceCommit,
    manifestHash: sha256File(manifestPath),
    buildRecordHash: sha256File(recordPath),
    writtenAt: new Date().toISOString(),
  };
  const receiptPath = path.join(candidateDir, 'release-receipt.json');
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  return receiptPath;
}

/**
 * 把 out 目录打成含 `out/**` 条目的**真 asar**（R1 测试桩路径）。
 * 暂存目录复制 out → <staging>/out，使归档内条目即 `out/...`，与
 * verify-release 的 out 清单规范一致（桩产物也要能与 out 清单对账）。
 * 仅测试桩分支使用；真实发布走 electron-builder，不经此函数。
 */
function packOutAsar(rootOutDir, stagingDir, asarPath) {
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.cpSync(rootOutDir, path.join(stagingDir, 'out'), { recursive: true });
  // @electron/asar 4.x 只提供异步 createPackage（createPackageSync 已移除）；
  // 用子进程包装为同步调用，与 makeZip 的 spawnSync 模式一致
  const script = [
    "const asar = require('@electron/asar');",
    'const [src, dest] = process.argv.slice(1);',
    'asar.createPackage(src, dest).then(',
    '  () => process.exit(0),',
    '  (e) => { console.error(e && (e.stack || e.message)); process.exit(1); },',
    ');',
  ].join('\n');
  const r = spawnSync(process.execPath, ['-e', script, stagingDir, asarPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`asar 打包失败（exit=${r.status}）：${r.stderr || r.stdout || '(无输出)'}`);
  }
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

/**
 * 选项解析。三条硬规则：
 *   1) 需要值的选项**必须有值**——缺值记录在 opts.missingValue 里，由 main 拒绝。
 *      旧写法 `opts.x = argv[++i]` 在缺值时得到 undefined，随后被当成「没声明」
 *      而静默放行：调用者以为指定了目标，实际没有。
 *   2) 未识别的 `--xxx` 记入 opts.unknown，由 main 报错（不再静默丢弃）。
 *   3) `--x=value` 与 `--x value` 等价，避免标准写法被误判成未知参数。
 *
 * 无值选项（--strict/--skip-gui/--skip-e2e）不消耗下一个参数，因此位置参数
 * （mode / buildId）的位置保持不变。
 */
const VALUE_OPTS = { '--root': 'root', '--manifest': 'manifest', '--candidate-dir': 'candidateDir', '--build-id': 'buildId' };
const FLAG_OPTS = { '--skip-e2e': 'skipE2e', '--skip-gui': 'skipGui', '--strict': 'strict' };

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const eq = raw.indexOf('=');
    const flag = eq > 0 ? raw.slice(0, eq) : raw;

    if (FLAG_OPTS[flag]) {
      opts[FLAG_OPTS[flag]] = true;
      continue;
    }
    if (VALUE_OPTS[flag]) {
      if (eq > 0) {
        opts[VALUE_OPTS[flag]] = raw.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      // 缺值判定：没有下一个参数，或下一个本身就是另一个选项
      if (next === undefined || (next.startsWith('--') && next.length > 2)) {
        opts.missingValue = (opts.missingValue || []).concat(flag);
        continue;
      }
      opts[VALUE_OPTS[flag]] = next;
      i += 1;
      continue;
    }
    if (raw.startsWith('--')) {
      opts.unknown = (opts.unknown || []).concat(raw);
      continue;
    }
    positional.push(raw);
  }
  if (opts.mode === undefined) opts.mode = positional[0];
  if (opts.buildId === undefined) opts.buildId = positional[1];
  return opts;
}

/**
 * 路径规范化后比较：Windows 下大小写与分隔符都不该让「同一个目录」被判成不同。
 * 不做 realpath（候选目录可能尚不存在，且符号链接语义不是这里要解决的问题）。
 */
function samePath(a, b) {
  const na = path.resolve(ROOT, a).replace(/[\\/]+/g, path.sep).toLowerCase();
  const nb = path.resolve(ROOT, b).replace(/[\\/]+/g, path.sep).toLowerCase();
  return na === nb;
}

/**
 * N4：调用方给出的显式绑定必须与 buildId 推导出的目标一致。
 *
 * 背景：shell 入口曾承诺校验 GATE_MANIFEST / GATE_CANDIDATE_DIR 与推导目标一致，
 * 实际只判断非空，随后只把 buildId 传下来——于是「变量指向 A、buildId 指向 B」时
 * 下层仍只核验 B 的默认路径，调用者意图与实际验证目标不一致（不是说 B 的坏产物
 * 能通过，而是核验对象可能不是调用者以为的那个）。这里把比较放到 Node 层，
 * 按仓库根解析、规范化后严格比较，不一致就在**运行核验之前**非零退出。
 */
function assertExplicitBinding(opts, { candidateDir, manifest }) {
  const mismatches = [];
  if (opts.manifest && !samePath(opts.manifest, manifest)) {
    mismatches.push(`--manifest 指向 ${path.resolve(ROOT, opts.manifest)}，但 buildId=${opts.buildId} 推导为 ${manifest}`);
  }
  if (opts.candidateDir && !samePath(opts.candidateDir, candidateDir)) {
    mismatches.push(`--candidate-dir 指向 ${path.resolve(ROOT, opts.candidateDir)}，但 buildId=${opts.buildId} 推导为 ${candidateDir}`);
  }
  if (mismatches.length) {
    console.error('[FAIL] 显式绑定与 buildId 推导目标不一致（拒绝按未声明的目标核验）：');
    for (const m of mismatches) console.error(`       ${m}`);
    console.error('       要么让变量与 buildId 指向同一候选，要么只传 buildId 让工具推导；');
    console.error('       不接受「声明了一个目标、实际核验另一个」这种调用方式。');
    process.exit(2);
  }
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
  console.error('  可选：--strict（仅 build 模式：要求发布资格，不可发布则非 0 退出）');
  console.error('  可选：--manifest <路径> / --candidate-dir <路径>（仅 verify 模式：');
  console.error('        显式声明核验目标，必须与 buildId 推导结果一致，否则退出 2）');
  console.error('  未识别的参数或缺少参数值一律退出 2（不静默丢弃）。');
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
  // 2) 来源/内容/zip 绑定 + 发布资格与完成回执（verify-release，三元显式绑定）。
  //    R1：对外核验必须给出**发布级**结论——缺 receipt、绑定错误、注入环境、
  //    跳过必检均不得给绿色结果（--require-release-eligibility）。
  //    显式传 --root，保证核验对象是本次 buildId 的构建根而非工具自身仓库。
  const vr = runStep('verify:release', nodeBin, [
    VERIFY_RELEASE, '--manifest', manifest, '--candidate-dir', candidateDir, '--build-id', buildId,
    '--root', ROOT, '--require-release-eligibility',
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
  //    R3：--strict-completeness 让包装器做「完成集合相等」机器校验
  //    （预期集合=同配置 vitest list；JSON 结果绑定本次 runId；缺失/解析失败一律失败关闭）；
  //    --expect-no-skip：发布链不允许未批准的 skipped/todo（当前测试库无 skip/todo）。
  step(
    'test:unit',
    nodeBin,
    [path.join(__dirname, 'r5-run-suite.cjs'), 'run', 'tests/unit', '--strict-completeness', '--expect-no-skip'],
    { env: testEnv() },
  );

  // 3) R4：干净构建**提前到集成之前**（唯一一次）——
  //    集成/e2e/打包共用同一份新构建产物，从结构上消除「集成用到旧 out
  //    worker、打包才重建」的缓存协议；旧的 prepare:out 前置（仅凭
  //    out/main/index.js 存在即跳过，可能用旧源码产物跑集成）随之删除。
  step('build', npmBin, ['run', 'build']);

  // 3.5) R4：构建成功后记录 out 完整清单快照（相对路径+bytes+sha256）。
  //      打包前复核（见下）与之逐一比对：测试期间 out 被更改 → 拒绝。
  //      测试注入环境（OTS_STEP_STUB）没有真实构建产物，快照/复核整体跳过。
  const stubBuild = stepStub('build');
  let outSnapshot = null;
  if (stubBuild === null && !process.env.OTS_STEP_STUB) {
    const { outManifestOfDir } = require('./verify-release.cjs');
    try {
      outSnapshot = outManifestOfDir(path.join(ROOT, 'out'));
    } catch (e) {
      console.error(`[FAIL] 构建成功但 out 清单不可用：${e.message}`);
      process.exit(1);
    }
    console.log(`  out 快照：${Object.keys(outSnapshot.files).length} 个文件（构建后）`);
  }

  // 4) 集成测试（受控并发（任务 B）：并行资源竞争会造成超时/假失败）
  //    R3：同样启用严格完整性（预期集合 + JSON 机器结果 + 完成集合相等）
  //    R4：此时跑的是步骤 3 刚构建出的同一份 out
  step(
    'test:integration',
    nodeBin,
    [
      path.join(__dirname, 'r5-run-suite.cjs'),
      'run',
      'tests/integration',
      ...INTEGRATION_CONCURRENCY_ARGS,
      '--strict-completeness',
      '--expect-no-skip',
    ],
    { env: testEnv() },
  );

  // 5) 运行期测试
  if (!opts.skipE2e) {
    step('test:e2e', npmBin, ['run', 'test:e2e']);
    step('test:e2e:electron', npmBin, ['run', 'test:e2e:electron']);
  }
  step('audit', npmBin, ['run', 'audit']);

  // 5.5) R4：打包前 out 复核——与构建后快照逐一比对（含 sha256），
  //      测试期间输出被更改则拒绝；不得仅凭入口文件存在判断可用。
  if (outSnapshot) {
    const { outManifestOfDir, diffOutManifest } = require('./verify-release.cjs');
    let after;
    try {
      after = outManifestOfDir(path.join(ROOT, 'out'));
    } catch (e) {
      console.error(`[FAIL] 打包前 out 复核失败：${e.message}`);
      process.exit(1);
    }
    const d = diffOutManifest(outSnapshot, after);
    if (d.missing.length || d.extra.length || d.changed.length) {
      console.error('[FAIL] 打包前 out 复核失败：测试期间 out/ 被更改，产物同源性无法保证');
      for (const k of d.missing) console.error(`  - 缺失 ${k}`);
      for (const k of d.extra) console.error(`  - 新增 ${k}`);
      for (const k of d.changed) console.error(`  - 变更 ${k}`);
      process.exit(1);
    }
    console.log(`  out 复核通过：${Object.keys(after.files).length} 个文件与构建后快照一致`);
  }

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
    // 测试桩：造一个最小候选目录，让后续步骤有目标（仅当注入了 dist 桩）。
    // R1：ROOT/out 有真实编译产物时，经 @electron/asar 从暂存目录打**真 asar**
    // （条目即 out/**），使 verify-release 的 asar out/** 比对、register 绑定
    // 对桩产物也成立；out 为空时退回纯文本桩（只覆盖非生命周期场景）。
    fs.mkdirSync(path.join(outDir, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(outDir, EXE_NAME), 'stub-exe');
    const asarPath = path.join(outDir, 'resources', 'app.asar');
    const rootOutDir = path.join(ROOT, 'out');
    if (fs.existsSync(rootOutDir) && fs.readdirSync(rootOutDir).length > 0) {
      packOutAsar(rootOutDir, path.join(candRoot, 'asar-staging'), asarPath);
      console.log('  [stub] out/ 有产物 → 打真 asar（条目 out/**）');
    } else {
      fs.writeFileSync(asarPath, 'stub-asar');
    }
  }

  // 6) 打包 GUI 冒烟（Playwright 启动候选 exe，与真实双击同一机制）。
  //    脚本内已 delete ELECTRON_RUN_AS_NODE；不修改系统全局变量、不关 sandbox。
  //    任务 D：用 node 直接跑 CJS（**不再用 npx tsx** —— tsx 非声明依赖，会联网下载）。
  if (!opts.skipGui) {
    step('smoke:gui', nodeBin, [path.join(__dirname, 'smoke-packaged.cjs'), outDir]);
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

  // 9) 登记（绑定构建记录 + out 清单 + 锁文件；显式传 --root 保证登记查的是本次构建根）
  const record = writeBuildRecord(ROOT, candRoot, buildId, steps);
  const manifest = path.join(candRoot, 'candidate-manifest.json');
  step('register', nodeBin, [
    CANDIDATE_MANIFEST, 'register',
    '--root', ROOT,
    '--manifest', manifest,
    '--candidate-dir', outDir,
    '--build-record', record,
    '--zip', zipPath,
    '--build-id', buildId,
    // S5：本分支是 electron-builder 真实打包链，必须显式声明；
    // 否则登记器默认 manual-repack 会写出「手工重封」备注与
    // reproducibleBuild=false，让发布材料里的来源方式不真实。
    '--pack-method', 'electron-builder',
  ]);

  // 10) 发布身份核验（core 层，verify-release 三元显式绑定）：
  //     只校验事实/产物/来源绑定，**不要求发布资格**——资格与回执由步骤 12 终判。
  //     这里不能传 --require-release-eligibility：完成回执此刻还不存在，
  //     先要求资格会重建「记录要求自己尚未发生的回执」式自引用（R1）。
  step('verify:release', nodeBin, [
    VERIFY_RELEASE, '--manifest', manifest, '--candidate-dir', outDir, '--build-id', buildId,
    '--root', ROOT,
  ]);

  // 10.5) 完成回执（R1）：走到这里说明 register 与 core 核验都真实退出 0，
  //       写独立 release-receipt/1。任一失败时链路已在此前 STOPPED，
  //       回执不会被写出（失败即阻断回执）。
  //       回执必须绑定**真实存在的 manifest**——测试桩（OTS_STEP_STUB）注入下
  //       register 未真实执行、manifest 不存在，此时不写回执（回执缺席会被
  //       发布级 verify 拒绝，不影响桩场景的开发构建结论）。
  if (fs.existsSync(manifest)) {
    writeReleaseReceipt(candRoot, buildId, sourceCommit, manifest, record);
  } else {
    console.log('  [stub] 登记未真实发生（manifest 不存在），跳过完成回执');
  }

  // 11) 构建后冻结复核：源码提交必须未变
  const headAfter = gitsha();
  if (headAfter !== sourceCommit) {
    console.error(`[FAIL] 构建过程中源码提交发生变化：${sourceCommit} → ${headAfter}，候选身份作废`);
    process.exit(1);
  }

  // 12) 发布资格终判（R1/R2）：资格由共享校验器按可信策略重算（不信任自报），
  //     且必须持有完成回执（register + core 核验确实完成的证据）。
  //     旧 finalize 回写路径已删除——登记后 build-record/2 不可变。
  const eligibility = readReleaseEligibility(candRoot);
  const hasReceipt = fs.existsSync(path.join(candRoot, 'release-receipt.json'));
  const problems = [...eligibility.problems];
  if (!hasReceipt) {
    problems.push('完成回执 release-receipt.json 缺失：register 或核心核验未完成，不得发布');
  }
  const skipped = [...(opts.skipE2e ? ['test:e2e', 'test:e2e:electron'] : []), ...(opts.skipGui ? ['smoke:gui'] : [])];

  console.log(`\nmanifest: ${path.relative(ROOT, manifest)}`);
  if (fs.existsSync(zipPath)) {
    console.log(`zip:      ${path.relative(ROOT, zipPath)} (sha256=${sha256File(zipPath).slice(0, 16)}…)`);
  }
  const exePath = path.join(outDir, EXE_NAME);
  if (fs.existsSync(exePath)) {
    console.log(`exe:      sha256=${sha256File(exePath).slice(0, 16)}…`);
  }

  if (eligibility.ok && hasReceipt) {
    // S2：build 侧不得凭自判输出发布成功——写完回执后调用与独立 verify
    // **同一判据**的发布级只读终检（全绑定 + --require-release-eligibility），
    // 真实退出 0 才输出唯一 ALL_GREEN；不回写 record（登记后不可变）。
    console.log('\n=== 发布级只读终检（S2：与独立 verify 同一判据）===');
    const fr = spawnSync(nodeBin, [
      VERIFY_RELEASE, '--manifest', manifest, '--candidate-dir', outDir, '--build-id', buildId,
      '--root', ROOT, '--require-release-eligibility',
    ], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', windowsHide: true });
    if (fr.error || fr.status !== 0) {
      const code = typeof fr.status === 'number' && fr.status !== 0 ? fr.status : 1;
      console.error(`[FAIL] 发布级终检未通过（退出 ${code}）：不得输出发布 ALL_GREEN`);
      process.exit(code);
    }
    console.log(`\nALL_GREEN buildId=${buildId}`);
  } else {
    // 开发构建：明确区别于发布 ALL_GREEN，且标注不可发布
    console.log(`\nDEV_BUILD_COMPLETE buildId=${buildId}（不可发布，releaseEligible=false）`);
    if (skipped.length) console.log(`  本次跳过（开发构建允许）：${skipped.join('、')}`);
    for (const p of problems) console.log(`  原因：${p}`);
    if (opts.strict) {
      console.error('[FAIL] --strict 模式下要求发布资格，但本次构建不可发布');
      process.exit(1);
    }
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

  // N4：未知参数必须报错。此前尾部参数（例如只想给 verify 加 --strict）会被静默丢弃，
  // 调用者以为生效了、实际没有——这类「以为加了其实没加」比直接失败更危险。
  if (opts.unknown && opts.unknown.length) {
    console.error(`[FAIL] 无法识别的参数：${opts.unknown.join(' ')}`);
    usage();
    process.exit(2);
  }
  // N4：需要值的选项缺值同样不能放行——`--manifest` 后面没跟路径时，旧行为是
  // 把它当成「没声明绑定」，于是调用者指定的目标被静默忽略。宁可失败。
  if (opts.missingValue && opts.missingValue.length) {
    console.error(`[FAIL] 选项缺少参数值：${opts.missingValue.join(' ')}`);
    usage();
    process.exit(2);
  }

  if (opts.mode === 'build') {
    const buildId = opts.buildId || newBuildId();
    runBuild(buildId, opts);
  } else if (opts.mode === 'verify') {
    if (!opts.buildId) { usage(); process.exit(2); }
    // N4：--strict 只对 build 模式有意义（验证「本次构建是否具备发布资格」）。
    // verify 模式本身已经用 --require-release-eligibility 要求发布级结论，
    // 再传 --strict 说明调用者对自己的调用方式有误解，明确失败而不是假装接受。
    if (opts.strict) {
      console.error('[FAIL] verify 模式不接受 --strict：核验已经要求发布级结论（--require-release-eligibility）');
      console.error('       若想要求「本次构建具备发布资格」，请用 build 模式加 --strict。');
      process.exit(2);
    }
    // N4：verify 模式的显式绑定校验（build 模式不使用这两个变量）
    const candidateDir = path.join(ROOT, `candidate-${opts.buildId}`, 'win-unpacked');
    const manifest = path.join(ROOT, `candidate-${opts.buildId}`, 'candidate-manifest.json');
    assertExplicitBinding(opts, { candidateDir, manifest });
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
  // R1/R2：门禁场景 5e 组合式验收需要的真实实现（记录/回执/asar/zip）
  writeBuildRecord,
  writeReleaseReceipt,
  packOutAsar,
  makeZip,
};
