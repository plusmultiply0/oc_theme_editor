/**
 * 启动恢复扫描（T40、R7）。
 *
 * 只检查本工具自己记录过的目标；不认识的目标不碰。
 * 状态判定只看可证明的磁盘事实：
 * - 当前 hash == afterHash  → 其实已经应用成功，只是没记账
 * - 当前 hash == beforeHash → 什么都没写成，安全
 * - 两者都不是            → needs_recovery，停在原地等人处理，绝不自动用旧版覆盖
 *
 * R7：本模块必须由主进程在启动时真正调用（见 src/main/index.ts 与 services/recovery-service.ts）。
 * 早先只有函数与单测、没有任何调用点，等于恢复检测从来没跑过。
 *
 * R1：目标归档的 hash 走 physical-fs，避免 Electron 把 `.asar` 当虚拟目录。
 */
import path from 'node:path';
import { physicalFsp, physicalSha256File } from './physical-fs';
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
      currentHash = await physicalSha256File(record.targetPath);
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

export interface InstanceRecoveryScan {
  instanceId: string;
  txDir: string;
  pending: PendingTransaction[];
}

/**
 * 扫描运行数据目录下**所有**实例的未完成事务。
 * 主进程启动时调用；某个实例目录读不到就跳过，不影响其余实例。
 */
export async function scanAllPending(runtimeRoot: string): Promise<InstanceRecoveryScan[]> {
  const instancesDir = path.join(runtimeRoot, 'instances');
  let names: string[];
  try {
    names = await physicalFsp.readdir(instancesDir);
  } catch {
    return [];
  }
  const out: InstanceRecoveryScan[] = [];
  for (const name of names) {
    const txDir = path.join(instancesDir, name, 'transactions');
    let pending: PendingTransaction[];
    try {
      pending = await scanPending(txDir);
    } catch {
      continue;
    }
    if (pending.length > 0) out.push({ instanceId: name, txDir, pending });
  }
  return out;
}

/** 是否有必须人工处理的未完成事务（会阻断继续 apply） */
export function blockingRecovery(scans: InstanceRecoveryScan[]): PendingTransaction[] {
  return scans.flatMap((s) => s.pending).filter((p) => p.state === 'needs_recovery');
}

/**
 * 把已判定状态的操作落账。只允许落到与磁盘事实一致的终态：
 * - state === 'applied'    → 才允许写 applied
 * - state === 'unchanged'  → 才允许写 failed
 * - needs_recovery         → 只能显式确认记为 needs_recovery，绝不悄悄改成 applied
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
  await physicalFsp.rm(stageDir, { recursive: true, force: true });
}

/** 清理某个实例下遗留的准备区目录（启动时调用，只删 stage 子目录，不碰备份与事务日志） */
export async function cleanAllStages(runtimeRoot: string): Promise<number> {
  const instancesDir = path.join(runtimeRoot, 'instances');
  let names: string[];
  try {
    names = await physicalFsp.readdir(instancesDir);
  } catch {
    return 0;
  }
  let cleaned = 0;
  for (const name of names) {
    const stageDir = path.join(instancesDir, name, 'stage');
    const exists = await physicalFsp
      .stat(stageDir)
      .then(() => true)
      .catch(() => false);
    if (!exists) continue;
    try {
      await cleanStage(stageDir);
      cleaned += 1;
    } catch {
      // 下一次启动再试
    }
  }
  return cleaned;
}
