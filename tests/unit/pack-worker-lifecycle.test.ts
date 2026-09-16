/**
 * 打包工作进程的事件契约测试（复审 N2）。
 *
 * 问题：旧实现只监听 message 与 exit。Node 的 `fork` 是**先返回对象、后 emit('error')**
 * ——派生失败（EAGAIN/EMFILE 等）与通道错误都不一定同步抛出，外围 try/catch 兜不住；
 * EventEmitter 在没有 error 监听时会把错误直接抛出进程，变成未捕获异常，
 * 而不是返回预期的 Result。此外成功消息一到就 kill + resolve，不等进程退出。
 *
 * 本文件用**注入的假 handle**驱动 `packArchiveInWorker` 的同一条状态机：
 * 不派生真实进程、不写任何真实归档，因此可以在普通单测里稳定复现事件交错。
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { packArchiveInWorker, type PackOptions } from '../../src/core/patch/pack';

interface FakeChild extends EventEmitter {
  send: (message: unknown, cb?: (err: Error | null) => void) => void;
  kill: () => void;
  killCalls: number;
}

interface FakeHarness {
  child: FakeChild;
  opts: PackOptions;
  /** 测试侧主动触发的动作 */
  emitExit: (code: number | null) => void;
  emitMessage: (payload: unknown) => void;
  emitError: (err: Error) => void;
  sendCallbackError: (err: Error) => void;
  exitCount: () => number;
}

/** 构造一个假 handle：send 的行为由测试显式驱动，便于精确控制事件交错 */
function makeHarness(): FakeHarness {
  const child = new EventEmitter() as FakeChild;
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
  };
  let sendCb: ((err: Error | null) => void) | undefined;
  let sendCount = 0;
  child.send = (_message: unknown, cb?: (err: Error | null) => void) => {
    sendCount += 1;
    sendCb = cb;
  };
  const opts: PackOptions = {
    workerPath: 'FAKE_WORKER_PATH',
    timeoutMs: 5_000,
    forkOverride: () => ({
      onMessage: (l) => child.on('message', (m: unknown) => l(m as never)),
      onExit: (l) => child.on('exit', (c: unknown) => l((c as number | null) ?? null)),
      onError: (l) => child.on('error', (e: Error) => l(e)),
      postMessage: (m) =>
        child.send(m, (err: Error | null | undefined) => {
          if (err) child.emit('error', err);
        }),
      kill: () => child.kill(),
    }),
  };
  return {
    child,
    opts,
    emitExit: (code) => child.emit('exit', code),
    emitMessage: (payload) => child.emit('message', payload),
    emitError: (err) => child.emit('error', err),
    sendCallbackError: (err) => sendCb?.(err),
    exitCount: () => sendCount,
  };
}

const JOB = { appDir: '/fake/app', stagedArchive: '/fake/staged.asar', files: [] };

describe('N2：打包工作进程的事件契约', () => {
  it('注册了 error 监听：异步派生失败不会从 EventEmitter 逸出，而是结构化失败', async () => {
    const h = makeHarness();
    const p = packArchiveInWorker(JOB, h.opts);
    // 监听必须在发送任务之前就挂上（否则错误可能在挂监听前到达）
    expect(h.child.listenerCount('error')).toBeGreaterThan(0);
    // 模拟「fork 返回之后才到达」的异步派生失败
    expect(() => h.emitError(Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' }))).not.toThrow();
    const r = await p;
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.code).toBe('STAGE_FAILED');
    expect(r.error.message).toContain('派生或通道失败');
    expect(r.error.detail).toContain('EAGAIN');
  });

  it('IPC 发送回调报错时同样是结构化失败，不抛未捕获异常', async () => {
    const h = makeHarness();
    const p = packArchiveInWorker(JOB, h.opts);
    const err = Object.assign(new Error('channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' });
    expect(() => h.sendCallbackError(err)).not.toThrow();
    const r = await p;
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.code).toBe('STAGE_FAILED');
    expect(r.error.detail).toContain('channel closed');
  });

  it('error 与 exit 交错到达时只结算一次，且不产生未处理拒绝', async () => {
    const h = makeHarness();
    const p = packArchiveInWorker(JOB, h.opts);
    h.emitError(new Error('first failure'));
    h.emitExit(1);
    h.emitMessage({ ok: true });
    const r = await p;
    expect(r.success).toBe(false);
    if (r.success) return;
    // 第一次失败胜出，后续事件被忽略（恰好结算一次）
    expect(r.error.detail).toContain('first failure');
    expect(h.child.killCalls).toBe(1);
  });

  it('成功消息早到、退出迟到：必须等退出后再交付（不再一发消息就 kill）', async () => {
    const h = makeHarness();
    const p = packArchiveInWorker(JOB, h.opts);
    h.emitMessage({ ok: true });
    // 消息已到但进程还没退出：此刻不能结算，也不能 kill 一个仍在收尾的进程
    await new Promise((r) => setImmediate(r));
    expect(h.child.killCalls).toBe(0);

    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);

    h.emitExit(0);
    const r = await p;
    expect(r.success).toBe(true);
    // 正常退出路径不需要 kill
    expect(h.child.killCalls).toBe(0);
  });

  it('退出先到、成功消息晚到：按异常退出处理（不能先报成功再后台失败）', async () => {
    const h = makeHarness();
    const p = packArchiveInWorker(JOB, h.opts);
    h.emitExit(1);
    const r = await p;
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.message).toContain('异常退出');
    // 之后再来的成功消息不得翻案
    h.emitMessage({ ok: true });
    expect((await p).success).toBe(false);
  });

  it('worker 主动报失败时立即结算并回收进程', async () => {
    const h = makeHarness();
    const p = packArchiveInWorker(JOB, h.opts);
    h.emitMessage({ ok: false, error: { code: 'STAGE_FAILED', message: '打包失败', detail: 'detail-x' } });
    const r = await p;
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.message).toBe('打包失败');
    expect(r.error.detail).toBe('detail-x');
    expect(h.child.killCalls).toBe(1);
  });

  it('无法识别的回执按失败关闭', async () => {
    const h = makeHarness();
    const p = packArchiveInWorker(JOB, h.opts);
    h.emitMessage({ unexpected: true });
    const r = await p;
    expect(r.success).toBe(false);
  });

  it('超时会结算失败并回收进程，不遗留计时器', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      const p = packArchiveInWorker(JOB, { ...h.opts, timeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_100);
      const r = await p;
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.error.message).toContain('打包超时');
      expect(h.child.killCalls).toBe(1);
      // 计时器已清理：再推进时间不应产生新的副作用
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.child.killCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('成功回执 + 正常退出码 0 → 成功（唯一的成功路径）', async () => {
    const h = makeHarness();
    const p = packArchiveInWorker(JOB, h.opts);
    h.emitMessage({ ok: true });
    h.emitExit(0);
    const r = await p;
    expect(r.success).toBe(true);
    // 正常退出路径不需要 kill
    expect(h.child.killCalls).toBe(0);
  });

  it('成功回执后以非 0 退出（exit 1）→ 结构化失败，不报成功', async () => {
    const h = makeHarness();
    const p = packArchiveInWorker(JOB, h.opts);
    h.emitMessage({ ok: true });
    h.emitExit(1);
    const r = await p;
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.message).toContain('成功回执后异常退出');
    expect(r.error.recoveryHint).toContain('残留');
    expect(h.child.killCalls).toBe(0);
  });

  it('成功回执后以 null 退出（被信号终止）→ 结构化失败', async () => {
    const h = makeHarness();
    const p = packArchiveInWorker(JOB, h.opts);
    h.emitMessage({ ok: true });
    h.emitExit(null);
    const r = await p;
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.message).toContain('成功回执后异常退出');
  });

  it('成功回执后进程始终不退出：宽限届满请求终止，退出未确认 → 明确失败（不再报成功）', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      const p = packArchiveInWorker(JOB, { ...h.opts, timeoutMs: 10 * 60_000 });
      h.emitMessage({ ok: true });
      // 宽限期内：既不能结算，也不能 kill 一个仍在收尾的进程
      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.child.killCalls).toBe(0);
      // 宽限届满：请求终止，但 kill 成功 ≠ 已退出，必须继续等 exit
      await vi.advanceTimersByTimeAsync(11_000);
      expect(h.child.killCalls).toBe(1);
      let settled = false;
      void p.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);
      // 终止后的有界等待到期：exit 始终没来 → 失败关闭而非成功
      await vi.advanceTimersByTimeAsync(5_000);
      const r = await p;
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.error.message).toContain('仍未退出');
      expect(r.error.recoveryHint).toContain('残留');
      expect(r.error.detail).toContain('exit');
      // 结算后计时器已清理：再推进时间不产生新副作用
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.child.killCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('终止请求抛错（kill 拒绝）→ 明确失败，且不吞掉 kill 错误', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.child.kill = () => {
        h.child.killCalls += 1;
        throw new Error('kill refused');
      };
      const p = packArchiveInWorker(JOB, { ...h.opts, timeoutMs: 10 * 60_000 });
      h.emitMessage({ ok: true });
      await vi.advanceTimersByTimeAsync(31_000);
      const r = await p;
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.error.message).toContain('无法终止');
      expect(r.error.detail).toContain('kill refused');
      expect(h.child.killCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('终止请求之后进程自行以 0 退出 → 回收已确认，按契约成功', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      const p = packArchiveInWorker(JOB, { ...h.opts, timeoutMs: 10 * 60_000 });
      h.emitMessage({ ok: true });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(h.child.killCalls).toBe(1);
      h.emitExit(0);
      const r = await p;
      expect(r.success).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('只结算一次：迟到/重复的消息与退出不改结论', async () => {
    const h = makeHarness();
    const p = packArchiveInWorker(JOB, h.opts);
    h.emitMessage({ ok: true });
    h.emitExit(0);
    expect((await p).success).toBe(true);
    // 迟到事件不得翻案
    h.emitMessage({ ok: false, error: { code: 'STAGE_FAILED', message: 'late' } });
    h.emitExit(1);
    expect((await p).success).toBe(true);
  });

  it('失败先结算：后到的成功回执与 0 退出不翻案', async () => {
    const h = makeHarness();
    const p = packArchiveInWorker(JOB, h.opts);
    h.emitExit(1);
    expect((await p).success).toBe(false);
    h.emitMessage({ ok: true });
    h.emitExit(0);
    expect((await p).success).toBe(false);
  });

  it('派生同步抛错时也转成结构化失败', async () => {
    const opts: PackOptions = {
      workerPath: 'FAKE_WORKER_PATH',
      timeoutMs: 1_000,
      forkOverride: () => {
        throw new Error('spawn ENOENT');
      },
    };
    const r = await packArchiveInWorker(JOB, opts);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.code).toBe('STAGE_FAILED');
    expect(r.error.detail).toContain('spawn ENOENT');
  });
});
