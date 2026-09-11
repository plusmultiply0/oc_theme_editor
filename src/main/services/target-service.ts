/**
 * 目标识别服务（T30、T31、T51）。
 *
 * 只扫明确登记过的候选位置；识别不出来的目录一并返回原因，
 * 界面要能显示「扫过哪里、哪里不认」，而不是只说「没找到」。
 */
import { discoverTargets as scan, inspectRoot } from '../../core/patch/discover';
import { ok, fail, type Result } from '../../shared/errors';
import type { TargetInfo } from '../../shared/schema';
import type { DiscoveredTargets, RejectedTargetInfo } from '../../shared/ipc';

export interface TargetServiceOptions {
  localAppData?: string;
  /** 用户手动指定的额外候选根目录 */
  extraRoots?: string[];
  /** 是否查询 Windows 卸载登记表补充候选 */
  useRegistry?: boolean;
}

export class TargetService {
  private readonly cache = new Map<string, TargetInfo>();

  constructor(private readonly opts: TargetServiceOptions = {}) {}

  async discover(): Promise<Result<DiscoveredTargets>> {
    const { outcomes, scanned } = await scan({
      ...(this.opts.localAppData ? { localAppData: this.opts.localAppData } : {}),
      ...(this.opts.extraRoots ? { extraRoots: this.opts.extraRoots } : {}),
      useRegistry: this.opts.useRegistry ?? true,
    });

    const targets: TargetInfo[] = [];
    const rejected: RejectedTargetInfo[] = [];
    for (const o of outcomes) {
      if (o.kind === 'target') {
        targets.push(o.target);
        this.cache.set(o.target.targetId, o.target);
      } else {
        rejected.push({
          path: o.rejected.path,
          support: o.rejected.support,
          message: o.rejected.message,
          recoveryHint: o.rejected.recoveryHint,
        });
      }
    }

    return ok({ targets, rejected, scanned });
  }

  get(targetId: string): Result<TargetInfo> {
    const t = this.cache.get(targetId);
    if (!t) {
      return fail('TARGET_NOT_FOUND', '目标记录已失效', '请重新检测安装目标。');
    }
    return ok(t);
  }

  /** 按已缓存的安装路径重新识别，用于应用前刷新版本与指纹 */
  async refresh(targetId: string): Promise<Result<TargetInfo>> {
    const current = this.cache.get(targetId);
    if (!current) {
      return fail('TARGET_NOT_FOUND', '目标记录已失效', '请重新检测安装目标。');
    }
    const r = await inspectRoot(current.installPath);
    if (!r.success) return r;
    if (r.data.kind !== 'target') {
      return fail(
        'TARGET_UNSUPPORTED',
        r.data.rejected.message,
        r.data.rejected.recoveryHint,
      );
    }
    this.cache.set(targetId, r.data.target);
    return ok(r.data.target);
  }
}
