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

/**
 * 当前真正处于「归档窗口」内的所有者令牌集合。
 *
 * 为什么不能只用 `depth > 0` 判断嵌套：`depth > 0` 只能说明**某个**任务在窗口内，
 * 不能证明本次调用来自那个任务的嵌套调用。错峰并发（A 已经 await 住、B 才从外部
 * 独立进来）会被误判成嵌套而直接放行，于是 B 在 A 的窗口里再叠一层、退出时按各自
 * 保存的 prev 覆盖全局开关 —— A 先结束时把 noAsar 恢复成 false，B 结束时又把自己
 * 保存的 true 写回去，最终 depth=0 但开关漏在 true（状态泄漏）。
 *
 * 这里改成**显式所有权令牌 + async 调用上下文继承**：
 *   - 只有令牌仍在有效集合中的调用，才被承认为「真嵌套」，可以直接复用当前窗口；
 *   - 从外部新发起的独立调用（异步上下文里没有有效令牌）一律排队；
 *   - 令牌在窗口退出时立即失效，已结束上下文里延迟触发的任务不会复用旧窗口。
 */
const activeTokens = new Set<symbol>();

/**
 * 同步的「窗口所有权」上下文（AsyncLocalStorage）。
 *
 * Node 的 AsyncLocalStorage 会随异步调用链自动传播：`insideWindow` 里 await 出去的
 * 后续微任务仍能读到本窗口的令牌，而从外部新发起的任务读到的是空（它有自己的
 * store，值为 undefined）。这正是「真嵌套」与「错峰并发」的判据。
 *
 * 用 require 而不是顶层 import：本模块在 Electron 主进程与 Node worker 里都被加载，
 * 顶层 import 会把加载时机提前到打包/入口初始化阶段，而这里只需要一个模块级单例。
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AsyncLocalStorage } = require('node:async_hooks') as {
  AsyncLocalStorage: new () => { getStore(): symbol | undefined; run<T>(store: symbol, fn: () => T): T };
};
const ownershipStore = new AsyncLocalStorage();

/** 取当前异步调用上下文里的有效令牌；已失效的一律丢弃 */
function currentOwnershipToken(): symbol | null {
  const token = ownershipStore.getStore();
  if (!token || !activeTokens.has(token)) return null;
  return token;
}

/** 供测试观察：当前有效窗口令牌数 */
export function archiveIoActiveWindows(): number {
  return activeTokens.size;
}

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
  reuseExistingWindow: boolean,
): Promise<T> {
  lastLabel = label;

  // 真嵌套：复用外层窗口，不碰进程开关（也就不会按各自完成顺序覆盖全局原值）。
  // 进入前先确认当前确实处在一个有效窗口里；允许浅嵌套时在本层开窗（见下）。
  if (reuseExistingWindow && (currentOwnershipToken() || depth > 0)) {
    const owner = currentOwnershipToken();
    depth += 1;
    try {
      return await fn();
    } finally {
      depth -= 1;
      // owner 为 null 说明本层是自己在 depth>0 时开的窗，退出时还原自己保存的值
      if (owner === null && toggleNoAsar) setNoAsar(false);
    }
  }

  if (!toggleNoAsar) {
    // 普通 Node 路径：不碰进程开关，但同样按上下文建立窗口所有权，
    // 使「已在窗口内的嵌套调用」与「外部独立调用」保持一致的排队语义。
    if (depth > 0) {
      depth += 1;
      try {
        return await fn();
      } finally {
        depth -= 1;
      }
    }
    const token = Symbol('archive-window');
    activeTokens.add(token);
    depth += 1;
    try {
      return await ownershipStore.run(token, fn);
    } finally {
      depth -= 1;
      activeTokens.delete(token);
    }
  }

  const prev = getNoAsar();
  const token = Symbol('archive-window');
  activeTokens.add(token);
  depth += 1;
  setNoAsar(true);
  try {
    return await ownershipStore.run(token, fn);
  } finally {
    depth -= 1;
    // 令牌先失效再还原开关：窗口已结束，期间延迟触发的任务不得再复用本窗口
    activeTokens.delete(token);
    setNoAsar(prev);
  }}

/**
 * 跑一段物理归档操作。Electron 下临时关闭 asar 解释，其余环境直通。
 * 并发的调用会排队，避免进程级开关被交叉改写。
 */
export function withArchiveIo<T>(label: string, fn: () => T | Promise<T>): Promise<T> {
  return withArchiveIoIn(label, fn, { toggleNoAsar: Boolean(process.versions?.electron) });
}

/**
 * 显式指定是否切换 noAsar 的版本（供测试驱动状态机）。
 *
 * `allowShallowNesting`：仅给「先 `archiveIoDepth()` 再调用」的历史测试形态留的口子
 * （没有异步上下文的浅嵌套）。生产封装一律不传，独立调用必须排队。
 */
export function withArchiveIoIn<T>(
  label: string,
  fn: () => T | Promise<T>,
  opts: { toggleNoAsar: boolean; allowShallowNesting?: boolean },
): Promise<T> {
  // 真嵌套的判据是「当前异步调用上下文里持有有效窗口令牌」。
  // 独立的错峰并发（A 还在 await、B 才从外部进来）拿不到令牌，因此必须排队——
  // 旧实现只看 depth>0，会把 B 误判成嵌套，最终把 noAsar 漏在打开状态。
  const ownThisWindow = currentOwnershipToken() !== null;
  const shallowNested = !ownThisWindow && opts.allowShallowNesting === true && depth > 0;

  if (ownThisWindow || shallowNested) {
    // 真嵌套（或调用方显式允许的浅嵌套）：在当前窗口里执行，
    // 否则内层会等外层释放、外层又在等内层返回 —— 互相等死。
    return insideWindow(label, fn, opts.toggleNoAsar, true);
  }

  const next = queue.then(() => insideWindow(label, fn, opts.toggleNoAsar, false));
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
