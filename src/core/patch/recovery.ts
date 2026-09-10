/**
 * 启动恢复扫描（T40）。
 *
 * 只检查本工具自己记录过的目标；不认识的目标不碰。
 * 状态判定只看可证明的磁盘事实：
 * - 当前 hash == afterHash  → 其实已经应用成功，只是没记账
 * - 当前 hash == beforeHash → 什么都没写成，安全
 * - 两者都不是            → needs_recovery，停在原地等人处理，绝不自动用旧版覆盖
 */
import fs from 'node:fs/promises';
import { sha256File } from './asar';
import { isPending, listTx, appendPhase, type TxRecord } from './txlog';
import type { OperationStatus } from '../../shared/schema';

export type RecoveryState = 'applied' | 'unchanged' | 'needs_recovery';

export interface PendingTransaction {
  record: TxRecord;
  state: RecoveryState;
  currentHash: string | null;
  advice: string;
}

const ADVICE: Record<RecoveryState, string> = {
  applied: '目标内容已是本次操作的结果，可安全标记为已应用。',
  unchanged: '目标仍是操作前的状态，本次没有产生改动，可安全重试或忽略。',
  needs_recovery: '目标既不是操作前也不是操作后的状态，请勿重复应用；请使用恢复入口处理。',
};

export async function scanPending(txDir: string): Promise<PendingTransaction[]> {
  const all = await listTx(txDir);
  const out: PendingTransaction[] = [];

  for (const record of all) {
    if (!isPending(record.status)) continue;
    let currentHash: string | null = null;
    try {
      currentHash = await sha256File(record.targetPath);
    } catch {
      currentHash = null;
    }
    const state: RecoveryState =
      currentHash === null
        ? 'needs_recovery'
        : currentHash === record.afterHash
          ? 'applied'
          : currentHash === record.beforeHash
            ? 'unchanged'
            : 'needs_recovery';
    out.push({ record, state, currentHash, advice: ADVICE[state] });
  }
  return out;
}

/**
 * 把已判定状态的操作落账。只允许落到终态，不允许把 needs_recovery 悄悄改成 applied。
 */
export async function finalizePending(
  txDir: string,
  record: TxRecord,
  status: Extract<OperationStatus, 'applied' | 'failed' | 'rolled_back' | 'needs_recovery'>,
  note?: string,
): Promise<ReturnType<typeof appendPhase>> {
  return appendPhase(txDir, record, status, note);
}

/** 清理准备区残留；删除失败不抛错，交下一次启动扫描 */
export async function cleanStage(stageDir: string): Promise<void> {
  await fs.rm(stageDir, { recursive: true, force: true });
}
