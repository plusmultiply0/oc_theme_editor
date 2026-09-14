#!/usr/bin/env node
/**
 * 候选身份登记与核验（R2 → S3 → P2）。
 *
 * 核心契约（P2 关键修正）：
 *   1. **manifest 与源码分离**：登记文件写到本次构建的产物目录
 *      （典型 `<项目>/candidate-<buildId>/candidate-manifest.json`），落在
 *      `.gitignore` 的 candidate- 忽略范围内，不参与源码提交——否则
 *      「写登记 → 工作树判脏 → 提交又换 HEAD」自相矛盾（B2）。
 *   2. **必须显式传 `--manifest`**：不偷偷回落根目录历史 manifest。已存在的
 *      目标默认拒绝覆盖（需 `--force` 才允许）。
 *   3. **源码冻结用严格 Git 判定**：Git 查询失败必须报错（不能把空字符串
 *      当干净状态）；已跟踪文件改动、以及**新增的未跟踪源码/构建脚本**
 *      都必须阻止登记；仅豁免明确的生成/证据路径。
 *   4. **构建记录绑定**：要求同时提供本次构建记录（`--build-record`），
 *      登记其 hash，并核对它声明的 sourceCommit / lockfile / 版本与本次输入
 *      一致——不接受「旧 out 还在就代表刚构建过」。R1/R2：记录必须是
 *      build-record/2 且结构/事实合格（checkRecordFacts），旧 /1 自引用
 *      记录不得入册；登记后记录不可变（不再有 finalize 回写）。
 *
 * 用法：
 *   node tools/candidate-manifest.cjs register --manifest <路径> --candidate-dir <候选目录>
 *        --build-record <构建记录 json> [--zip <zip路径>] [--build-id <id>]
 *        [--pack-method electron-builder|manual-repack] [--note <说明>] [--force]
 *   node tools/candidate-manifest.cjs check --manifest <路径>
 *   node tools/candidate-manifest.cjs show  --manifest <路径>
 *
 * 所有子命令都接受 `--root <仓库根>`：默认是**本脚本所在仓库**；显式传入后
 * 所有相对路径（候选目录、构建记录、manifest、out/、锁文件）都以该根解析，
 * 供命令级集成测试在独立小型 Git 夹具里真实执行，不改动本仓库。
 *
 * 退出码：0 通过；1 失败。只读核对，不修改候选本身。
 */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// R1/R2：登记只接受 build-record/2 且结构/事实合格——与核验端（verify-release）
// 共用 tools/release-eligibility.cjs 同一把尺子，旧 /1 自引用记录不得入册。
const { RECORD_SCHEMA, checkRecordFacts } = require('./release-eligibility.cjs');

/** 本脚本所在仓库（默认根）；实际根可由 --root 覆盖 */
const SCRIPT_ROOT = path.resolve(__dirname, '..');
let ROOT = SCRIPT_ROOT;
const SCHEMA = 'candidate-manifest/3';

/** 读取当前根的 package.json（在 applyRoot 之后调用；根由 --root 决定） */
function readPkg() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  } catch (e) {
    console.error(`[FAIL] 无法读取 ${path.relative(process.cwd(), path.join(ROOT, 'package.json'))}：${e.message}`);
    process.exit(1);
  }
}

const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/* ---------------- Git：失败必须报错，不得当成「干净」 ---------------- */

/**
 * 读取 Git 状态（严格）。返回 { ok, head, porcelain, error }。
 * 任何失败（非仓库、git 不可用、命令非 0 退出）都置 ok=false + error，绝不静默。
 */
function gitState(cwd = ROOT) {  const run = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    const head = run(['rev-parse', 'HEAD']);
    if (!/^[0-9a-f]{40}$/.test(head)) {
      return { ok: false, head: '', porcelain: '', error: `rev-parse HEAD 返回非提交值：${head || '(空)'}` };
    }
    const porcelain = run(['status', '--porcelain']);
    return { ok: true, head, porcelain, error: '' };
  } catch (e) {
    return { ok: false, head: '', porcelain: '', error: e && e.message ? e.message.split('\n')[0] : String(e) };
  }
}

/**
 * 允许出现在冻结判定之外、且不影响源码身份的路径（生成产物 / 证据 / 会话数据）。
 * 注意：构建记录（build-record*.json）属生成产物，其 hash 由登记单独绑定，
 * 不构成源码身份，故豁免——否则「登记本次构建记录」本身会把工作树判脏。
 */
const EXEMPT_PREFIXES = [
  'candidate-', 'release', 'out/', 'dist/', 'node_modules/', 'backups/',
  'handoff/', '.workbuddy/', 'test-results/', 'playwright-report/',
];
const EXEMPT_FILES = ['build-record.json'];

/**
 * 严格冻结判定：把 porcelain 行分成
 *   - trackedDirty：已跟踪文件的修改/删除/改名（必须拒绝）；
 *   - untrackedCode：未跟踪的**源码或脚本**（必须拒绝，不能统一忽略 `??`）；
 *   - ignored：明确的生成/证据路径（豁免）。
 * 返回 { trackedDirty, untrackedCode, ignored }。porcelain 为 null/undefined 视为调用错误。
 */
function classifyWorktree(porcelain) {
  if (porcelain === null || porcelain === undefined) {
    throw new Error('classifyWorktree 需要一个 porcelain 字符串（Git 状态读取失败时不要调用）');
  }
  const trackedDirty = [];
  const untrackedCode = [];
  const ignored = [];
  for (const raw of String(porcelain).split('\n')) {
    if (!raw.trim()) continue;
    const code = raw.slice(0, 2);
    const p = raw.slice(3).trim().replace(/^"|"$/g, '');
    const rel = p.includes(' -> ') ? p.split(' -> ').pop() : p;
    if (code !== '??') { trackedDirty.push(`${code} ${rel}`); continue; }
    const exempt = EXEMPT_PREFIXES.some((pre) => rel.startsWith(pre) || rel === pre.replace(/\/$/, ''))
      || EXEMPT_FILES.includes(rel);
    if (exempt) ignored.push(rel);
    else untrackedCode.push(rel);
  }
  return { trackedDirty, untrackedCode, ignored };
}

/* ---------------- 参数 ---------------- */

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') opts.manifest = argv[++i];
    else if (a === '--root') opts.root = argv[++i];
    else if (a === '--candidate-dir') opts.candidateDir = argv[++i];
    else if (a === '--build-record') opts.buildRecord = argv[++i];
    else if (a === '--zip') opts.zip = argv[++i];
    else if (a === '--build-id') opts.buildId = argv[++i];
    else if (a === '--pack-method') opts.packMethod = argv[++i];
    else if (a === '--note') opts.note = argv[++i];
    else if (a === '--force') opts.force = true;
    else opts._.push(a);
  }
  return opts;
}

/** 应用 --root：所有后续相对路径都以该根解析（默认脚本所在仓库） */
function applyRoot(opts) {
  if (!opts.root) return;
  const r = path.resolve(process.cwd(), opts.root);
  if (!fs.existsSync(r) || !fs.statSync(r).isDirectory()) {
    console.error(`--root 不是目录：${opts.root}`);
    process.exit(1);
  }
  ROOT = r;
}

/** 解析 --manifest（必填）。显式给出，绝不回落根目录历史 manifest。 */
function requireManifestPath(opts) {
  if (!opts.manifest) {
    console.error('必须显式提供 --manifest <路径>（通常为 <候选产物目录>/candidate-manifest.json）。');
    console.error('本工具不回落根目录历史 candidate-manifest.json——那是历史记录，不是本次发布登记。');
    process.exit(1);
  }
  const p = path.resolve(ROOT, opts.manifest);
  const inCandidateArea = path.relative(ROOT, p).split(path.sep)[0].startsWith('candidate-');
  if (!inCandidateArea) {
    // 允许放在任意生成目录，但提示一次：manifest 不应进入源码提交范围
    console.error(`[提示] manifest 目标不在 candidate- 生成目录内：${path.relative(ROOT, p)}`);
  }
  return p;
}

/* ---------------- register ---------------- */

function cmdRegister(argv) {
  const opts = parseArgs(argv);
  applyRoot(opts);
  const manifestPath = requireManifestPath(opts);

  const dirArg = opts.candidateDir || (opts._[0] && !opts._[0].startsWith('--') ? opts._[0] : '');
  if (!dirArg) {
    console.error('缺少 --candidate-dir <候选目录>（win-unpacked，含 OpenCodeThemeSwitcher.exe 与 resources/app.asar）');
    process.exit(1);
  }
  const candidateDir = path.resolve(ROOT, dirArg);
  const exe = path.join(candidateDir, 'OpenCodeThemeSwitcher.exe');
  const asar = path.join(candidateDir, 'resources', 'app.asar');
  for (const f of [exe, asar]) {
    if (!fs.existsSync(f)) {
      console.error(`候选缺少 ${path.relative(ROOT, f)}，不是完整 win-unpacked 候选`);
      process.exit(1);
    }
  }

  // 默认拒绝覆盖已存在的登记（避免把两次构建混成一份身份）
  if (fs.existsSync(manifestPath) && !opts.force) {
    console.error(`[FAIL] 登记目标已存在，默认拒绝覆盖：${path.relative(ROOT, manifestPath)}`);
    console.error('       每次构建使用全新目录与唯一 buildId；确需覆盖请显式加 --force。');
    process.exit(1);
  }

  const packMethod = opts.packMethod || 'manual-repack';
  if (!['electron-builder', 'manual-repack'].includes(packMethod)) {
    console.error(`--pack-method 只支持 electron-builder | manual-repack，收到 ${packMethod}`);
    process.exit(1);
  }

  // ---- 1) 源码冻结（严格 Git）----
  const state = gitState();
  if (!state.ok) {
    console.error(`[FAIL] 无法读取 Git 状态，按未冻结处理：${state.error}`);
    console.error('       不接受「Git 读不到就当干净」。修复 Git 环境后重试。');
    process.exit(1);
  }
  const { trackedDirty, untrackedCode, ignored } = classifyWorktree(state.porcelain);
  if (trackedDirty.length) {
    console.error(`[FAIL] 工作树已跟踪文件存在未提交改动（${trackedDirty.length} 项）：${trackedDirty.slice(0, 3).join('；')}`);
    console.error('       登记前必须冻结源码：提交或还原后再登记。');
    process.exit(1);
  }
  if (untrackedCode.length) {
    console.error(`[FAIL] 存在未跟踪的源码/脚本（${untrackedCode.length} 项）：${untrackedCode.slice(0, 3).join('；')}`);
    console.error('       未跟踪的构建输入会让「源码提交」无法代表构建内容；请纳入提交或移除后再登记。');
    process.exit(1);
  }
  const sourceCommit = state.head;

  // ---- 2) 构建记录（必须属于本次输入）----
  if (!opts.buildRecord) {
    console.error('[FAIL] 缺少 --build-record <构建记录 json>：登记必须绑定本次构建记录。');
    console.error('       不接受「旧 out 存在就代表刚构建」；先由发布链生成 build-record.json。');
    process.exit(1);
  }
  const buildRecordPath = path.resolve(ROOT, opts.buildRecord);
  if (!fs.existsSync(buildRecordPath)) {
    console.error(`[FAIL] 构建记录不存在：${opts.buildRecord}`);
    process.exit(1);
  }
  let record;
  try {
    record = JSON.parse(fs.readFileSync(buildRecordPath, 'utf8'));
  } catch (e) {
    console.error(`[FAIL] 构建记录无法解析：${e.message}`);
    process.exit(1);
  }
  // ---- 2.1) 构建记录 schema/事实（R1/R2）：与核验端同一把尺子 ----
  // 旧 /1 记录把尚未发生的 register/verify:release 写成 pending（自引用），
  // 不得入册；未知 policyVersion、畸形 steps、注入标志、重复步骤同样拒绝。
  if (!record || typeof record !== 'object' || record.schema !== RECORD_SCHEMA) {
    console.error(
      `[FAIL] 构建记录 schema=${(record && record.schema) || '(缺失)'} 不是 ${RECORD_SCHEMA}：` +
      '旧 /1 记录自引用登记后步骤，拒绝登记（请由当前发布链重新生成 build-record/2）。',
    );
    process.exit(1);
  }
  const facts = checkRecordFacts(record);
  if (!facts.ok) {
    console.error('[FAIL] 构建记录结构/事实校验失败（checkRecordFacts），拒绝登记：');
    for (const p of facts.problems) console.error(`       - ${p}`);
    process.exit(1);
  }
  // S1：构建身份交叉校验（与核验端共用 checkRecordBinding）——
  // record.buildId 必填、显式 --build-id 必须与记录一致、锁文件 hash 必填。
  const { checkRecordBinding } = require('./verify-release.cjs');
  const bindProblems = checkRecordBinding(record, { buildId: opts.buildId });
  if (bindProblems.length) {
    console.error('[FAIL] 构建身份校验失败（S1：同一构建的身份不能缺失或改名）：');
    for (const p of bindProblems) console.error(`       - ${p}`);
    process.exit(1);
  }
  if (!record.sourceCommit || !record.out || !record.out.files) {
    console.error('[FAIL] 构建记录缺少必需字段（sourceCommit / out.files）：拒绝登记。');
    process.exit(1);
  }
  if (record.sourceCommit !== sourceCommit) {
    console.error(`[FAIL] 构建记录 sourceCommit=${String(record.sourceCommit).slice(0, 12)} 与当前 HEAD ${sourceCommit.slice(0, 12)} 不一致；`);
    console.error('       说明记录不是本次冻结源码的构建。重新构建并生成记录，不要伪改字段。');
    process.exit(1);
  }
  if (record.version !== readPkg().version) {
    console.error(`[FAIL] 构建记录 version=${record.version} 与 package.json ${readPkg().version} 不一致，需重新构建/登记。`);
    process.exit(1);
  }

  // ---- 3) 锁文件 + 版本（记录并实际比较）----
  const lockfilePath = path.join(ROOT, 'package-lock.json');
  if (!fs.existsSync(lockfilePath)) {
    console.error('[FAIL] 未找到 package-lock.json：登记必须记录锁文件 hash。');
    process.exit(1);
  }
  const lockfileSha256 = sha256(lockfilePath);
  // S1：lockfileSha256 必填已在 checkRecordBinding 校验（record 侧）；
  // 这里比对磁盘锁文件与记录是否同一份依赖。
  if (record.lockfileSha256 !== lockfileSha256) {
    console.error('[FAIL] 构建记录里的锁文件 hash 与当前 package-lock.json 不一致（依赖已变），需重新构建。');
    process.exit(1);
  }

  // ---- 4) out 冻结清单：必须与构建记录一致（记录即本次输入）----
  const { outManifestOfDir, diffOutManifest } = require('./verify-release.cjs');
  let outManifest;
  try {
    outManifest = outManifestOfDir(path.join(ROOT, 'out'));
  } catch (e) {
    console.error(`[FAIL] 无法生成构建输出清单：${e.message}`);
    console.error('       登记必须发生在本次构建之后，且传入的是 out 目录本身。');
    process.exit(1);
  }
  const outDiff = diffOutManifest(record.out, outManifest);
  if (outDiff.missing.length || outDiff.extra.length || outDiff.changed.length) {
    console.error('[FAIL] 当前 out/** 与构建记录不一致，说明登记的不是记录对应的那次构建：');
    if (outDiff.missing.length) console.error(`       记录中有而磁盘缺失 ${outDiff.missing.length} 个：${outDiff.missing.slice(0, 3).join('、')}`);
    if (outDiff.extra.length) console.error(`       磁盘多出记录外 ${outDiff.extra.length} 个：${outDiff.extra.slice(0, 3).join('、')}`);
    if (outDiff.changed.length) console.error(`       内容不一致 ${outDiff.changed.length} 个：${outDiff.changed.slice(0, 3).join('、')}`);
    process.exit(1);
  }

  const manifest = {
    schema: SCHEMA,
    version: readPkg().version,
    // S1：--build-id 与 record.buildId 的相等性已在 checkRecordBinding 校验；
    // manifest.buildId 恒取记录侧身份，不允许静默改名。
    buildId: record.buildId,
    sourceCommit,
    sourceCommitSubject: execFileSync('git', ['log', '-1', '--format=%s', sourceCommit], { cwd: ROOT, encoding: 'utf8' }).trim(),
    registeredAt: new Date().toISOString(),
    packMethod,
    reproducibleBuild: packMethod === 'electron-builder',
    lockfileSha256,
    buildRecord: {
      path: path.relative(ROOT, buildRecordPath).replace(/\\/g, '/'),
      sha256: sha256(buildRecordPath),
    },
    out: { fileCount: Object.keys(outManifest.files).length, files: outManifest.files },
    ignoredWorktreePaths: ignored,
    candidateDir: path.relative(ROOT, candidateDir).replace(/\\/g, '/'),
    zip: null,
    hashes: { exe: sha256(exe), 'app.asar': sha256(asar), zip: null },
    notes:
      opts.note ||
      (packMethod === 'manual-repack'
        ? '手工重封候选：普通 dist 通过不代表此候选/zip 的生成证据，重建需按 handoff 记录执行。'
        : ''),
  };
  if (!manifest.buildId) {
    console.error('[FAIL] 无法确定 buildId（既未传 --build-id，构建记录也没有 buildId）。');
    process.exit(1);
  }
  if (opts.zip) {
    const zipPath = path.resolve(ROOT, opts.zip);
    if (!fs.existsSync(zipPath)) {
      console.error(`zip 不存在：${opts.zip}`);
      process.exit(1);
    }
    manifest.zip = path.relative(ROOT, zipPath).replace(/\\/g, '/');
    manifest.hashes.zip = sha256(zipPath);
  }

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`已登记候选 -> ${path.relative(ROOT, manifestPath)}（schema ${SCHEMA}）`);
  printManifest(manifest);
}

/* ---------------- check / show ---------------- */

function printManifest(m) {
  console.log(`  version      ${m.version}`);
  console.log(`  buildId      ${m.buildId}`);
  console.log(`  sourceCommit ${String(m.sourceCommit).slice(0, 12)} ${m.sourceCommitSubject || ''}`);
  console.log(`  packMethod   ${m.packMethod}（reproducibleBuild=${m.reproducibleBuild}）`);
  console.log(`  candidateDir ${m.candidateDir}`);
  if (m.zip) console.log(`  zip          ${m.zip}`);
  console.log(`  exe  sha256  ${m.hashes.exe}`);
  console.log(`  asar sha256  ${m.hashes['app.asar']}`);
  if (m.hashes.zip) console.log(`  zip  sha256  ${m.hashes.zip}`);
  if (m.lockfileSha256) console.log(`  lock sha256  ${m.lockfileSha256}`);
  if (m.buildRecord) console.log(`  buildRecord  ${m.buildRecord.path}  sha256=${String(m.buildRecord.sha256).slice(0, 16)}…`);
  if (m.out) console.log(`  out/**       ${m.out.fileCount} 个文件（冻结清单，发布门禁逐文件核对）`);
  if (m.notes) console.log(`  notes        ${m.notes}`);
}

function loadManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    console.error(`未找到 ${path.relative(ROOT, manifestPath)}：请先 register 生成本次候选登记（--manifest 显式指定）。`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function cmdCheck(argv) {
  const opts = parseArgs(argv);
  applyRoot(opts);
  const manifestPath = requireManifestPath(opts);
  const m = loadManifest(manifestPath);
  const problems = [];
  if (m.schema !== SCHEMA) problems.push(`schema=${m.schema || '(缺失)'} 不是 ${SCHEMA}（旧登记缺少构建记录绑定）`);

  const dir = path.resolve(ROOT, m.candidateDir || '');
  if (!m.candidateDir || !fs.existsSync(dir)) {
    problems.push(`候选目录不存在：${m.candidateDir || '(缺失)'}`);
  } else {
    const exe = path.join(dir, 'OpenCodeThemeSwitcher.exe');
    const asar = path.join(dir, 'resources', 'app.asar');
    if (!fs.existsSync(exe) || sha256(exe) !== m.hashes.exe) problems.push('exe 缺失或 hash 与登记不符');
    if (!fs.existsSync(asar) || sha256(asar) !== m.hashes['app.asar']) problems.push('app.asar 缺失或 hash 与登记不符');
  }
  if (m.zip) {
    const zp = path.resolve(ROOT, m.zip);
    if (!fs.existsSync(zp) || sha256(zp) !== m.hashes.zip) problems.push('zip 缺失或 hash 与登记不符');
  }
  if (m.version !== readPkg().version) {
    problems.push(`manifest version ${m.version} != package.json version ${readPkg().version}（源码版本已变，需重新登记/冻结候选）`);
  }
  if (m.lockfileSha256) {
    const lock = path.join(ROOT, 'package-lock.json');
    if (!fs.existsSync(lock) || sha256(lock) !== m.lockfileSha256) {
      problems.push('package-lock.json 缺失或 hash 与登记不符（依赖已变，需重新登记）');
    }
  }
  if (m.buildRecord && m.buildRecord.path) {
    const br = path.resolve(ROOT, m.buildRecord.path);
    if (!fs.existsSync(br)) problems.push(`构建记录缺失：${m.buildRecord.path}`);
    else if (sha256(br) !== m.buildRecord.sha256) problems.push('构建记录 hash 与登记不符（记录被改过）');
  }
  if (m.out && m.out.files) {
    const { outManifestOfDir, diffOutManifest } = require('./verify-release.cjs');
    let localOut;
    try {
      localOut = outManifestOfDir(path.join(ROOT, 'out'));
    } catch (e) {
      problems.push(`无法生成本地 out 清单：${e.message}`);
    }
    if (localOut) {
      const diff = diffOutManifest(m.out, localOut);
      if (diff.missing.length) problems.push(`本地 out/** 缺少登记文件 ${diff.missing.length} 个：${diff.missing.slice(0, 3).join('、')}`);
      if (diff.extra.length) problems.push(`本地 out/** 多出登记外文件 ${diff.extra.length} 个：${diff.extra.slice(0, 3).join('、')}`);
      if (diff.changed.length) problems.push(`本地 out/** 与登记清单内容不一致 ${diff.changed.length} 个：${diff.changed.slice(0, 3).join('、')}`);
    }
  }
  if (problems.length) {
    for (const p of problems) console.error(`[FAIL] ${p}`);
    process.exit(1);
  }
  console.log('候选身份核对通过（磁盘与登记一致）');
  printManifest(m);
}

function cmdShow(argv) {
  const opts = parseArgs(argv);
  applyRoot(opts);
  printManifest(loadManifest(requireManifestPath(opts)));
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'register') cmdRegister(rest);
else if (cmd === 'check') cmdCheck(rest);
else if (cmd === 'show' || !cmd) cmdShow(rest);
else {
  console.error(`未知子命令 ${cmd}；可用：register / check / show`);
  process.exit(1);
}

module.exports = { SCHEMA, gitState, classifyWorktree, EXEMPT_PREFIXES };
