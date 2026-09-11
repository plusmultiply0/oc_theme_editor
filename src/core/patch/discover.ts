/**
 * 目标发现与识别（T30、T31）。
 *
 * 只扫「明确登记过」的候选位置，不做全盘搜索。
 * 认不出就是认不出：不允许因为目录里恰好有 app.asar 就认定兼容。
 *
 * 关于卸载登记表：Windows 上每个装过的软件都会在这里登记 InstallLocation。
 * 早先的实现把**所有**登记项都拿来当候选，导致 Fiddler、Postman、VS Code
 * 这些无关软件全被扫一遍并挂进「未通过」列表。
 * 现在必须先按 DisplayName 过滤，只保留名字与本工具目标相关的登记项。
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

/** 只保留名称与本工具目标相关的登记项；其余软件一律不扫 */
const TARGET_NAME_RE = /opencode/i;

/** 卸载登记表位置；64 位系统上还要看 WOW6432Node 分支 */
const UNINSTALL_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

export type RegRunner = (args: string[]) => string;

function defaultRegRunner(args: string[]): string {
  return execFileSync('reg', ['query', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 15000,
    windowsHide: true,
  });
}

export interface UninstallEntry {
  key: string;
  displayName?: string;
  installLocation?: string;
}

/**
 * 解析 `reg query ... /s` 的输出。
 * 形如：
 *   HKEY_CURRENT_USER\...\Uninstall\{GUID}
 *       DisplayName    REG_SZ    OpenCode
 *       InstallLocation    REG_SZ    D:\Apps\OpenCode
 */
export function parseRegDump(raw: string): UninstallEntry[] {
  const entries: UninstallEntry[] = [];
  let current: UninstallEntry | null = null;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^HKEY_/i.test(line)) {
      current = { key: line };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    const m = /^(\S+)\s+REG_SZ\s+(.*)$/i.exec(line);
    if (!m) continue;
    const value = unquote(m[2]);
    const name = m[1].toLowerCase();
    if (name === 'displayname') current.displayName = value;
    else if (name === 'installlocation') current.installLocation = value;
  }
  return entries;
}

/** 去掉引号与尾部分隔符：登记值里这两种脏数据都见过 */
function unquote(v: string): string {
  const trimmed = v.trim();
  const quoted = /^"(.*)"$/.exec(trimmed);
  return (quoted ? quoted[1] : trimmed).replace(/[\\/]+$/, '');
}

export interface DiscoverOptions {
  localAppData?: string;
  /** 测试或用户手动指定的额外候选根目录 */
  extraRoots?: string[];
  /** 是否读取 Windows 卸载登记表；失败时静默忽略 */
  useRegistry?: boolean;
  /** 注册表查询执行器，便于测试替换 */
  regRunner?: RegRunner;
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
  if (opts.useRegistry) roots.push(...registryRoots(opts.regRunner ?? defaultRegRunner));
  return [...new Set(roots)];
}

/**
 * 读卸载登记表里与本工具目标相关的 InstallLocation。
 * 属尽力而为：某个键读不到就跳过，不影响其余候选。
 */
export function registryRoots(runner: RegRunner = defaultRegRunner): string[] {
  if (process.platform !== 'win32') return [];
  const out: string[] = [];
  // 同一个安装常常在 HKCU/HKLM 与 WOW6432Node 视图里各登记一次，按小写路径去重
  const seen = new Set<string>();
  for (const key of UNINSTALL_KEYS) {
    let entries: UninstallEntry[];
    try {
      entries = parseRegDump(runner([key, '/s', '/v', 'DisplayName']));
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.displayName || !TARGET_NAME_RE.test(e.displayName)) continue;
      try {
        const detail = parseRegDump(runner([e.key, '/v', 'InstallLocation']));
        const loc = detail[0]?.installLocation;
        if (!loc) continue;
        const dedupKey = loc.toLowerCase();
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        out.push(loc);
      } catch {
        // 单个登记项读失败不影响其余候选
      }
    }
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

/**
 * 扫描全部候选位置。
 *
 * 返回的 `scanned` 是**实际检查过**的目录（存在且已尝试识别），
 * `outcomes` 只包含真正需要用户知道的结果：
 *   - 识别成功的目标；
 *   - 有归档但适配/版本/读取有问题的目录。
 * 「这目录里压根没有应用归档」不算失败——那只是注册表里顺带带来的无关目录，
 * 不该占着「未通过」列表刷屏。
 */
export async function discoverTargets(
  opts: DiscoverOptions = {},
): Promise<{ outcomes: InspectOutcome[]; scanned: string[] }> {
  const roots = candidateRoots(opts);
  const outcomes: InspectOutcome[] = [];
  const scanned: string[] = [];
  for (const root of roots) {
    if (!(await isDir(root))) continue;
    scanned.push(root);
    const r = await inspectRoot(root);
    if (!r.success) {
      outcomes.push(reject(root, 'unknown', r.error.code, r.error.message, r.error.recoveryHint));
      continue;
    }
    if (r.data.kind === 'rejected' && r.data.rejected.code === 'TARGET_NOT_FOUND') continue;
    outcomes.push(r.data);
  }
  return { outcomes, scanned };
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
