/* 单独跑 3 个可疑文件（低负载环境），输出到证据目录 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const safeTmp = path.join(repo, 'node_modules', '.cache', 'ots-test-tmp');
fs.mkdirSync(safeTmp, { recursive: true });

const files = [
  'tests/integration/discover.test.ts',
  'tests/integration/stage-idempotence.test.ts',
  'tests/integration/transaction.test.ts',
];

const r = spawnSync(
  process.execPath,
  [path.join(repo, 'node_modules', 'vitest', 'vitest.mjs'), 'run', ...files],
  {
    cwd: repo,
    env: { ...process.env, TEMP: safeTmp, TMP: safeTmp },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 8 * 60 * 1000,
    windowsHide: true,
  },
);
const out = (r.stdout || '') + '\n--- stderr ---\n' + (r.stderr || '');
fs.writeFileSync(path.join(repo, 'handoff', 'review-2026-09-13', 'evidence', 'r5-suspects.log'), out);
const summary = out.match(/Test Files.*$|Tests .*$/gm);
console.log(`exit=${r.status}`);
console.log(summary ? summary.join('\n') : out.slice(-1500));
