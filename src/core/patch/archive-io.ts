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

function insideWindow<T>(label: string, fn: () => T): T {
  if (!process.versions?.electron) {
    lastLabel = label;
    return fn();
  }
  const prev = getNoAsar();
  depth += 1;
  lastLabel = label;
  setNoAsar(true);
  try {
    return fn();
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
  // 已在窗口内（同步嵌套调用）就直接执行，避免等自己被自己阻塞
  if (depth > 0) return Promise.resolve().then(() => insideWindow(label, fn));

  const run = async (): Promise<T> => insideWindow(label, fn);
  const next = queue.then(run, run);
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
