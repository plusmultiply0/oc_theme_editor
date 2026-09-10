/**
 * 恢复（T41）。
 *
 * 两个入口：恢复上一主题 / 恢复原版。
 * 恢复是一次新的前向操作，不改写历史记录；还原前同样先备份当前状态。
 * 备份损坏、目标已升级、hash 不符、原版未知时一律拒绝，不做「尽力而为」的写入。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { adapterById } from '../../adapters/registry';
import type { TargetAdapter } from '../../adapters/types';
import { fail, ok, type Result } from '../../shared/errors';
import type { OperationManifest, TargetInfo } from '../../shared/schema';
import { readAsar, readAsarPackage, sha256File } from './asar';
import { preRestoreDir, type RuntimeLayout } from './layout';
import { latestBackup, verifyBackup, createBackup, type BackupRecord } from './backup';
import { commitStaged, type CommitHooks } from './commit';
import { withLock } from './lock';
import { appendPhase, writeTx, type TxRecord } from './txlog';
import type { ProcessProbe } from './precheck';

export type RestoreKind = 'previous' | 'original';

export interface RestoreInput {
  target: TargetInfo;
  layout: RuntimeLayout;
  kind: RestoreKind;
  probe?: ProcessProbe;
  hooks?: CommitHooks;
  now?: () => string;
}

export interface RestoreResult {
  manifest: OperationManifest;
  backup: BackupRecord;
}

function backupDirFor(layout: RuntimeLayout, kind: RestoreKind): string {
  return kind === 'original' ? `${layout.backupsDir}/original` : `${layout.backupsDir}/previous`;
}

export async function restoreTarget(input: RestoreInput): Promise<Result<RestoreResult>> {
  const adapter = adapterById(input.target.adapterId);
  if (!adapter) {
    return fail('TARGET_UNSUPPORTED', '适配规则不存在', '请重新检测目标。');
  }

  return withLock(input.layout.locks, input.layout.instanceId, async () => {
    const archivePath = archiveOf(input.target, adapter);
    const snapshot = await readAsar(archivePath);
    if (!snapshot.success) return snapshot;

    // 目标升级后拒绝恢复：备份与当前版本不匹配，写回去只会制造更糟的状态
    const pkg = await readAsarPackage(snapshot.data);
    if (!pkg.success) return pkg;
    if ((pkg.data.version ?? '') !== input.target.version) {
      return fail(
        'TARGET_VERSION_MISMATCH',
        `目标版本已变化（记录 ${input.target.version}，当前 ${pkg.data.version ?? '未知'}）`,
        '请先重新检测目标并重新应用主题，再考虑恢复。',
      );
    }

    const dir = backupDirFor(input.layout, input.kind);
    const record = await latestBackup(dir);
    if (!record) {
      return fail(
        'BACKUP_MISSING',
        input.kind === 'original' ? '没有可用的原版备份' : '没有可恢复的上一主题',
        input.kind === 'original'
          ? '原版备份只在本工具首次接管时创建；未创建过则无法恢复原版。'
          : '请先应用一次主题，之后才能恢复上一主题。',
      );
    }
    if (input.kind === 'original' && !record.pristine) {
      return fail(
        'BACKUP_MISSING',
        '无法确认为原版，恢复原版已禁用',
        '本工具首次接管该安装时它已被改动过，因此不能保证这份备份是出厂原版。',
      );
    }

    const verified = await verifyBackup(record);
    if (!verified.success) return verified;

    // 还原前同样备份当前状态，避免恢复失败把用户推到更糟的状态
    const currentHash = snapshot.data.sha256;
    const pre = await createBackup({
      archivePath,
      dir: preRestoreDir(input.layout),
      kind: 'pre-restore',
      version: pkg.data.version ?? '',
      expectedHash: currentHash,
      note: '恢复操作执行前的现场备份',
    });
    if (!pre.success) return pre;

    const operationId = newOpId(input.now);
    const base: TxRecord = {
      schema: 1,
      operationId,
      targetId: input.target.targetId,
      version: input.target.version,
      adapterId: input.target.adapterId,
      beforeHash: currentHash,
      afterHash: record.sha256,
      backupHash: pre.data.sha256,
      backupPath: pre.data.file,
      themeSummary: input.kind === 'original' ? '恢复原版' : '恢复上一主题',
      status: 'backed_up',
      createdAt: new Date().toISOString(),
      kind: input.kind === 'original' ? 'restore-original' : 'restore-previous',
      backupKind: 'pre-restore',
      phases: [{ phase: 'backed_up', at: new Date().toISOString() }],
      targetPath: archivePath,
    };
    const wrote = await writeTx(input.layout.txDir, base);
    if (!wrote.success) return wrote;

    const committing = await appendPhase(input.layout.txDir, base, 'committing');
    if (!committing.success) return committing;

    const committed = await commitStaged({
      targetPath: archivePath,
      stagedPath: record.file,
      expectedBeforeHash: currentHash,
      expectedAfterHash: record.sha256,
      ...(input.hooks ? { hooks: input.hooks } : {}),
    });
    if (!committed.success) {
      const st = committed.error.code === 'NEEDS_RECOVERY' ? 'needs_recovery' : 'failed';
      await appendPhase(input.layout.txDir, committing.data, st, committed.error.message);
      return committed;
    }

    const done = await appendPhase(input.layout.txDir, committing.data, 'applied');
    if (!done.success) return done;

    // 恢复完成后清掉「上一主题」记录，避免把刚还原的状态又当作可回退项
    if (input.kind === 'previous') {
      await fs.rm(record.file, { force: true });
    }

    return ok({ manifest: stripTx(done.data), backup: pre.data });
  });
}

/** adapter 中资源布局用正斜杠声明，这里按当前平台拼成真实路径 */
export function archiveOf(target: TargetInfo, adapter: TargetAdapter): string {
  return path.join(target.installPath, ...adapter.layout.archive.split('/'));
}

export async function currentArchiveHash(target: TargetInfo, adapter: TargetAdapter): Promise<string> {
  return sha256File(archiveOf(target, adapter));
}

export function newOpId(now?: () => string): string {
  const d = now ? now() : new Date().toISOString();
  return `op-${d.replace(/[^0-9A-Za-z]/g, '')}-${Math.random().toString(36).slice(2, 8)}`;
}

function stripTx(rec: TxRecord): OperationManifest {
  const { phases: _phases, targetPath: _targetPath, ...rest } = rec;
  return rest;
}
