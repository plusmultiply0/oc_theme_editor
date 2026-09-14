/**
 * 全量单元/集成测试统一入口（S5 重构；P4 任务 B 增补受控并发与完整性检查）。
 *
 * 做三件事：
 *  1. 把 TEMP/TMP 注入项目内**本次运行独立**的安全子目录再派生 vitest——本机安全进程
 *     会持久锁 %TEMP% 下新建的 *.asar（见 tests/fixtures/test-tmp.ts 头注释）；
 *     safe-delete-shim 对临时目录路径的 rmSync 有豁免，删除护栏不被误触。
 *     **任务 B**：每次运行分配独立子目录（`<root>/run-<runId>`），避免不同运行互相
 *     干扰/互锁；`OTS_TEST_TMP` 或 `--tmp` 改变的是**根**，运行目录仍在其下。
 *  2. 受控并发：**发布模式**必须传 `--pool=forks --maxWorkers=1 --no-file-parallelism`
 *     （任务 B 起由发布编排器固定传入），避免并行资源竞争造成假失败。
 *  3. 传播子进程退出码，并做**完整性检查**：应运行文件集合 = 实际完成集合、
 *     失败 0、Unhandled Error 0、`skipped`/`todo` 与预期一致、退出 0；
 *     同时记录 spawn error / signal / 超时 / 日志路径 / 执行命令。
 *     **失败永不返回 0**（S5 修复点：旧版只打印退出码，外层自然退出 0，失败被吞）。
 *
 * 临时根可移植：默认 `node_modules/.cache/ots-test-tmp`（相对仓库），
 * 可用 OTS_TEST_TMP 或 --tmp 参数覆盖；不硬编码个人盘符，CI 可用。
 * 每次运行的完整输出写 `node_modules/.cache/ots-test-logs/suite-<runId>.log`，
 * runId 带毫秒时间戳与随机后缀，不覆盖历史日志。
 *
 * 用法：
 *   node tools/r5-run-suite.cjs                    # 全量 vitest run
 *   node tools/r5-run-suite.cjs run tests/unit     # 透传 vitest 参数
 *   node tools/r5-run-suite.cjs run tests/integration --maxWorkers=1 --no-file-parallelism
 */
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 从 vitest 文本输出里解析机器可读的完整性要素。
 * 不依赖「最后显示全 ✓」——显式读汇总行，缺一即视为判据不足。
 *
 * 两条防误判措施（否则包装层自测的模拟文本会把真实结果带偏）：
 *  1. **只扫尾部**：vitest 的最终汇总块总在输出末尾（测试 stdout 会在其前 flush），
 *     只看末尾 `SUMMARY_TAIL_LINES` 行即可排除正文里夹带的 vitest 样式文本；
 *  2. **取最后一块**：末尾若仍有多个候选，取最后一个（真实汇总块）。
 */
const SUMMARY_TAIL_LINES = 40;

function parseVitestSummary(output) {
  const clean = String(output || '').replace(/\u001b\[[0-9;]*m/g, '');
  const tail = clean.split(/\r?\n/).slice(-SUMMARY_TAIL_LINES).join('\n');
  const num = (re) => {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    const all = [...tail.matchAll(g)];
    return all.length ? Number(all[all.length - 1][1]) : null;
  };
  /** 取最后一个形如 `Tests  5 failed | 168 passed (173)` 的行文本 */
  const lastSummaryLine = (label) => {
    const re = new RegExp(`^[^\\S\\n]*${label}\\s+([^\\n(]*\\(\\d+\\))`, 'gm');
    const all = [...tail.matchAll(re)];
    return all.length ? all[all.length - 1][1].trim() : null;
  };
  const pick = (line, kw) => {
    if (!line) return null;
    const m = line.match(new RegExp(`(\\d+)\\s+${kw}`));
    return m ? Number(m[1]) : null;
  };

  const filesLine = lastSummaryLine('Test Files');
  const testsLine = lastSummaryLine('Tests');

  return {
    // 汇总块里的 `(N)` 即总数；取最后一处
    filesTotal: (() => {
      const re = /^[^\S\n]*Test Files\s+[^\n(]*\((\d+)\)/gm;
      const all = [...tail.matchAll(re)];
      return all.length ? Number(all[all.length - 1][1]) : null;
    })(),
    testsTotal: (() => {
      const re = /^[^\S\n]*Tests\s+[^\n(]*\((\d+)\)/gm;
      const all = [...tail.matchAll(re)];
      return all.length ? Number(all[all.length - 1][1]) : null;
    })(),
    testsFailed: pick(testsLine, 'failed'),
    testsPassed: pick(testsLine, 'passed'),
    testsSkipped: pick(testsLine, 'skipped'),
    testsTodo: pick(testsLine, 'todo'),
    filesFailed: pick(filesLine, 'failed'),
    filesPassed: pick(filesLine, 'passed'),
    // Unhandled Error 有两个可判读来源，取**较大者**（任一命中即不得放行）：
    //   1) 汇总行 `Errors  1 error`（vitest 官方汇总块）
    //   2) 正文 `Vitest caught 1 unhandled error during the test run.`
    // 只认其一会在格式变化时静默漏判，故两者都读。
    unhandledErrors: (() => {
      const a = num(/^\s*Errors\s+(\d+)\s+error/m);
      const b = num(/Vitest caught\s+(\d+)\s+unhandled error/i);
      const c =
        /⎯+\s*Unhandled Error/i.test(tail) || /^\s*Unhandled Error\s*$/m.test(tail) ? 1 : 0;
      const vals = [a, b, c].filter((v) => v != null);
      return vals.length ? Math.max(...vals) : 0;
    })(),
    hasSummary: filesLine != null && testsLine != null,
  };
}

/**
 * 完整性检查：RPC 错误或少跑文件**不能**只靠「最后显示全 ✓」放行。
 * 返回 { ok, problems, summary }。
 */
function checkCompleteness(output, opts = {}) {
  const s = parseVitestSummary(output);
  const problems = [];
  if (!s.hasSummary) problems.push('缺少 Test Files / Tests 汇总行（可能未跑完或被中断）');
  if (s.unhandledErrors && s.unhandledErrors > 0) {
    problems.push(`存在 ${s.unhandledErrors} 个 Unhandled Error（含 RPC/worker 通信错误）`);
  }
  if (s.testsFailed && s.testsFailed > 0) problems.push(`测试失败 ${s.testsFailed} 项`);
  if (opts.expectedFiles != null && s.filesTotal != null && s.filesTotal !== opts.expectedFiles) {
    problems.push(`应运行文件 ${opts.expectedFiles} 个，实际完成 ${s.filesTotal} 个`);
  }
  if (opts.expectNoSkip && ((s.testsSkipped || 0) > 0 || (s.testsTodo || 0) > 0)) {
    problems.push(`存在 skipped=${s.testsSkipped || 0} / todo=${s.testsTodo || 0}，与预期不一致`);
  }
  return { ok: problems.length === 0, problems, summary: s };
}

function runSuite(options = {}) {
  const repo = options.repo || path.resolve(__dirname, '..');
  const spawn = options.spawn || spawnSync;
  const vitestArgs = options.vitestArgs || ['run'];
  const tmpRoot =
    options.tmpRoot ||
    process.env.OTS_TEST_TMP ||
    path.join(repo, 'node_modules', '.cache', 'ots-test-tmp');
  const logDir = options.logDir || path.join(repo, 'node_modules', '.cache', 'ots-test-logs');

  // 任务 B：本次运行独立的临时子目录（根可配置，运行目录不共用）
  const runIdSeed = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto
    .randomBytes(2)
    .toString('hex')}`;
  const runTmp = path.join(tmpRoot, `run-${runIdSeed}`);

  fs.mkdirSync(runTmp, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const runId = runIdSeed;
  const logPath = path.join(logDir, `suite-${runId}.log`);
  const command = [process.execPath, path.join(repo, 'node_modules', 'vitest', 'vitest.mjs'), ...vitestArgs];

  const r = spawn(process.execPath, command.slice(1), {
    cwd: repo,
    env: { ...process.env, TEMP: runTmp, TMP: runTmp },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs ?? 9 * 60 * 1000,
    windowsHide: true,
  });

  const combined = `${r.stdout || ''}${r.stderr || ''}`;

  // 日志写入失败只报告，不影响退出码判定（S5：日志问题不能吞掉测试结果）
  try {
    fs.writeFileSync(
      logPath,
      [
        `command: ${command.join(' ')}`,
        `cwd: ${repo}`,
        `tempRoot(本次运行): ${runTmp}`,
        `timeoutMs: ${options.timeoutMs ?? 9 * 60 * 1000}`,
        `status: ${r.status === null ? 'null' : r.status}`,
        `signal: ${r.signal || 'none'}`,
        `spawnError: ${r.error ? r.error.message : 'none'}`,
        '',
        '--- stdout ---',
        r.stdout || '',
        '--- stderr ---',
        r.stderr || '',
      ].join('\n'),
    );
  } catch (e) {
    console.error(`[r5-run-suite] 日志写入失败（不影响退出码判定）：${logPath}：${e}`);
  }

  const timedOut = Boolean(r.error && /ETIMEDOUT|timed? ?out/i.test(String(r.error.message || '')));
  const failed =
    Boolean(r.error) || Boolean(r.signal) || r.status === null || r.status !== 0;
  let exitCode = failed ? (typeof r.status === 'number' ? r.status : 1) : 0;

  // 任务 B：完整性检查——RPC 错误/少跑文件不得放行
  const completeness = checkCompleteness(combined, options.completeness || {});
  if (exitCode === 0 && !completeness.ok) {
    // 进程自称成功，但汇总显示不完整（典型：Unhandled Error 被算作非 0，或汇总缺失）
    exitCode = 1;
  }

  console.log(`exit=${r.status === null ? 'null' : r.status} signal=${r.signal || 'none'}`);
  console.log(`log=${logPath}`);
  console.log(`command=${command.join(' ')}`);
  console.log(`tempRoot=${runTmp}`);
  if (timedOut) console.log('timeout=true');
  if (r.error) console.log(`spawnError=${r.error.message}`);
  const summ = completeness.summary;
  console.log(
    `summary files=${summ.filesPassed ?? '?'}passed/${summ.filesTotal ?? '?'}total ` +
      `tests=${summ.testsPassed ?? '?'}passed/${summ.testsTotal ?? '?'}total ` +
      `failed=${summ.testsFailed ?? 0} unhandledErrors=${summ.unhandledErrors ?? 0}`,
  );
  if (!completeness.ok) {
    console.log('COMPLETENESS_FAIL:');
    for (const p of completeness.problems) console.log(`  - ${p}`);
    if (exitCode === 0) exitCode = 1;
  }
  // 保留关键摘要（不只最后六行），失败时保留更多上下文
  const lines = combined.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/).filter(Boolean);
  if (lines.length) {
    const tail = completeness.ok ? 8 : 30;
    console.log(lines.slice(-tail).join('\n'));
  }

  return {
    exitCode,
    status: r.status,
    signal: r.signal,
    error: r.error ? r.error.message : null,
    timedOut,
    logPath,
    tmpRoot,
    runTmp,
    command: command.join(' '),
    completeness,
  };
}

module.exports = { runSuite, checkCompleteness, parseVitestSummary };

if (require.main === module) {
  const args = process.argv.slice(2);
  const tmpFlag = args.indexOf('--tmp');
  let tmpRoot;
  if (tmpFlag >= 0) {
    tmpRoot = args[tmpFlag + 1];
    args.splice(tmpFlag, 2);
  }
  const { exitCode } = runSuite({ tmpRoot, vitestArgs: args });
  process.exitCode = exitCode;
}
