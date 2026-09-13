/**
 * 测试包装脚本 tools/r5-run-suite.cjs 的包装层行为（S5）。
 *
 * 全部用 stub spawner，不触碰真实 vitest / 真实安装：
 *  - 退出码传播：0 / 普通失败 23 / 信号终止 / spawn 错误；
 *  - 日志按 runId 命名、连续运行互不覆盖；
 *  - TEMP/TMP 注入到指定的安全根。
 */
import fs from 'node:fs';
import { testTmpRoot } from '../fixtures/test-tmp';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface SuiteResult {
  exitCode: number;
  status: number | null;
  signal: string | null;
  logPath: string;
  tmpRoot: string;
}
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
interface SuiteOptions {
  repo?: string;
  spawn?: (file: string, args: readonly string[], options: SpawnOptions) => SpawnResult;
  vitestArgs?: string[];
  tmpRoot?: string;
  logDir?: string;
}
const requireCjs = createRequire(import.meta.url);
const { runSuite } = requireCjs('../../tools/r5-run-suite.cjs') as {
  runSuite: (opts?: SuiteOptions) => SuiteResult;
};

function baseOpts() {
  const root = fs.mkdtempSync(path.join(testTmpRoot(), 'ots-suite-wrapper-'));
  return { repo: root, tmpRoot: path.join(root, 'tmp'), logDir: path.join(root, 'logs') };
}

describe('r5-run-suite 包装层（S5）', () => {
  it('成功（status 0）退出 0，并把 TEMP/TMP 注入指定安全根', () => {
    const opts = baseOpts();
    let capturedEnv: Record<string, string | undefined> | undefined;
    const r = runSuite({
      ...opts,
      spawn: (_file: string, _args: readonly string[], o: SpawnOptions) => {
        capturedEnv = o.env;
        return { status: 0, signal: null, stdout: 'all green', stderr: '' };
      },
    });
    expect(r.exitCode).toBe(0);
    expect(capturedEnv?.TEMP).toBe(opts.tmpRoot);
    expect(capturedEnv?.TMP).toBe(opts.tmpRoot);
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

  it('日志按 runId 命名：连续两次运行互不覆盖', () => {
    const opts = baseOpts();
    let call = 0;
    const spawn = () => {
      call += 1;
      return { status: 0, signal: null, stdout: `run-${call}`, stderr: '' };
    };
    const first = runSuite({ ...opts, spawn });
    const second = runSuite({ ...opts, spawn });

    expect(first.logPath).not.toBe(second.logPath);
    expect(fs.readFileSync(first.logPath, 'utf8')).toContain('run-1');
    expect(fs.readFileSync(second.logPath, 'utf8')).toContain('run-2');
    expect(path.dirname(first.logPath)).toBe(opts.logDir);
  });
});
