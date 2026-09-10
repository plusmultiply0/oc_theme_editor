/**
 * 目标发现与识别（T30、T31）。
 *
 * 只扫「明确登记过」的候选位置，不做全盘搜索。
 * 认不出就是认不出：不允许因为目录里恰好有 app.asar 就认定兼容。
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { ADAPTERS, adapterForPackage, knownInstallDirNames } from '../../adapters/registry';
import type { TargetAdapter } from '../../adapters/types';
import type { TargetInfo, TargetSupport } from '../../shared/schema';
import { ok, type ErrorCode, type Result } from '../../shared/errors';
import { canonicalize, instanceIdFromPath } from './paths';
import { readAsar, readAsarPackage } from './asar';

export interface DiscoverOptions {
  localAppData?: string;
  /** 测试或用户手动指定的额外候选根目录 */
  extraRoots?: string[];
  /** 是否读取 Windows 卸载登记表；失败时静默忽略 */
  useRegistry?: boolean;
}

/** 明确的候选安装根目录，去重且保持顺序 */
export function candidateRoots(opts: DiscoverOptions = {}): string[] {
  const localAppData = opts.localAppData ?? process.env.LOCALAPPDATA ?? '';
  const roots: string[] = [];
  if (localAppData) {
    for (const dir of knownInstallDirNames()) {
      roots.push(path.join(localAppData, 'Programs', dir));
    }
  }
  for (const r of opts.extraRoots ?? []) roots.push(r);
  if (opts.useRegistry) roots.push(...registryRoots());
  return [...new Set(roots)];
}

/** 读卸载登记表里的 InstallLocation；属尽力而为，读不到就返回空 */
export function registryRoots(): string[] {
  if (process.platform !== 'win32') return [];
  const out: string[] = [];
  try {
    // 同步读取，候选枚举本身很短；失败一律返回空，不影响主流程
    for (const key of [
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    ]) {
      const raw = execFileSync('reg', ['query', key, '/s', '/v', 'InstallLocation'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      });
      for (const line of raw.split(/\r?\n/)) {
        const m = /InstallLocation\s+REG_SZ\s+(.+)$/.exec(line.trim());
        if (m) {
          const v = m[1].trim();
          if (v) out.push(v);
        }
      }
    }
  } catch {
    return [];
  }
  return out;
}

export interface RejectedTarget {
  path: string;
  support: Exclude<TargetSupport, 'supported'>;
  code: ErrorCode;
  message: string;
  recoveryHint: string;
}

export type InspectOutcome =
  | { kind: 'target'; target: TargetInfo }
  | { kind: 'rejected'; rejected: RejectedTarget };

function reject(
  p: string,
  support: Exclude<TargetSupport, 'supported'>,
  code: ErrorCode,
  message: string,
  recoveryHint: string,
): InspectOutcome {
  return { kind: 'rejected', rejected: { path: p, support, code, message, recoveryHint } };
}

/** 按 adapter 声明的布局定位并校验一个候选目录 */
export async function inspectRoot(root: string): Promise<Result<InspectOutcome>> {
  const canon = await canonicalize(root);
  if (!canon.success) return canon;

  const candidates: { adapter: TargetAdapter; archive: string; exe: string }[] = [];
  for (const adapter of ADAPTERS) {
    candidates.push({
      adapter,
      archive: path.join(canon.data, adapter.layout.archive),
      exe: path.join(canon.data, adapter.layout.exe),
    });
  }

  let matched: { adapter: TargetAdapter; archive: string } | null = null;
  for (const c of candidates) {
    if (await isFile(c.archive)) {
      matched = { adapter: c.adapter, archive: c.archive };
      break;
    }
  }

  if (!matched) {
    return ok(
      reject(
        canon.data,
        'unknown',
        'TARGET_NOT_FOUND',
        '该目录没有可识别的应用归档',
        '请手动选择 OpenCode 的安装目录（应包含 resources 文件夹）。',
      ),
    );
  }

  const snapshot = await readAsar(matched.archive);
  if (!snapshot.success) {
    return ok(
      reject(
        canon.data,
        'unknown',
        snapshot.error.code,
        snapshot.error.message,
        snapshot.error.recoveryHint,
      ),
    );
  }

  const pkg = await readAsarPackage(snapshot.data);
  if (!pkg.success) {
    return ok(
      reject(canon.data, 'unknown', pkg.error.code, pkg.error.message, pkg.error.recoveryHint),
    );
  }

  const adapter = adapterForPackage(pkg.data);
  if (!adapter) {
    return ok(
      reject(
        canon.data,
        'unsupported',
        'TARGET_UNSUPPORTED',
        `未适配的应用：${pkg.data.name ?? '未知'}`,
        '当前版本只支持已验证的目标；可以继续预览，但不能应用。',
      ),
    );
  }

  if (adapter.id !== matched.adapter.id) {
    // 归档位置属于另一个 adapter，说明布局判断与包声明不一致，按不支持处理
    return ok(
      reject(
        canon.data,
        'unsupported',
        'TARGET_UNSUPPORTED',
        '资源布局与已适配目标不一致',
        '该安装可能来自其他渠道，暂不支持应用。',
      ),
    );
  }

  const version = pkg.data.version ?? '';
  const supported = adapter.supportedVersions.includes(version);
  const target: TargetInfo = {
    targetId: `${adapter.id}:${instanceIdFromPath(canon.data)}`,
    installPath: canon.data,
    channel: adapter.channel,
    version,
    adapterId: adapter.id,
    fingerprint: snapshot.data.sha256,
    support: supported ? 'supported' : 'unknown',
    ...(supported
      ? {}
      : {
          rejectReason: `版本 ${version || '未知'} 未经验证（已验证：${adapter.supportedVersions.join('、')}）；只允许预览，不允许应用。`,
        }),
  };
  return ok({ kind: 'target', target });
}

/** 扫描全部候选位置，返回存在的目标；不存在的目录不出现在结果里 */
export async function discoverTargets(
  opts: DiscoverOptions = {},
): Promise<{ outcomes: InspectOutcome[]; scanned: string[] }> {
  const roots = candidateRoots(opts);
  const outcomes: InspectOutcome[] = [];
  for (const root of roots) {
    if (!(await isDir(root))) continue;
    const r = await inspectRoot(root);
    if (r.success) outcomes.push(r.data);
    else {
      outcomes.push(
        reject(root, 'unknown', r.error.code, r.error.message, r.error.recoveryHint),
      );
    }
  }
  return { outcomes, scanned: roots };
}

export function onlySupported(outcomes: InspectOutcome[]): TargetInfo[] {
  return outcomes
    .filter((o): o is { kind: 'target'; target: TargetInfo } => o.kind === 'target')
    .map((o) => o.target)
    .filter((t) => t.support === 'supported');
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
