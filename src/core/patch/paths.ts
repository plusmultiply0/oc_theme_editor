/**
 * 路径安全与规范化（T30）。
 *
 * - 一律 canonicalize 后再使用，处理大小写、junction 与 symlink。
 * - 任何来自 manifest / 用户输入的路径都必须先过包含性检查，拒绝越界。
 */
import path from 'node:path';
import { fail, ok, type Result } from '../../shared/errors';
import { physicalFsp } from './physical-fs';

/** 判断字符串中是否含控制字符，避免使用带控制字符的正则字面量 */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** 解析真实绝对路径；不存在或无法解析时返回 TARGET_NOT_FOUND */
export async function canonicalize(p: string): Promise<Result<string>> {
  const abs = path.resolve(p);
  try {
    return ok(await physicalFsp.realpath(abs));
  } catch (e) {
    return fail(
      'TARGET_NOT_FOUND',
      '路径不存在或无法解析',
      '请确认安装目录仍然存在，或手动选择正确目录。',
      String(e),
    );
  }
}

/** child 是否严格位于 parent 之内（同目录不算「之内」） */
export function isContained(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 把不可信的相对片段安全地拼到根目录内。
 * 拒绝绝对路径、盘符、`..` 越界与控制字符。
 */
export function safeJoin(root: string, ...segments: string[]): Result<string> {
  for (const seg of segments) {
    if (!seg || seg.trim() === '') {
      return fail('INVALID_PARAMS', '路径片段为空', '请检查配置中的路径字段。');
    }
    if (hasControlChar(seg)) {
      return fail('INVALID_PARAMS', '路径包含非法控制字符', '请检查配置中的路径字段。');
    }
    if (path.isAbsolute(seg) || /^[a-zA-Z]:/.test(seg)) {
      return fail('INVALID_PARAMS', '路径片段不允许为绝对路径', '请检查配置中的路径字段。');
    }
  }
  const joined = path.resolve(root, ...segments);
  if (!isContained(path.resolve(root), joined)) {
    return fail('INVALID_PARAMS', '路径越界，已拒绝', '请检查配置中的路径字段。');
  }
  return ok(joined);
}

/**
 * 归档内条目名安全校验（T35 归档炸弹与路径穿越防护的前置）。
 * 允许嵌套，但不允许 `..`、盘符、前导斜杠、反斜杠分隔与控制字符。
 */
export function isSafeArchiveEntry(entry: string): boolean {
  if (!entry || entry.trim() === '') return false;
  if (hasControlChar(entry)) return false;
  if (entry.includes('\\')) return false;
  if (entry.startsWith('/') || /^[a-zA-Z]:/.test(entry)) return false;
  const parts = entry.split('/');
  return parts.every((p) => p !== '' && p !== '.' && p !== '..');
}

/** 安装实例 ID：由 canonical 路径派生，用于隔离备份与锁，不含用户主目录语义 */
export function instanceIdFromPath(installPath: string): string {
  return fnv1aPair(installPath.toLowerCase());
}

/** 仅用于目录命名的稳定哈希，非安全用途 */
function fnv1aPair(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (h2 + c * (i + 1)) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}
