/**
 * 全量单元/集成测试统一入口（S5 重构）。
 *
 * 做两件事：
 *  1. 把 TEMP/TMP 注入项目内安全根再派生 vitest——本机安全进程会持久锁
 *     %TEMP% 下新建的 *.asar（见 tests/fixtures/test-tmp.ts 头注释）；
 *     safe-delete-shim 对临时目录路径的 rmSync 有豁免，删除护栏不被误触。
 *  2. 传播子进程退出码：测试失败时本脚本退出码与 vitest 一致（如 23），
 *     spawn 错误/信号终止/超时一律 1——**失败永不返回 0**（S5 修复点：
 *     旧版只打印退出码，外层自然退出 0，失败被吞）。
 *
 * 临时根可移植：默认 `node_modules/.cache/ots-test-tmp`（相对仓库），
 * 可用 OTS_TEST_TMP 或 --tmp 参数覆盖；不硬编码个人盘符，CI 可用。
 * 每次运行的完整输出写 `node_modules/.cache/ots-test-logs/suite-<runId>.log`，
 * runId 带毫秒时间戳与随机后缀，不覆盖历史日志。
 *
 * 用法：
 *   node tools/r5-run-suite.cjs                    # 全量 vitest run
 *   node tools/r5-run-suite.cjs run tests/unit     # 透传 vitest 参数
 */
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function runSuite(options = {}) {
  const repo = options.repo || path.resolve(__dirname, '..');
  const spawn = options.spawn || spawnSync;
  const vitestArgs = options.vitestArgs || ['run'];
  const tmpRoot =
    options.tmpRoot ||
    process.env.OTS_TEST_TMP ||
    path.join(repo, 'node_modules', '.cache', 'ots-test-tmp');
  const logDir = options.logDir || path.join(repo, 'node_modules', '.cache', 'ots-test-logs');

  fs.mkdirSync(tmpRoot, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto
    .randomBytes(2)
    .toString('hex')}`;
  const logPath = path.join(logDir, `suite-${runId}.log`);

  const r = spawn(
    process.execPath,
    [path.join(repo, 'node_modules', 'vitest', 'vitest.mjs'), ...vitestArgs],
    {
      cwd: repo,
      env: { ...process.env, TEMP: tmpRoot, TMP: tmpRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs ?? 9 * 60 * 1000,
      windowsHide: true,
    },
  );

  // 日志写入失败只报告，不影响退出码判定（S5：日志问题不能吞掉测试结果）
  try {
    fs.writeFileSync(logPath, (r.stdout || '') + '\n--- stderr ---\n' + (r.stderr || ''));
  } catch (e) {
    console.error(`[r5-run-suite] 日志写入失败（不影响退出码判定）：${logPath}：${e}`);
  }

  const failed =
    Boolean(r.error) || Boolean(r.signal) || r.status === null || r.status !== 0;
  const exitCode = failed ? (typeof r.status === 'number' ? r.status : 1) : 0;

  console.log(`exit=${r.status === null ? 'null' : r.status} signal=${r.signal || 'none'}`);
  console.log(`log=${logPath}`);
  const combined = `${r.stdout || ''}${r.stderr || ''}`;
  const lines = combined.split(/\r?\n/).filter(Boolean);
  if (lines.length) console.log(lines.slice(-6).join('\n'));

  return { exitCode, status: r.status, signal: r.signal, logPath, tmpRoot };
}

module.exports = { runSuite };

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
