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
    const inner = await withArchiveIoIn(
      'test-outer',
      async () => {
        expect(archiveIoDepth()).toBe(1);
        // 内层不排队（depth>0 直接执行），但深度会计数 —— 这正是「已在窗口内」的判据
        const v = await withArchiveIoIn(
          'test-inner',
          async () => {
            expect(archiveIoDepth()).toBe(2);
            await delay(5);
            return 'inner';
          },
          { toggleNoAsar: true },
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
