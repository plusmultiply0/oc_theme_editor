#!/usr/bin/env node
/* 只读探测 Electron ASAR：解析头部、列出条目、读取单个文件元信息。绝不写入。
 * 用法: node tools/inspect-asar.cjs [asarPath] [--list <dir>] [--read <entry>]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const defaultAsar = process.env.OPENCODE_APP_DIR
  ? path.join(process.env.OPENCODE_APP_DIR, 'resources', 'app.asar')
  : path.join(process.env.LOCALAPPDATA || '', 'Programs', '@opencode-aidesktop', 'resources', 'app.asar');

function parseHeader(fd) {
  const pre = Buffer.alloc(16);
  fs.readSync(fd, pre, 0, 16, 0);
  if (pre.readUInt32LE(0) !== 4) throw new Error('Not an ASAR (magic != 4)');
  const start = 8 + pre.readUInt32LE(4);
  const size = pre.readUInt32LE(12);
  const buf = Buffer.alloc(size);
  fs.readSync(fd, buf, 0, size, 16);
  return { start, header: JSON.parse(buf.toString()) };
}

function walk(node, parts = [], out = new Map()) {
  for (const [name, value] of Object.entries(node.files || {})) {
    const next = [...parts, name];
    if (value.files) walk(value, next, out);
    else out.set(next.join('/'), value);
  }
  return out;
}

function readEntry(fd, start, entry) {
  if (entry.unpacked || entry.link) throw new Error('Entry is unpacked or a link; read from disk instead');
  const buf = Buffer.alloc(entry.size);
  fs.readSync(fd, buf, 0, entry.size, start + Number(entry.offset));
  return buf;
}

const args = process.argv.slice(2);
let listDir = null;
let readName = null;
const positional = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--list') { listDir = args[i + 1] ?? null; i += 1; continue; }
  if (args[i] === '--read') { readName = args[i + 1] ?? null; i += 1; continue; }
  if (args[i].startsWith('--')) continue;
  positional.push(args[i]);
}
const asarPath = positional[0] || defaultAsar;

if (!fs.existsSync(asarPath)) {
  console.error('ASAR not found:', asarPath);
  process.exit(2);
}

const fd = fs.openSync(asarPath, 'r');
try {
  const { start, header } = parseHeader(fd);
  const entries = walk(header);
  const stat = fs.statSync(asarPath);
  console.log('asar:', asarPath);
  console.log('bytes:', stat.size, '| entries:', entries.size, '| dataStart:', start);

  const pkgEntry = entries.get('package.json');
  if (pkgEntry && !pkgEntry.unpacked) {
    const pkg = JSON.parse(readEntry(fd, start, pkgEntry).toString());
    console.log('package:', JSON.stringify({
      name: pkg.name, version: pkg.version, productName: pkg.productName, main: pkg.main,
    }));
  } else {
    console.log('package: (unpacked or missing)');
  }

  if (listDir) {
    const prefix = listDir.replace(/[\\/]+$/, '') + '/';
    const names = [...entries.keys()].filter(k => k.startsWith(prefix));
    console.log(`--list ${listDir}: ${names.length} entries`);
    for (const n of names.slice(0, 200)) console.log('  ', n.replace(prefix, ''));
    if (names.length > 200) console.log(`   ... ${names.length - 200} more`);
  }

  if (readName) {
    const e = entries.get(readName);
    if (!e) { console.log('--read: entry not found'); process.exit(3); }
    console.log('--read', readName, JSON.stringify({ size: e.size, unpacked: !!e.unpacked }));
    if (!e.unpacked) {
      const buf = readEntry(fd, start, e);
      console.log(buf.toString('utf8').slice(0, 4000));
    }
  }
} finally {
  fs.closeSync(fd);
}
