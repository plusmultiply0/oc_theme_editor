/**
 * 应用流程编排（T34–T39、T42）。
 *
 * 状态推进：inspected → staged → backed_up → committing → applied
 * 任一步失败都落账：提交前 failed，提交后按磁盘事实判 rolled_back / needs_recovery。
 *
 * 安全约束：
 * - 未经验证的目标（support !== 'supported'）一律拒绝应用。
 * - 不修改可执行文件、不改安全开关、不强制结束进程。
 * - 重复应用同一主题直接返回已应用，不重复写盘。
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { adapterById } from '../../adapters/registry';
import type { TargetAdapter } from '../../adapters/types';
import { fail, ok, type Result } from '../../shared/errors';
import type { OperationEvent, OperationManifest, TargetInfo } from '../../shared/schema';
import { readAsar, readAsarText } from './asar';
import { physicalFsp } from './physical-fs';
import { ensureDirs, originalDir, previousDir, runtimeDirs, type RuntimeLayout } from './layout';
import { ensureOriginalBackup, createBackup } from './backup';
import { assessOriginalEvidence } from './original-evidence';
import { stageChanges, type StageResult } from './stage';
import { commitStaged, type CommitHooks } from './commit';
import { withLock } from './lock';
import { appendPhase, listTx, writeTx, type TxRecord } from './txlog';
import { precheckTarget, type ProcessProbe } from './precheck';
import { instanceIdFromPath } from './paths';
import { newOpId } from './restore';

export interface ApplyHooks {
  /** 覆盖可用磁盘字节数，用于注入「磁盘不足」 */
  freeBytes?(): Promise<number>;
  /** 覆盖进程探针结果 */
  probe?: ProcessProbe;
  /** 进入 stage 前抛错，模拟 stage 失败 */
  failBeforeStage?(): Promise<void>;
  /** stage 完成后破坏 staged 产物，模拟产物与记录不符 */
  corruptStaged?(stagedPath: string): Promise<void>;
  /** 备份复制后破坏备份内容，模拟备份 hash 校验失败 */
  corruptBackup?: boolean;
  /** 提交阶段钩子 */
  commit?: CommitHooks;
  /** 写入事务日志失败 */
  failLogWrite?: boolean;
}

export interface ApplyInput {
  target: TargetInfo;
  runtimeRoot: string;
  css: string;
  imageBytes: Buffer;
  themeSummary: string;
  /** 主题内容指纹；不传则由 css + 图片计算 */
  themeHash?: string;
  onEvent?: (e: OperationEvent) => void;
  hooks?: ApplyHooks;
  now?: () => string;
}

export interface ApplyResult {
  manifest: OperationManifest;
  staged: StageResult;
  /** 重复应用时为 true，此时没有产生任何写入 */
  noop: boolean;
}

export function computeThemeHash(css: string, imageBytes: Buffer): string {
  return crypto
    .createHash('sha256')
    .update(css, 'utf8')
    .update(imageBytes)
    .digest('hex');
}

export async function applyTheme(input: ApplyInput): Promise<Result<ApplyResult>> {
  const adapter = adapterById(input.target.adapterId);
  if (!adapter) {
    return fail('TARGET_UNSUPPORTED', '适配规则不存在', '请重新检测目标。');
  }
  if (input.target.support !== 'supported') {
    return fail(
      'TARGET_UNSUPPORTED',
      input.target.rejectReason ?? '该目标未经验证',
      '未验证的目标只允许预览，不允许应用。',
    );
  }

  const instanceId = instanceIdFromPath(input.target.installPath);
  const layout: RuntimeLayout = runtimeDirs(input.runtimeRoot, instanceId);
  await ensureDirs(layout);

  return withLock(layout.locks, instanceId, async () => {
    return runApply(input, adapter, layout);
  });
}

async function runApply(
  input: ApplyInput,
  adapter: TargetAdapter,
  layout: RuntimeLayout,
): Promise<Result<ApplyResult>> {
  const emit = (phase: string, message: string, percent?: number) =>
    input.onEvent?.({
      operationId: 'pending',
      phase,
      message,
      ...(percent === undefined ? {} : { percent }),
    });

  const archivePath = path.join(input.target.installPath, ...adapter.layout.archive.split('/'));
  const exePath = path.join(input.target.installPath, ...adapter.layout.exe.split('/'));

  const snapshot = await readAsar(archivePath);
  if (!snapshot.success) return snapshot;
  const beforeHash = snapshot.data.sha256;

  // T42：重复应用同一主题且不重复写盘
  const themeHash = input.themeHash ?? computeThemeHash(input.css, input.imageBytes);
  const lastApplied = await latestApplied(layout);
  if (
    lastApplied &&
    lastApplied.themeHash === themeHash &&
    lastApplied.afterHash === beforeHash
  ) {
    return ok({
      manifest: lastApplied,
      staged: {
        stagedArchive: '',
        afterHash: beforeHash,
        added: [],
        changed: [],
        removed: [],
        unpackedPreserved: true,
        fileCount: 0,
        themeLayers: { removedLegacy: [], keptAssets: [], selfPresent: true },
      },
      noop: true,
    });
  }

  // T32、T33：进程、写权限、磁盘
  const pre = await precheckTarget(
    input.target,
    {
      ...(input.hooks?.probe ? { probe: input.hooks.probe } : {}),
      archiveSize: snapshot.data.size,
    },
  );
  if (!pre.success) return pre;
  if (input.hooks?.freeBytes) {
    const free = await input.hooks.freeBytes();
    if (free < pre.data.requiredBytes) {
      return fail(
        'DISK_FULL',
        `磁盘空间不足：需要约 ${(pre.data.requiredBytes / 1024 / 1024).toFixed(0)} MB`,
        '请清理磁盘后重试；空间不足时不会开始写入。',
      );
    }
  }

  const operationId = newOpId(input.now);
  emit('inspected', '已确认目标版本与资源', 5);

  const workDir = path.join(layout.stageDir, operationId);

  if (input.hooks?.failBeforeStage) {
    try {
      await input.hooks.failBeforeStage();
    } catch (e) {
      return fail('STAGE_FAILED', '准备区生成失败', '安装未被修改；请重试。', String(e));
    }
  }

  emit('staged', '正在生成准备区资源', 20);
  const staged = await stageChanges({
    adapter,
    archivePath,
    workDir,
    css: input.css,
    imageBytes: input.imageBytes,
  });
  if (!staged.success) {
    return fail(staged.error.code, staged.error.message, staged.error.recoveryHint, staged.error.detail);
  }

  if (input.hooks?.corruptStaged) {
    await input.hooks.corruptStaged(staged.data.stagedArchive);
  }

  let record: TxRecord = {
    schema: 1,
    operationId,
    targetId: input.target.targetId,
    version: input.target.version,
    adapterId: adapter.id,
    beforeHash,
    afterHash: staged.data.afterHash,
    backupHash: '',
    backupPath: '',
    themeSummary: input.themeSummary,
    status: 'inspected',
    createdAt: new Date().toISOString(),
    kind: 'apply',
    themeHash,
    phases: [{ phase: 'inspected', at: new Date().toISOString() }],
    targetPath: archivePath,
  };
  void exePath;

  const wrote0 = await writeTx(layout.txDir, record);
  if (!wrote0.success) return wrote0;

  const toStaged = await appendPhase(layout.txDir, record, 'staged');
  if (!toStaged.success) return toStaged;
  record = toStaged.data;
  emit('staged', '准备区校验通过', 40);

  // T36 / R2：先保住「首次接管快照」语义，再备份上一主题。
  // 是否原版由证据判定，不再靠「看不到本工具标记」反推。
  const htmlText = await readAsarText(snapshot.data, adapter.injection.htmlEntry);
  const assessment = await assessOriginalEvidence({
    version: input.target.version,
    sha256: beforeHash,
    html: htmlText.success ? htmlText.data : '',
    adapter,
    readEntry: async (entry) => {
      const r = await readAsarText(snapshot.data, entry);
      return r.success ? r.data : null;
    },
  });

  const original = await ensureOriginalBackup(originalDir(layout), {
    archivePath,
    expectedHash: beforeHash,
    version: input.target.version,
    evidence: assessment.evidence,
    note: assessment.note,
  });
  if (!original.success) return original;

  const prev = await createBackup({
    archivePath,
    dir: previousDir(layout),
    kind: 'previous',
    version: input.target.version,
    expectedHash: beforeHash,
    ...(input.hooks?.corruptBackup ? { corruptAfterCopy: true } : {}),
  });
  if (!prev.success) {
    await appendPhase(layout.txDir, record, 'failed', prev.error.message);
    return prev;
  }
  await pruneBackups(previousDir(layout), 3);

  record = { ...record, backupHash: prev.data.sha256, backupPath: prev.data.file };
  const toBackedUp = await appendPhase(layout.txDir, record, 'backed_up');
  if (!toBackedUp.success) return toBackedUp;
  record = toBackedUp.data;
  emit('backed_up', '备份已完成并通过校验', 60);

  if (input.hooks?.failLogWrite) {
    return fail('STAGE_FAILED', '事务日志写入失败（注入）', '安装未被修改。');
  }

  const toCommitting = await appendPhase(layout.txDir, record, 'committing');
  if (!toCommitting.success) return toCommitting;
  record = toCommitting.data;
  emit('committing', '正在替换应用资源', 80);

  const committed = await commitStaged({
    targetPath: archivePath,
    stagedPath: staged.data.stagedArchive,
    expectedBeforeHash: beforeHash,
    expectedAfterHash: staged.data.afterHash,
    ...(input.hooks?.commit ? { hooks: input.hooks.commit } : {}),
  });

  if (!committed.success) {
    const st: 'failed' | 'needs_recovery' =
      committed.error.code === 'NEEDS_RECOVERY' ? 'needs_recovery' : 'failed';
    await appendPhase(layout.txDir, record, st, committed.error.message);
    return committed;
  }

  const done = await appendPhase(layout.txDir, record, 'applied');
  if (!done.success) {
    // 提交已成功但记账失败：不能盲目回滚，按磁盘事实停在 needs_recovery
    await appendPhase(layout.txDir, record, 'needs_recovery', '提交成功但日志写入失败').catch(
      () => undefined,
    );
    return fail(
      'NEEDS_RECOVERY',
      '主题已写入，但操作记录写入失败',
      '目标已是新主题；请使用恢复入口或重新应用以补齐记录，不要重复手动替换文件。',
    );
  }
  record = done.data;
  emit('applied', '应用完成，已通过 hash 复核', 100);

  await physicalFsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);

  const { phases: _p, targetPath: _t, ...manifest } = record;
  return ok({ manifest, staged: staged.data, noop: false });
}

async function latestApplied(layout: RuntimeLayout): Promise<TxRecord | undefined> {
  const all = await listTx(layout.txDir);
  const applied = all.filter((r) => r.status === 'applied' && r.kind !== 'restore-original');
  return applied.length ? applied[applied.length - 1] : undefined;
}

/** 只保留最近 N 份备份，避免 150MB 级归档无限堆积 */
async function pruneBackups(dir: string, keep: number): Promise<void> {
  try {
    const files = (await physicalFsp.readdir(dir))
      .filter((n) => n.endsWith('.asar'))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      await physicalFsp.rm(path.join(dir, f), { force: true });
    }
  } catch {
    // 清理失败不影响主流程
  }
}
