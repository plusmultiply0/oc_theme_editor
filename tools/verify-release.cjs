#!/usr/bin/env node
/**
 * 本次发布门禁核验（S3）——与「旧候选身份核验」（tools/verify-package.cjs）分开命名与输出。
 *
 * 定位：verify-package.cjs 只证明「登记候选的磁盘身份与登记一致」，不证明
 * 「当前源码的本次构建已通过发布验收」（S3 之前它甚至拦不住候选缺 ImageStore 修复）。
 * 本工具只回答一个问题：**这份候选是否绑定当前源码的本次构建**。
 *
 * 失败关闭原则（任一不满足即失败，绝不回落）：
 *   1. candidate-manifest.json 必须是 candidate-manifest/2（旧 /1 登记缺 out/** 冻结清单，不得通过）；
 *   2. manifest.buildId 必须 === --build-id（禁止回落历史 manifest）；
 *   3. --candidate-dir 解析后必须 === manifest.candidateDir（显式目标与登记不一致即失败，
 *      不自动重登记掩盖不一致）；
 *   4. manifest.sourceCommit 必须 === 当前 git HEAD，且已跟踪文件无未提交改动（源码冻结）；
 *   5. 本地 out/** 必须与 manifest.out 冻结清单逐文件一致（缺/多/hash 差都失败）——旧 out
 *      不能充当当前源码的唯一证据；
 *   6. 候选 asar 内 out/** 必须与 manifest.out 完全一致，且至少包含图片修复三模块
 *      （ImageStore / theme generate / image-probe）；
 *   7. zip 必须从同一候选目录打包：逐条目 CRC32+大小与磁盘一致，条目集合相等（缺/多都报告），
 *      zip hash 与登记一致；分发验收禁止 --no-identity（本工具无该开关）。
 *
 * 用法：node tools/verify-release.cjs --candidate-dir <候选目录> --build-id <本次构建ID> [--source-commit <sha>]
 * 退出码：0 时——发布级（--require-release-eligibility）打印 RELEASE_GREEN、
 *          core 基础核验打印 CORE_VERIFY_GREEN（S2：core ≠ 发布资格）；
 *          1 有失败项（逐条列出）。
 */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// --root 可在 main 中重新指向（夹具测试传夹具根）；默认为编排根
let ROOT = path.resolve(__dirname, '..');

/** 图片修复三模块：本轮修复落点，out/** 核对集合必须至少覆盖这些（S3 执行方案 4） */
const REQUIRED_MODULES = [
  'out/main/services/image-store.js',
  'out/core/theme/generate.js',
  'out/core/theme/image-probe.js',
];

/**
 * 发布资格校验（任务 C/R2）：**复用共享实现** `tools/release-eligibility.cjs`，
 * 保证与 `release-build.cjs` 的判定同一把尺子。用于关闭
 * 「跳过检查仍可发布」缺口——只核对 hash 不看步骤契约是不够的。
 * core 层用 checkRecordFacts（结构+已记录步骤事实）；发布级判定用
 * checkReleaseEligibility（12 项齐全）。R2：记录不能自行缩减必检集合。
 */
const { checkRecordFacts, checkReleaseEligibility } = require('./release-eligibility.cjs');

const RECEIPT_SCHEMA = 'release-receipt/1';

/**
 * release-receipt/1 完成回执绑定校验（R1，纯函数）。
 * 回执必须存在、schema 正确，且与 manifest/构建记录/buildId/sourceCommit 的
 * 当前事实完全绑定——任何一项对不上都视为「回执来自另一次构建」或产物被篡改。
 * @param {object} params
 * @param {object|null} params.receipt 已解析的回执（不存在/不可解析传 null）
 * @param {string} params.manifestHash 当前 manifest 文件 sha256
 * @param {string} params.buildRecordHash 当前构建记录文件 sha256
 * @param {string} params.buildId 期望 buildId
 * @param {string} params.sourceCommit 期望来源提交
 * @returns {string[]} 问题列表（空 = 通过）
 */
function checkReleaseReceipt({ receipt, manifestHash, buildRecordHash, buildId, sourceCommit } = {}) {
  if (!receipt || typeof receipt !== 'object') {
    return ['完成回执 release-receipt.json 缺失或不可解析：register 与 core 核验未完成，不得给发布绿色结果'];
  }
  const problems = [];
  if (receipt.schema !== RECEIPT_SCHEMA) {
    problems.push(`回执 schema=${receipt.schema || '(缺失)'} 不是 ${RECEIPT_SCHEMA}`);
  }
  if (receipt.buildId !== buildId) {
    problems.push(`回执 buildId=${receipt.buildId || '(缺失)'} ≠ 期望 ${buildId}`);
  }
  if (receipt.sourceCommit !== sourceCommit) {
    problems.push(
      `回执 sourceCommit=${String(receipt.sourceCommit || '(缺失)').slice(0, 12)} ≠ 期望 ${String(sourceCommit || '').slice(0, 12)}`,
    );
  }
  if (receipt.manifestHash !== manifestHash) {
    problems.push('回执 manifestHash 与当前登记文件不符（登记被改过，或回执来自另一次构建）');
  }
  if (receipt.buildRecordHash !== buildRecordHash) {
    problems.push('回执 buildRecordHash 与当前构建记录不符（记录被改过，或回执来自另一次构建）');
  }
  return problems;
}

/**
 * S1：构建身份交叉校验（纯函数，登记端与核验端共用同一把尺子）。
 * buildId 是一次构建的身份，不能静默改名：record.buildId 必须是非空字符串；
 * 显式 --build-id、manifest.buildId、manifest.sourceCommit、manifest.version
 * 一旦提供必须与记录一致；record.lockfileSha256 必填（锁文件身份不能
 * 「字段有才比较」）。核验端独立执行本检查，不假设所有 manifest 都由
 * 当前登记器正确写出。
 * @returns {string[]} 问题列表（空 = 通过）
 */
function checkRecordBinding(record, { buildId, manifest } = {}) {
  const problems = [];
  if (!record || typeof record !== 'object') {
    problems.push('构建记录缺失或不可解析');
    return problems;
  }
  if (typeof record.buildId !== 'string' || !record.buildId) {
    problems.push('构建记录缺少 buildId（一次构建的身份不能缺失）');
  } else {
    if (buildId !== undefined && buildId !== null && record.buildId !== buildId) {
      problems.push(`构建记录 buildId=${record.buildId} 与显式目标 buildId=${buildId} 不一致`);
    }
    if (manifest && typeof manifest.buildId === 'string' && manifest.buildId && record.buildId !== manifest.buildId) {
      problems.push(`构建记录 buildId=${record.buildId} 与登记 manifest.buildId=${manifest.buildId} 不一致（同一构建身份不得改名）`);
    }
  }
  if (manifest) {
    if (record.sourceCommit && manifest.sourceCommit && record.sourceCommit !== manifest.sourceCommit) {
      problems.push(
        `构建记录 sourceCommit=${String(record.sourceCommit).slice(0, 12)} 与登记 manifest.sourceCommit=${String(manifest.sourceCommit).slice(0, 12)} 不一致`,
      );
    }
    if (record.version && manifest.version && record.version !== manifest.version) {
      problems.push(`构建记录 version=${record.version} 与登记 manifest.version=${manifest.version} 不一致`);
    }
  }
  if (typeof record.lockfileSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(record.lockfileSha256)) {
    problems.push('构建记录缺少合法 lockfileSha256（锁文件身份必填，不做条件比较）');
  }
  return problems;
}

/*
 * 清单键规范（统一，三处必须一致）：项目逻辑路径 `out/...`，正斜杠分隔。
 *   - outManifestOfDir(<root>/out)：磁盘基准是 out 目录本身，键加一次 `out/`；
 *   - outManifestOfAsar(app.asar)：归档内条目本就写作 `out/...`，直接采用；
 *   - REQUIRED_MODULES：同上。
 * 历史上两者基准不同（磁盘产出 `main/...`，另一侧要 `out/main/...`），
 * 真实调用下会把整批文件报成 50 缺 / 50 多、三个图片模块全判缺失（B1）。
 */

// ---------- 基础 ----------
const sha256Buf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha256File = (f) => sha256Buf(fs.readFileSync(f));

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  } catch {
    return '';
  }
}

/** CRC32（zip 格式标准；自带查表实现，不依赖 node 版本） */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------- ASAR 读取（与 verify-package.cjs 同一头部格式约定） ----------
function readAsarHeader(archive) {
  const fd = fs.openSync(archive, 'r');
  try {
    const pre = Buffer.alloc(16);
    fs.readSync(fd, pre, 0, 16, 0);
    if (pre.readUInt32LE(0) !== 4) throw new Error('magic != 4，不是 ASAR');
    const dataStart = 8 + pre.readUInt32LE(4);
    const size = pre.readUInt32LE(12);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 16);
    return { header: JSON.parse(buf.toString()), dataStart };
  } finally {
    fs.closeSync(fd);
  }
}

function asarEntries(header) {
  const map = new Map();
  (function walk(node, parts) {
    for (const [name, v] of Object.entries(node.files || {})) {
      const next = [...parts, name];
      const rel = next.join('/');
      if (v.files) walk(v, next);
      else map.set(rel, v);
    }
  })(header, []);
  return map;
}

/** 读取 asar 条目内容；unpacked 条目从 app.asar.unpacked 磁盘读；缺失返回 null */
function readAsarEntryBuf(asarPath, entries, dataStart, rel) {
  const node = entries.get(rel);
  if (!node) return null;
  if (node.unpacked) {
    const p = path.join(asarPath + '.unpacked', ...rel.split('/'));
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  }
  const buf = Buffer.alloc(node.size);
  const fd = fs.openSync(asarPath, 'r');
  try {
    fs.readSync(fd, buf, 0, node.size, dataStart + Number(node.offset));
  } finally {
    fs.closeSync(fd);
  }
  return buf;
}

// ---------- out/** 冻结清单 ----------
/** 递归列出目录下所有文件，返回相对路径（正斜杠）数组 */
function listFilesRecursive(dir, base = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...listFilesRecursive(p, base));
    else out.push(path.relative(base, p).replace(/\\/g, '/'));
  }
  return out;
}

const OUT_PREFIX = 'out/';

/**
 * 校验相对路径属于 out/** 规范（清单键统一为 `out/...` 正斜杠路径）：
 *   - 必须以 `out/` 开头，且 `out/` 之后非空；
 *   - 不得出现 `out/out/`（调用者重复加前缀的信号）；
 *   - 不得含反斜杠（分隔符必须统一为 `/`）、`.`/`..` 段、空段、绝对路径或盘符。
 * 返回 null 表示合法，否则返回中文原因（供测试与失败信息直接展示）。
 */
function validateOutKey(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return '路径为空';
  if (rel.includes('\\')) return `含反斜杠分隔符：${rel}`;
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return `是绝对路径或盘符路径：${rel}`;
  if (!rel.startsWith(OUT_PREFIX)) return `不以 out/ 开头：${rel}`;
  const rest = rel.slice(OUT_PREFIX.length);
  if (!rest) return `out/ 之后为空：${rel}`;
  if (rest.startsWith(OUT_PREFIX)) return `重复 out/ 前缀（out/out/…）：${rel}`;
  const segs = rel.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return `含空段或 ./.. 段：${rel}`;
  return null;
}

/**
 * 磁盘目录的 out/** 清单：rel -> { bytes, sha256 }。
 * 参数固定是 **out 目录本身**（例如 <root>/out）；键统一加一次 `out/` 前缀，
 * 与 ASAR 清单、REQUIRED_MODULES 采用同一规范——不得靠调用者传父目录实现对齐。
 * 非法键、重复键、空清单都直接抛错（宁可失败也不要产出不一致的清单）。
 */
function outManifestOfDir(outDir) {
  const files = {};
  const rels = listFilesRecursive(outDir);
  if (rels.length === 0) {
    throw new Error(`out 清单为空：${outDir} 下没有文件（确认传入的是 out 目录本身，且构建已完成）`);
  }
  for (const rel of rels) {
    const key = OUT_PREFIX + rel;
    const invalid = validateOutKey(key);
    if (invalid) throw new Error(`非法 out 清单键（${invalid}）`);
    if (key in files) throw new Error(`重复 out 清单键：${key}`);
    const buf = fs.readFileSync(path.join(outDir, ...rel.split('/')));
    files[key] = { bytes: buf.length, sha256: sha256Buf(buf) };
  }
  return { files };
}

/** asar 内 out/** 清单（unpacked 条目落盘读取）；键规范与 outManifestOfDir 相同 */
function outManifestOfAsar(asarPath) {
  const { header, dataStart } = readAsarHeader(asarPath);
  const entries = asarEntries(header);
  const files = {};
  for (const rel of [...entries.keys()].sort()) {
    if (!rel.startsWith(OUT_PREFIX)) continue;
    const invalid = validateOutKey(rel);
    if (invalid) throw new Error(`归档内非法 out 条目（${invalid}）`);
    if (rel in files) throw new Error(`归档内重复 out 条目：${rel}`);
    const buf = readAsarEntryBuf(asarPath, entries, dataStart, rel);
    files[rel] = buf === null
      ? { error: 'missing-or-unreadable' }
      : { bytes: buf.length, sha256: sha256Buf(buf) };
  }
  return { files };
}

/** 比较两份 out 清单：返回 { missing, extra, changed }，三者都非空即失败 */
function diffOutManifest(expected, actual) {
  const expectedFiles = (expected && expected.files) || {};
  const actualFiles = (actual && actual.files) || {};
  const missing = [];
  const extra = [];
  const changed = [];
  for (const [rel, meta] of Object.entries(expectedFiles)) {
    const a = actualFiles[rel];
    if (!a) missing.push(rel);
    else if (a.error || a.sha256 !== meta.sha256) changed.push(rel);
  }
  for (const rel of Object.keys(actualFiles)) {
    if (!(rel in expectedFiles)) extra.push(rel);
  }
  return { missing, extra, changed };
}

// ---------- 绑定与源码冻结（纯函数，供单元测试复用） ----------
/**
 * 显式目标与登记的一致性检查；返回问题列表（空 = 通过）。
 * headCommit/sourceCommit 任一给出即检查；两者都应等于 manifest.sourceCommit。
 */
function checkBinding({ manifest, root = ROOT, candidateDir, buildId, sourceCommit, headCommit } = {}) {
  const problems = [];
  if (!manifest) {
    problems.push('candidate-manifest.json 不存在：发布门禁必须绑定显式登记，不做默认回落');
    return problems;
  }
  if (manifest.schema !== 'candidate-manifest/3' && manifest.schema !== 'candidate-manifest/2') {
    problems.push(
      `schema=${manifest.schema || '(缺失)'} 不是 candidate-manifest/3：` +
      '旧登记缺少 out/** 冻结清单与构建记录绑定，不允许通过发布门禁（请用 node tools/candidate-manifest.cjs register 重新登记本次构建）',
    );
  }
  if (buildId && manifest.buildId !== buildId) {
    problems.push(`manifest.buildId=${manifest.buildId} ≠ 期望 ${buildId}：禁止回落历史 manifest（唯一 buildId 原则）`);
  }
  if (candidateDir) {
    const registered = path.resolve(root, manifest.candidateDir || '');
    const given = path.resolve(candidateDir);
    const same = path.relative(registered, given) === '' && path.relative(given, registered) === '';
    if (!same) {
      problems.push(
        `显式候选目录 ${candidateDir} 与登记 candidateDir=${manifest.candidateDir} 不一致：` +
        '失败关闭，不允许自动重登记来掩盖不一致',
      );
    }
  }
  if (sourceCommit && manifest.sourceCommit !== sourceCommit) {
    problems.push(`manifest.sourceCommit=${manifest.sourceCommit.slice(0, 12)} ≠ 显式指定 ${sourceCommit.slice(0, 12)}`);
  }
  if (headCommit && manifest.sourceCommit !== headCommit) {
    problems.push(
      `manifest.sourceCommit=${manifest.sourceCommit.slice(0, 12)} ≠ 当前 HEAD ${headCommit.slice(0, 12)}：` +
      '登记的不是本次源码提交（不要仅把 sourceCommit 改成 HEAD 而不重建）',
    );
  }
  return problems;
}

/** 源码冻结检查：git status --porcelain 输出中，非未跟踪（非 ?? 开头）行 = 已跟踪文件有改动 */
function checkSourceFreeze(porcelainOutput) {
  const dirty = String(porcelainOutput || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith('??'));
  return dirty.length === 0 ? [] : [
    `工作树已跟踪文件存在未提交改动（${dirty.length} 项）：${dirty.slice(0, 3).join('；')}——` +
    '构建前必须冻结源码（提交后登记），禁止用漂移的工作树冒充登记提交',
  ];
}

// ---------- ZIP 中央目录 ----------
/** 解析 zip 中央目录，返回文件条目 [{ name, crc32, size }]（目录条目 name 以 / 结尾，已过滤） */
function readZipCentral(zipPath) {
  const buf = fs.readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('找不到 zip EOCD，不是 zip 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) {
      throw new Error(`zip 中央目录第 ${i} 项签名错误`);
    }
    const crc = buf.readUInt32LE(off + 16);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (!name.endsWith('/')) entries.push({ name, crc32: crc, size });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * zip 与候选目录一致性：条目集合相等，逐条目 CRC32+大小与磁盘文件一致。
 * 返回问题列表（空 = 通过）。这正是「zip hash 相符 ≠ zip 内部就是所检目录」缺的那环。
 */
function checkZipMatchesDir(zipPath, dir) {
  const problems = [];
  const diskFiles = listFilesRecursive(dir);
  const diskMap = new Map();
  for (const rel of diskFiles) {
    const buf = fs.readFileSync(path.join(dir, ...rel.split('/')));
    diskMap.set(rel, { size: buf.length, crc32: crc32(buf) });
  }
  let zipEntries;
  try {
    zipEntries = readZipCentral(zipPath);
  } catch (e) {
    return [`zip 无法解析：${e.message}`];
  }
  // 条目名规范化：zip 规范用 `/`，但 Windows PowerShell 5.1 的 Compress-Archive
  // 会写 `\`（本仓库 makeZip 即用它）——比较前统一为 `/`，否则整目录假不一致
  const zipMap = new Map(zipEntries.map((e) => [e.name.replace(/\\/g, '/'), e]));
  for (const [name, e] of zipMap) {
    const d = diskMap.get(name);
    if (!d) { problems.push(`zip 内多出磁盘没有的条目：${name}`); continue; }
    if (d.crc32 !== e.crc32 || d.size !== e.size) {
      problems.push(`zip 条目与磁盘内容不一致（疑似混入旧文件）：${name}（zip crc=${e.crc32.toString(16)} size=${e.size}，磁盘 crc=${d.crc32.toString(16)} size=${d.size}）`);
    }
  }
  for (const rel of diskMap.keys()) {
    if (!zipMap.has(rel)) problems.push(`zip 缺少候选目录中的文件：${rel}`);
  }
  return problems;
}

// ---------- CLI ----------
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--candidate-dir') opts.candidateDir = argv[++i];
    else if (a === '--build-id') opts.buildId = argv[++i];
    else if (a === '--manifest') opts.manifest = argv[++i];
    else if (a === '--source-commit') opts.sourceCommit = argv[++i];
    else if (a === '--skip-deep-zip') opts.skipDeepZip = true;
    // R1：发布级判定旗标（缺失时 runVerify 传了也不生效——必须显式解析）
    else if (a === '--require-release-eligibility') opts.requireReleaseEligibility = true;
    // R1/R2：仓库根（夹具测试必传；manifest/候选/out/锁文件/git 查询都以其解析）
    else if (a === '--root') opts.root = argv[++i];
    else if (a.startsWith('--root=')) opts.root = a.slice('--root='.length);
  }
  return opts;
}

/**
 * zip 深度完整性验证（P3）：按本地文件头逐条真实解压读取，验证声明 CRC 与
 * 实读内容一致，并拒绝越界/重复/目录逃逸条目。仅信中央目录是不够的——
 * 声明与实际内容可以不一致。
 * 返回问题列表。不解压到磁盘，全部在内存比对，且强制条目路径不越出根。
 */
function deepVerifyZip(zipPath) {
  const problems = [];
  const buf = fs.readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return ['zip 找不到 EOCD'];
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const seen = new Set();
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) {
      problems.push(`中央目录第 ${i} 项签名错误`);
      break;
    }
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (seen.has(name)) { problems.push(`zip 内重复条目：${name}`); continue; }
    seen.add(name);
    // 目录逃逸 / 绝对路径
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) {
      problems.push(`zip 条目路径越界（疑似目录逃逸）：${name}`); continue;
    }
    // 本地文件头校验（数据起点）
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) {
      problems.push(`本地文件头签名错误：${name}`); continue;
    }
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    if (method !== 0) {
      // 非 store：只校验范围不越界（压缩解压由系统 unzip 语义保证，这里不重造 inflate）
      if (dataStart + csize > buf.length) problems.push(`条目数据超出文件末尾：${name}`);
      continue;
    }
    if (dataStart + usize > buf.length) { problems.push(`条目数据超出文件末尾：${name}`); continue; }
    const content = buf.subarray(dataStart, dataStart + usize);
    if (content.length !== usize) { problems.push(`条目实际长度与声明不符：${name}`); continue; }
    if (crc32(content) !== crc) problems.push(`条目实读内容 CRC 与声明不符：${name}`);
  }
  return problems;
}

/** 读取 manifest（显式 --manifest；不回落默认路径） */
function loadReleaseManifest(manifestPath) {
  if (!manifestPath) return { missing: true, reason: '未提供 --manifest：发布门禁必须显式绑定登记，不回落默认候选' };
  const p = path.resolve(ROOT, manifestPath);
  if (!fs.existsSync(p)) return { missing: true, reason: `登记的 manifest 不存在：${manifestPath}` };
  try {
    return { manifest: JSON.parse(fs.readFileSync(p, 'utf8')), path: p };
  } catch (e) {
    return { missing: true, reason: `manifest 解析失败：${e.message}` };
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  // --root 必须最先应用：后续所有相对路径（manifest/候选/out/锁文件/git 查询）都以它解析
  if (opts.root) ROOT = path.resolve(opts.root);
  if (!opts.candidateDir || !opts.buildId) {
    console.error('用法：node tools/verify-release.cjs --manifest <登记路径> --candidate-dir <候选目录> --build-id <本次构建ID> [--source-commit <sha>]');
    console.error('      [--require-release-eligibility] [--root <仓库根>]');
    console.error('本次发布门禁必须显式绑定登记（manifest 路径 + buildId + 候选目录）；旧候选身份核验请用 npm run verify:package。');
    process.exit(1);
  }

  const results = [];
  const check = (ok, label, detail) => {
    results.push({ ok: Boolean(ok), label, detail: detail === undefined ? '' : String(detail) });
  };
  console.log(`RELEASE_VERIFY：本次发布门禁（buildId=${opts.buildId}）`);
  console.log(`  核对目标：${opts.candidateDir}`);
  console.log(`  登记清单：${opts.manifest || '(未提供)'}`);
  if (opts.requireReleaseEligibility) {
    console.log('  发布级判定：要求 12 项必检步骤齐全 + 完成回执绑定（--require-release-eligibility）');
  }

  // 1) 绑定与源码冻结
  const loaded = loadReleaseManifest(opts.manifest);
  if (loaded.missing) {
    check(false, '显式登记的 manifest 可用', loaded.reason);
  } else {
    const manifest = loaded.manifest;
    const headCommit = git(['rev-parse', 'HEAD']).trim() || undefined;
    const bindingProblems = checkBinding({
      manifest, root: ROOT, candidateDir: opts.candidateDir,
      buildId: opts.buildId, sourceCommit: opts.sourceCommit, headCommit,
    });
    check(bindingProblems.length === 0, '显式目标与登记绑定一致（buildId/候选目录/来源提交）',
      bindingProblems.join('；'));
    const freezeProblems = checkSourceFreeze(git(['status', '--porcelain']));
    check(freezeProblems.length === 0, '源码冻结（已跟踪文件无未提交改动）', freezeProblems.join('；'));
    // 登记来源一致性：锁文件与构建记录 hash 必须与磁盘一致（不能只记录不比较）
    const lock = path.join(ROOT, 'package-lock.json');
    if (manifest.lockfileSha256) {
      check(fs.existsSync(lock) && sha256File(lock) === manifest.lockfileSha256,
        'package-lock.json 与登记 hash 一致',
        fs.existsSync(lock) ? 'hash 不符（依赖已变，需重新登记）' : 'package-lock.json 缺失');
    } else {
      check(false, '登记含锁文件 hash', '旧登记未记录锁文件 hash');
    }
    if (manifest.buildRecord && manifest.buildRecord.path) {
      const br = path.resolve(ROOT, manifest.buildRecord.path);
      const brOk = fs.existsSync(br) && sha256File(br) === manifest.buildRecord.sha256;
      check(brOk, '构建记录存在且 hash 与登记一致',
        fs.existsSync(br) ? '构建记录 hash 不符（被改过）' : `构建记录缺失：${manifest.buildRecord.path}`);

      // 4) 构建记录事实（R1 core 层）：schema/策略版本/注入标志/已记录步骤事实。
      //    **不要求 12 项齐全**（开发构建允许缺省跳过项）；完整资格由
      //    --require-release-eligibility 另行要求（发布级判定）。
      if (fs.existsSync(br)) {
        try {
          const rec = JSON.parse(fs.readFileSync(br, 'utf8'));
          const facts = checkRecordFacts(rec);
          check(facts.ok, '构建记录事实校验通过（build-record/2 结构、策略版本、已记录步骤均真实通过）',
            facts.problems.join('；'));
          // S1：构建身份交叉校验（core 即查，不等发布级旗标）——record.buildId
          // 必须与 manifest.buildId 及显式 CLI buildId 一致，锁文件 hash 必填。
          const bindingProblems = checkRecordBinding(rec, { buildId: opts.buildId, manifest });
          check(bindingProblems.length === 0,
            '构建记录与登记身份交叉一致（record.buildId/来源提交/版本/锁文件 hash）',
            bindingProblems.join('；'));
          if (opts.requireReleaseEligibility) {
            // 4b) 发布级资格（R1/R2）：12 项登记前步骤齐全且真实通过、无注入；
            //     必检集合按可信策略锁定，记录不能自行缩减。
            const elig = checkReleaseEligibility(rec);
            check(elig.ok, `发布资格校验通过（必需步骤 ${elig.required.length} 项齐全、均 passed 且退出 0）`,
              elig.problems.join('；'));
            // 4c) 完成回执绑定（R1）：register + core 核验的完成证据必须在场，
            //     且与当前 manifest/记录/buildId/来源提交完全绑定。
            const receiptPath = path.join(path.dirname(loaded.path), 'release-receipt.json');
            let receipt = null;
            try {
              receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
            } catch {
              receipt = null;
            }
            const receiptProblems = checkReleaseReceipt({
              receipt,
              manifestHash: sha256File(loaded.path),
              buildRecordHash: sha256File(br),
              buildId: opts.buildId,
              sourceCommit: manifest.sourceCommit,
            });
            check(receiptProblems.length === 0, '完成回执存在且与 manifest/记录/buildId/来源提交完全绑定（release-receipt/1）',
              receiptProblems.join('；'));
          }
        } catch (e) {
          check(false, '构建记录可解析且含发布资格字段', `解析失败：${e.message}`);
        }
      }
    } else {
      check(false, '登记绑定构建记录', '旧登记未绑定本次构建记录');
    }

    const candidateDir = path.resolve(ROOT, opts.candidateDir);
    const exe = path.join(candidateDir, 'OpenCodeThemeSwitcher.exe');
    const asar = path.join(candidateDir, 'resources', 'app.asar');
    const haveCandidate = fs.existsSync(exe) && fs.existsSync(asar);

    // 2) 候选身份（exe/asar hash 与登记一致）
    if (haveCandidate) {
      check(sha256File(exe) === manifest.hashes.exe, 'exe sha256 与登记一致');
      check(sha256File(asar) === manifest.hashes['app.asar'], 'app.asar sha256 与登记一致');
    } else {
      check(false, '候选目录含 exe 与 resources/app.asar', `目录不存在或缺文件：${candidateDir}`);
    }

    // 3) out/** 冻结清单：登记必须有，本地与包内都必须逐文件一致
    const hasOutManifest = (manifest.schema === 'candidate-manifest/3' || manifest.schema === 'candidate-manifest/2')
      && manifest.out && manifest.out.files;
    if (!hasOutManifest) {
      check(false, '登记含 out/** 冻结清单（schema/3）', `schema=${manifest.schema || '(缺失)'} 缺 out 清单，不允许通过发布门禁`);
    } else if (haveCandidate) {
      for (const m of REQUIRED_MODULES) {
        check(Boolean(manifest.out.files[m]), `登记 out 清单覆盖图片修复模块 ${m}`,
          manifest.out.files[m] ? '' : '缺失：out/** 核对必须至少覆盖 ImageStore/generate/image-probe');
      }
      const localOut = outManifestOfDir(path.join(ROOT, 'out'));
      const localDiff = diffOutManifest(manifest.out, localOut);
      check(
        localDiff.missing.length === 0 && localDiff.extra.length === 0 && localDiff.changed.length === 0,
        `本地 out/** 与登记清单一致（${Object.keys(manifest.out.files).length} 个文件）`,
        [
          localDiff.missing.length && `缺 ${localDiff.missing.length} 个：${localDiff.missing.slice(0, 3).join('、')}`,
          localDiff.extra.length && `多 ${localDiff.extra.length} 个：${localDiff.extra.slice(0, 3).join('、')}`,
          localDiff.changed.length && `内容不一致 ${localDiff.changed.length} 个：${localDiff.changed.slice(0, 3).join('、')}`,
          '（请重新 npm run build && 重新登记，旧 out 不能充当当前源码的证据）',
        ].filter(Boolean).join('；'),
      );
      const asarOut = outManifestOfAsar(asar);
      const asarDiff = diffOutManifest(manifest.out, asarOut);
      check(
        asarDiff.missing.length === 0 && asarDiff.extra.length === 0 && asarDiff.changed.length === 0,
        `候选 asar 内 out/** 与登记清单一致（${Object.keys(manifest.out.files).length} 个文件）`,
        [
          asarDiff.missing.length && `缺 ${asarDiff.missing.length} 个：${asarDiff.missing.slice(0, 3).join('、')}`,
          asarDiff.extra.length && `多 ${asarDiff.extra.length} 个：${asarDiff.extra.slice(0, 3).join('、')}`,
          asarDiff.changed.length && `内容不一致 ${asarDiff.changed.length} 个：${asarDiff.changed.slice(0, 3).join('、')}`,
          '（候选落后/领先于登记构建，需重新打包并重新登记）',
        ].filter(Boolean).join('；'),
      );
    }

    // 4) zip：hash 与登记一致 + 内部与候选目录逐条目一致 + 真实解压完整性
    if (manifest.zip) {
      const zp = path.resolve(ROOT, manifest.zip);
      if (!fs.existsSync(zp)) {
        check(false, '分发 zip 存在', manifest.zip);
      } else {
        check(sha256File(zp) === manifest.hashes.zip, '分发 zip sha256 与登记一致', manifest.zip);
        if (fs.existsSync(candidateDir)) {
          let zipProblems = [];
          try {
            zipProblems = checkZipMatchesDir(zp, candidateDir);
          } catch (e) {
            zipProblems = [`zip 无法解析：${e.message}`];
          }
          check(zipProblems.length === 0, `zip 内部与候选目录逐条目一致`,
            zipProblems.slice(0, 3).join('；') + (zipProblems.length > 3 ? ` 等 ${zipProblems.length} 项` : ''));
        }
        if (!opts.skipDeepZip) {
          const deep = deepVerifyZip(zp);
          check(deep.length === 0, 'zip 深度完整性（实读内容 CRC、无越界/重复/逃逸条目）',
            deep.slice(0, 3).join('；') + (deep.length > 3 ? ` 等 ${deep.length} 项` : ''));
        }
      }
    } else {
      check(false, '登记含分发 zip', '发布门禁要求 zip 与候选同源登记');
    }
  }

  // 汇总
  const failed = results.filter((r) => !r.ok);
  for (const r of failed) console.log(`[FAIL] ${r.label} | ${r.detail}`);
  console.log(`\n发布门禁核验 ${results.length} 项，失败 ${failed.length} 项`);
  if (failed.length === 0) {
    if (opts.requireReleaseEligibility) {
      // S2：发布级（资格 + 回执绑定全过）才允许输出最终发布标记
      console.log(`RELEASE_GREEN buildId=${opts.buildId}（发布级：资格+回执全过）`);
      console.log('stage=final publishable=true');
    } else {
      // S2：core 基础核验 ≠ 发布资格——不再输出 RELEASE_GREEN，避免日志
      // 扫描器或人把它当成最终发布结论。
      console.log(`CORE_VERIFY_GREEN buildId=${opts.buildId}（仅基础核验；发布级判定需 --require-release-eligibility）`);
      console.log('stage=core publishable=false');
    }
    process.exit(0);
  }
  console.log('RELEASE_VERIFY FAILED（本结论只认显式绑定，不回落默认候选）');
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  REQUIRED_MODULES,
  OUT_PREFIX,
  validateOutKey,
  crc32,
  readAsarHeader,
  asarEntries,
  readAsarEntryBuf,
  listFilesRecursive,
  outManifestOfDir,
  outManifestOfAsar,
  diffOutManifest,
  checkBinding,
  checkSourceFreeze,
  readZipCentral,
  checkZipMatchesDir,
  deepVerifyZip,
  loadReleaseManifest,
  RECEIPT_SCHEMA,
  checkReleaseReceipt,
  checkRecordBinding,
};
