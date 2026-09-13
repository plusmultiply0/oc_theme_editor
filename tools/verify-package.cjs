#!/usr/bin/env node
/**
 * 便携包内容核对（docs/release-checklist.md 第 1、2 节）。
 *
 * 只读，不写入、不解压、不改动任何文件。用法：
 *   node tools/verify-package.cjs [候选目录] [--no-identity]
 *
 * 目标解析（R2）：
 *   - 默认从项目根 candidate-manifest.json 读取 candidateDir（唯一登记候选）；
 *     manifest 缺失或目标目录不存在都直接失败，绝不回退旧的 win-unpacked。
 *   - 显式给出候选目录时也默认做身份核对（exe/asar/zip hash 与登记一致），
 *     `--no-identity` 仅用于取证核对未登记目录，此时跳过身份与内容比对。
 *
 * 退出码：0 全部通过；1 有失败项（逐条列出）。
 */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// ---------- 目标解析：默认绑定 manifest 候选，不自动回退 ----------
const argv = process.argv.slice(2);
const noIdentity = argv.includes('--no-identity');
const dirArgs = argv.filter((a) => !a.startsWith('--'));
const MANIFEST_PATH = path.join(ROOT, 'candidate-manifest.json');
let manifest = null;
if (!dirArgs.length) {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('未找到 candidate-manifest.json：请先 node tools/candidate-manifest.cjs register <候选目录> 登记唯一候选（或显式传入候选目录，仅限取证）');
    process.exit(1);
  }
  manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}
const ROOT_DIR = path.resolve(ROOT, dirArgs[0] || manifest.candidateDir);
if (!fs.existsSync(ROOT_DIR)) {
  console.error(`候选目录不存在：${ROOT_DIR}${manifest ? '（来自 candidate-manifest.json，核对目标以登记为准，不回退旧目录）' : ''}`);
  process.exit(1);
}
if (manifest) console.log(`核对目标：${manifest.candidateDir}（buildId=${manifest.buildId}）`);
else if (noIdentity) console.log(`核对目标：${ROOT_DIR}（--no-identity 取证模式，跳过身份核对）`);
else console.log(`核对目标：${ROOT_DIR}（显式目录，将与登记候选做身份核对）`);

const results = [];
const check = (ok, label, detail) => {
  results.push({ ok: Boolean(ok), label, detail: detail === undefined ? '' : String(detail) });
};

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

if (!fs.existsSync(ROOT_DIR)) {
  console.error(`找不到 ${ROOT_DIR}：请先 npm run dist`);
  process.exit(1);
}

// ---------- 1. 产物指纹 ----------
const exe = path.join(ROOT_DIR, 'OpenCodeThemeSwitcher.exe');
const asar = path.join(ROOT_DIR, 'resources', 'app.asar');
check(fs.existsSync(exe), 'OpenCodeThemeSwitcher.exe 存在', exe);
check(fs.existsSync(asar), 'resources/app.asar 存在', asar);
if (fs.existsSync(exe)) {
  const st = fs.statSync(exe);
  check(st.size > 100 * 1024 * 1024, 'exe 体积符合 Electron 运行时量级');
  console.log(`  exe   ${mb(st.size)}  sha256=${sha256(exe)}`);
}
if (fs.existsSync(asar)) {
  const st = fs.statSync(asar);
  check(st.size > 5 * 1024 * 1024 && st.size < 100 * 1024 * 1024, 'app.asar 体积合理');
  console.log(`  asar  ${mb(st.size)}  sha256=${sha256(asar)}`);
}

// ---------- 2. 归档结构（直接解析归档头，不依赖 asar 库的列表格式） ----------
function readHeader(archive) {
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

let files = [];
let unpacked = 0;
let dataStart = 0;
let nodes = new Map();
if (fs.existsSync(asar)) {
  const { header, dataStart: ds } = readHeader(asar);
  dataStart = ds;
  (function walk(node, parts) {
    for (const [name, v] of Object.entries(node.files || {})) {
      const next = [...parts, name];
      const rel = next.join('/');
      if (v.files) walk(v, next);
      else {
        files.push(rel);
        nodes.set(rel, v);
        if (v.unpacked) unpacked += 1;
      }
    }
  })(header, []);
  console.log(`\n  归档条目 ${files.length}，unpacked ${unpacked}`);

  /*
   * unpacked 标记必须落到磁盘：归档头说「这些文件在外面」，
   * 外面却没有 = 运行时 require 原生模块直接失败。
   * 本仓库真出过这个事故（打包被中断后 app.asar.unpacked 缺失），
   * 而当时的核对只数了标记数量，因此漏过。
   */
  const unpackedDir = path.join(ROOT_DIR, 'resources', 'app.asar.unpacked');
  const missingUnpacked = [...nodes.entries()]
    .filter(([, v]) => v.unpacked)
    .map(([rel]) => rel)
    .filter((rel) => !fs.existsSync(path.join(unpackedDir, rel)));
  check(
    missingUnpacked.length === 0,
    'unpacked 标记的文件都存在于 app.asar.unpacked',
    missingUnpacked.length === 0
      ? `共 ${unpacked} 个，目录 ${path.relative(ROOT_DIR, unpackedDir)}`
      : `缺失 ${missingUnpacked.length} 个：${missingUnpacked.slice(0, 5).join('、')}`,
  );

  const tops = {};
  for (const f of files) {
    const t = f.split('/')[0];
    tops[t] = (tops[t] || 0) + 1;
  }
  const allowed = new Set(['node_modules', 'out', 'package.json']);
  const unexpected = Object.keys(tops).filter((t) => !allowed.has(t));
  check(
    unexpected.length === 0,
    '归档顶层只允许 node_modules / out / package.json',
    `实际：${Object.keys(tops).join('、')}`,
  );
  const leaked = files.filter((f) => /^(src|tests|handoff|docs)\//i.test(f));
  check(leaked.length === 0, '归档不含 src / tests / handoff / docs', leaked.slice(0, 3).join('、'));
}

/** 读取归档内文本条目；unpacked 或缺失返回 null */
function readEntry(entry) {
  const node = nodes.get(entry);
  if (!node || node.unpacked) return null;
  const buf = Buffer.alloc(node.size);
  const fd = fs.openSync(asar, 'r');
  try {
    fs.readSync(fd, buf, 0, node.size, dataStart + Number(node.offset));
  } finally {
    fs.closeSync(fd);
  }
  return buf.toString('utf8');
}

// ---------- 3. 本轮修复必须在包内 ----------
for (const m of [
  'out/main/index.js',
  'out/preload/index.js',
  'out/renderer/index.html',
  'out/core/patch/physical-fs.js',
  'out/core/patch/archive-io.js',
  'out/core/patch/legacy-theme.js',
  'out/core/patch/original-evidence.js',
  'out/core/theme/surfaces.js',
  'out/core/theme/tokens.js',
  'out/main/services/recovery-service.js',
]) {
  check(files.includes(m), `包内存在 ${m}`, files.includes(m) ? '' : '缺失');
}

const mainJs = readEntry('out/main/index.js') ?? '';
const ipcJs = readEntry('out/main/ipc.js') ?? '';
for (const [label, token, where] of [
  ['R7 启动恢复扫描（RecoveryService）', 'RecoveryService', mainJs],
  ['R7 测试环境开关（限定合成安装）', 'THEME_SWITCHER_NO_REGISTRY', mainJs],
  ['R6 手动指定目录（处理器）', 'chooseTargetDirectory', ipcJs],
  ['R7 恢复状态查询（处理器）', 'getRecoveryStatus', ipcJs],
  ['R7 恢复落账（处理器）', 'resolveRecovery', ipcJs],
]) {
  check(Boolean(where) && where.includes(token), `主进程包含 ${label}`, token);
}

// renderer 由 vite 打成单文件，按字符串抽查
const rendererJs = files
  .filter((f) => /^out\/renderer\/assets\/index-.*\.js$/.test(f))
  .map((f) => readEntry(f) ?? '')
  .join('\n');
for (const [label, token] of [
  ['R4 减少透明度进参数', '减少透明度（面板用纯色）'],
  ['R2 三个恢复语义（takeover 入口）', '恢复到首次接管时'],
  ['R2 原版诚实提示', '没有可证明的出厂原版'],
  ['R6 手动指定目录入口', '选择安装目录'],
  ['R7 待恢复面板', '待恢复'],
  ['R3 确认框披露旧主题层', '旧主题层'],
]) {
  check(rendererJs.includes(token), `renderer 包含 ${label}`, token);
}

// ---------- 4. 包内不得出现私有路径与凭证 ----------
// 凭证与私有串一律查（与 npm run audit 同一套正则的子集），unpacked 条目与超大文件跳过
const PRIVATE_PATTERNS = [
  ['作者用户名', /\bylzho\b/i],
  ['工作区绝对路径', /[A-Za-z]:[\\/]+zjcfile/i],
  ['用户目录绝对路径', /[A-Za-z]:[\\/]+Users[\\/]+(?!someone|username|user\b)[A-Za-z0-9._-]+/i],
  ['OpenAI 形态密钥', /sk-[A-Za-z0-9]{20,}/],
  ['GitHub 形态令牌', /gh[pousr]_[A-Za-z0-9]{30,}/],
  ['私钥块', /-----BEGIN [A-Z ]*PRIVATE KEY/],
];
if (fs.existsSync(asar)) {
  const fd = fs.openSync(asar, 'r');
  try {
    let scanned = 0;
    let hits = 0;
    for (const [entry, node] of nodes) {
      if (!/\.(js|json|html|css|md|txt)$/i.test(entry)) continue;
      if (node.unpacked || !node.size || node.size > 8 * 1024 * 1024) continue;
      const buf = Buffer.alloc(node.size);
      fs.readSync(fd, buf, 0, node.size, dataStart + Number(node.offset));
      scanned += 1;
      const text = buf.toString('utf8');
      for (const [label, re] of PRIVATE_PATTERNS) {
        if (re.test(text)) {
          hits += 1;
          console.log(`[FAIL] 包内 ${label}：${entry}`);
        }
      }
    }
    check(hits === 0, '包内无私有路径与凭证', `扫描 ${scanned} 个文本条目，命中 ${hits}`);
  } finally {
    fs.closeSync(fd);
  }
}

/*
 * ---------- 5. 打包产物必须真的能加载原生模块 ----------
 *
 * 归档头齐全 ≠ 能跑。本仓库真出过：@img/sharp-win32-x64 被标成 unpacked
 * 但磁盘上没有，运行时 require('sharp') 直接失败；后来又发现运行期依赖
 * @img/colour 整个没被打进包。两项都是「只查结构与清单」查不出来的。
 *
 * 做法：用 exe 的 Node 模式（ELECTRON_RUN_AS_NODE=1）在包内 require sharp
 * 并真的产出一张 PNG —— 不需要窗口与 GPU，任何环境都能跑，结论可复核。
 */
const { spawnSync } = require('node:child_process');
if (fs.existsSync(exe) && fs.existsSync(asar)) {
  const script =
    `const sharp = require(${JSON.stringify(path.join(asar, 'node_modules', 'sharp'))});` +
    `sharp({create:{width:8,height:8,channels:3,background:{r:1,g:2,b:3}}})` +
    `.png().toBuffer().then((b) => console.log('OK ' + b.length))` +
    `.catch((e) => { console.log('ERR ' + e.message); process.exitCode = 3; });`;
  const r = spawnSync(exe, ['-e', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const ok = r.status === 0 && /OK \d+/.test(out);
  check(
    ok,
    '打包应用内可加载 sharp 并产出图片（原生模块可用）',
    ok ? out.trim().split('\n').slice(-1)[0] : out.trim().split('\n').slice(-1)[0] || `exit=${r.status}`,
  );
}

/*
 * ---------- 6. 候选身份核对（R2） ----------
 * 仅 exe 相同不算候选相同：exe 是 Electron 运行时，新旧候选几乎必然一致。
 * 必须逐项核对 exe/asar/zip 的 sha256 与 candidate-manifest.json 登记一致，
 * 并把包内关键构建产物与本地 out/ 字节比对，防止「核对到旧目录」或
 * 「候选与当前源码构建输出脱节」被误判为通过。--no-identity 跳过本段（仅限取证）。
 */
function readEntryBuffer(entry) {
  const node = nodes.get(entry);
  if (!node || node.unpacked) return null;
  const buf = Buffer.alloc(node.size);
  const fd = fs.openSync(asar, 'r');
  try {
    fs.readSync(fd, buf, 0, node.size, dataStart + Number(node.offset));
  } finally {
    fs.closeSync(fd);
  }
  return buf;
}
if (!noIdentity) {
  if (!manifest && fs.existsSync(MANIFEST_PATH)) {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  }
  if (!manifest) {
    check(false, '候选身份核对', '未提供 candidate-manifest.json；显式目录核对仅限取证，需加 --no-identity');
  } else {
    check(manifest.version === pkg.version, 'manifest version 与 package.json 一致',
      manifest.version === pkg.version ? manifest.version : `${manifest.version} vs ${pkg.version}`);
    if (fs.existsSync(exe)) {
      check(sha256(exe) === manifest.hashes.exe, 'exe sha256 与登记一致', manifest.hashes.exe.slice(0, 16) + '…');
    }
    if (fs.existsSync(asar)) {
      check(sha256(asar) === manifest.hashes['app.asar'], 'app.asar sha256 与登记一致', manifest.hashes['app.asar'].slice(0, 16) + '…');
    }
    if (manifest.zip) {
      const zp = path.resolve(ROOT, manifest.zip);
      if (fs.existsSync(zp)) {
        check(sha256(zp) === manifest.hashes.zip, '分发 zip sha256 与登记一致（zip 与核对对象为同一候选）', manifest.hashes.zip.slice(0, 16) + '…');
      } else {
        check(false, '分发 zip 存在', manifest.zip);
      }
    }
    for (const rel of ['out/main/index.js', 'out/preload/index.js', 'out/core/patch/stage.js']) {
      const local = path.join(ROOT, rel);
      if (!fs.existsSync(local)) {
        check(false, `本地构建输出存在 ${rel}`, '缺失：请先 npm run build，否则无法证明候选与当前源码一致');
        continue;
      }
      const inAsar = readEntryBuffer(rel);
      if (!inAsar) {
        check(false, `包内存在 ${rel}`, '缺失或位于 unpacked');
        continue;
      }
      const localSha = crypto.createHash('sha256').update(fs.readFileSync(local)).digest('hex');
      const asarSha = crypto.createHash('sha256').update(inAsar).digest('hex');
      check(localSha === asarSha, `包内 ${rel} 与本地构建输出一致`,
        localSha === asarSha ? '' : `本地 ${localSha.slice(0, 12)} 包内 ${asarSha.slice(0, 12)}（候选落后于源码，需重新构建并重新登记）`);
    }
  }
}

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.ok);
for (const r of failed) console.log(`[FAIL] ${r.label} | ${r.detail}`);
console.log(`\n核对 ${results.length} 项，失败 ${failed.length} 项`);
process.exit(failed.length === 0 ? 0 : 1);