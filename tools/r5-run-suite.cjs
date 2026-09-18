/**
 * 全量单元/集成测试统一入口（S5 重构；P4-B 受控并发与文本完整性检查；
 * R3 升级：**完成集合相等** 的机器可读完整性检查）。
 *
 * 做四件事：
 *  1. 把 TEMP/TMP 注入**本次运行独立**的安全子目录再派生 vitest——根默认为系统临时目录
 *     （`os.tmpdir()`），运行目录形如 `<root>/ots-<runId>`；可用 `OTS_TEST_TMP` 或
 *     `--tmp` 覆盖根。**不要**把默认根放回项目盘：本机实测 TEMP 落项目盘会让
 *     vitest 跑完不退出、稳定触顶超时（复审 G3，2026-09-18）。
 *     同时避开 %TEMP% 下新建 *.asar 被安全进程持久锁住的问题，且让
 *     safe-delete-shim 的 rmSync 获得临时目录豁免；不同运行之间不互相干扰。
 *  2. 受控并发：**发布模式**必须传 `--pool=forks --maxWorkers=1 --no-file-parallelism`，
 *     避免并行资源竞争造成假失败。
 *  3. **R3 严格完整性（--strict-completeness）**：
 *     - 运行前用**同一配置与过滤条件**执行 `vitest list --filesOnly` 收集预期文件集合；
 *     - 运行时附加 JSON reporter（`--outputFile.json=<logDir>/result-<runId>.json`）
 *       取得机器可读结果（字段取自本地 vitest dist 实现：顶层 success/numTotal*，
 *       testResults[].name/status/message 与 assertionResults[].status；
 *       StatusMap: fail→failed、skip→skipped、todo→todo、run/queued/only→pending）；
 *     - 校验：**完成文件集合与预期集合全等**（不比分母、不比括号计划数）、
 *       文件级失败/收集错误=0、测试失败=0、pending（未完成）=0、
 *       skipped/todo 仅允许 skipAllowlist 精确/前缀匹配的条目、
 *       numTotalTests/numFailedTests 与逐条聚合一致、success=true；
 *     - 机器结果缺失、解析失败、`startTime` 不属于本次运行（runId 绑定）→ 一律失败关闭；
 *     - 文本摘要只供人阅读与兜底（Unhandled Error 启发式仍生效），不作为放行依据。
 *  4. 传播子进程退出码并记录 spawn error / signal / 超时 / 日志路径 / 执行命令。
 *     **失败永不返回 0**。
 *
 * 用法：
 *   node tools/r5-run-suite.cjs                    # 全量 vitest run
 *   node tools/r5-run-suite.cjs run tests/unit     # 透传 vitest 参数
 *   node tools/r5-run-suite.cjs run tests/integration --maxWorkers=1 --no-file-parallelism \
 *        --strict-completeness [--expect-no-skip | --allow-skip --skip-allow=ID1,ID2]
 *        [--timeout-ms=N]
 *
 * 严格模式（--strict-completeness）**默认禁止 skip/todo**，与纯函数默认一致；
 * 确需放行必须显式 `--allow-skip` 并逐个 `--skip-allow=` 精确授权。
 */
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 临时根推导（G3）：显式 `--tmp`/options > `OTS_TEST_TMP` > **系统临时目录**。
 * 默认曾是 `<repo>/node_modules/.cache/ots-test-tmp`（项目盘）——本机实测 TEMP 落
 * 项目盘会让 vitest 跑完不退出、稳定触顶 9 分钟超时，故默认改为 os.tmpdir()。
 * 纯函数导出，便于单测覆盖优先级推导而不触碰真实目录。
 */
function resolveTmpRoot({ tmpRoot, env = process.env } = {}) {
  return tmpRoot || env.OTS_TEST_TMP || os.tmpdir();
}

/** 文本摘要兜底解析：只扫尾部（否则正文里夹带的 vitest 样式文本会带偏解析）。 */
const SUMMARY_TAIL_LINES = 40;

const stripAnsi = (s) => String(s || '').replace(/\u001b\[[0-9;]*m/g, '');

function parseVitestSummary(output) {
  const clean = stripAnsi(output);
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
 * 文本层完整性检查（兜底防线）。R3 后文本只作兜底：完成集合以 JSON 机器结果为准。
 *
 * `output` 可传字符串（旧用法）或 `{ stdout, stderr }`：超长 stderr 会把 stdout 里
 * 的真实汇总挤出「拼接文本」的尾部窗口，所以汇总优先从 stdout 尾部找（找不到再找
 * stderr 尾部）；Unhandled Error 启发式两侧都查（任一命中即算，取较大者）。
 */
function checkCompleteness(output, opts = {}) {
  let outText = output || '';
  let errText = '';
  if (output && typeof output === 'object' && !Buffer.isBuffer(output)) {
    outText = output.stdout || '';
    errText = output.stderr || '';
  }
  const summary = { ...parseVitestSummary(outText) };
  if (errText) {
    const sErr = parseVitestSummary(errText);
    if (!summary.hasSummary && sErr.hasSummary) Object.assign(summary, sErr);
    if ((sErr.unhandledErrors || 0) > (summary.unhandledErrors || 0)) {
      summary.unhandledErrors = sErr.unhandledErrors;
    }
  }
  const problems = [];
  if (!summary.hasSummary) problems.push('缺少 Test Files / Tests 汇总行（可能未跑完或被中断）');
  if (summary.unhandledErrors && summary.unhandledErrors > 0) {
    problems.push(`存在 ${summary.unhandledErrors} 个 Unhandled Error（含 RPC/worker 通信错误）`);
  }
  if (summary.testsFailed && summary.testsFailed > 0) problems.push(`测试失败 ${summary.testsFailed} 项`);
  if (summary.filesFailed && summary.filesFailed > 0) problems.push(`文件失败 ${summary.filesFailed} 个`);
  if (opts.expectedFiles != null && summary.filesTotal != null && summary.filesTotal !== opts.expectedFiles) {
    problems.push(`应运行文件 ${opts.expectedFiles} 个，实际完成 ${summary.filesTotal} 个`);
  }
  if (opts.expectNoSkip && !opts.skipIdentityCheck && ((summary.testsSkipped || 0) > 0 || (summary.testsTodo || 0) > 0)) {
    problems.push(`存在 skipped=${summary.testsSkipped || 0} / todo=${summary.testsTodo || 0}，与预期不一致`);
  }
  return { ok: problems.length === 0, problems, summary };
}

/** 路径规范化：绝对化后转相对仓库的正斜杠相对路径（Windows/Linux 一致比较）。 */
function normalizeRelFile(repo, p) {
  const abs = path.resolve(repo, String(p));
  const rel = path.relative(repo, abs).split(path.sep).join('/');
  return { abs, rel };
}

/**
 * R3：运行前用同一配置与过滤条件收集预期测试文件集合。
 * `vitest list --filesOnly <与本次运行相同的过滤参数>`，输出每行一个文件路径。
 * 任何不可解析（非已存在文件的行）→ 判定失败（解析失败必须失败关闭）。
 */
function collectExpectedFiles({ repo, vitestArgs, spawn, env, timeoutMs = 120000 }) {
  const listArgs = ['list', '--filesOnly'];
  for (let i = 0; i < vitestArgs.length; i++) {
    const a = vitestArgs[i];
    if (i === 0 && a === 'run') continue;
    // 防御性剔除运行期报告参数（预期清单收集不需要它们）。
    // **两段式必须把「值」一起剔除**（S4）：只剔键会把 `dot` / 报告路径当成
    // 过滤条件传给 `vitest list --filesOnly`，当它们碰巧匹配到别的测试文件时，
    // 预期集合被污染 → 严格校验误报或运行范围偏离。等号形式不受影响。
    if (a === '--reporter') { i++; continue; }
    if (a.startsWith('--reporter=')) continue;
    if (a.startsWith('--outputFile')) {
      if (!a.includes('=')) i++; // 两段式：吃掉下一个 token（报告路径）
      continue;
    }
    listArgs.push(a);
  }
  const vitestPath = path.join(repo, 'node_modules', 'vitest', 'vitest.mjs');
  const command = [vitestPath, ...listArgs];
  const r = spawn(process.execPath, command, {
    cwd: repo,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    windowsHide: true,
  });
  const problems = [];
  if (r.error) problems.push(`vitest list 派生失败：${r.error.message}`);
  if (r.signal) problems.push(`vitest list 被信号终止：${r.signal}`);
  if (r.status !== 0) problems.push(`vitest list 退出码 ${r.status === null ? 'null' : r.status}（非 0）`);
  const files = [];
  const badLines = [];
  for (const raw of stripAnsi(r.stdout).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const { abs, rel } = normalizeRelFile(repo, line);
    let isFile = false;
    try {
      isFile = fs.statSync(abs).isFile();
    } catch {
      isFile = false;
    }
    if (isFile) files.push(rel);
    else badLines.push(line);
  }
  if (badLines.length) problems.push(`vitest list 输出含不可解析行（前 3）：${badLines.slice(0, 3).join(' | ')}`);
  if (files.length === 0) problems.push('vitest list 未解析出任何预期测试文件（空集合在发布模式不允许）');
  return { ok: problems.length === 0, files, problems, exit: r.status, command: command.join(' ') };
}

/**
 * R3：读取并校验 JSON 机器结果文件。
 * - 缺失 / 解析失败 → 失败关闭；
 * - `startTime` 必须不早于本次运行开始（允许 5s 时钟偏差）——结果绑定本次 runId；
 * - 必须含 testResults 数组（本地 vitest JSON reporter 契约）。
 */
function readJsonResult(resultPath, { startMs, nowMs = Date.now() } = {}) {
  const problems = [];
  if (!fs.existsSync(resultPath)) {
    return { ok: false, result: null, problems: [`机器可读结果缺失：${resultPath}（vitest 未写出 JSON 报告）`] };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  } catch (e) {
    return { ok: false, result: null, problems: [`机器可读结果解析失败：${e.message}`] };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, result: null, problems: ['机器可读结果不是 JSON 对象'] };
  }
  if (typeof parsed.startTime !== 'number' || parsed.startTime < startMs - 5000 || parsed.startTime > nowMs + 5000) {
    problems.push(
      `机器结果不属于本次运行：startTime=${parsed.startTime} 不在本次运行窗口内（runId 绑定失败）`,
    );
  }
  if (!Array.isArray(parsed.testResults)) {
    problems.push('机器结果缺少 testResults 数组（不符合本地 vitest JSON reporter 契约）');
  }
  return { ok: problems.length === 0, result: parsed, problems };
}

/**
 * R3 核心：**完成集合相等**检查（纯函数，便于门禁测试注入）。
 * 字段语义取自本地 vitest dist（JsonReporter/StatusMap），不凭网上示例猜。
 * @returns {{ ok: boolean, problems: string[], counts: object }}
 */
function checkStrictCompleteness({ repo, expected, result, expectNoSkip = true, skipAllowlist = [] } = {}) {
  const problems = [];
  const counts = {
    expectedFiles: Array.isArray(expected) ? expected.length : null,
    filesRun: 0, filesFailed: 0, missingFiles: 0, extraFiles: 0,
    testsTotal: 0, testsPassed: 0, testsFailed: 0, testsSkipped: 0, testsTodo: 0, testsPending: 0,
    schemaErrors: 0,
  };
  if (!result || typeof result !== 'object') {
    return { ok: false, problems: ['机器可读结果缺失'], counts };
  }
  const tr = Array.isArray(result.testResults) ? result.testResults : null;
  if (!tr) return { ok: false, problems: ['机器结果缺少 testResults 数组'], counts };
  if (tr.length === 0) problems.push('机器结果为空（未完成任何测试文件——worker 未完成或收集失败）');

  /** allowlist 匹配：精确 id、`entry::` 前缀（文件级豁免）、尾随 `*` 通配 */
  const allowed = (id) =>
    skipAllowlist.some((a) => id === a || id.startsWith(`${a}::`) || (a.endsWith('*') && id.startsWith(a.slice(0, -1))));

  const filesRun = new Set();
  const failedTests = [];
  const skippedTests = [];
  const todoTests = [];
  const pendingTests = [];

  for (const f of tr) {
    const name = f && typeof f.name === 'string' ? f.name : null;
    if (!name) {
      problems.push('结果中存在缺少 name 的文件条目');
      continue;
    }
    const { rel } = normalizeRelFile(repo, name);
    if (filesRun.has(rel)) problems.push(`文件在结果中重复出现：${rel}`);
    filesRun.add(rel);
    counts.filesRun++;
    if (f.status !== 'passed') {
      counts.filesFailed++;
      problems.push(
        `文件未通过：${rel}（status=${f.status}${f.message ? '，' + String(f.message).split(/\r?\n/)[0].slice(0, 200) : ''}）`,
      );
    } else if (f.message) {
      counts.filesFailed++;
      problems.push(`文件存在收集错误：${rel}：${String(f.message).split(/\r?\n/)[0].slice(0, 200)}`);
    }
    // S3：assertionResults 是本地 vitest JSON reporter 契约的**必需字段**。
    // 缺失 / null / 非数组都属畸形报告，**绝不能**兜底成空数组——那会让
    // 「文件状态 passed + 0 项断言」被当成「跑完且全过」（零项成功）。
    if (!Array.isArray(f.assertionResults)) {
      counts.schemaErrors++;
      problems.push(
        `文件结果缺少 assertionResults 数组（畸形机器报告，失败关闭）：${rel}` +
          `（实际 ${f.assertionResults === undefined ? 'undefined' : typeof f.assertionResults}）`,
      );
      continue;
    }
    if (f.assertionResults.length === 0) {
      problems.push(`文件内没有任何测试项（零项文件不得视为完成）：${rel}`);
    }
    const ar = f.assertionResults;
    for (const t of ar) {
      counts.testsTotal++;
      const id = `${rel}::${(t && (t.fullName || t.title)) || '(无名)'}`;
      const st = t && t.status;
      if (st === 'passed') counts.testsPassed++;
      else if (st === 'failed') { counts.testsFailed++; failedTests.push(id); }
      else if (st === 'skipped') { counts.testsSkipped++; skippedTests.push(id); }
      else if (st === 'todo') { counts.testsTodo++; todoTests.push(id); }
      else if (st === 'pending') { counts.testsPending++; pendingTests.push(id); }
      else problems.push(`未知测试状态：${id}（${st}）`);
    }
  }

  if (counts.testsPending > 0) {
    problems.push(
      `存在未完成（pending）测试 ${counts.testsPending} 项——worker 可能未跑完：${pendingTests.slice(0, 3).join('；')}`,
    );
  }
  if (counts.testsFailed > 0) {
    problems.push(`测试失败 ${counts.testsFailed} 项：${failedTests.slice(0, 3).join('；')}`);
  }
  if (expectNoSkip) {
    const notAllowedSkip = skippedTests.filter((id) => !allowed(id));
    if (notAllowedSkip.length) {
      problems.push(`存在非允许 skip ${notAllowedSkip.length} 项：${notAllowedSkip.slice(0, 3).join('；')}`);
    }
    const notAllowedTodo = todoTests.filter((id) => !allowed(id));
    if (notAllowedTodo.length) {
      problems.push(`存在非允许 todo ${notAllowedTodo.length} 项：${notAllowedTodo.slice(0, 3).join('；')}`);
    }
  }

  // 总数一致性：括号里的计划总数不可信，逐条聚合必须与机器结果声明一致
  if (result.numTotalTests !== counts.testsTotal) {
    problems.push(`总数不一致：numTotalTests=${result.numTotalTests} 与逐条聚合 ${counts.testsTotal} 不等`);
  }
  if (result.numFailedTests !== counts.testsFailed) {
    problems.push(`失败数不一致：numFailedTests=${result.numFailedTests} 与逐条聚合 ${counts.testsFailed} 不等`);
  }
  if (result.success !== true) problems.push('机器结果 success=false');

  // ---- S3：数值类型 + 全零拒绝 + suite 级计数 ----
  // vitest 的 success 只由「有文件 && 失败 suite 数 0 && 失败测试数 0」算出，
  // **不覆盖** suite 级 pending，因此不能单靠 success 推断所有 suite 已完成。
  // （suite 数含嵌套 describe，不等于测试文件数，故只校验为 0，不与文件数比对。）
  const isCount = (v) => Number.isInteger(v) && v >= 0;
  if (!isCount(result.numTotalTests)) {
    problems.push(`numTotalTests 不是非负整数：${JSON.stringify(result.numTotalTests)}`);
  }
  if (!isCount(result.numFailedTests)) {
    problems.push(`numFailedTests 不是非负整数：${JSON.stringify(result.numFailedTests)}`);
  }
  if (counts.testsTotal === 0) {
    problems.push('本次运行总测试数为 0：全零报告不得视为通过（个别文件若确有合法空套件，须显式豁免并给出理由）');
  }
  if (!isCount(result.numFailedTestSuites)) {
    problems.push(`numFailedTestSuites 缺失或不是非负整数：${JSON.stringify(result.numFailedTestSuites)}`);
  } else if (result.numFailedTestSuites !== 0) {
    problems.push(`存在未通过的测试 suite：numFailedTestSuites=${result.numFailedTestSuites}`);
  }
  if (!isCount(result.numPendingTestSuites)) {
    problems.push(`numPendingTestSuites 缺失或不是非负整数：${JSON.stringify(result.numPendingTestSuites)}`);
  } else if (result.numPendingTestSuites !== 0) {
    problems.push(
      `存在未完成（pending）的测试 suite：numPendingTestSuites=${result.numPendingTestSuites}` +
        '（该计数含 run/queued/todo 模式的 suite，vitest 的 success 不覆盖此项）',
    );
  }

  // **完成集合相等**：不比数量、不比分母，比规范化后的文件集合
  const expectedSet = new Set(Array.isArray(expected) ? expected : []);
  const missing = [...expectedSet].filter((f) => !filesRun.has(f));
  const extra = [...filesRun].filter((f) => !expectedSet.has(f));
  counts.missingFiles = missing.length;
  counts.extraFiles = extra.length;
  if (missing.length) {
    problems.push(`未完成文件 ${missing.length} 个：${missing.slice(0, 5).join('、')}`);
  }
  if (extra.length) {
    problems.push(`结果含预期之外文件 ${extra.length} 个：${extra.slice(0, 5).join('、')}`);
  }

  return { ok: problems.length === 0, problems, counts };
}

function runSuite(options = {}) {
  const repo = options.repo || path.resolve(__dirname, '..');
  const spawn = options.spawn || spawnSync;
  const vitestArgs = options.vitestArgs || ['run'];
  const tmpRoot = resolveTmpRoot({ tmpRoot: options.tmpRoot });
  const logDir = options.logDir || path.join(repo, 'node_modules', '.cache', 'ots-test-logs');

  // 本次运行独立的临时子目录（根可配置，运行目录不共用）
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(2).toString('hex')}`;
  const runTmp = path.join(tmpRoot, `ots-${runId}`);
  fs.mkdirSync(runTmp, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const env = { ...process.env, TEMP: runTmp, TMP: runTmp };
  const timeoutMs = options.timeoutMs ?? 9 * 60 * 1000;
  const logPath = path.join(logDir, `suite-${runId}.log`);
  const vitestPath = path.join(repo, 'node_modules', 'vitest', 'vitest.mjs');

  // ---- R3 严格模式：先收集预期集合，再注入 JSON reporter ----
  const strict = options.strict || { enabled: false };
  const strictEnabled = Boolean(strict.enabled);
  let expected = null;
  let resultPath = null;
  let expectedProblems = [];
  const startMs = Date.now();

  if (strictEnabled) {
    expected = collectExpectedFiles({ repo, vitestArgs, spawn, env, timeoutMs: options.listTimeoutMs ?? 120000 });
    if (!expected.ok) {
      expectedProblems = [`预期文件集合收集失败（失败关闭，未执行测试）：${expected.problems.join('；')}`];
      console.log(`exit=not-run strict=expected-list-failed runId=${runId}`);
      console.log(`log=${logPath}`);
      for (const p of expectedProblems) console.log(`STRICT_FAIL: ${p}`);
      try {
        fs.writeFileSync(
          logPath,
          [`command: (not run) vitest list failed`, `runId: ${runId}`, ...expected.problems.map((p) => `- ${p}`)].join('\n'),
        );
      } catch {}
      return {
        exitCode: 1, status: null, signal: null, error: null, timedOut: false,
        logPath, tmpRoot, runTmp, command: expected.command, completeness: null,
        strict: { enabled: true, expectedFiles: null, problems: expectedProblems, resultPath: null },
      };
    }
    resultPath = path.join(logDir, `result-${runId}.json`);
    try { fs.rmSync(resultPath, { force: true }); } catch {}
    console.log(`strict=on expectedFiles=${expected.files.length}`);
    console.log(`resultJson=${resultPath}`);
  }

  const extraArgs = strictEnabled
    ? ['--reporter=default', '--reporter=json', `--outputFile.json=${resultPath}`]
    : [];
  const command = [vitestPath, ...vitestArgs, ...extraArgs];

  const r = spawn(process.execPath, command, {
    cwd: repo,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    windowsHide: true,
  });

  const combined = `${r.stdout || ''}${r.stderr || ''}`;
  // 日志写入失败只报告，不影响退出码判定（日志问题不能吞掉测试结果）
  try {
    fs.writeFileSync(
      logPath,
      [
        `command: ${command.join(' ')}`,
        `cwd: ${repo}`,
        `tempRoot(本次运行): ${runTmp}`,
        `runId: ${runId}`,
        `strict: ${strictEnabled ? `on (expectedFiles=${expected ? expected.files.length : '?'})` : 'off'}`,
        `timeoutMs: ${timeoutMs}`,
        `status: ${r.status === null ? 'null' : r.status}`,
        `signal: ${r.signal || 'none'}`,
        `spawnError: ${r.error ? r.error.message : 'none'}`,
        `resultJson: ${resultPath || 'none'}`,
        '',
        strictEnabled && expected ? `--- expected files (${expected.files.length}) ---\n${expected.files.join('\n')}\n` : '',
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
  const processFailed = Boolean(r.error) || Boolean(r.signal) || r.status === null || r.status !== 0;
  let exitCode = processFailed ? (typeof r.status === 'number' ? r.status : 1) : 0;

  // 文本层兜底检查（Unhandled Error 启发式等）。stdout/stderr 分开解析：
  // 超长 stderr 不得把 stdout 的真实汇总挤出尾部窗口。严格模式下 skip 以 JSON
  // 为准（带身份豁免），文本 skipped 计数不再用于 skip 判定（skipIdentityCheck）。
  const legacyOpts = { ...(options.completeness || {}) };
  if (strictEnabled) legacyOpts.skipIdentityCheck = true;
  const completeness = checkCompleteness({ stdout: r.stdout, stderr: r.stderr }, legacyOpts);

  // R3 严格完整性：完成集合相等 + 机器结果校验
  let strictProblems = [];
  let strictResult = null;
  if (strictEnabled) {
    const rr = readJsonResult(resultPath, { startMs });
    if (!rr.ok) {
      strictProblems = [...rr.problems];
    } else {
      const sc = checkStrictCompleteness({
        repo,
        expected: expected.files,
        result: rr.result,
        expectNoSkip: strict.expectNoSkip !== false,
        skipAllowlist: strict.skipAllowlist || [],
      });
      strictResult = sc;
      strictProblems = sc.problems;
    }
    if (strictProblems.length && exitCode === 0) exitCode = 1;
  }

  if (exitCode === 0 && !completeness.ok) {
    // 进程自称成功，但文本兜底显示不完整（典型：Unhandled Error）
    exitCode = 1;
  }

  console.log(`exit=${r.status === null ? 'null' : r.status} signal=${r.signal || 'none'}`);
  console.log(`log=${logPath}`);
  console.log(`command=${command.join(' ')}`);
  console.log(`tempRoot=${runTmp}`);
  if (timedOut) console.log('timeout=true');
  if (r.error) console.log(`spawnError=${r.error.message}`);
  const summ = completeness.summary;
  if (summ) {
    console.log(
      `summary files=${summ.filesPassed ?? '?'}passed/${summ.filesTotal ?? '?'}total ` +
        `tests=${summ.testsPassed ?? '?'}passed/${summ.testsTotal ?? '?'}total ` +
        `failed=${summ.testsFailed ?? 0} unhandledErrors=${summ.unhandledErrors ?? 0}`,
    );
  }
  if (strictEnabled && strictResult) {
    const c = strictResult.counts;
    console.log(
      `strict=files=${c.filesRun}/${c.expectedFiles} tests=${c.testsPassed}/${c.testsTotal} ` +
        `failed=${c.testsFailed} skipped=${c.testsSkipped} todo=${c.testsTodo} pending=${c.testsPending}`,
    );
  }
  if (!completeness.ok || strictProblems.length) {
    console.log('COMPLETENESS_FAIL:');
    for (const p of completeness.problems) console.log(`  - ${p}`);
    for (const p of strictProblems) console.log(`  - [strict] ${p}`);
    if (exitCode === 0) exitCode = 1;
  }
  // 保留关键摘要（不只最后六行），失败时保留更多上下文
  const lines = stripAnsi(combined).split(/\r?\n/).filter(Boolean);
  if (lines.length) {
    const tail = exitCode === 0 ? 8 : 30;
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
    strict: strictEnabled
      ? { enabled: true, expectedFiles: expected ? expected.files.length : null, problems: strictProblems, resultPath, counts: strictResult ? strictResult.counts : null }
      : { enabled: false },
  };
}

/**
 * CLI 参数解析（纯函数，导出以便门禁直接断言默认语义，无需真跑 vitest）。
 *
 * S4 要点：
 * - 严格模式（--strict-completeness）**默认禁止 skip/todo** —— 与纯函数
 *   `checkStrictCompleteness` 的默认一致；需要放行必须显式 `--allow-skip`，
 *   并逐个 `--skip-allow=` 精确授权。
 * - 包装器自有参数被剥离后，其余参数**原样透传**给 vitest。
 */
function parseCliArgs(argv) {
  const args = [...argv];
  let tmpRoot;
  const tmpFlag = args.indexOf('--tmp');
  if (tmpFlag >= 0) {
    tmpRoot = args[tmpFlag + 1];
    args.splice(tmpFlag, 2);
  }
  // 提取包装器自有参数，其余透传 vitest
  const vitestArgs = [];
  let strictEnabled = false;
  // null = 未显式指定：**strict 启用时默认禁止 skip**（与纯函数默认一致，S4）。
  // 需要放行必须显式 --allow-skip，并逐个 --skip-allow= 精确授权。
  let expectNoSkip = null;
  const skipAllowlist = [];
  let timeoutMs;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--strict-completeness') { strictEnabled = true; continue; }
    if (a === '--expect-no-skip') { expectNoSkip = true; continue; }
    if (a === '--allow-skip') { expectNoSkip = false; continue; }
    if (a.startsWith('--skip-allow=')) {
      for (const id of a.slice('--skip-allow='.length).split(',')) if (id.trim()) skipAllowlist.push(id.trim());
      continue;
    }
    if (a === '--skip-allow') {
      const v = args[i + 1];
      if (v != null) {
        for (const id of v.split(',')) if (id.trim()) skipAllowlist.push(id.trim());
        i++;
      }
      continue;
    }
    if (a.startsWith('--timeout-ms=')) { timeoutMs = Number(a.slice('--timeout-ms='.length)); continue; }
    vitestArgs.push(a);
  }
  const resolvedExpectNoSkip = expectNoSkip === null ? strictEnabled : expectNoSkip;
  return {
    tmpRoot,
    vitestArgs,
    timeoutMs,
    strict: { enabled: strictEnabled, expectNoSkip: resolvedExpectNoSkip, skipAllowlist },
  };
}

module.exports = {
  runSuite,
  resolveTmpRoot,
  checkCompleteness,
  parseVitestSummary,
  checkStrictCompleteness,
  collectExpectedFiles,
  readJsonResult,
  normalizeRelFile,
  parseCliArgs,
};

if (require.main === module) {
  const { tmpRoot, vitestArgs, timeoutMs, strict } = parseCliArgs(process.argv.slice(2));
  const { exitCode } = runSuite({ tmpRoot, vitestArgs, timeoutMs, strict });
  process.exitCode = exitCode;
}
