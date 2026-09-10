/**
 * 提交（T37、T38、T39）。
 *
 * 提交顺序（明确、可补偿）：
 *   1. 再次核对目标 hash（防止准备期间被升级或其他工具改动）
 *   2. 把 staged 文件写到「目标同目录」的临时文件（同卷，保证 rename 是同卷移动）
 *   3. rename 覆盖目标 —— Windows 上同卷 rename 不会写出半截文件
 *   4. 复核目标 hash
 *
 * 第 3 步之前失败：删除临时文件，目标原封不动。
 * 第 3 步之后失败：目标已是新内容，必须按 hash 判定，标记 needs_recovery，不盲目回滚。
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { fail, ok, type Result } from '../../shared/errors';
import { sha256File } from './asar';

export interface CommitHooks {
  /** 在 hash 复核前改动目标，模拟「准备期间目标被升级/被其他进程改动」 */
  mutateBeforeVerify?(): Promise<void>;
  /** 在 rename 之前中断，模拟提交中断 */
  interruptBeforeRename?(): Promise<void>;
  /** rename 成功但复核前中断，模拟提交后异常 */
  interruptAfterRename?(): Promise<void>;
}

export interface CommitInput {
  targetPath: string;
  stagedPath: string;
  expectedBeforeHash: string;
  expectedAfterHash: string;
  hooks?: CommitHooks;
}

export interface CommitResult {
  beforeHash: string;
  afterHash: string;
  tempFile: string;
}

export async function commitStaged(input: CommitInput): Promise<Result<CommitResult>> {
  const { targetPath, stagedPath, expectedBeforeHash, expectedAfterHash } = input;

  if (input.hooks?.mutateBeforeVerify) {
    await input.hooks.mutateBeforeVerify();
  }

  let beforeHash: string;
  try {
    beforeHash = await sha256File(targetPath);
  } catch (e) {
    return fail('TARGET_HASH_MISMATCH', '提交前无法读取目标', '请确认应用已退出后重试。', String(e));
  }
  if (beforeHash !== expectedBeforeHash) {
    return fail(
      'TARGET_HASH_MISMATCH',
      '目标在准备期间发生了变化',
      '已中止，安装未被修改；请重新检测目标后再应用。',
      `expected=${expectedBeforeHash} actual=${beforeHash}`,
    );
  }

  const tempFile = `${targetPath}.ts-staged`;
  try {
    await fs.copyFile(stagedPath, tempFile);
    const stagedHash = await sha256File(tempFile);
    if (stagedHash !== expectedAfterHash) {
      await fs.rm(tempFile, { force: true });
      return fail(
        'STAGE_FAILED',
        '准备产物与记录不一致',
        '已中止，安装未被修改。',
        `expected=${expectedAfterHash} actual=${stagedHash}`,
      );
    }
  } catch (e) {
    await fs.rm(tempFile, { force: true }).catch(() => undefined);
    const code = (e as NodeJS.ErrnoException).code;
    return fail(
      code === 'ENOSPC' ? 'DISK_FULL' : 'STAGE_FAILED',
      code === 'ENOSPC' ? '磁盘空间不足，写入临时文件失败' : '写入临时文件失败',
      '已中止，安装未被修改。',
      String(e),
    );
  }

  if (input.hooks?.interruptBeforeRename) {
    await fs.rm(tempFile, { force: true }).catch(() => undefined);
    try {
      await input.hooks.interruptBeforeRename();
    } catch (e) {
      return fail('STAGE_FAILED', '提交被中断', '安装未被修改。', String(e));
    }
    return fail('STAGE_FAILED', '提交被中断', '安装未被修改。');
  }

  try {
    await fs.rename(tempFile, targetPath);
  } catch (e) {
    await fs.rm(tempFile, { force: true }).catch(() => undefined);
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
      return fail('FILE_LOCKED', '目标文件被占用，替换失败', '请确认应用已退出后重试；安装未被修改。', String(e));
    }
    return fail('STAGE_FAILED', '替换目标文件失败', '安装未被修改。', String(e));
  }

  if (input.hooks?.interruptAfterRename) {
    try {
      await input.hooks.interruptAfterRename();
    } catch {
      // 落到 needs_recovery
    }
    return fail('NEEDS_RECOVERY', '提交后未能完成复核', '目标可能已是新版本，请通过恢复入口处理。');
  }

  let afterHash: string;
  try {
    afterHash = await sha256File(targetPath);
  } catch (e) {
    return fail('NEEDS_RECOVERY', '提交后无法读取目标', '请通过恢复入口处理。', String(e));
  }
  if (afterHash !== expectedAfterHash) {
    return fail(
      'NEEDS_RECOVERY',
      '提交后目标 hash 与预期不符',
      '请通过恢复入口处理；不要重复应用。',
      `expected=${expectedAfterHash} actual=${afterHash}`,
    );
  }

  return ok({ beforeHash, afterHash, tempFile: path.basename(tempFile) });
}
