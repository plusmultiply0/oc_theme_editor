#!/usr/bin/env node
/**
 * tools/release-gate.sh 脚本层故障传播测试（R1 修复验收）。
 *
 * 把真实 npm 替换为函数桩，不执行任何真实构建/测试/打包命令：
 *   - 依次令每一步失败，断言后续步骤未执行、退出码保留、不打印 ALL_GREEN；
 *   - 重点覆盖 dist=17（历史缺陷：dist 失败仍全绿）且 verify:package 桩本可
 *     返回 0 的情形——dist 失败时 verify 步骤根本不应被执行；
 *   - 断言固定日志 /tmp/a4-gate.txt 不再被覆盖（每次运行写独立 a4-gate-<ID>.txt）。
 *
 * 用法：node tools/test-release-gate.cjs
 * 退出码：0 全部通过；1 有失败。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const GATE = path.join(ROOT, 'tools', 'release-gate.sh');

const ALL_STEPS = [
  'typecheck', 'lint', 'test:unit', 'test:integration', 'build',
  'test:e2e', 'test:e2e:electron', 'audit', 'dist', 'verify:package',
];

function findBash() {
  const candidates = ['D:/SOFTWARE/Git/bin/bash.exe', 'C:/Program Files/Git/bin/bash.exe'];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'bash';
}

/** 在隔离 cwd 中以函数桩执行门禁脚本。failStep 指定哪一步返回 failCode。 */
function runGate({ failStep = '', failCode = 0 }) {
  const runDir = fs.mkdtempSync(path.join(__dirname, 'gate-test-'));
  const callsFile = path.join(runDir, 'calls.txt').replace(/\\/g, '/');
  const original = fs.readFileSync(GATE, 'utf8');
  const patched = original.replace(/^cd ".*" ?\|\| exit 1$/m, ': # stay in isolated cwd');
  if (patched === original) throw new Error('gate patch failed: cd line not found');

  // failGuard 为空时用占位命令 `:`，避免展开成 bash 语法错误的 `;;`
  const failGuard = failStep
    ? `if [ "$1" = "run" ] && [ "$2" = "${failStep}" ]; then return ${failCode}; fi`
    : ':';
  // 哨兵：固定旧日志 /tmp/a4-gate.txt 放入标记内容，运行后必须原样保留；
  // 并要求本次运行产生了新的独立 a4-gate-<ID>.txt 日志。trap EXIT 保住退出码。
  const prelude = [
    'echo OLD-EVIDENCE > /tmp/a4-gate.txt',
    `npm() { echo "npm $*" >> '${callsFile}'; ${failGuard}; return 0; }`,
    "trap 'rc=$?",
    `if [ "$(cat /tmp/a4-gate.txt 2>/dev/null)" = "OLD-EVIDENCE" ]; then echo SENTINEL_INTACT; else echo SENTINEL_OVERWRITTEN; fi`,
    `ls /tmp/a4-gate-*.txt >/dev/null 2>&1 && echo UNIQUE_LOG_PRESENT || echo UNIQUE_LOG_MISSING`,
    'exit $rc\' EXIT',
    '',
  ].join('\n');

  const out = spawnSync(findBash(), ['--noprofile', '--norc', '-s'], {
    input: prelude + patched, encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  const calls = fs.existsSync(callsFile)
    ? fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean)
    : [];
  fs.rmSync(runDir, { recursive: true, force: true });
  const executedSteps = calls.map((c) => c.replace(/^npm run /, ''));
  return { status: out.status, stdout: out.stdout || '', stderr: out.stderr || '', executedSteps };
}

const failures = [];
function expect(cond, label, detail) {
  if (cond) console.log(`  PASS  ${label}`);
  else { console.error(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); failures.push(label); }
}

function scenario(name, opts, asserts) {
  console.log(`\n== ${name} ==`);
  const r = runGate(opts);
  asserts(r);
}

// 1) 依次令每一步失败：退出码保留、后续步骤未执行、无 ALL_GREEN
for (let i = 0; i < ALL_STEPS.length; i++) {
  const step = ALL_STEPS[i];
  const code = 20 + i;
  scenario(`失败传播：${step} 返回 ${code}`, { failStep: step, failCode: code }, (r) => {
    expect(r.status === code, `${step}=${code} 时整体退出码为 ${code}`, `实际 ${r.status}`);
    expect(r.executedSteps.join(',') === ALL_STEPS.slice(0, i + 1).join(','),
      `${step} 失败后无后续步骤`, `实际执行 ${r.executedSteps.join(',')}`);
    expect(!r.stdout.includes('ALL_GREEN'), `${step} 失败时不打印 ALL_GREEN`);
    expect(r.stdout.includes('STOPPED at ' + step), `${step} 失败时打印 STOPPED`);
    expect(r.stdout.includes('SENTINEL_INTACT'), '固定旧日志 /tmp/a4-gate.txt 未被覆盖');
    expect(r.stdout.includes('UNIQUE_LOG_PRESENT'), '本次运行写了独立 a4-gate-<ID>.txt 日志');
  });
}

// 2) 全绿路径：10 步全部执行，ALL_GREEN，退出 0
scenario('全绿路径', {}, (r) => {
  expect(r.status === 0, '全绿时退出 0', `实际 ${r.status}`);
  expect(r.executedSteps.join(',') === ALL_STEPS.join(','),
    '全绿时 10 步全部执行', `实际 ${r.executedSteps.join(',')}`);
  expect(r.stdout.includes('ALL_GREEN'), '全绿时打印 ALL_GREEN');
  expect(r.stdout.includes('SENTINEL_INTACT'), '固定旧日志未被覆盖');
});

if (failures.length) {
  console.error(`\n${failures.length} 项断言失败`);
  process.exit(1);
}
console.log('\nR1 门禁故障传播测试：全部通过');
