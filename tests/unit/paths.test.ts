import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalize, instanceIdFromPath, isContained, isSafeArchiveEntry, safeJoin } from '../../src/core/patch/paths';

describe('路径安全（T30）', () => {
  it('拒绝绝对路径片段', () => {
    const root = path.resolve('/');
    const r = safeJoin(root, 'C:\\Windows');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('INVALID_PARAMS');
  });

  it('拒绝 .. 越界', () => {
    const r = safeJoin('/a/b', '../c');
    expect(r.success).toBe(false);
  });

  it('拒绝空片段与控制字符', () => {
    expect(safeJoin('/a', '').success).toBe(false);
    expect(safeJoin('/a', 'x\u0000y').success).toBe(false);
  });

  it('合法片段拼接到根内', () => {
    const root = path.resolve('/a/b');
    const r = safeJoin(root, 'resources', 'app.asar');
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe(path.join(root, 'resources', 'app.asar'));
  });

  it('包含性判断：同目录不算之内，子目录算之内', () => {
    expect(isContained('/a', '/a')).toBe(false);
    expect(isContained('/a', '/a/b')).toBe(true);
    expect(isContained('/a', '/b')).toBe(false);
  });

  it('不存在的路径 canonicalize 失败', async () => {
    const r = await canonicalize(path.join('/definitely-not-exist', 'x'));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('TARGET_NOT_FOUND');
  });

  it('实例 ID 只依赖路径且与大小写无关', () => {
    const a = instanceIdFromPath('C:\\Program Files\\OpenCode');
    const b = instanceIdFromPath('c:\\program files\\opencode');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(instanceIdFromPath('D:\\other')).not.toBe(a);
  });
});

describe('归档条目名安全（T35）', () => {
  it.each(['out/renderer/index.html', 'a/b/c.css'])('接受 %s', (e) => {
    expect(isSafeArchiveEntry(e)).toBe(true);
  });

  it.each([
    '../evil.css',
    'a/../../evil.css',
    '/abs/evil.css',
    'C:/evil.css',
    'a\\b.css',
    '',
    'a//b.css',
    'a/./b.css',
    'evil\u0000.css',
  ])('拒绝 %s', (e) => {
    expect(isSafeArchiveEntry(e)).toBe(false);
  });
});
