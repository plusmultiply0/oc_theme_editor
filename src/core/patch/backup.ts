/**
 * 备份（T36、T41）。
 *
 * 三种语义必须分清（R2 修正）：
 * - `original`：本工具**首次接管**那一刻的快照。它是不是「出厂原版」需要**证据**，
 *   不能靠「没看到我们的标记」推断——原型时代的 snow-theme.css 就不带我们的标记，
 *   旧实现据此把一份已改过的安装标成了 pristine=true，于是「恢复原版」实际恢复的是旧定制。
 * - `previous`：上一次成功应用前的状态，用于「恢复上一主题」。
 * - `pre-restore`：恢复操作执行前的现场备份。
 *
 * 证据规则（见 original-evidence.ts）：
 *   evidence === 'factory'    → 有可信证据（已核实的出厂指纹）；「恢复原版」可用
 *   evidence === 'unverified' → 无法证明；界面按「首次接管快照」呈现，不冒充原版
 *
 * 备份一律复制后重新算 hash 校验，hash 不符即判失败，不留坏备份。
 *
 * R1：所有对归档与备份文件的读写都走 physical-fs，避免 Electron 的 fs 包装把
 * `*.asar` 当虚拟目录。
 */
import path from 'node:path';
import { fail, ok, type Result } from '../../shared/errors';
import { physicalFsp, physicalSha256File, physicalStat } from './physical-fs';
import { matchFactoryFingerprint, type OriginalEvidence } from './original-evidence';

export type BackupKind = 'original' | 'previous' | 'pre-restore';
export type { OriginalEvidence };

export interface BackupRecord {
  kind: BackupKind;
  file: string;
  sha256: string;
  size: number;
  createdAt: string;
  version: string;
  /** 仅 original 有意义：能否确认为未被改动过的出厂原版 */
  pristine: boolean;
  /** 原版判定依据；旧记录缺这个字段，由迁移补成 'unverified' */
  evidence?: OriginalEvidence;
  note?: string;
}

const LEGACY_DOWNGRADE_NOTE =
  '此记录由旧版本创建，当时仅凭「没有本工具的注入条目」就推断为原版，证据不成立；' +
  '已降级为「首次接管快照」，不能当作出厂原版使用。';

function metaFile(dir: string): string {
  return path.join(dir, 'meta.json');
}

function legacyMetaBackup(dir: string): string {
  return path.join(dir, 'meta.json.pre-r2.bak');
}

async function readRawMeta(dir: string): Promise<BackupRecord[]> {
  try {
    const raw = JSON.parse(await physicalFsp.readFile(metaFile(dir), 'utf8')) as BackupRecord[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

async function writeMeta(dir: string, records: BackupRecord[]): Promise<void> {
  await physicalFsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, 'meta.json.tmp');
  await physicalFsp.writeFile(tmp, JSON.stringify(records, null, 2), 'utf8');
  await physicalFsp.rename(tmp, metaFile(dir));
}

/**
 * 迁移旧元数据（R2）：
 * - 靠「标记不存在」推断出的原版记录 → 降级为未验证快照；
 * - 如果它的哈希正好命中已登记的出厂指纹 → 升级为有证据的原版。
 *
 * 只改元数据，**不动备份文件本身**，所以恢复能力不丢。
 * 迁移前先把原 meta.json 另存一份，便于人工核对。
 */
function migrateRecords(records: BackupRecord[]): { records: BackupRecord[]; changed: boolean } {
  let changed = false;
  const out = records.map((r) => {
    const next: BackupRecord = { ...r };
    if (next.kind !== 'original') return next;

    const matched = matchFactoryFingerprint(next.version, next.sha256);
    if (matched) {
      if (next.evidence !== 'factory' || next.pristine !== true) {
        next.evidence = 'factory';
        next.pristine = true;
        next.note = `已与登记的出厂指纹一致（版本 ${matched.version}，来源：${matched.source}）。`;
        changed = true;
      }
      return next;
    }

    if (next.evidence !== 'unverified') {
      next.evidence = 'unverified';
      next.pristine = false;
      next.note = next.note ? `${next.note} ${LEGACY_DOWNGRADE_NOTE}` : LEGACY_DOWNGRADE_NOTE;
      changed = true;
    } else if (next.pristine !== false) {
      next.pristine = false;
      changed = true;
    }
    return next;
  });
  return { records: out, changed };
}

/**
 * 读取备份元数据。发现旧记录时顺手做一次有备份的迁移，幂等。
 * 迁移失败（例如只读目录）不阻断读取——先按迁移后的视图返回，下次再落盘。
 */
async function readMeta(dir: string): Promise<BackupRecord[]> {
  const raw = await readRawMeta(dir);
  const { records, changed } = migrateRecords(raw);
  if (changed) {
    try {
      const backup = legacyMetaBackup(dir);
      const exists = await physicalFsp
        .stat(backup)
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        await physicalFsp.writeFile(backup, JSON.stringify(raw, null, 2), 'utf8');
      }
      await writeMeta(dir, records);
    } catch {
      // 落盘失败不影响本次读取结果
    }
  }
  return records;
}

export interface CreateBackupInput {
  archivePath: string;
  dir: string;
  kind: BackupKind;
  version: string;
  /** 备份前目标的 hash，用于校验备份完整性 */
  expectedHash: string;
  pristine?: boolean;
  evidence?: OriginalEvidence;
  note?: string;
  /** 故障注入：复制完成后是否破坏备份内容，用于验证 hash 校验 */
  corruptAfterCopy?: boolean;
}

export async function createBackup(input: CreateBackupInput): Promise<Result<BackupRecord>> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(input.dir, `${input.kind}-${stamp}.asar`);

  try {
    await physicalFsp.mkdir(input.dir, { recursive: true });
    await physicalFsp.copyFile(input.archivePath, file);
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
    await physicalFsp.appendFile(file, 'corrupted');
  }

  let sha256: string;
  let size: number;
  try {
    sha256 = await physicalSha256File(file);
    size = (await physicalStat(file)).size;
  } catch (e) {
    return fail('BACKUP_FAILED', '备份无法校验', '未对安装产生任何改动。', String(e));
  }

  if (sha256 !== input.expectedHash) {
    // 备份与目标不一致，宁可失败也不能留一个假备份
    await physicalFsp.rm(file, { force: true });
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
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.note ? { note: input.note } : {}),
  };

  const existing = await readMeta(input.dir);
  await writeMeta(input.dir, [...existing, record]);
  return ok(record);
}

/** 列出某个备份目录下的全部记录，供界面区分「原版 / 首次接管快照 / 上一主题」（T41、R2） */
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
    const st = await physicalStat(record.file);
    if (st.size !== record.size) {
      return fail('BACKUP_MISSING', '备份大小与记录不符', '备份可能已损坏，请不要继续恢复。');
    }
    const sha = await physicalSha256File(record.file);
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

export interface OriginalBackupInput {
  archivePath: string;
  expectedHash: string;
  version: string;
  /** 来自 original-evidence 的判定结果 */
  evidence: OriginalEvidence;
  /** 判定依据的可读说明，会写进记录供界面展示 */
  note?: string;
}

/**
 * 保证存在一份「首次接管快照」。
 *
 * 原版与否完全由 `evidence` 决定：只有 'factory' 才会记录 pristine=true 并开放
 * 「恢复原版」。拿不出证据时如实记录为未验证快照，把恢复能力保留在独立入口里。
 */
export async function ensureOriginalBackup(
  dir: string,
  opts: OriginalBackupInput,
): Promise<Result<OriginalState>> {
  const existing = await latestBackup(dir);
  if (existing) return ok({ record: existing, pristine: existing.pristine });

  const r = await createBackup({
    archivePath: opts.archivePath,
    dir,
    kind: 'original',
    version: opts.version,
    expectedHash: opts.expectedHash,
    evidence: opts.evidence,
    pristine: opts.evidence === 'factory',
    ...(opts.note ? { note: opts.note } : {}),
  });
  if (!r.success) return r;
  return ok({ record: r.data, pristine: r.data.pristine });
}
