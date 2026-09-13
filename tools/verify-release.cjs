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
 * 退出码：0 打印 RELEASE_GREEN；1 有失败项（逐条列出）。
 */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'candidate-manifest.json');

/** 图片修复三模块：本轮修复落点，out/** 核对集合必须至少覆盖这些（S3 执行方案 4） */
const REQUIRED_MODULES = [
  'out/main/services/image-store.js',
  'out/core/theme/generate.js',
  'out/core/theme/image-probe.js',
];

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

/** 磁盘目录的 out/** 清单：rel -> { bytes, sha256 } */
function outManifestOfDir(outDir) {
  const files = {};
  for (const rel of listFilesRecursive(outDir)) {
    const buf = fs.readFileSync(path.join(outDir, ...rel.split('/')));
    files[rel] = { bytes: buf.length, sha256: sha256Buf(buf) };
  }
  return { files };
}

/** asar 内 out/** 清单（unpacked 条目落盘读取） */
function outManifestOfAsar(asarPath) {
  const { header, dataStart } = readAsarHeader(asarPath);
  const entries = asarEntries(header);
  const files = {};
  for (const rel of [...entries.keys()].sort()) {
    if (!rel.startsWith('out/')) continue;
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
  if (manifest.schema !== 'candidate-manifest/2') {
    problems.push(
      `schema=${manifest.schema || '(缺失)'} 不是 candidate-manifest/2：` +
      '旧登记缺少 out/** 冻结清单，不允许通过发布门禁（请用 node tools/candidate-manifest.cjs register 重新登记本次构建）',
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
  const zipMap = new Map(zipEntries.map((e) => [e.name, e]));
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
    else if (a === '--source-commit') opts.sourceCommit = argv[++i];
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.candidateDir || !opts.buildId) {
    console.error('用法：node tools/verify-release.cjs --candidate-dir <候选目录> --build-id <本次构建ID> [--source-commit <sha>]');
    console.error('本次发布门禁必须显式绑定登记（buildId + 候选目录）；旧候选身份核验请用 npm run verify:package。');
    process.exit(1);
  }

  const results = [];
  const check = (ok, label, detail) => {
    results.push({ ok: Boolean(ok), label, detail: detail === undefined ? '' : String(detail) });
  };
  console.log(`RELEASE_VERIFY：本次发布门禁（buildId=${opts.buildId}）`);
  console.log(`  核对目标：${opts.candidateDir}`);

  // 1) 绑定与源码冻结
  if (!fs.existsSync(MANIFEST_PATH)) {
    check(false, 'candidate-manifest.json 存在', '缺失：发布门禁必须绑定显式登记');
  } else {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const headCommit = git(['rev-parse', 'HEAD']).trim() || undefined;
    const bindingProblems = checkBinding({
      manifest, root: ROOT, candidateDir: opts.candidateDir,
      buildId: opts.buildId, sourceCommit: opts.sourceCommit, headCommit,
    });
    check(bindingProblems.length === 0, '显式目标与登记绑定一致（buildId/候选目录/来源提交）',
      bindingProblems.join('；'));
    const freezeProblems = checkSourceFreeze(git(['status', '--porcelain']));
    check(freezeProblems.length === 0, '源码冻结（已跟踪文件无未提交改动）', freezeProblems.join('；'));

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
    const hasOutManifest = manifest.schema === 'candidate-manifest/2' && manifest.out && manifest.out.files;
    if (!hasOutManifest) {
      check(false, '登记含 out/** 冻结清单（schema/2）', '旧登记缺 out 清单，不允许通过发布门禁');
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

    // 4) zip：hash 与登记一致 + 内部与候选目录逐条目一致
    if (manifest.zip) {
      const zp = path.resolve(ROOT, manifest.zip);
      if (!fs.existsSync(zp)) {
        check(false, '分发 zip 存在', manifest.zip);
      } else {
        check(sha256File(zp) === manifest.hashes.zip, '分发 zip sha256 与登记一致', manifest.zip);
        if (fs.existsSync(candidateDir)) {
          const zipProblems = checkZipMatchesDir(zp, candidateDir);
          check(zipProblems.length === 0, `zip 内部与候选目录逐条目一致（${readZipCentral(zp).length} 个文件条目）`,
            zipProblems.slice(0, 3).join('；') + (zipProblems.length > 3 ? ` 等 ${zipProblems.length} 项` : ''));
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
    console.log(`RELEASE_GREEN buildId=${opts.buildId}`);
    process.exit(0);
  }
  console.log('RELEASE_VERIFY FAILED（本结论只认显式绑定，不回落默认候选）');
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  REQUIRED_MODULES,
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
};
