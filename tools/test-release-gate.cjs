#!/usr/bin/env node
/**
 * tools/release-gate.sh 脚本层故障传播测试（R1 验收 + S6 日志隔离 + S3 绑定验收）。
 *
 * 把真实 npm/node 替换为函数桩，不执行任何真实构建/测试/打包命令：
 *   - 依次令每一步失败，断言后续步骤未执行、退出码保留、不打印 ALL_GREEN；
 *   - 重点覆盖 dist=17（历史缺陷：dist 失败仍全绿）且 verify 桩本可
 *     返回 0 的情形——dist 失败时 verify 步骤根本不应被执行；
 *   - S6：日志目录隔离——每个场景用独立临时目录（GATE_LOG_DIR 注入），
 *     预先存在的旧证据文件必须原样保留；运行前后比较目录文件集合，
 *     断言**恰好新增一个**本次 runId 日志且内容含本次步骤与退出码；
 *   - S6：同一日志目录连续两次运行（模拟并发），证据互不覆盖；
 *   - S3：verify:package 改走 node tools/verify-release.cjs，必须显式绑定
 *     GATE_CANDIDATE_DIR + GATE_BUILD_ID：缺任一在构建前 exit 2、一步不跑、
 *     不打印 ALL_GREEN；全绿场景断言 node 调用带完整绑定参数。
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
const VERIFY_RELEASE = 'tools/verify-release.cjs';

function findBash() {
  const candidates = ['D:/SOFTWARE/Git/bin/bash.exe', 'C:/Program Files/Git/bin/bash.exe'];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'bash';
}

// Windows 下本机安全进程可能短暂握住 bash 刚写过的文件（R5 教训），
// recursive 删除带重试参数：EBUSY/EPERM 自动重试，不留残留目录
const rmDir = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

/**
 * 在隔离环境中以函数桩执行门禁脚本。
 * - failStep 指定哪一步返回 failCode（verify:package 的失败注入到 node 桩，
 *   其余步骤注入到 npm 桩）；
 * - logDir 省略时在 runDir 下新建独立日志目录（场景隔离）；
 *   显式传入可模拟「共享目录多次运行」；
 * - candidate / buildId 默认注入测试绑定值；传空字符串表示不设置该环境变量
 *   （S3：模拟缺失绑定的失败关闭场景）。
 */
function runGate({ failStep = '', failCode = 0, logDir, candidate = 'candidate-X/win-unpacked.new', buildId = 'b-test-1' } = {}) {
  const runDir = fs.mkdtempSync(path.join(__dirname, 'gate-test-'));
  const callsFile = path.join(runDir, 'calls.txt').replace(/\\/g, '/');
  const gateLogDir = (logDir || path.join(runDir, 'gate-logs')).replace(/\\/g, '/');
  fs.mkdirSync(gateLogDir, { recursive: true });

  // 预先存在的「共享旧证据」：运行后必须原样保留（S6：不再写共享 /tmp/a4-gate.txt）
  const oldEvidence = path.join(gateLogDir, 'old-evidence.txt');
  fs.writeFileSync(oldEvidence, 'OLD-EVIDENCE');

  const before = fs.readdirSync(gateLogDir).sort().join(',');

  const original = fs.readFileSync(GATE, 'utf8');
  const patched = original.replace(/^cd ".*" ?\|\| exit 1$/m, ': # stay in isolated cwd');
  if (patched === original) throw new Error('gate patch failed: cd line not found');

  // npm 桩：记录调用并按需失败（除 verify:package 外的 9 步）。
  // node 桩：记录调用；verify:package 现在是 node tools/verify-release.cjs（S3），
  // 失败注入按 $1 = tools/verify-release.cjs 判断。
  // trap EXIT 保住退出码。
  const npmGuard = failStep && failStep !== 'verify:package'
    ? `if [ "$1" = "run" ] && [ "$2" = "${failStep}" ]; then return ${failCode}; fi`
    : ':';
  const nodeGuard = failStep === 'verify:package'
    ? `if [ "$1" = "${VERIFY_RELEASE}" ]; then return ${failCode}; fi`
    : ':';
  const prelude = [
    `npm() { echo "npm $*" >> '${callsFile}'; ${npmGuard}; return 0; }`,
    `node() { echo "node $*" >> '${callsFile}'; ${nodeGuard}; return 0; }`,
    "trap 'rc=$?",
    'exit $rc\' EXIT',
    '',
  ].join('\n');

  const env = { ...process.env, GATE_LOG_DIR: gateLogDir };
  if (candidate) env.GATE_CANDIDATE_DIR = candidate;
  if (buildId) env.GATE_BUILD_ID = buildId;

  const out = spawnSync(findBash(), ['--noprofile', '--norc', '-s'], {
    input: prelude + patched, encoding: 'utf8', timeout: 60000, windowsHide: true, env,
  });
  const calls = fs.existsSync(callsFile)
    ? fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean)
    : [];

  // —— S6 断言数据（在清理 runDir 之前收集）——
  const sentinelIntact = fs.readFileSync(oldEvidence, 'utf8') === 'OLD-EVIDENCE';
  const after = fs.readdirSync(gateLogDir).sort();
  const added = after.filter((f) => !before.split(',').includes(f));
  const gateLogAdded = added.filter((f) => /^a4-gate-\d{8}-\d{6}-\d+\.txt$/.test(f));
  const gateLogContent = gateLogAdded.length === 1
    ? fs.readFileSync(path.join(gateLogDir, gateLogAdded[0]), 'utf8')
    : '';

  rmDir(runDir);
  // 归一化为步骤名：npm 桩去掉 "npm run " 前缀；发布核验步骤走 node 桩
  // （node tools/verify-release.cjs --candidate-dir <dir> --build-id <id>），
  // 它是门禁中唯一的 node 调用，语义上就是 verify:package 这一步。原始调用保留在 nodeCalls。
  const executedSteps = calls.map((c) =>
    c.startsWith(`node ${VERIFY_RELEASE}`) ? 'verify:package' : c.replace(/^npm run /, ''),
  );
  return {
    status: out.status,
    stdout: out.stdout || '',
    stderr: out.stderr || '',
    executedSteps,
    nodeCalls: calls.filter((c) => c.startsWith('node ')),
    sentinelIntact,
    addedCount: added.length,
    gateLogAdded: gateLogAdded.length,
    gateLogContent,
  };
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

// 1) 依次令每一步失败：退出码保留、后续步骤未执行、无 ALL_GREEN、日志隔离完好
for (let i = 0; i < ALL_STEPS.length; i++) {
  const step = ALL_STEPS[i];
  const code = 20 + i;
  scenario(`失败传播：${step} 返回 ${code}`, { failStep: step, failCode: code }, (r) => {
    expect(r.status === code, `${step}=${code} 时整体退出码为 ${code}`, `实际 ${r.status}`);
    expect(r.executedSteps.join(',') === ALL_STEPS.slice(0, i + 1).join(','),
      `${step} 失败后无后续步骤`, `实际执行 ${r.executedSteps.join(',')}`);
    expect(!r.stdout.includes('ALL_GREEN'), `${step} 失败时不打印 ALL_GREEN`);
    expect(r.stdout.includes('STOPPED at ' + step), `${step} 失败时打印 STOPPED`);
    expect(r.sentinelIntact, '场景目录中预先存在的旧证据未被访问/修改');
    expect(r.gateLogAdded === 1 && r.addedCount === 1,
      '恰好新增一个本次 runId 的独立日志', `新增 ${r.addedCount} 个文件`);
    expect(r.gateLogContent.includes(`EXIT ${step} = ${code}`) && r.gateLogContent.includes('STOPPED'),
      '本次日志内容含该步骤退出码与 STOPPED');
  });
}

// 2) 全绿路径：显式绑定注入，10 步全部执行，verify-release 调用带完整绑定参数
scenario('全绿路径（显式绑定）', {}, (r) => {
  expect(r.status === 0, '全绿时退出 0', `实际 ${r.status}`);
  expect(r.executedSteps.join(',') === ALL_STEPS.join(','),
    '全绿时 10 步全部执行', `实际 ${r.executedSteps.join(',')}`);
  expect(r.stdout.includes('ALL_GREEN'), '全绿时打印 ALL_GREEN');
  expect(r.nodeCalls.some((c) => c.includes(VERIFY_RELEASE)
      && c.includes('--candidate-dir candidate-X/win-unpacked.new')
      && c.includes('--build-id b-test-1')),
    'verify-release 调用显式绑定候选目录与 buildId', `实际 node 调用：${r.nodeCalls.join(' | ')}`);
  expect(r.sentinelIntact, '旧证据未被访问/修改');
  expect(r.gateLogAdded === 1 && r.gateLogContent.includes('ALL_GREEN'),
    '恰好新增一个本次日志且含 ALL_GREEN');
});

// 3) S3：缺 GATE_BUILD_ID —— 构建前失败关闭（exit 2），一步不跑
scenario('缺失 GATE_BUILD_ID（S3 失败关闭）', { buildId: '' }, (r) => {
  expect(r.status === 2, '缺绑定时退出 2', `实际 ${r.status}`);
  expect(r.executedSteps.length === 0, '缺绑定时一步都不执行', `实际执行 ${r.executedSteps.join(',')}`);
  expect(!r.stdout.includes('ALL_GREEN'), '缺绑定时不会打印 ALL_GREEN');  expect(r.stdout.includes('缺少 GATE_CANDIDATE_DIR/GATE_BUILD_ID'), '缺绑定时给出明确停止原因');  expect(r.sentinelIntact, '旧证据未被访问/修改');
  expect(r.gateLogAdded === 1 && r.gateLogContent.includes('STOPPED at verify:package'),
    '缺绑定同样落一份含 STOPPED 的独立日志');
});

// 4) S3：缺 GATE_CANDIDATE_DIR —— 同样失败关闭
scenario('缺失 GATE_CANDIDATE_DIR（S3 失败关闭）', { candidate: '' }, (r) => {
  expect(r.status === 2, '缺候选目录绑定时退出 2', `实际 ${r.status}`);
  expect(r.executedSteps.length === 0, '缺候选目录绑定时一步都不执行', `实际执行 ${r.executedSteps.join(',')}`);
  expect(!r.stdout.includes('ALL_GREEN'), '缺候选目录绑定时不会打印 ALL_GREEN');
});

// 5) 同一日志目录连续两次运行：证据互不覆盖（并发安全的最小确定性模拟）
{
  console.log('\n== 共享日志目录两次运行互不覆盖 ==');
  const shared = fs.mkdtempSync(path.join(__dirname, 'gate-shared-'));
  const logDir = path.join(shared, 'gate-logs').replace(/\\/g, '/');
  const a = runGate({ failStep: 'dist', failCode: 17, logDir });
  const b = runGate({ logDir });
  const files = fs.readdirSync(logDir).filter((f) => /^a4-gate-/.test(f));
  const contents = files.map((f) => fs.readFileSync(path.join(logDir, f), 'utf8'));
  rmDir(shared);
  expect(a.status === 17 && b.status === 0, '两次运行退出码各自正确（17 与 0）');
  expect(files.length === 2, '共享目录恰好留下两个独立日志', `实际 ${files.length} 个`);
  expect(contents.some((c) => c.includes('STOPPED at dist')) && contents.some((c) => c.includes('ALL_GREEN')),
    '两份日志内容各自完整（STOPPED 与 ALL_GREEN 各一份）');
}

if (failures.length) {
  console.error(`\n${failures.length} 项断言失败`);
  process.exit(1);
}
console.log('\nR1/S6/S3 门禁故障传播、日志隔离与绑定测试：全部通过');
