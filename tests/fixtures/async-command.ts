/**
 * 异步子进程执行（P4 任务 A 的核心设施）。
 *
 * 背景：`tests/integration/candidate-manifest.test.ts` 原先用 `execFileSync` /
 * `spawnSync` 在 Vitest **worker 内部**等待子进程。等待同步子进程期间，worker
 * 自己的事件循环无法处理 IPC 消息，于是 `rpc().onTaskUpdate(...)` 的回执迟迟发不出去，
 * 60 秒（Vitest 3.2.7 RPC 默认值，见 `index.B521nVV-.js:3`）后抛
 * `[vitest-worker]: Timeout calling "onTaskUpdate"`，把退出码拉成 1。
 *
 * 本模块把「worker 侧等待」改成异步（`execFile` + Promise），事件循环在等待期间
 * 仍可处理 IPC。**不改变被测行为**：仍是真实 spawn 真实 git / 真实 CLI。
 *
 * 注意区分：独立 CLI 内部用同步 Git 不一定有问题；问题在 **worker 用同步方式等待 CLI**。
 */
import { execFile } from 'node:child_process';

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
  /** 进程无法启动/被信号终止/超时时的错误文本（便于定位） */
  error?: string;
  /** 被信号终止时的信号名（如 SIGTERM） */
  signal?: NodeJS.Signals;
  /** 本次子进程耗时（毫秒），用于诊断慢在哪一步 */
  durationMs: number;
}

/** 单个诊断子进程的建议上限；**不能**替代测试总时限，也不得把超时当成功 */
const DEFAULT_TIMEOUT_MS = 25_000;

/**
 * 异步执行一个命令。**任何异常路径都返回非 0**（spawn 失败 / 信号 / 超时），
 * 并保留错误文本与耗时；绝不把失败静默成 0。
 */
export function runCommand(
  file: string,
  args: string[],
  cwd: string,
  opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: opts.env ?? { ...process.env },
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - started;
        const err = error as (Error & { code?: number | string; signal?: NodeJS.Signals }) | null;
        // spawn 失败 / 信号 / 超时 / 非 0 退出码 —— 一律非 0，绝不吞
        const status =
          err == null ? 0 : typeof err.code === 'number' ? err.code : 1;
        resolve({
          status,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          durationMs,
          ...(err ? { error: err.message } : {}),
          ...(err && err.signal ? { signal: err.signal } : {}),
        });
      },
    );
  });
}

/**
 * 记录参考用的「最大事件循环延迟」观测器。
 *
 * 用途：证明异步等待期间事件循环确实还在转动（`setInterval` 能按时触发），
 * 并给出一个诊断数字。**不作为业务测试的通过/失败硬阈值**。
 */
export class EventLoopLagProbe {
  private timer: NodeJS.Timeout | null = null;
  private last = 0;
  private maxLag = 0;

  start(intervalMs = 25): void {
    this.last = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      this.maxLag = Math.max(this.maxLag, now - this.last - intervalMs);
      this.last = now;
    }, intervalMs);
    // 不要因为这个探针把进程吊住
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): { maxLagMs: number } {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return { maxLagMs: this.maxLag };
  }

  get maxLagMs(): number {
    return this.maxLag;
  }
}
