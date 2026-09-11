/**
 * 启动恢复服务（R7）。
 *
 * 之前 `scanPending` 有函数、有测试，但在 src 里找不到任何调用点——
 * 恢复检测从来不跑，等于没有。本服务把扫描、状态展示、
 * 「必须人工处理」的阻断，以及落账动作都接到主进程启动流程上。
 *
 * 三条硬规则：
 * - 状态不明（既不是操作前也不是操作后）只提示，不自动覆盖；
 * - 落账方向由**磁盘事实**决定，不允许把 needs_recovery 悄悄写成 applied；
 * - 有待人工处理的事务时，阻止对该实例继续 apply。
 */
import path from 'node:path';
import { fail, ok, type Result } from '../../shared/errors';
import type {
  PendingRecoveryItem,
  RecoveryAction,
  RecoveryState,
  RecoveryStatus,
} from '../../shared/ipc';
import {
  scanAllPending,
  finalizePending,
  cleanAllStages,
  type InstanceRecoveryScan,
  type PendingTransaction,
} from '../../core/patch/recovery';
import { physicalFsp } from '../../core/patch/physical-fs';

const ACTION_LABEL: Record<RecoveryAction, string> = {
  'mark-applied': '标记为已应用（目标内容已是本次操作的结果）',
  'mark-failed': '标记为未生效（目标仍是操作前的状态）',
  acknowledge: '知悉并保持待处理（不做任何自动改写）',
};

function actionsFor(state: RecoveryState): RecoveryAction[] {
  if (state === 'applied') return ['mark-applied', 'acknowledge'];
  if (state === 'unchanged') return ['mark-failed', 'acknowledge'];
  return ['acknowledge'];
}

function toItem(instanceId: string, p: PendingTransaction): PendingRecoveryItem {
  return {
    operationId: p.record.operationId,
    instanceId,
    state: p.state,
    advice: p.advice,
    themeSummary: p.record.themeSummary,
    status: p.record.status,
    createdAt: p.record.createdAt,
    targetPath: p.record.targetPath,
    blocking: p.state === 'needs_recovery',
    actions: actionsFor(p.state),
  };
}

export class RecoveryService {
  private scans: InstanceRecoveryScan[] = [];
  private stagesCleaned = 0;

  constructor(private readonly opts: { runtimeRoot: string }) {}

  /** 启动时调用：清理残留准备区 + 扫描所有实例的未完成事务 */
  async bootstrap(): Promise<RecoveryStatus> {
    this.stagesCleaned = await cleanAllStages(this.opts.runtimeRoot);
    return this.scan();
  }

  async scan(): Promise<RecoveryStatus> {
    this.scans = await scanAllPending(this.opts.runtimeRoot);
    const items = this.scans.flatMap((s) => s.pending.map((p) => toItem(s.instanceId, p)));
    const blockingCount = items.filter((i) => i.blocking).length;
    return { items, blockingCount, stagesCleaned: this.stagesCleaned };
  }

  status(): RecoveryStatus {
    const items = this.scans.flatMap((s) => s.pending.map((p) => toItem(s.instanceId, p)));
    return {
      items,
      blockingCount: items.filter((i) => i.blocking).length,
      stagesCleaned: this.stagesCleaned,
    };
  }

  /** 供 OperationService 使用的闸门：有待人工处理的事务就不许继续写 */
  async assertClear(): Promise<Result<void>> {
    const s = await this.scan();
    if (s.blockingCount === 0) return ok(undefined);
    const first = s.items.find((i) => i.blocking);
    return fail(
      'NEEDS_RECOVERY',
      `存在待处理的未完成事务（${first?.operationId ?? '未知'}）`,
      '上次写入没有正常结束，目标可能处于中间状态。请先在「待恢复」面板确认处理，再重新应用。',
      first ? `${first.targetPath} · ${first.status}` : undefined,
    );
  }

  /** 落账：只允许落到与磁盘事实一致的终态 */
  async resolve(input: { operationId?: string; action?: string }): Promise<Result<RecoveryStatus>> {
    const operationId = input?.operationId;
    const action = input?.action as RecoveryAction | undefined;
    if (!operationId || !action || !(action in ACTION_LABEL)) {
      return fail('INVALID_PARAMS', '恢复动作参数不合法', '请刷新后重试。');
    }

    const scanned = await scanAllPending(this.opts.runtimeRoot);
    const hit = scanned
      .flatMap((s) => s.pending.map((p) => ({ txDir: s.txDir, pending: p })))
      .find((x) => x.pending.record.operationId === operationId);
    if (!hit) {
      return fail('MANIFEST_CORRUPT', '未找到该未完成事务', '它可能已被处理；请刷新。');
    }

    const { state, record } = hit.pending;
    if (action === 'mark-applied' && state !== 'applied') {
      return fail(
        'INVALID_PARAMS',
        '目标内容与「已应用」不符，不能这样标记',
        '磁盘上的内容既不是本次操作的结果，也不是操作前状态；请使用恢复入口处理。',
      );
    }
    if (action === 'mark-failed' && state !== 'unchanged') {
      return fail(
        'INVALID_PARAMS',
        '目标内容与「未生效」不符，不能这样标记',
        '磁盘上的内容不是操作前状态；请使用恢复入口处理。',
      );
    }

    const target =
      action === 'mark-applied'
        ? 'applied'
        : action === 'mark-failed'
          ? 'failed'
          : 'needs_recovery';

    const r = await finalizePending(
      hit.txDir,
      record,
      target,
      action === 'acknowledge' ? '用户已确认并保持待处理' : '由启动恢复面板落账',
    );
    if (!r.success) return r;
    return ok(await this.scan());
  }

  /** 只读提示：待处理事务涉及的归档是否仍存在，供诊断 */
  async describeTargets(): Promise<string[]> {
    const out: string[] = [];
    for (const s of this.scans) {
      for (const p of s.pending) {
        const exists = await physicalFsp
          .stat(p.record.targetPath)
          .then(() => true)
          .catch(() => false);
        out.push(`${path.basename(p.record.targetPath)} ${exists ? '存在' : '不存在'}`);
      }
    }
    return out;
  }
}
