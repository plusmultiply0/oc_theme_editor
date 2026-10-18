/**
 * smoke:gui 环境受限替代证据（policy v2）。
 *
 * 用途：当本机环境使「Playwright 驱动默认配置（沙箱开）Electron」必然崩溃、
 * 且已取证与应用代码无关时（handoff/gpu-smoke-incident-2026-10-18/），
 * 发布链以本工具产出的证据替代 smoke:gui 的发布事实。
 *
 * 证据两联，缺一不可，任一失败退出非 0：
 *   1) 双击等价启动：干净环境（剥除宿主泄漏的 ELECTRON_RUN_AS_NODE）裸跑候选
 *      exe（无参数 = 用户双击等价），要求存活 ≥6 秒——证明真实用户路径可用；
 *   2) 降级配置冒烟：跑 smoke-packaged.cjs --diagnostic-degraded，要求
 *      SMOKE_READY ready=true——证明窗口/渲染进程/界面契约在自动化驱动下真实
 *      成立（仅沙箱被降级，与默认配置的差异已如实标注）。
 *
 * 产出：<候选根>/smoke-env-limited-evidence.json（文件名固定，登记/核验端硬绑定）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const SMOKE_PACKAGED = path.join(__dirname, 'smoke-packaged.cjs');
const EVIDENCE_NAME = 'smoke-env-limited-evidence.json';
const MANUAL_ALIVE_MS = 6000;

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function parseArgs(argv) {
  const positional = [];
  let reason = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--reason') { reason = argv[i + 1] || ''; i += 1; continue; }
    positional.push(argv[i]);
  }
  return { dir: positional[0], reason };
}

function main() {
  const { dir, reason } = parseArgs(process.argv.slice(2));
  if (!dir) {
    console.error('用法: node tools/smoke-env-limited.cjs <win-unpacked 目录> [--reason <受限原因>]');
    process.exit(2);
  }
  const exe = path.join(dir, 'OpenCodeThemeSwitcher.exe');
  if (!fs.existsSync(exe)) {
    console.log(`SMOKE_ENV_LIMITED_FAIL: 候选 exe 不存在：${exe}`);
    process.exit(1);
  }
  console.log(`SMOKE_ENV_LIMITED_EXE ${exe}`);
  console.log(`SMOKE_ENV_LIMITED_EXE_SHA256 ${sha256File(exe)}`);

  // ---- 证据 1：双击等价启动存活 ----
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // 宿主泄漏会让 exe 退化成 Node 模式（start.cjs 同源事故）
  const started = Date.now();
  const child = spawn(exe, [], { stdio: 'ignore', env });
  let manualAlive = false;
  let earlyExit = null;
  child.on('exit', (code) => { earlyExit = code; });
  console.log(`MANUAL_LAUNCH waiting ${MANUAL_ALIVE_MS}ms（双击等价：无参数、干净环境）…`);
  setTimeout(() => {
    if (earlyExit !== null) {
      console.log(`SMOKE_ENV_LIMITED_FAIL: 双击等价启动提前退出 code=${earlyExit}（要求存活 ≥${MANUAL_ALIVE_MS / 1000}s）`);
      finish(1);
      return;
    }
    manualAlive = true;
    child.kill();
    console.log(`MANUAL_LAUNCH alive=${MANUAL_ALIVE_MS}ms ✓`);

    // ---- 证据 2：降级配置冒烟 READY ----
    console.log('DEGRADED_SMOKE 运行 smoke-packaged.cjs --diagnostic-degraded …');
    const degEnv = { ...process.env };
    delete degEnv.ELECTRON_RUN_AS_NODE;
    const r = spawnSync(process.execPath, [SMOKE_PACKAGED, '--diagnostic-degraded', dir], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      windowsHide: true,
      env: degEnv,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const readyMatch = out.match(/SMOKE_READY ready=(\S+) timedOut=(\S+)/);
    // 降级冒烟按设计「不构成发布资格」时退出 1（SMOKE_DIAGNOSTIC_ONLY），退出码不判，READY 才判
    if (!readyMatch || readyMatch[1] !== 'true') {
      console.log(`SMOKE_ENV_LIMITED_FAIL: 降级冒烟未 READY（exit=${r.status} ready=${readyMatch && readyMatch[1]}）`);
      finish(1);
      return;
    }
    console.log(`DEGRADED_SMOKE ready=true ✓（waitedMs=${(out.match(/waitedMs=(\d+)/) || [])[1]}）`);

    // ---- 写证据 ----
    const candidateRoot = path.resolve(dir, '..');
    const evidence = {
      schema: 'smoke-env-limited-evidence/1',
      createdAt: new Date().toISOString(),
      reason: reason || '(未提供 --reason)',
      exe: { name: path.basename(exe), sha256: sha256File(exe) },
      manualLaunch: {
        equivalence: '双击等价：无启动参数、环境剥除 ELECTRON_RUN_AS_NODE',
        aliveMs: MANUAL_ALIVE_MS,
        survived: true,
      },
      degradedSmoke: {
        args: ['--no-sandbox', '--in-process-gpu'],
        ready: true,
        readyLine: readyMatch[0],
        // 降级模式按设计「不构成发布资格」退出 1，退出码仅留痕不作判据
        diagnosticExit: r.status,
      },
      system: {
        platform: process.platform,
        osRelease: os.release(),
        osVersion: typeof os.version === 'function' ? os.version() : '',
      },
    };
    const evidencePath = path.join(candidateRoot, EVIDENCE_NAME);
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.log(`SMOKE_ENV_LIMITED_OK evidence=${path.relative(process.cwd(), evidencePath)}`);
    finish(0);
  }, MANUAL_ALIVE_MS);

  let done = false;
  function finish(code) {
    if (done) return;
    done = true;
    // 确保测试实例不残留
    try { child.kill(); } catch {}
    process.exit(code);
  }
}

main();
