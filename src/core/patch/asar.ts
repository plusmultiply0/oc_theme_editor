/**
 * ASAR 只读访问（T31、T36、T39 的指纹来源）。
 *
 * 只做读取与校验，不做写入；写入与打包在 patch 阶段单独处理。
 * 使用已纳入依赖的 @electron/asar（MIT），不依赖任何作者本机脚本。
 *
 * R1 修正：Electron 主进程的 `fs` 被包装过，会把 `app.asar` 当虚拟目录
 * （isFile=false / size=0）。因此本文件的 stat 与 hash 一律走 physical-fs，
 * 归档库调用统一从 archive-io 出去（Electron 下临时关闭 asar 解释）。
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { fail, ok, type Result } from '../../shared/errors';
import { physicalSha256File, physicalStat, physicalFsIsTrustworthy } from './physical-fs';
import { readRawHeader, readArchiveEntrySync, uncacheArchive } from './archive-io';

export interface AsarSnapshot {
  archivePath: string;
  /** 归档头的根目录节点 */
  header: Record<string, unknown>;
  size: number;
  sha256: string;
}

export function sha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 物理文件指纹：Electron 下必须绕过 fs 包装，否则读到的是虚拟目录（size=0） */
export async function sha256File(file: string): Promise<string> {
  return physicalSha256File(file);
}

/** 读取归档头与整体指纹；每次都先 uncache，避免读到进程内缓存的旧头 */
export async function readAsar(archivePath: string): Promise<Result<AsarSnapshot>> {
  if (!physicalFsIsTrustworthy()) {
    return fail(
      'RUNTIME_IO_UNAVAILABLE',
      '当前运行时无法按物理文件读取应用归档',
      '这是工具自身的运行环境问题（Electron 未提供 original-fs）；请改用随包发布的版本，不要据此判断安装不受支持。',
    );
  }

  let size = 0;
  try {
    const st = await physicalStat(archivePath);
    if (!st.isFile()) {
      return fail('TARGET_NOT_FOUND', '应用归档不是文件', '请重新选择安装目录。');
    }
    size = st.size;
  } catch (e) {
    return fail('TARGET_NOT_FOUND', '未找到应用归档', '请确认安装目录完整。', String(e));
  }

  uncacheArchive(archivePath);
  let header: Record<string, unknown>;
  try {
    // getRawHeader 返回 { headerString, header, ... }；不同版本字段层级不同，这里兼容两种
    const raw = await readRawHeader(archivePath);
    const nested = raw && typeof raw === 'object' ? (raw.header as Record<string, unknown>) : undefined;
    const candidate =
      raw && typeof raw.files === 'object'
        ? raw
        : nested && typeof nested.files === 'object'
          ? nested
          : undefined;
    if (!candidate) {
      return fail('TARGET_UNSUPPORTED', '应用归档结构异常', '该安装可能已被修改或不受支持。');
    }
    header = candidate;
  } catch (e) {
    return fail('TARGET_UNSUPPORTED', '应用归档无法解析', '该安装可能已被修改或不受支持。', String(e));
  }

  let sha256: string;
  try {
    sha256 = await physicalSha256File(archivePath);
  } catch (e) {
    return fail('TARGET_NOT_FOUND', '应用归档无法读取', '请确认应用已退出且文件未被占用。', String(e));
  }

  return ok({ archivePath, header, size, sha256 });
}

/** 扁平列出归档内所有文件条目（目录不列出） */
export function listAsarFiles(header: Record<string, unknown>, prefix = ''): string[] {
  const files = (header as { files?: Record<string, unknown> }).files ?? {};
  const out: string[] = [];
  for (const [name, node] of Object.entries(files)) {
    const entry = node as { files?: Record<string, unknown> };
    const rel = prefix ? `${prefix}/${name}` : name;
    if (entry.files) out.push(...listAsarFiles(entry as Record<string, unknown>, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * 归档内路径一律按平台分隔符传给 asar：
 * Windows 上它用 path.dirname/basename 逐级查找，正斜杠会被当成单个文件名。
 */
export function toArchivePath(entry: string): string {
  return entry.split('/').join(path.sep);
}

/** 读取归档内单个文件；不存在或读取失败都返回失败，不返回空 Buffer 冒充成功 */
export async function readAsarFile(snapshot: AsarSnapshot, entry: string): Promise<Result<Buffer>> {
  try {
    const buf = await readArchiveEntrySync(snapshot.archivePath, toArchivePath(entry));
    if (!buf) {
      return fail('TARGET_NOT_FOUND', `归档内缺少条目 ${entry}`, '该安装可能已被修改。');
    }
    return ok(buf);
  } catch (e) {
    return fail('TARGET_NOT_FOUND', `读取归档条目失败：${entry}`, '该安装可能已被修改。', String(e));
  }
}

/** 读取归档内的文本条目（HTML / CSS / JSON），解码失败按读取失败处理 */
export async function readAsarText(snapshot: AsarSnapshot, entry: string): Promise<Result<string>> {
  const buf = await readAsarFile(snapshot, entry);
  if (!buf.success) return buf;
  return ok(buf.data.toString('utf8'));
}

/** 读取归档的 package.json 并做基本形状校验 */
export async function readAsarPackage(
  snapshot: AsarSnapshot,
): Promise<Result<{ name?: string; version?: string }>> {
  const buf = await readAsarFile(snapshot, 'package.json');
  if (!buf.success) return buf;
  try {
    const parsed = JSON.parse(buf.data.toString('utf8')) as { name?: string; version?: string };
    return ok(parsed);
  } catch (e) {
    return fail('TARGET_UNSUPPORTED', '归档 package.json 无法解析', '该安装可能已损坏。', String(e));
  }
}
