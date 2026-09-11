/**
 * 只读导出真实安装里的官方主 CSS，用于核对 OpenCode 1.18.29 实际使用的 token 名。
 * 只读取归档条目并写到系统临时目录，不修改任何安装内容。
 * 用法：node tools/dump-official-css.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { extractFile } = require('@electron/asar');

const asar = path.join(
  process.env.LOCALAPPDATA || '',
  'Programs',
  '@opencode-aidesktop',
  'resources',
  'app.asar',
);

const entry = process.argv[2] || 'out/renderer/assets/main-C-FJvlHS.css';
const out = path.join(os.tmpdir(), 'ots-official-' + path.basename(entry));

// Windows 上 @electron/asar 用 path.dirname/basename 逐级查找，归档内路径要转成平台分隔符
const buf = extractFile(asar, entry.split('/').join(path.sep));
fs.writeFileSync(out, buf);
console.log(`wrote ${out} (${buf.length} bytes)`);
