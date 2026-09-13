#!/usr/bin/env node
/**
 * 候选唯一身份登记（R2）。
 *
 * 背景：verify-package 默认核对 package.json build.directories.output 下的
 * win-unpacked，而真正通过 30 项核对的重封候选在 win-unpacked.new——默认
 * 发布链会核对到旧坏包。本工具建立单一候选事实源 candidate-manifest.json：
 * 版本、来源提交、构建 ID、目录、exe/asar/zip hash、打包方式全登记在案，
 * 包检查默认绑定该候选，身份不符即失败，绝不自动回退旧目录。
 *
 * 用法：
 *   node tools/candidate-manifest.cjs register <候选目录> [--zip <zip路径>]
 *        [--build-id <id>] [--pack-method electron-builder|manual-repack]
 *        [--note <说明>]
 *   node tools/candidate-manifest.cjs show    打印当前登记
 *   node tools/candidate-manifest.cjs check   核对磁盘与登记 hash 一致
 *
 * 退出码：0 通过；1 失败。只读核对，不修改候选本身。
 */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'candidate-manifest.json');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--zip') opts.zip = argv[++i];
    else if (a === '--build-id') opts.buildId = argv[++i];
    else if (a === '--pack-method') opts.packMethod = argv[++i];
    else if (a === '--note') opts.note = argv[++i];
    else if (a === '--source-commit') opts.sourceCommit = argv[++i];
    else opts._.push(a);
  }
  return opts;
}

function cmdRegister(argv) {
  const opts = parseArgs(argv);
  const dirArg = opts._[0];
  if (!dirArg) {
    console.error('用法：node tools/candidate-manifest.cjs register <候选目录> [--zip <zip>] [--build-id <id>] [--pack-method <m>] [--note <n>] [--source-commit <sha>]');
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
  const packMethod = opts.packMethod || 'manual-repack';
  if (!['electron-builder', 'manual-repack'].includes(packMethod)) {
    console.error(`--pack-method 只支持 electron-builder | manual-repack，收到 ${packMethod}`);
    process.exit(1);
  }
  const sourceCommit = opts.sourceCommit || git(['rev-parse', 'HEAD']);
  const manifest = {
    schema: 'candidate-manifest/1',
    version: pkg.version,
    buildId: opts.buildId || `${packMethod}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
    sourceCommit,
    sourceCommitSubject: git(['log', '-1', '--format=%s', sourceCommit]),
    registeredAt: new Date().toISOString(),
    packMethod,
    reproducibleBuild: packMethod === 'electron-builder',
    notes:
      opts.note ||
      (packMethod === 'manual-repack'
        ? '手工重封候选：普通 dist 通过不代表此候选/zip 的生成证据，重建需按 handoff 记录执行。'
        : ''),
    candidateDir: path.relative(ROOT, candidateDir).replace(/\\/g, '/'),
    zip: null,
    hashes: {
      exe: sha256(exe),
      'app.asar': sha256(asar),
      zip: null,
    },
  };
  if (opts.zip) {
    const zipPath = path.resolve(ROOT, opts.zip);
    if (!fs.existsSync(zipPath)) {
      console.error(`zip 不存在：${opts.zip}`);
      process.exit(1);
    }
    manifest.zip = path.relative(ROOT, zipPath).replace(/\\/g, '/');
    manifest.hashes.zip = sha256(zipPath);
  }
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`已登记候选 -> ${path.relative(ROOT, MANIFEST)}`);
  printManifest(manifest);
}

function printManifest(m) {
  console.log(`  version      ${m.version}`);
  console.log(`  buildId      ${m.buildId}`);
  console.log(`  sourceCommit ${m.sourceCommit.slice(0, 12)} ${m.sourceCommitSubject}`);
  console.log(`  packMethod   ${m.packMethod}（reproducibleBuild=${m.reproducibleBuild}）`);
  console.log(`  candidateDir ${m.candidateDir}`);
  if (m.zip) console.log(`  zip          ${m.zip}`);
  console.log(`  exe  sha256  ${m.hashes.exe}`);
  console.log(`  asar sha256  ${m.hashes['app.asar']}`);
  if (m.hashes.zip) console.log(`  zip  sha256  ${m.hashes.zip}`);
  if (m.notes) console.log(`  notes        ${m.notes}`);
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST)) {
    console.error(`未找到 ${path.relative(ROOT, MANIFEST)}：请先 node tools/candidate-manifest.cjs register <候选目录> 登记唯一候选`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

function cmdCheck() {
  const m = loadManifest();
  const problems = [];
  const dir = path.resolve(ROOT, m.candidateDir);
  if (!fs.existsSync(dir)) {
    problems.push(`候选目录不存在：${m.candidateDir}`);
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
  if (m.version !== pkg.version) {
    problems.push(`manifest version ${m.version} != package.json version ${pkg.version}（源码版本已变，需重新登记/冻结候选）`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`[FAIL] ${p}`);
    process.exit(1);
  }
  console.log('候选身份核对通过（磁盘与登记一致）');
  printManifest(m);
}

function cmdShow() {
  printManifest(loadManifest());
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'register') cmdRegister(rest);
else if (cmd === 'check') cmdCheck();
else if (cmd === 'show' || !cmd) cmdShow();
else {
  console.error(`未知子命令 ${cmd}；可用：register / check / show`);
  process.exit(1);
}
