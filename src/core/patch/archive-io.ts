/**
 * 归档库 I/O 隔离层（R1）。
 *
 * `@electron/asar` 内部直接 `require('fs')`，我们无法把 `original-fs` 注入进去。
 * Electron 下那份 `fs` 是被包装过的：路径里含 `.asar` 的会被当成虚拟目录，
 * 归档库拿到的就不是真实文件。实测读取（`getRawHeader`）尚能工作，但写侧
 * （`extractAll` / `createPackageFromStreams` 落到 `*.asar` 目标）没有保证。
 *
 * 处理办法：在 Electron 下把 `process.noAsar` **临时**打开，让归档库与 fs 都回到物理语义，
 * 用完立刻恢复。三条纪律：
 *   1. 只在调用归档库这一小段时间内打开，不设全局长期开关
 *      ——本工具自身的模块也从 app.asar 里加载，全局关掉 asar 会把模块加载一起搞坏。
 *   2. 所有物理归档操作**串行**执行：`process.noAsar` 是进程级开关，
 *      并发进入会互相把状态改花。
 *   3. 恢复语义用 try/finally 保证，即使归档库抛错也不会把开关漏在打开状态。
 *
 * 已实测（tools/electron-asar-probe.cjs，Electron 36.9.5）：打开时 `statSync(app.asar)`
 * 返回真实文件（isFile=true/size=150584833），关闭后立刻恢复虚拟目录语义。
 */
import type { Stats } from 'node:fs';
import {
  createPackageFromStreams,
  extractAll,
  extractFile,
  getRawHeader,
  uncache,
} from '@electron/asar';

/** 重打包用的流条目；`stat` 必须是原始 fs.Stats（asar 内部直接取 size/mode） */
export interface ArchiveStreamEntry {
  path: string;
  type: 'directory' | 'file';
  unpacked: boolean;
  stat: Stats;
  streamGenerator?: () => NodeJS.ReadableStream;
}

interface NoAsarProcess {
  noAsar?: boolean;
}

function getNoAsar(): boolean {
  return (process as unknown as NoAsarProcess).noAsar === true;
}

function setNoAsar(v: boolean): void {
  (process as unknown as NoAsarProcess).noAsar = v;
}

/** 当前是否处于「归档操作窗口」内；供测试断言状态没有泄漏 */
let depth = 0;
let queue: Promise<unknown> = Promise.resolve();
let lastLabel = '';

export function archiveIoDepth(): number {
  return depth;
}

export function archiveIoNoAsarOpen(): boolean {
  return getNoAsar();
}

/** 最近一次归档操作的标签，排查用 */
export function lastArchiveOpLabel(): string {
  return lastLabel;
}

/**
 * 归档操作窗口：窗口内 asar 解释关闭，退出时恢复原值。
 *
 * 事故报告点名的独立缺陷（第四节）：旧实现用 `try { return fn() } finally { 恢复 }`，
 * 当 `fn` 返回的是 **Promise** 时，`finally` 在拿到 Promise 的同一刻就执行了，
 * 于是异步期间的 I/O 根本不在保护窗口里 —— 开关形同虚设。
 * 这里改成 `await fn()`，窗口覆盖整个异步过程；配合下面的串行队列，
 * 不会有并发的归档操作在开关关闭时交叉执行。
 *
 * `toggleNoAsar` 显式传入，是为了让测试能在普通 Node 下驱动这套状态机
 * （Node 下 `process.versions.electron` 为空，本来不会切换开关）。
 */
async function insideWindow<T>(
  label: string,
  fn: () => T | Promise<T>,
  toggleNoAsar: boolean,
): Promise<T> {
  lastLabel = label;
  if (!toggleNoAsar) return await fn();
  const prev = getNoAsar();
  depth += 1;
  setNoAsar(true);
  try {
    return await fn();
  } finally {
    depth -= 1;
    setNoAsar(prev);
  }
}

/**
 * 跑一段物理归档操作。Electron 下临时关闭 asar 解释，其余环境直通。
 * 并发的调用会排队，避免进程级开关被交叉改写。
 */
export function withArchiveIo<T>(label: string, fn: () => T | Promise<T>): Promise<T> {
  return withArchiveIoIn(label, fn, { toggleNoAsar: Boolean(process.versions?.electron) });
}

/** 显式指定是否切换 noAsar 的版本（供测试驱动状态机） */
export function withArchiveIoIn<T>(
  label: string,
  fn: () => T | Promise<T>,
  opts: { toggleNoAsar: boolean },
): Promise<T> {
  // 已在窗口内（嵌套调用）就不排队：直接在当前窗口里执行，
  // 否则内层会等外层释放，外层又在等内层返回 —— 互相等死。
  if (depth > 0) return insideWindow(label, fn, opts.toggleNoAsar);
  const next = queue.then(() => insideWindow(label, fn, opts.toggleNoAsar));
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

// ---------- 薄封装：所有归档库调用只从这里出去，便于审查 ----------

export type RawAsarHeader = Record<string, unknown>;

export function readRawHeader(archivePath: string): Promise<RawAsarHeader> {
  return withArchiveIo('getRawHeader', () => getRawHeader(archivePath) as RawAsarHeader);
}

export function readArchiveEntrySync(archivePath: string, entry: string): Promise<Buffer> {
  return withArchiveIo('extractFile', () => {
    const buf = extractFile(archivePath, entry);
    if (!buf) throw new Error(`归档条目不存在：${entry}`);
    return buf;
  });
}

export function extractArchive(archivePath: string, destDir: string): Promise<void> {
  return withArchiveIo('extractAll', () => extractAll(archivePath, destDir));
}

export type AsarStreamEntry = Parameters<typeof createPackageFromStreams>[1][number];

export function writeArchiveFromStreams(
  archivePath: string,
  streams: ArchiveStreamEntry[],
): Promise<void> {
  return withArchiveIo('createPackageFromStreams', () =>
    createPackageFromStreams(archivePath, streams as AsarStreamEntry[]),
  );
}

/** 清掉归档库对某个路径的进程内缓存；没走 fs，不需要开关 */
export function uncacheArchive(archivePath: string): void {
  try {
    uncache(archivePath);
  } catch {
    // 缓存清理失败不影响正确性：后续读取都会先 uncache
  }
}
