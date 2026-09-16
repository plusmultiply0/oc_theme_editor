/**
 * 复刻发布链 test:e2e 失败：按 release-build.cjs 的真实调用方式重跑前缀。
 *
 * 关键差异（已从 release-build.cjs 读出）：
 *   test:unit      -> env = testEnv()（TEMP 重定向到项目盘 runDir）
 *   test:integration -> env = testEnv()（另一次重定向，另一个 runDir）
 *   test:e2e       -> 不传 env，runStep 用 opts.env || process.env
 *                     => e2e 继承的是外层 shell 的 process.env（系统 Temp）
 *
 * 因此 e2e 之前的 integration 会在「项目盘 runDir」里制造大量文件，
 * 而 e2e / Electron 走的是系统 Temp。本脚本复刻该顺序，
 * 并对每一步打印它实际拿到的 TEMP。
 */
/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const nodeBin = process.execPath;

function testEnv() {
  const tmpRoot = process.env.OTS_TEST_TMP || path.join(ROOT, 'node_modules', '.cache', 'ots-test-tmp');
  const runDir = path.join(tmpRoot, `run-${process.pid}-${Date.now()}`);
  fs.mkdirSync(runDir, { recursive: true });
  return { ...process.env, TEMP: runDir, TMP: runDir };
}

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
  // 与 release-build.cjs 一致：不传 env
  step('test:e2e', 'npm.cmd', ['run', 'test:e2e'], {});
}
