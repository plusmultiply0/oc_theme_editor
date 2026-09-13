/* 用安全 TEMP/TMP 派生 vitest 全量测试（绕开 bash 环境对 TEMP 的依赖） */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const safeTmp = path.join(repo, 'node_modules', '.cache', 'ots-test-tmp');
fs.mkdirSync(safeTmp, { recursive: true });

const nodeExe = process.execPath;
const r = spawnSync(
  nodeExe,
  [path.join(repo, 'node_modules', 'vitest', 'vitest.mjs'), 'run'],
  {
    cwd: repo,
    env: { ...process.env, TEMP: safeTmp, TMP: safeTmp },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 9 * 60 * 1000,
    windowsHide: true,
  },
);

const logPath = path.join(repo, 'handoff', 'review-2026-09-13', 'evidence', 'r5-full-suite.log');
fs.writeFileSync(logPath, (r.stdout || '') + '\n--- stderr ---\n' + (r.stderr || ''));
console.log(`exit=${r.status} signal=${r.signal || 'none'}`);
const tail = ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/).filter(Boolean).slice(-25).join('\n');
console.log(tail);
