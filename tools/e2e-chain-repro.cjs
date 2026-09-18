/**
 * 复刻发布链前缀的步骤顺序，逐步打印它实际拿到的 TEMP（G2 取证复跑）。
 *
 * 2026-09-16 首版取证到的缺陷：test:e2e 不传 env，继承外层 TEMP。
 * G2（2026-09-18 复审）已修：e2e 两步与 unit/integration 同样注入 testEnv()。
 * 本工具现在**直接 require 编排器的真实 testEnv**（不再本地复刻——复刻本身
 * 就是文档漂移源），预期结论：四步各自拿到独立的 `ots-*` 运行目录，
 * 且默认都位于同一临时根（OTS_TEST_TMP 或系统临时目录）之下。
 */
/* eslint-disable no-console */
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const nodeBin = process.execPath;

// 真实实现，与 release-build.cjs 完全同源（G2 修的就是「复刻与本体不一致」）
const { testEnv } = require('./release-build.cjs');

function step(name, cmd, args, opts = {}) {
  const env = opts.env || process.env;
  console.log(`\n=== ${name} ===`);
  console.log(`  TEMP=${env.TEMP}`);
  const started = Date.now();
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    windowsHide: true,
    shell: /\.cmd$/.test(cmd),
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const keep = out
    .split(/\r?\n/)
    .filter((l) => /passed|failed|未发现目标|Expected substring|Received string|Test Files|Tests /.test(l))
    .slice(0, 8);
  console.log(`  EXIT ${name} = ${r.status} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  for (const l of keep) console.log('  | ' + l.trim());
  return r.status;
}

const mode = process.argv[2] || 'full';

if (mode === 'full' || mode === 'unit') {
  step(
    'test:unit',
    nodeBin,
    [path.join(__dirname, 'r5-run-suite.cjs'), 'run', 'tests/unit', '--strict-completeness', '--expect-no-skip'],
    { env: testEnv() },
  );
}
if (mode === 'full' || mode === 'integration') {
  step(
    'test:integration',
    nodeBin,
    [
      path.join(__dirname, 'r5-run-suite.cjs'),
      'run',
      'tests/integration',
      '--pool=forks',
      '--maxWorkers=1',
      '--no-file-parallelism',
      '--strict-completeness',
      '--expect-no-skip',
    ],
    { env: testEnv() },
  );
}
if (mode === 'full' || mode === 'e2e') {
  // 与 release-build.cjs 一致（G2 修复后）：e2e 两步同样注入 testEnv()
  step('test:e2e', 'npm.cmd', ['run', 'test:e2e'], { env: testEnv() });
  step('test:e2e:electron', 'npm.cmd', ['run', 'test:e2e:electron'], { env: testEnv() });
}
