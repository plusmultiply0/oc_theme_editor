/**
 * 物理文件系统访问层（R1）。
 *
 * 背景（P0 审查 R1，已在真机复现）：
 * Electron 主进程里的 `require('fs')` 被包装过，**路径中出现 `.asar`** 的会被当成虚拟目录：
 *   - `fs.statSync('…/resources/app.asar').isFile` → false
 *   - `.size` → 0
 * 于是同一份用户安装在 Node 下识别正常，跑到 Electron 里就变成「该目录没有可识别的应用归档」，
 * 界面随之禁用「应用」。这不是版本不支持，纯粹是 I/O 语义用错了层。
 *
 * 约定：
 * - 所有涉及**应用归档**的真实读写（识别 / stat / hash / 备份 / 复制 / 替换 / 恢复）
 *   一律走本模块导出的 `physicalFs` / `physicalFsp`。
 * - Electron 下使用官方提供的 `original-fs`（未包装实现）；Node（测试、CLI、构建）下
 *   就是标准的 `node:fs`。两边行为一致，不需要为测试写两套分支。
 * - 不设置全局 `process.noAsar`：本工具的自身模块也在归档里，关掉 asar 会破坏模块加载。
 *   确实需要临时切换的场景（无法注入 fs 的第三方归档库）走 `withArchiveIo`，见 archive-io.ts。
 */
import crypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodeFsp from 'node:fs/promises';
import type { BigIntStats, PathLike, Stats } from 'node:fs';

export type PhysicalFsSource = 'original-fs' | 'node:fs';

interface OriginalFsModule {
  promises?: unknown;
}

let cachedSource: PhysicalFsSource | null = null;

export function isElectronRuntime(): boolean {
  return Boolean(process.versions?.electron);
}

/**
 * 取未包装的 fs。只有 Electron 运行时才存在 `original-fs`（Node 下 require 会抛
 * MODULE_NOT_FOUND），因此这里用运行时 require 而不是静态 import：
 * 静态 import 会让测试环境直接加载失败。
 */
function loadOriginalFs(): { fs: typeof nodeFs; fsp: typeof nodeFsp } | null {
  if (!isElectronRuntime()) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('original-fs') as OriginalFsModule;
    const fsp = (mod as { promises?: typeof nodeFsp }).promises;
    if (!fsp || typeof fsp.stat !== 'function') {
      // 拿不到 promises 变体就宁可显式失败，不用被包装的那份偷偷顶替
      return null;
    }
    return { fs: mod as typeof nodeFs, fsp };
  } catch {
    return null;
  }
}

const original = loadOriginalFs();

export const physicalFs: typeof nodeFs = original ? original.fs : nodeFs;
export const physicalFsp: typeof nodeFsp = original ? original.fsp : nodeFsp;

export function physicalFsSource(): PhysicalFsSource {
  if (cachedSource === null) cachedSource = original ? 'original-fs' : 'node:fs';
  return cachedSource;
}

/** Electron 运行时却拿不到 original-fs：说明物理 I/O 会退化成虚拟语义，必须显式报错而不是误判 */
export function physicalFsIsTrustworthy(): boolean {
  return !isElectronRuntime() || Boolean(original);
}

// ---------- 常用只读操作的窄接口（便于测试替换与阅读） ----------

/** 真实物理文件判断：Electron 包装 fs 下对 `.asar` 会错判为目录，这里必须走物理层 */
export async function physicalIsFile(p: PathLike): Promise<boolean> {
  try {
    return (await physicalFsp.stat(p)).isFile();
  } catch {
    return false;
  }
}

export async function physicalIsDir(p: PathLike): Promise<boolean> {
  try {
    return (await physicalFsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function physicalStat(p: PathLike): Promise<Stats> {
  return physicalFsp.stat(p);
}

export function physicalStatSync(p: PathLike): Stats {
  return physicalFs.statSync(p);
}

export function physicalStatSyncBigInt(p: PathLike): BigIntStats {
  return physicalFs.statSync(p, { bigint: true }) as BigIntStats;
}

/** 分块流式 SHA256，避免把 150MB 级归档整体读进内存 */
export async function physicalSha256File(file: PathLike): Promise<string> {
  const h = crypto.createHash('sha256');
  const handle = await physicalFsp.open(file, 'r');
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      h.update(chunk.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return h.digest('hex');
}

export function physicalSha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
