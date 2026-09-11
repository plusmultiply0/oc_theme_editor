/**
 * 备份（T36、T41）。
 *
 * 语义分两层：
 * - original：工具首次接管时的状态。若首次接管就发现目标已被本工具（或其他工具）改动过，
 *   不能把它当成原版，标记 pristine=false 并禁用「恢复原版」。
 * - previous：上一次成功应用前的状态，用于「恢复上一主题」。
 *
 * 备份一律复制后重新算 hash 校验，hash 不符即判失败，不留坏备份。
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { fail, ok, type Result } from '../../shared/errors';
import { sha256File } from './asar';

export type BackupKind = 'original' | 'previous' | 'pre-restore';

export interface BackupRecord {
  kind: BackupKind;
  file: string;
  sha256: string;
  size: number;
  createdAt: string;
  version: string;
  /** 仅 original 有意义：能否确认为未被改动过的原版 */
  pristine: boolean;
  note?: string;
}

function metaFile(dir: string): string {
  return path.join(dir, 'meta.json');
}

async function readMeta(dir: string): Promise<BackupRecord[]> {
  try {
    const raw = JSON.parse(await fs.readFile(metaFile(dir), 'utf8')) as BackupRecord[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

async function writeMeta(dir: string, records: BackupRecord[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, 'meta.json.tmp');
  await fs.writeFile(tmp, JSON.stringify(records, null, 2), 'utf8');
  await fs.rename(tmp, metaFile(dir));
}

export interface CreateBackupInput {
  archivePath: string;
  dir: string;
  kind: BackupKind;
  version: string;
  /** 备份前目标的 hash，用于校验备份完整性 */
  expectedHash: string;
  pristine?: boolean;
  note?: string;
  /** 故障注入：复制完成后是否破坏备份内容，用于验证 hash 校验 */
  corruptAfterCopy?: boolean;
}

export async function createBackup(input: CreateBackupInput): Promise<Result<BackupRecord>> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(input.dir, `${input.kind}-${stamp}.asar`);

  try {
    await fs.mkdir(input.dir, { recursive: true });
    await fs.copyFile(input.archivePath, file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return fail(
      code === 'ENOSPC' ? 'DISK_FULL' : 'BACKUP_FAILED',
      code === 'ENOSPC' ? '磁盘空间不足，备份失败' : '备份失败',
      '未对安装产生任何改动；请检查磁盘空间与权限后重试。',
      String(e),
    );
  }

  if (input.corruptAfterCopy) {
    await fs.appendFile(file, 'corrupted');
  }

  let sha256: string;
  let size: number;
  try {
    sha256 = await sha256File(file);
    size = (await fs.stat(file)).size;
  } catch (e) {
    return fail('BACKUP_FAILED', '备份无法校验', '未对安装产生任何改动。', String(e));
  }

  if (sha256 !== input.expectedHash) {
    // 备份与目标不一致，宁可失败也不能留一个假备份
    await fs.rm(file, { force: true });
    return fail(
      'BACKUP_HASH_MISMATCH',
      '备份校验失败，备份与目标不一致',
      '未对安装产生任何改动；请重试，若持续失败请勿继续应用。',
      `expected=${input.expectedHash} actual=${sha256}`,
    );
  }

  const record: BackupRecord = {
    kind: input.kind,
    file,
    sha256,
    size,
    createdAt: new Date().toISOString(),
    version: input.version,
    pristine: input.pristine ?? false,
    ...(input.note ? { note: input.note } : {}),
  };

  const existing = await readMeta(input.dir);
  await writeMeta(input.dir, [...existing, record]);
  return ok(record);
}

/** 列出某个备份目录下的全部记录，供界面区分「原版 / 上一主题」（T41） */
export async function listBackupRecords(dir: string): Promise<BackupRecord[]> {
  return readMeta(dir);
}

export async function latestBackup(dir: string): Promise<BackupRecord | null> {
  const all = await readMeta(dir);
  if (all.length === 0) return null;
  return all[all.length - 1];
}

/** 校验备份仍然存在且内容未被改动 */
export async function verifyBackup(record: BackupRecord): Promise<Result<BackupRecord>> {
  try {
    const st = await fs.stat(record.file);
    if (st.size !== record.size) {
      return fail('BACKUP_MISSING', '备份大小与记录不符', '备份可能已损坏，请不要继续恢复。');
    }
    const sha = await sha256File(record.file);
    if (sha !== record.sha256) {
      return fail('BACKUP_HASH_MISMATCH', '备份内容与记录不符', '备份已损坏，请不要继续恢复。');
    }
  } catch (e) {
    return fail('BACKUP_MISSING', '备份文件不存在或无法读取', '请确认备份目录未被清理。', String(e));
  }
  return ok(record);
}

export interface OriginalState {
  record: BackupRecord;
  /** false 表示无法确认为原版，UI 必须禁用「恢复原版」并说明原因 */
  pristine: boolean;
}

export async function ensureOriginalBackup(
  dir: string,
  opts: {
    archivePath: string;
    expectedHash: string;
    version: string;
    alreadyPatched: boolean;
  },
): Promise<Result<OriginalState>> {
  const existing = await latestBackup(dir);
  if (existing) return ok({ record: existing, pristine: existing.pristine });

  const r = await createBackup({
    archivePath: opts.archivePath,
    dir,
    kind: 'original',
    version: opts.version,
    expectedHash: opts.expectedHash,
    pristine: !opts.alreadyPatched,
    ...(opts.alreadyPatched
      ? {
          note:
            '首次接管时目标已包含本工具的注入条目，无法确认为出厂原版；「恢复原版」不可用。',
        }
      : {}),
  });
  if (!r.success) return r;
  return ok({ record: r.data, pristine: r.data.pristine });
}
