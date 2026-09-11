#!/usr/bin/env node
/**
 * 便携包内容核对（docs/release-checklist.md 第 1、2 节）。
 *
 * 只读，不写入、不解压、不改动任何文件。用法：
 *   node tools/verify-package.cjs [win-unpacked 目录]
 * 默认核对 package.json `build.directories.output` 指向目录下的 win-unpacked。
 *
 * 退出码：0 全部通过；1 有失败项（逐条列出）。
 */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const outDir = (pkg.build && pkg.build.directories && pkg.build.directories.output) || 'release';
const ROOT_DIR = path.resolve(ROOT, process.argv[2] || path.join(outDir, 'win-unpacked'));

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

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.ok);
for (const r of failed) console.log(`[FAIL] ${r.label} | ${r.detail}`);
console.log(`\n核对 ${results.length} 项，失败 ${failed.length} 项`);
process.exit(failed.length === 0 ? 0 : 1);
