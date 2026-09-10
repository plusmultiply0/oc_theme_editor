/**
 * 事务日志（T38、T39、T40）。
 *
 * - 日志必须先于关键写入持久化：先写 committing，再动目标文件。
 * - 日志本身用「临时文件 + rename」落盘，避免半截 JSON。
 * - 状态不明时停在 needs_recovery，不自动用旧版覆盖（T40）。
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { OperationManifestSchema, type OperationManifest, type OperationStatus } from '../../shared/schema';
import { fail, ok, type Result } from '../../shared/errors';

export interface TxPhaseEntry {
  phase: OperationStatus;
  at: string;
  note?: string;
}

export interface TxRecord extends OperationManifest {
  phases: TxPhaseEntry[];
  /** 目标资源路径仅存于本机日志，不外传 */
  targetPath: string;
}

/** 非终态：启动时扫描到这些状态说明上次操作没有走完 */
export const PENDING_STATUSES: readonly OperationStatus[] = [
  'inspected',
  'staged',
  'backed_up',
  'committing',
];

export function isPending(status: OperationStatus): boolean {
  return PENDING_STATUSES.includes(status);
}

function txFile(txDir: string, operationId: string): string {
  return path.join(txDir, `${operationId}.json`);
}

async function atomicWriteJson(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

export async function writeTx(txDir: string, record: TxRecord): Promise<Result<void>> {
  try {
    await atomicWriteJson(txFile(txDir, record.operationId), record);
    return ok(undefined);
  } catch (e) {
    return fail('STAGE_FAILED', '事务日志写入失败', '请检查运行数据目录是否可写。', String(e));
  }
}

export async function readTx(txDir: string, operationId: string): Promise<Result<TxRecord>> {
  try {
    const raw = JSON.parse(await fs.readFile(txFile(txDir, operationId), 'utf8')) as unknown;
    const parsed = OperationManifestSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('MANIFEST_CORRUPT', '事务记录已损坏', '请使用恢复入口处理该安装目标。', parsed.error.message);
    }
    const rec = raw as TxRecord;
    if (!Array.isArray(rec.phases) || typeof rec.targetPath !== 'string') {
      return fail('MANIFEST_CORRUPT', '事务记录缺少必要字段', '请使用恢复入口处理该安装目标。');
    }
    return ok({ ...(parsed.data as OperationManifest), phases: rec.phases, targetPath: rec.targetPath });
  } catch (e) {
    return fail('MANIFEST_CORRUPT', '事务记录无法读取', '请使用恢复入口处理该安装目标。', String(e));
  }
}

export async function listTx(txDir: string): Promise<TxRecord[]> {
  let names: string[];
  try {
    names = (await fs.readdir(txDir)).filter((n) => n.endsWith('.json') && !n.endsWith('.tmp'));
  } catch {
    return [];
  }
  const out: TxRecord[] = [];
  for (const n of names) {
    const r = await readTx(txDir, n.slice(0, -'.json'.length));
    if (r.success) out.push(r.data);
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

export async function appendPhase(
  txDir: string,
  record: TxRecord,
  phase: OperationStatus,
  note?: string,
): Promise<Result<TxRecord>> {
  const next: TxRecord = {
    ...record,
    status: phase,
    phases: [...record.phases, { phase, at: new Date().toISOString(), ...(note ? { note } : {}) }],
  };
  const w = await writeTx(txDir, next);
  if (!w.success) return w;
  return ok(next);
}
