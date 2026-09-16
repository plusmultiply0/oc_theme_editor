/**
 * 归档 I/O 窗口的状态机测试（事故报告第四节点名的独立缺陷）。
 *
 * 旧实现 `try { return fn() } finally { 恢复 }`：当 fn 返回 Promise 时，
 * finally 在拿到 Promise 的同一刻就执行了，异步期间开关根本不在保护窗口里。
 * 修复后窗口覆盖整个 await 过程。
 *
 * 这里用 `withArchiveIoIn(..., { toggleNoAsar: true })` 显式驱动状态机 ——
 * 普通测试进程不是 Electron，`withArchiveIo` 不会切换开关，那样写测不到任何东西。
 */
import { describe, expect, it } from 'vitest';
import {
  archiveIoActiveWindows,
  archiveIoDepth,
  archiveIoNoAsarOpen,
  withArchiveIoIn,
} from '../../src/core/patch/archive-io';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('归档 I/O 窗口（noAsar 覆盖整个异步过程）', () => {
  it('异步操作执行期间开关必须处于打开状态，结束后恢复', async () => {
    expect(archiveIoNoAsarOpen()).toBe(false);
    let seenDuringAwait: boolean | undefined;
    const r = await withArchiveIoIn(
      'test-async',
      async () => {
        await delay(20);
        seenDuringAwait = archiveIoNoAsarOpen();
        return 'done';
      },
      { toggleNoAsar: true },
    );
    expect(r).toBe('done');
    // 关键断言：不是「调用后为 false」，而是「await 期间为 true」
    expect(seenDuringAwait).toBe(true);
    expect(archiveIoNoAsarOpen()).toBe(false);
    expect(archiveIoDepth()).toBe(0);
  });

  it('异步操作中途抛错，开关也必须恢复，不能泄漏', async () => {
    await expect(
      withArchiveIoIn(
        'test-throw',
        async () => {
          await delay(10);
          expect(archiveIoNoAsarOpen()).toBe(true);
          throw new Error('boom');
        },
        { toggleNoAsar: true },
      ),
    ).rejects.toThrow('boom');
    expect(archiveIoNoAsarOpen()).toBe(false);
    expect(archiveIoDepth()).toBe(0);
  });

  it('并发的两个异步操作被串行化，各自窗口内开关都正确', async () => {
    const log: string[] = [];
    const op = (name: string, ms: number): Promise<string> =>
      withArchiveIoIn(
        `test-${name}`,
        async () => {
          log.push(`${name}:open=${archiveIoNoAsarOpen()}`);
          await delay(ms);
          // 另一个操作不能在本窗口未结束时把开关关掉
          log.push(`${name}:after=${archiveIoNoAsarOpen()}`);
          return name;
        },
        { toggleNoAsar: true },
      );

    const [a, b] = await Promise.all([op('a', 40), op('b', 10)]);
    expect(a).toBe('a');
    expect(b).toBe('b');
    expect(log).toHaveLength(4);
    for (const line of log) expect(line.endsWith('true')).toBe(true);
    expect(archiveIoNoAsarOpen()).toBe(false);
    expect(archiveIoDepth()).toBe(0);
  });

  it('进入窗口前外层本来就把开关打开时，退出必须还原为打开（而不是误判成关闭）', async () => {
    const prev = archiveIoNoAsarOpen();
    (process as unknown as { noAsar?: boolean }).noAsar = true;
    try {
      await withArchiveIoIn(
        'test-nested-restore',
        async () => {
          await delay(10);
          return archiveIoNoAsarOpen();
        },
        { toggleNoAsar: true },
      );
      // 退出后应还原为「进入前的 true」，不是想当然的 false
      expect(archiveIoNoAsarOpen()).toBe(true);
    } finally {
      (process as unknown as { noAsar?: boolean }).noAsar = prev;
    }
    expect(archiveIoNoAsarOpen()).toBe(false);
  });

  it('窗口内再发起归档操作不会互相等死，且只算一层窗口', async () => {
    // allowShallowNesting 显式声明「这是无异步上下文的浅嵌套」——历史上内层靠
    // depth>0 自动放行；N1 之后该判据只对显式声明的调用保留，独立调用一律排队。
    const inner = await withArchiveIoIn(
      'test-outer',
      async () => {
        expect(archiveIoDepth()).toBe(1);
        const v = await withArchiveIoIn(
          'test-inner',
          async () => {
            expect(archiveIoDepth()).toBe(2);
            await delay(5);
            return 'inner';
          },
          { toggleNoAsar: true, allowShallowNesting: true },
        );
        expect(archiveIoDepth()).toBe(1);
        return v;
      },
      { toggleNoAsar: true },
    );
    expect(inner).toBe('inner');
    expect(archiveIoDepth()).toBe(0);
    expect(archiveIoNoAsarOpen()).toBe(false);
  });

  it('toggleNoAsar=false 时完全不碰进程开关（普通 Node 环境的真实路径）', async () => {
    const before = archiveIoNoAsarOpen();
    const r = await withArchiveIoIn(
      'test-noop',
      async () => {
        await delay(5);
        return archiveIoNoAsarOpen();
      },
      { toggleNoAsar: false },
    );
    expect(r).toBe(before);
    expect(archiveIoNoAsarOpen()).toBe(before);
  });
});

/**
 * N1 回归：错峰并发（staggered concurrency）不得被误判为嵌套。
 *
 * 旧判据是进程级 `depth > 0`：只要「有任务在窗口里」就放行任何新调用。
 * 于是 A 已经 await 住、B 才从外部进来时，B 会叠进 A 的窗口（depth=2），
 * 两者各自保存/还原开关 —— A 先结束把 noAsar 恢复成 false，B 结束时又把
 * 自己保存的 true 写回去，最终 depth=0 但开关漏在 true。
 *
 * 已有并发用例（Promise.all）不覆盖这个形态：两项都在首个队列回调开始前入队，
 * 它们本来就都走队列，测不到「A 在窗口中、B 从外部独立进来」。
 */
describe('归档 I/O 窗口 · 错峰并发（N1）', () => {
  const deferred = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it('A 已进入窗口并 await 时，外部独立调用 B 必须排队而不是叠进 A 的窗口', async () => {
    const aStarted = deferred();
    const aRelease = deferred();
    const bRelease = deferred();
    const timeline: string[] = [];

    const a = withArchiveIoIn(
      'stagger-A',
      async () => {
        timeline.push('A:enter');
        aStarted.resolve();
        await aRelease.promise;
        timeline.push('A:exit');
        return 'A';
      },
      { toggleNoAsar: true },
    );
    await aStarted.promise;

    // 关键：B 在 A 已 await 之后、从 A 的回调之外发起
    const b = withArchiveIoIn(
      'stagger-B',
      async () => {
        timeline.push(`B:enter(noAsar=${archiveIoNoAsarOpen()})`);
        await bRelease.promise;
        timeline.push('B:exit');
        return 'B';
      },
      { toggleNoAsar: true },
    );

    // B 不得在 A 结束前进入
    await delay(20);
    expect(timeline).toEqual(['A:enter']);
    expect(archiveIoActiveWindows()).toBe(1);
    expect(archiveIoDepth()).toBe(1);

    aRelease.resolve();
    expect(await a).toBe('A');
    // A 退出后 B 才能进入，且窗口内开关必须是打开的
    await delay(20);
    expect(timeline).toContain('B:enter(noAsar=true)');

    bRelease.resolve();
    expect(await b).toBe('B');
    expect(timeline).toEqual(['A:enter', 'A:exit', 'B:enter(noAsar=true)', 'B:exit']);
  });

  it('错峰并发结束后不泄漏：depth=0、开关与进入前一致、无残留窗口', async () => {
    const aRelease = deferred();
    const aStarted = deferred();

    const a = withArchiveIoIn(
      'leak-A',
      async () => {
        aStarted.resolve();
        await aRelease.promise;
      },
      { toggleNoAsar: true },
    );
    await aStarted.promise;
    const b = withArchiveIoIn('leak-B', async () => {}, { toggleNoAsar: true });

    aRelease.resolve();
    await Promise.all([a, b]);

    expect(archiveIoDepth()).toBe(0);
    expect(archiveIoNoAsarOpen()).toBe(false);
    expect(archiveIoActiveWindows()).toBe(0);
  });

  it('错峰并发的失败组合也不泄漏：A 抛错、B 正常', async () => {
    const aRelease = deferred();
    const aStarted = deferred();

    const a = withArchiveIoIn(
      'throw-A',
      async () => {
        aStarted.resolve();
        await aRelease.promise;
        throw new Error('A-boom');
      },
      { toggleNoAsar: true },
    );
    await aStarted.promise;
    const b = withArchiveIoIn('ok-B', async () => 'ok', { toggleNoAsar: true });

    aRelease.resolve();
    await expect(a).rejects.toThrow('A-boom');
    await expect(b).resolves.toBe('ok');

    expect(archiveIoDepth()).toBe(0);
    expect(archiveIoNoAsarOpen()).toBe(false);
    expect(archiveIoActiveWindows()).toBe(0);
  });

  it('进入窗口前 noAsar 已为 true 时，错峰并发结束后仍还原为 true', async () => {
    const before = archiveIoNoAsarOpen();
    (process as unknown as { noAsar?: boolean }).noAsar = true;
    try {
      const aRelease = deferred();
      const aStarted = deferred();
      const a = withArchiveIoIn(
        'prev-true-A',
        async () => {
          aStarted.resolve();
          await aRelease.promise;
        },
        { toggleNoAsar: true },
      );
      await aStarted.promise;
      const b = withArchiveIoIn('prev-true-B', async () => {}, { toggleNoAsar: true });
      aRelease.resolve();
      await Promise.all([a, b]);
      expect(archiveIoNoAsarOpen()).toBe(true);
      expect(archiveIoDepth()).toBe(0);
    } finally {
      (process as unknown as { noAsar?: boolean }).noAsar = before;
    }
    expect(archiveIoNoAsarOpen()).toBe(false);
  });

  it('真嵌套（窗口内再调用）仍然可直接执行，不死锁', async () => {
    const log: string[] = [];
    const r = await withArchiveIoIn(
      'nest-outer',
      async () => {
        log.push(`outer:${archiveIoNoAsarOpen()}`);
        const inner = await withArchiveIoIn(
          'nest-inner',
          async () => {
            await delay(5);
            log.push(`inner:${archiveIoNoAsarOpen()}`);
            return 'inner-ok';
          },
          { toggleNoAsar: true },
        );
        return inner;
      },
      { toggleNoAsar: true },
    );
    expect(r).toBe('inner-ok');
    expect(log).toEqual(['outer:true', 'inner:true']);
    expect(archiveIoNoAsarOpen()).toBe(false);
    expect(archiveIoDepth()).toBe(0);
  });

  it('已结束窗口的令牌立即失效：延迟任务不得复用旧窗口', async () => {
    let lateCall: (() => Promise<string>) | null = null;
    const r = await withArchiveIoIn(
      'token-expiry',
      async () => {
        // 捕获一个「窗口结束后才触发」的调用；它不是真嵌套，必须重新排队
        lateCall = () => withArchiveIoIn('late', async () => 'late', { toggleNoAsar: true });
        return 'first';
      },
      { toggleNoAsar: true },
    );
    expect(r).toBe('first');
    expect(archiveIoNoAsarOpen()).toBe(false);
    expect(archiveIoActiveWindows()).toBe(0);
    // 窗口已结束，lateCall 走队列开新窗口，而不是复用已失效的旧窗口
    expect(await lateCall!()).toBe('late');
    expect(archiveIoNoAsarOpen()).toBe(false);
    expect(archiveIoDepth()).toBe(0);
  });

  it('toggleNoAsar=false 时错峰并发同样串行化，且不碰开关', async () => {
    const aStarted = deferred();
    const aRelease = deferred();
    const order: string[] = [];
    const a = withArchiveIoIn(
      'noop-A',
      async () => {
        order.push('A:enter');
        aStarted.resolve();
        await aRelease.promise;
        order.push('A:exit');
      },
      { toggleNoAsar: false },
    );
    await aStarted.promise;
    const b = withArchiveIoIn(
      'noop-B',
      async () => {
        order.push('B:enter');
      },
      { toggleNoAsar: false },
    );
    await delay(20);
    expect(order).toEqual(['A:enter']);
    aRelease.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['A:enter', 'A:exit', 'B:enter']);
    expect(archiveIoNoAsarOpen()).toBe(false);
    expect(archiveIoDepth()).toBe(0);
  });
});
