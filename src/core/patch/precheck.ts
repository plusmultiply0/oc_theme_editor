/**
 * 应用前的环境与安全检查（T32、T33）。
 *
 * 原则：
 * - 无法确认目标已退出 → 拒绝；提示用户自行保存并退出，不强制 kill、不自动提权。
 * - 只对已选定的目标判定，不因同名进程误伤其他安装。
 * - 磁盘预检要覆盖备份、staged 文件和事务临时文件三份开销。
 * - 不修改可执行文件、不改安全开关；遇到签名/完整性保护只上报不绕过。
 */
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fail, ok, type Result } from '../../shared/errors';
import type { TargetInfo } from '../../shared/schema';
import { adapterById } from '../../adapters/registry';
import { canonicalize } from './paths';
import { physicalFsp, physicalStat } from './physical-fs';

const execFileAsync = promisify(execFile);

export type ProcessState = 'idle' | 'running' | 'unknown';

/** 进程探针可注入，测试不需要真的启停应用 */
export type ProcessProbe = (exePath: string) => Promise<ProcessState>;

/** Windows 下按可执行文件路径精确匹配，避免误伤其他同名安装 */
export const systemProcessProbe: ProcessProbe = async (exePath) => {
  if (process.platform !== 'win32') return 'unknown';
  const exeName = path.basename(exePath).replace(/'/g, "''");
  const script = `Get-CimInstance Win32_Process -Filter "Name='${exeName}'" | Select-Object -ExpandProperty ExecutablePath`;
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
    );
    const want = exePath.toLowerCase();
    const lines = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return 'idle';
    return lines.some((l) => l.toLowerCase() === want) ? 'running' : 'idle';
  } catch {
    // 查询失败不能当作「没在运行」
    return 'unknown';
  }
};

export interface PrecheckReport {
  installPath: string;
  exePath: string;
  archivePath: string;
  archiveSize: number;
  processState: ProcessState;
  /** 目录可写（已实际创建探针文件验证） */
  writable: boolean;
  freeBytes: number;
  requiredBytes: number;
}

/**
 * 峰值占用（真机取证 2026-09-12 修正为四份）：
 *  1. 备份副本（写进运行数据目录，通常与安装同卷）
 *  2. 准备区：解包出来的整个应用目录
 *  3. 准备区：重打包出来的 staged 归档（与上一条并存）
 *  4. 提交时同卷的临时副本（目标归档旁）
 * 旧估算只算三份，真机上按 495 MB 放行却在提交阶段耗尽空间（ENOSPC），
 * 因此这里按四份算，再加固定余量。
 */
export function requiredBytes(archiveSize: number): number {
  const SLACK = 64 * 1024 * 1024;
  return archiveSize * 4 + SLACK;
}

export async function freeBytesOf(dir: string): Promise<number> {
  try {
    const st = await physicalFsp.statfs(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return 0;
  }
}

/** 用真实写探针判断目录可写，不靠 stat 模式位猜 */
export async function canWriteDir(dir: string): Promise<boolean> {
  const probe = path.join(dir, `.ts-probe-${process.pid}-${Date.now()}`);
  try {
    await physicalFsp.writeFile(probe, '');
    await physicalFsp.rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export interface PrecheckOptions {
  probe?: ProcessProbe;
  /** 归档字节数，默认从磁盘读取 */
  archiveSize?: number;
}

export async function precheckTarget(
  target: TargetInfo,
  opts: PrecheckOptions = {},
): Promise<Result<PrecheckReport>> {
  const adapter = adapterById(target.adapterId);
  if (!adapter) {
    return fail('TARGET_UNSUPPORTED', '目标使用的适配规则已不存在', '请重新检测安装目标。');
  }

  const canon = await canonicalize(target.installPath);
  if (!canon.success) return canon;

  const root = canon.data;
  const exePath = path.join(root, adapter.layout.exe);
  const archivePath = path.join(root, adapter.layout.archive);

  let archiveSize = opts.archiveSize ?? 0;
  if (archiveSize === 0) {
    try {
      archiveSize = (await physicalStat(archivePath)).size;
    } catch {
      return fail('TARGET_NOT_FOUND', '未找到应用归档', '请重新检测安装目标。');
    }
  }

  const probe = opts.probe ?? systemProcessProbe;
  const processState = await probe(exePath);
  if (processState === 'unknown') {
    return fail(
      'TARGET_RUNNING',
      '无法确认目标应用是否已退出',
      '请保存任务并完全退出 OpenCode 后重试；工具不会强制结束进程。',
    );
  }
  if (processState === 'running') {
    return fail(
      'TARGET_RUNNING',
      '目标应用正在运行',
      '请先保存任务并退出 OpenCode，再执行应用。',
    );
  }

  const resourcesDir = path.dirname(archivePath);
  if (!(await canWriteDir(resourcesDir))) {
    return fail(
      'PERMISSION_DENIED',
      '没有写入权限',
      '请确认当前账户对该安装目录有写权限，必要时改用用户级安装。',
    );
  }

  const freeBytes = await freeBytesOf(resourcesDir);
  const need = requiredBytes(archiveSize);
  if (freeBytes > 0 && freeBytes < need) {
    return fail(
      'DISK_FULL',
      `磁盘空间不足：需要约 ${(need / 1024 / 1024).toFixed(0)} MB，可用 ${(freeBytes / 1024 / 1024).toFixed(0)} MB`,
      '请清理磁盘后重试；空间不足时不会开始写入。',
    );
  }

  return ok({
    installPath: root,
    exePath,
    archivePath,
    archiveSize,
    processState,
    writable: true,
    freeBytes,
    requiredBytes: need,
  });
}

/** 运行数据根目录：系统用户数据目录，不放进源码或安装目录 */
export function runtimeRoot(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), 'OpenCodeThemeSwitcher');
  }
  return path.join(os.homedir(), '.opencode-theme-switcher');
}
