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
 *   7. zip 必须从同一候选目录打包：条目名先统一分隔符（`\` → `/`）再做安全检查与文件/目录区分，
 *      逐条目用**真实内容**（store 切片 / DEFLATE 实解压）比 sha256+大小，条目集合相等（缺/多都报告），
 *      zip hash 与登记一致；显式目录必须存在于磁盘，但不要求磁盘所有目录都显式出现在 zip 中；
 *      分发验收禁止 --no-identity（本工具无该开关）。
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
const zlib = require('node:zlib');
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

/** 递归列出目录下所有子目录，返回相对路径（正斜杠）数组（不含 dir 自身） */
function listDirsRecursive(dir, base = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (!fs.statSync(p).isDirectory()) continue;
    out.push(path.relative(base, p).replace(/\\/g, '/'));
    out.push(...listDirsRecursive(p, base));
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

// ---------- ZIP 条目解析（R1–R3 共用一个解析模块，一套规则） ----------
/*
 * Windows 名称限制（目标平台是 Windows）：
 *   - 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）在任何目录下都不可用；
 *   - `< > : " | ? *` 与控制字符在 Windows 上是非法字符；
 *   - 段尾的点或空格会被 Windows 静默去掉，使两个条目落到同一路径。
 */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const WINDOWS_ILLEGAL_CHARS = /[<>:"|?*\u0000-\u001f]/;

/** 支持的压缩方法：只认 store(0) 与 deflate(8)，其余（含加密、ZIP64）在解析期显式拒绝 */
const ZIP_SUPPORTED_METHODS = new Map([[0, 'store'], [8, 'deflate']]);
/** 单条条目解压上限（防止「只信声明大小」把内存吃光） */
const ZIP_MAX_ENTRY_BYTES = 1024 * 1024 * 1024;
/** 整包累计解压预算（超过即失败并给出可诊断原因） */
const ZIP_MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;

/* ZIP 结构签名（F4：边界校验需要的魔数，集中一处避免散落） */
const ZIP_SIG_LOCAL = 0x04034b50; // 本地文件头
const ZIP_SIG_CENTRAL = 0x02014b50; // 中央目录条目
const ZIP_SIG_EOCD = 0x06054b50; // 中央目录结束记录
const ZIP_SIG_DATA_DESCRIPTOR = 0x08074b50; // 数据描述符（可选）
const ZIP_SIG_ZIP64_EOCD_LOCATOR = 0x07064b50; // ZIP64 定位器（紧邻 EOCD 之前）

/**
 * 规范 ZIP 条目名（**所有 ZIP 检查的唯一入口**）：先统一分隔符，再判目录，最后做安全检查。
 *
 * 旧实现顺序是「先按原始名 `endsWith('/')` 排除目录，再把 `\` 转成 `/`」——
 * PowerShell 5.1 的 Compress-Archive 写的 `resources\` 因此被当成**文件**参加比较，
 * 而磁盘侧只枚举文件，必然报「zip 内多出磁盘没有的条目」，把合法候选误判为发布阻断（R1）。
 *
 * @returns {{name: string, pathKey: string, isDir: boolean, problem: string|null}}
 *   name 为规范化名（目录带结尾 `/`）；problem 非空表示该条目不可用于比较，调用方必须失败关闭。
 */
function normalizeZipEntryName(rawName) {
  const raw = typeof rawName === 'string' ? rawName : '';
  if (!raw) return { name: '', pathKey: '', isDir: false, problem: 'zip 条目名为空' };
  // 1) 统一分隔符（zip 规范是 `/`；Windows 常态工具会写 `\`）
  const name = raw.replace(/\\/g, '/');
  // 2) 规范化**之后**才判定目录：`resources\` → `resources/`，这才是目录
  const isDir = name.endsWith('/');
  const pathKey = isDir ? name.slice(0, -1) : name;
  const bad = (why) => ({ name, pathKey, isDir, problem: `zip 条目路径越界或不可用（${why}）：${name}` });
  if (!pathKey) return bad('空路径');
  if (pathKey.startsWith('/')) return bad('绝对路径或 UNC 前缀');
  if (/^[A-Za-z]:/.test(pathKey)) return bad('含盘符');
  for (const seg of pathKey.split('/')) {
    if (seg === '') return bad('含空路径段');
    if (seg === '.' || seg === '..') return bad('含 . / .. 段（目录逃逸）');
    if (WINDOWS_ILLEGAL_CHARS.test(seg)) return bad('含 Windows 非法字符');
    if (WINDOWS_RESERVED_NAME.test(seg)) return bad('使用 Windows 保留设备名');
    if (/[ .]$/.test(seg)) return bad('路径段以点或空格结尾（Windows 下会落到别的路径）');
  }
  return { name, pathKey, isDir, problem: null };
}

/** ZIP64 扩展字段（0x0001）判定：暂不支持，必须显式拒绝而不是静默跳过 */
function hasZip64Extra(extra) {
  let o = 0;
  while (o + 4 <= extra.length) {
    if (extra.readUInt16LE(o) === 0x0001) return true;
    o += 4 + extra.readUInt16LE(o + 2);
  }
  return false;
}

/** 从 EOCD 反查中央目录起点；找不到返回 -1 */
function findZipEocd(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === ZIP_SIG_EOCD) return i;
  }
  return -1;
}

/**
 * 校验 data descriptor（F4）。
 *
 * 中央目录里有真实的 CRC 与大小，而 bit 3 开启时**本地头**按 ZIP 语义是零占位，
 * 因此本地字段不能逐字比较（旧实现据此整段跳过）。但「跳过本地字段」不等于
 * 「这段数据不用核」——描述符本身必须存在、落在文件内、且与中央目录一致。
 * 兼容有签名（0x08074b50 + 12 字节）与无签名（12 字节）两种合法形式。
 *
 * @returns {string|null} 问题描述；null 表示通过
 */
function checkDataDescriptor(buf, e) {
  const p = e.dataStart + e.csize;
  if (p + 12 > buf.length) {
    return `声明了 data descriptor（bit 3）但描述符缺失或截断：${e.name}`;
  }
  const at = (off) =>
    off + 12 > buf.length
      ? null
      : {
          crc: buf.readUInt32LE(off),
          csize: buf.readUInt32LE(off + 4),
          usize: buf.readUInt32LE(off + 8),
        };
  const matches = (d) => !!d && d.crc === e.crc32 && d.csize === e.csize && d.usize === e.usize;
  // 有签名形式：签名后跟 crc/csize/usize；无签名形式：三字段直接开始。
  // 两种都试，任一对得上即通过（避免 crc 恰好等于签名值时误判）。
  const withSig = buf.readUInt32LE(p) === ZIP_SIG_DATA_DESCRIPTOR ? at(p + 4) : null;
  const noSig = at(p);
  if (matches(withSig) || matches(noSig)) return null;
  const seen = noSig
    ? `crc=0x${noSig.crc.toString(16)} csize=${noSig.csize} usize=${noSig.usize}`
    : '不足 12 字节';
  return (
    `data descriptor 与中央目录声明不符：${e.name}` +
    `（描述符 ${seen}；中央目录 crc=0x${e.crc32.toString(16)} csize=${e.csize} usize=${e.usize}）`
  );
}

/**
 * 解析整包：规范化每个条目名并做安全检查，再核对本地头↔中央目录与数据边界。
 * 结构性损坏（EOCD/中央目录签名）抛错；条目级问题收集进 problems（条目自身也记一份，
 * 便于后续跳过无效条目）。目录的「显式条目」与「由文件路径隐含的父目录」分开记录：
 * 合法 ZIP 可以只用文件条目隐式表达父目录，**不得**要求磁盘每个目录都在 ZIP 中显式出现。
 * @returns {{buf: Buffer, entries: object[], problems: string[], explicitDirs: Set<string>}}
 */
function parseZip(zipPath) {
  const buf = fs.readFileSync(zipPath);
  const eocd = findZipEocd(buf);
  if (eocd < 0) throw new Error('找不到 zip EOCD，不是 zip 文件');
  if (eocd + 22 > buf.length) throw new Error('EOCD 记录超出文件末尾（截断）');

  // F4：ZIP64 定位器紧邻 EOCD 之前（20 字节）——不支持，显式拒绝而不是当下标读完
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP_SIG_ZIP64_EOCD_LOCATOR) {
    throw new Error('暂不支持 ZIP64（发现 ZIP64 EOCD locator）');
  }

  const diskNum = buf.readUInt16LE(eocd + 4);
  const cdStartDisk = buf.readUInt16LE(eocd + 6);
  const entriesThisDisk = buf.readUInt16LE(eocd + 8);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const eocdCommentLen = buf.readUInt16LE(eocd + 20);

  // F4：EOCD 的磁盘/计数/范围自洽性——旧实现只取 count 与 cdOffset 就直接开遍历，
  // 声明与真实布局不符时会在越界处静默读到别的东西。
  if (diskNum !== 0 || cdStartDisk !== 0) {
    throw new Error(`不支持分卷 zip（disk=${diskNum}，中央目录起始盘=${cdStartDisk}）`);
  }
  if (entriesThisDisk !== count) {
    throw new Error(`EOCD 条目计数不自洽（本盘 ${entriesThisDisk} ≠ 总计 ${count}）`);
  }
  if (cdOffset + cdSize > buf.length) {
    throw new Error(`中央目录范围超出文件末尾（offset=${cdOffset} size=${cdSize}，文件 ${buf.length} 字节）`);
  }
  if (cdOffset + cdSize > eocd) {
    throw new Error(`中央目录范围与 EOCD 重叠（中央目录末尾 ${cdOffset + cdSize} > EOCD ${eocd}）`);
  }
  if (eocd + 22 + eocdCommentLen > buf.length) {
    throw new Error(`EOCD 注释长度 ${eocdCommentLen} 超出文件末尾（声明与实际不符）`);
  }

  const cdEnd = cdOffset + cdSize;
  let off = cdOffset;
  const entries = [];
  const problems = [];
  const flag = (entry, message) => {
    entry.problems.push(message);
    problems.push(message);
  };

  for (let i = 0; i < count; i++) {
    if (off + 46 > cdEnd) {
      throw new Error(`中央目录第 ${i} 项超出中央目录范围（声明 cdSize=${cdSize}）`);
    }
    if (buf.readUInt32LE(off) !== ZIP_SIG_CENTRAL) {
      throw new Error(`zip 中央目录第 ${i} 项签名错误`);
    }
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOffset = buf.readUInt32LE(off + 42);
    // F4：变长字段必须完整落在中央目录范围内。
    // 旧实现直接 `off += 46 + nameLen + extraLen + commentLen`：最后一项声明
    // commentLen=65535 而实际没有注释时，遍历会越出中央目录去读后续字节，
    // 反而「两个检查都无问题」。
    if (off + 46 + nameLen + extraLen + commentLen > cdEnd) {
      throw new Error(
        `中央目录第 ${i} 项的变长字段（name/extra/comment）越出中央目录范围` +
          `（需要 ${46 + nameLen + extraLen + commentLen} 字节，`
          + `剩余 ${cdEnd - off}：声明与实际不符）`,
      );
    }
    const rawName = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const extra = buf.subarray(off + 46 + nameLen, off + 46 + nameLen + extraLen);
    off += 46 + nameLen + extraLen + commentLen;

    const norm = normalizeZipEntryName(rawName);
    const entry = {
      rawName, name: norm.name, pathKey: norm.pathKey, isDir: norm.isDir,
      flags, method, crc32: crc, csize, usize, localOffset, dataStart: 0,
      dataDescriptor: (flags & 0x8) !== 0,
      problems: [],
    };
    entries.push(entry);
    if (norm.problem) flag(entry, norm.problem);
    /*
     * F4：目录条目**不再提前 continue**。
     * 旧实现 `if (norm.isDir) continue;` 让目录条目整段跳过加密/压缩方法/ZIP64 检查，
     * 于是「异常元信息挂在目录条目上」就查不出来了。校验的宽严应当只看字段是否适用，
     * 而不是看条目是不是目录。
     */
    if (flags & 0x1) flag(entry, `zip 条目已加密，无法核验内容：${entry.name}`);
    if (!ZIP_SUPPORTED_METHODS.has(method)) {
      flag(entry, `不支持的压缩方法 method=${method}（只支持 store=0 / deflate=8）：${entry.name}`);
    }
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff || hasZip64Extra(extra)) {
      flag(entry, `暂不支持 ZIP64 条目：${entry.name}`);
    }
  }

  // F4：遍历结束位置必须与 EOCD 声明的中央目录范围一致
  if (off !== cdEnd) {
    throw new Error(
      `中央目录遍历结束于 ${off}，与声明范围末尾 ${cdEnd} 不一致` +
        `（声明 cdSize=${cdSize}，${count} 项；中央目录长度或条目数与实际不符）`,
    );
  }

  // 重复 / 大小写冲突：Windows 下两个条目会落到同一路径（R3）
  const seenExact = new Map();
  const seenLower = new Map();
  for (const e of entries) {
    if (!e.pathKey) continue;
    if (seenExact.has(e.pathKey)) {
      flag(e, `zip 内重复条目（规范化后同一路径）：${e.pathKey}`);
      continue;
    }
    seenExact.set(e.pathKey, e);
    const lower = e.pathKey.toLowerCase();
    const prev = seenLower.get(lower);
    if (prev) flag(e, `zip 条目大小写冲突（Windows 下会落到同一路径）：${prev.pathKey} / ${e.pathKey}`);
    seenLower.set(lower, e);
  }

  /*
   * 文件 / 目录冲突（F4）：必须用 **Windows 冲突键**（小写）比较。
   *
   * 旧实现用区分大小写的 Set，于是 `a`（文件）与 `A/file.txt`（文件，隐含父目录 `A`）
   * 被当成两条互不相干的合法条目——而 Windows 上 `a` 与 `A` 是同一个名字，
   * 这个包解压时必然冲突。
   */
  const fileKeys = new Set();
  const fileKeysLower = new Map();
  const explicitDirs = new Set();
  const allDirsLower = new Map();
  const addDir = (key) => {
    const low = key.toLowerCase();
    if (!allDirsLower.has(low)) allDirsLower.set(low, key);
  };
  for (const e of entries) {
    if (!e.pathKey) continue;
    if (e.isDir) {
      explicitDirs.add(e.pathKey);
      addDir(e.pathKey);
    } else {
      fileKeys.add(e.pathKey);
      if (!fileKeysLower.has(e.pathKey.toLowerCase())) fileKeysLower.set(e.pathKey.toLowerCase(), e.pathKey);
    }
  }
  for (const k of fileKeys) {
    const segs = k.split('/');
    for (let i = 1; i < segs.length; i++) addDir(segs.slice(0, i).join('/'));
  }
  for (const k of fileKeys) {
    const asDir = allDirsLower.get(k.toLowerCase());
    if (asDir) {
      problems.push(
        asDir === k
          ? `zip 内同名条目既是文件又是目录（内容会互相覆盖）：${k}`
          : `zip 内文件与目录大小写别名冲突（Windows 下会落到同一路径）：文件 ${k} / 目录 ${asDir}`,
      );
    }
  }

  // 本地文件头 ↔ 中央目录一致性 + 数据边界
  for (const e of entries) {
    if (e.problems.length) continue;
    if (e.localOffset + 30 > buf.length || buf.readUInt32LE(e.localOffset) !== ZIP_SIG_LOCAL) {
      flag(e, `本地文件头签名错误：${e.name}`);
      continue;
    }
    const lFlags = buf.readUInt16LE(e.localOffset + 6);
    const lMethod = buf.readUInt16LE(e.localOffset + 8);
    const lNameLen = buf.readUInt16LE(e.localOffset + 26);
    const lExtraLen = buf.readUInt16LE(e.localOffset + 28);
    const lName = buf.toString('utf8', e.localOffset + 30, e.localOffset + 30 + lNameLen);
    e.dataStart = e.localOffset + 30 + lNameLen + lExtraLen;
    if (lName !== e.rawName) flag(e, `本地文件头名称与中央目录不一致：${e.name}`);
    if (lMethod !== e.method) {
      flag(e, `本地文件头压缩方法与中央目录不一致（${lMethod} ≠ ${e.method}）：${e.name}`);
    }
    if (lFlags !== e.flags) {
      flag(e, `本地文件头标志与中央目录不一致（0x${lFlags.toString(16)} ≠ 0x${e.flags.toString(16)}）：${e.name}`);
    }
    // data descriptor（bit 3）时本地头的 CRC/大小按 ZIP 语义是零占位，不能逐字比较；
    // 但描述符本身必须存在且与中央目录一致（F4），否则「跳过本地字段」= 整段不核。
    if (e.dataDescriptor && !e.isDir) {
      const dd = checkDataDescriptor(buf, e);
      if (dd) flag(e, dd);
    } else if (!e.isDir) {
      const lCrc = buf.readUInt32LE(e.localOffset + 14);
      const lCsize = buf.readUInt32LE(e.localOffset + 18);
      const lUsize = buf.readUInt32LE(e.localOffset + 22);
      if (lCrc !== e.crc32 || lCsize !== e.csize || lUsize !== e.usize) {
        flag(e, `本地文件头 CRC/大小与中央目录不一致：${e.name}`);
      }
    }
    if (e.dataStart + e.csize > buf.length) flag(e, `条目数据超出文件末尾（截断或边界异常）：${e.name}`);
  }

  return { buf, entries, problems, explicitDirs };
}

/**
 * 读取条目**真实内容**（R2）：store 直接切片，DEFLATE 用 Node zlib 真实解压。
 * 输出以声明大小封顶并计入累计预算，避免「只信声明大小」造成的无界内存分配；
 * 未知方法/加密/ZIP64 已在解析期拒绝，这里不再静默跳过压缩内容。
 * @returns {{content: Buffer|null, problem: string|null}}
 */
function readZipEntryContent(entry, buf, budget) {
  if (entry.problems.length) return { content: null, problem: entry.problems[0] };
  const declared = entry.usize;
  if (declared > ZIP_MAX_ENTRY_BYTES) {
    return {
      content: null,
      problem: `条目声明解压后 ${declared} 字节，超过单条上限 ${ZIP_MAX_ENTRY_BYTES}：${entry.name}`,
    };
  }
  if (declared > budget.remaining) {
    return {
      content: null,
      problem: `累计解压预算不足（上限 ${ZIP_MAX_TOTAL_BYTES} 字节），拒绝继续解压：${entry.name}`,
    };
  }
  if (entry.dataStart + entry.csize > buf.length) {
    return { content: null, problem: `条目数据超出文件末尾（截断或边界异常）：${entry.name}` };
  }
  const raw = buf.subarray(entry.dataStart, entry.dataStart + entry.csize);
  budget.remaining -= declared;
  if (entry.method === 0) {
    if (raw.length !== declared) {
      return {
        content: null,
        problem: `store 条目数据长度 ${raw.length} 与声明大小 ${declared} 不符：${entry.name}`,
      };
    }
    return { content: raw, problem: null };
  }
  let out;
  try {
    out = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(declared, 1) });
  } catch (e) {
    const code = e && typeof e === 'object' && 'code' in e ? String(e.code) : String(e);
    return {
      content: null,
      problem: `DEFLATE 解压失败（压缩数据损坏/截断，或实际输出超出声明大小）：${entry.name} | ${code}`,
    };
  }
  if (out.length !== declared) {
    return { content: null, problem: `解压后实际长度 ${out.length} 与声明 ${declared} 不符：${entry.name}` };
  }
  return { content: out, problem: null };
}

/**
 * 解析 zip 中央目录，返回文件条目 [{ name, crc32, size }]（目录条目在**规范化之后**过滤）。
 * 名称先经 normalizeZipEntryName（统一分隔符 + 安全检查），再区分文件/目录；
 * 任何不可安全解释的条目都抛错——调用方必须失败关闭，不得跳过。
 */
function readZipCentral(zipPath) {
  const parsed = parseZip(zipPath);
  if (parsed.problems.length) throw new Error(parsed.problems[0]);
  return parsed.entries
    .filter((e) => !e.isDir)
    .map((e) => ({ name: e.name, crc32: e.crc32, size: e.usize }));
}

/**
 * zip 与候选目录一致性（R1/R2/R3）：条目集合相等，且逐条目用**真实内容**（store 切片 /
 * DEFLATE 实解压）的 sha256 + 大小与磁盘文件比对——不再只信中央目录声明的 CRC/大小。
 *
 * 目录条目策略：显式目录必须确实存在于磁盘（凭空多出的目录拒绝）；但**不**要求磁盘每个
 * 目录都在 zip 中显式出现——合法 zip 可以只用文件条目隐式表达父目录。
 * 返回问题列表（空 = 通过）。
 */
function checkZipMatchesDir(zipPath, dir) {
  let parsed;
  try {
    parsed = parseZip(zipPath);
  } catch (e) {
    return [`zip 无法解析：${e.message}`];
  }
  // 越界/重复/大小写冲突/文件目录冲突/未知方法等已在解析期统一判定
  const problems = [...parsed.problems];
  const diskMap = new Map();
  for (const rel of listFilesRecursive(dir)) {
    const buf = fs.readFileSync(path.join(dir, ...rel.split('/')));
    diskMap.set(rel, { size: buf.length, sha256: sha256Buf(buf) });
  }
  const diskDirs = new Set(listDirsRecursive(dir));

  const zipFiles = new Map();
  for (const e of parsed.entries) {
    if (e.isDir) {
      // 显式目录条目必须先过安全检查（已在解析期），再要求磁盘上确有该目录
      if (!e.problems.length && !diskDirs.has(e.pathKey)) {
        problems.push(`zip 内多出磁盘没有的目录条目：${e.name}`);
      }
      continue;
    }
    if (e.problems.length) continue; // 无效条目已在解析期报过，不重复计入集合
    if (zipFiles.has(e.name)) continue;
    zipFiles.set(e.name, e);
  }

  const budget = { remaining: ZIP_MAX_TOTAL_BYTES };
  for (const [name, e] of zipFiles) {
    const d = diskMap.get(name);
    if (!d) {
      problems.push(`zip 内多出磁盘没有的条目：${name}`);
      continue;
    }
    const read = readZipEntryContent(e, parsed.buf, budget);
    if (read.problem) {
      problems.push(read.problem);
      continue;
    }
    const content = read.content;
    if (content.length !== d.size) {
      problems.push(`zip 条目与磁盘大小不一致（疑似混入旧文件）：${name}（zip ${content.length}，磁盘 ${d.size}）`);
      continue;
    }
    if (sha256Buf(content) !== d.sha256) {
      problems.push(`zip 条目与磁盘内容不一致（疑似混入旧文件）：${name}（实解压内容 sha256 与磁盘不符）`);
    }
  }
  for (const rel of diskMap.keys()) {
    if (!zipFiles.has(rel)) problems.push(`zip 缺少候选目录中的文件：${rel}`);
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
 * zip 深度完整性验证（R1/R2/R3）：按统一解析结果逐条读取**真实内容**——
 * store 直接切片、DEFLATE 用 Node zlib 真实解压（声明大小封顶 + 累计预算），
 * 再比对实读内容 CRC 与声明；越界/重复/大小写冲突/文件目录冲突/未知方法/ZIP64
 * 一律由共享解析入口拒绝。仅信中央目录是不够的：声明与实际内容可以不一致。
 * 返回问题列表。不解压到磁盘，全部在内存比对，条目路径不越出根。
 */
function deepVerifyZip(zipPath) {
  let parsed;
  try {
    parsed = parseZip(zipPath);
  } catch (e) {
    return [`zip 无法解析：${e.message}`];
  }
  const problems = [...parsed.problems];
  const budget = { remaining: ZIP_MAX_TOTAL_BYTES };
  for (const e of parsed.entries) {
    if (e.isDir || e.problems.length) continue;
    const read = readZipEntryContent(e, parsed.buf, budget);
    if (read.problem) {
      problems.push(read.problem);
      continue;
    }
    if (crc32(read.content) !== e.crc32) {
      problems.push(`条目实读内容 CRC 与声明不符：${e.name}`);
    }
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
  listDirsRecursive,
  outManifestOfDir,
  outManifestOfAsar,
  diffOutManifest,
  checkBinding,
  checkSourceFreeze,
  normalizeZipEntryName,
  parseZip,
  readZipEntryContent,
  ZIP_SUPPORTED_METHODS,
  /* F4：ZIP 结构边界校验需要的签名与描述符检查，导出供夹具单测直接调用 */
  ZIP_SIG_LOCAL,
  ZIP_SIG_CENTRAL,
  ZIP_SIG_EOCD,
  ZIP_SIG_DATA_DESCRIPTOR,
  ZIP_SIG_ZIP64_EOCD_LOCATOR,
  findZipEocd,
  checkDataDescriptor,
  readZipCentral,
  checkZipMatchesDir,
  deepVerifyZip,
  loadReleaseManifest,
  RECEIPT_SCHEMA,
  checkReleaseReceipt,
  checkRecordBinding,
};
