/**
 * 目标识别服务（T30、T31、T51；R6）。
 *
 * 只扫明确登记过的候选位置；识别不出来的目录一并返回原因，
 * 界面要能显示「扫过哪里、哪里不认」，而不是只说「没找到」。
 *
 * R6 补的是：识别失败之后用户没有出路。
 * 之前只有构造参数 `extraRoots`，界面上既没有「重新检测」也没有「选择安装目录」，
 * 而错误提示却在让用户「手动选择目录」——提示与能力对不上。
 * 现在 `registerDirectory` 由主进程的目录对话框驱动：renderer 永远拿不到也不传路径，
 * 只能拿到主进程登记后的 targetId。
 */
import { discoverTargets as scan, inspectRoot } from '../../core/patch/discover';
import { ok, fail, type Result } from '../../shared/errors';
import type { TargetInfo } from '../../shared/schema';
import type { DiscoveredTargets, RejectedTargetInfo, RegisterDirectoryResult } from '../../shared/ipc';

export interface TargetServiceOptions {
  localAppData?: string;
  /** 额外候选根目录：测试注入，或用户手动登记过的目录 */
  extraRoots?: string[];
  /** 是否查询 Windows 卸载登记表补充候选 */
  useRegistry?: boolean;
}

export class TargetService {
  private readonly cache = new Map<string, TargetInfo>();
  private readonly extraRoots: string[];

  constructor(private readonly opts: TargetServiceOptions = {}) {
    this.extraRoots = [...(opts.extraRoots ?? [])];
  }

  async discover(): Promise<Result<DiscoveredTargets>> {
    const { outcomes, scanned } = await scan({
      // 空串是有效取值：表示「不要用进程环境里的 LOCALAPPDATA」，
      // 自动化测试靠它把候选根目录限定在临时目录里。用真值判断会把空串漏掉。
      ...(this.opts.localAppData !== undefined ? { localAppData: this.opts.localAppData } : {}),
      extraRoots: this.extraRoots,
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
          code: o.rejected.code,
          message: o.rejected.message,
          recoveryHint: o.rejected.recoveryHint,
        });
      }
    }

    return ok({ targets, rejected, scanned });
  }

  /**
   * 登记用户手动选择的安装目录（R6）。
   * 目录由主进程的对话框选出；这里只接收路径、做识别、登记 targetId，
   * 不放开任何「renderer 传路径」的写入通道。
   */
  async registerDirectory(dir: string): Promise<Result<RegisterDirectoryResult>> {
    if (!dir) return fail('INVALID_PARAMS', '没有选择目录', '请重新选择 OpenCode 的安装目录。');

    const r = await inspectRoot(dir);
    if (!r.success) return r;

    if (r.data.kind === 'target') {
      this.cache.set(r.data.target.targetId, r.data.target);
      if (!this.extraRoots.includes(dir)) this.extraRoots.push(dir);
      return ok({ target: r.data.target });
    }

    const rejected: RejectedTargetInfo = {
      path: r.data.rejected.path,
      support: r.data.rejected.support,
      code: r.data.rejected.code,
      message: r.data.rejected.message,
      recoveryHint: r.data.rejected.recoveryHint,
    };
    return ok({ rejected });
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
