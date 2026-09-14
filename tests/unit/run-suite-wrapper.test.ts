/**
 * 测试包装脚本 tools/r5-run-suite.cjs 的包装层行为（S5；P4 任务 B 增补）。
 *
 * 全部用 stub spawner，不触碰真实 vitest / 真实安装：
 *  - 退出码传播：0 / 普通失败 23 / 信号终止 / spawn 错误；
 *  - 日志按 runId 命名、连续运行互不覆盖；
 *  - TEMP/TMP 注入到指定的安全根，且**每次运行使用独立子目录**（任务 B）；
 *  - **完整性检查**（任务 B）：缺汇总 / Unhandled Error / 失败用例 / 少跑文件，
 *    即使进程自称退出 0 也不得放行（防止 RPC 错误被吞成绿）。
 */
import fs from 'node:fs';
import { testTmpRoot } from '../fixtures/test-tmp';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface SpawnOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  timeout: number;
}
interface SpawnResult {
  status: number | null;
  signal: string | null;
  error?: Error;
  stdout?: string;
  stderr?: string;
}
interface SuiteResult {
  exitCode: number;
  status: number | null;
  signal: string | null;
  logPath: string;
  tmpRoot: string;
  runTmp: string;
  command: string;
  completeness: { ok: boolean; problems: string[] };
}
interface SuiteOptions {
  repo?: string;
  spawn?: (file: string, args: readonly string[], options: SpawnOptions) => SpawnResult;
  vitestArgs?: string[];
  tmpRoot?: string;
  logDir?: string;
  completeness?: { expectedFiles?: number; expectNoSkip?: boolean };
}
const requireCjs = createRequire(import.meta.url);
const { runSuite } = requireCjs('../../tools/r5-run-suite.cjs') as {
  runSuite: (opts?: SuiteOptions) => SuiteResult;
};

/** 真实 vitest 成功输出的最小可用子集（含汇总行，供完整性检查判读）。 */
const VITEST_OK = [
  ' Test Files  2 passed (2)',
  '      Tests  15 passed (15)',
  '   Duration  1.00s',
  '',
].join('\n');
/** 带 Unhandled Error 的 vitest 输出（RPC/worker 通信错误形态）。 */
const VITEST_UNHANDLED = [
  ' Test Files  2 passed (2)',
  '      Tests  15 passed (15)',
  '     Errors  1 error',
  '⎯⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯⎯',
  'Vitest caught 1 unhandled error during the test run.',
  '',
].join('\n');

function baseOpts() {
  const root = fs.mkdtempSync(path.join(testTmpRoot(), 'ots-suite-wrapper-'));
  return { repo: root, tmpRoot: path.join(root, 'tmp'), logDir: path.join(root, 'logs') };
}

describe('r5-run-suite 包装层（S5）', () => {
  it('成功（status 0 + 完整汇总）退出 0，并把 TEMP/TMP 注入指定的安全根下的独立运行子目录', () => {
    const opts = baseOpts();
    let capturedEnv: Record<string, string | undefined> | undefined;
    const r = runSuite({
      ...opts,
      spawn: (_file: string, _args: readonly string[], o: SpawnOptions) => {
        capturedEnv = o.env;
        return { status: 0, signal: null, stdout: VITEST_OK, stderr: '' };
      },
    });
    expect(r.exitCode).toBe(0);
    // 任务 B：运行目录在根之下，且是独立子目录（形如 <root>/run-<id>）
    expect(capturedEnv?.TEMP?.startsWith(opts.tmpRoot + path.sep)).toBe(true);
    expect(capturedEnv?.TMP?.startsWith(opts.tmpRoot + path.sep)).toBe(true);
    expect(capturedEnv?.TEMP).toBe(capturedEnv?.TMP);
    expect(path.basename(capturedEnv?.TEMP ?? '')).toMatch(/^run-/);
    expect(r.runTmp).toBe(capturedEnv?.TEMP);
  });

  it('普通失败（status 23）退出 23，不吞成 0', () => {
    const r = runSuite({
      ...baseOpts(),
      spawn: () => ({ status: 23, signal: null, stdout: 'failed', stderr: '' }),
    });
    expect(r.exitCode).toBe(23);
  });

  it('信号终止（status null + signal）退出 1', () => {
    const r = runSuite({
      ...baseOpts(),
      spawn: () => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' }),
    });
    expect(r.exitCode).toBe(1);
  });

  it('spawn 错误（error 对象）退出 1，日志失败也不改变判定', () => {
    const r = runSuite({
      ...baseOpts(),
      spawn: () => ({ status: null, signal: null, error: new Error('spawn failed'), stdout: '', stderr: '' }),
    });
    expect(r.exitCode).toBe(1);
  });

  it('日志按 runId 命名：连续两次运行互不覆盖，且运行目录互不相同', () => {
    const opts = baseOpts();
    let call = 0;
    const spawn = () => {
      call += 1;
      return { status: 0, signal: null, stdout: `${VITEST_OK}\nrun-${call}`, stderr: '' };
    };
    const first = runSuite({ ...opts, spawn });
    const second = runSuite({ ...opts, spawn });

    expect(first.logPath).not.toBe(second.logPath);
    expect(fs.readFileSync(first.logPath, 'utf8')).toContain('run-1');
    expect(fs.readFileSync(second.logPath, 'utf8')).toContain('run-2');
    expect(path.dirname(first.logPath)).toBe(opts.logDir);
    // 任务 B：每次运行独立临时子目录，避免互相干扰/互锁
    expect(first.runTmp).not.toBe(second.runTmp);
    expect(fs.existsSync(first.runTmp)).toBe(true);
    expect(fs.existsSync(second.runTmp)).toBe(true);
  });
});

describe('r5-run-suite 完整性检查（P4 任务 B）', () => {
  it('进程自称退出 0，但输出缺汇总 → 判定失败，不得放行', () => {
    const r = runSuite({
      ...baseOpts(),
      spawn: () => ({ status: 0, signal: null, stdout: 'all green\nno summary here', stderr: '' }),
    });
    expect(r.exitCode).toBe(1);
    expect(r.completeness.ok).toBe(false);
    expect(r.completeness.problems.join('；')).toMatch(/汇总/);
  });

  it('进程自称退出 0，但存在 Unhandled Error → 判定失败（RPC 错误不得被吞成绿）', () => {
    const r = runSuite({
      ...baseOpts(),
      spawn: () => ({ status: 0, signal: null, stdout: VITEST_UNHANDLED, stderr: '' }),
    });
    expect(r.exitCode).toBe(1);
    expect(r.completeness.ok).toBe(false);
    expect(r.completeness.problems.join('；')).toMatch(/Unhandled Error/);
  });

  it('进程自称退出 0，但汇总显示有失败用例 → 判定失败', () => {
    const failed = [' Test Files  1 failed (1)', '      Tests  1 failed | 14 passed (15)', ''].join('\n');
    const r = runSuite({
      ...baseOpts(),
      spawn: () => ({ status: 0, signal: null, stdout: failed, stderr: '' }),
    });
    expect(r.exitCode).toBe(1);
    expect(r.completeness.ok).toBe(false);
    expect(r.completeness.problems.join('；')).toMatch(/失败/);
  });

  it('expectedFiles 与实际完成文件数不符 → 判定失败（少跑文件不得放行）', () => {
    const r = runSuite({
      ...baseOpts(),
      completeness: { expectedFiles: 15 },
      spawn: () => ({ status: 0, signal: null, stdout: VITEST_OK, stderr: '' }),
    });
    expect(r.exitCode).toBe(1);
    expect(r.completeness.problems.join('；')).toMatch(/应运行文件 15 个，实际完成 2 个/);
  });

  it('expectNoSkip 下出现 skipped/todo → 判定失败', () => {
    const skipped = [' Test Files  2 passed (2)', '      Tests  13 passed | 2 skipped (15)', ''].join('\n');
    const r = runSuite({
      ...baseOpts(),
      completeness: { expectNoSkip: true },
      spawn: () => ({ status: 0, signal: null, stdout: skipped, stderr: '' }),
    });
    expect(r.exitCode).toBe(1);
    expect(r.completeness.problems.join('；')).toMatch(/skipped/);
  });
});
