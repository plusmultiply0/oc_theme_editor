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
import { adapterById } from '../../adapters/registry';
import { systemProcessProbe, type ProcessProbe } from '../../core/patch/precheck';
import { ok, fail, type Result } from '../../shared/errors';
import type { TargetInfo } from '../../shared/schema';
import type { DiscoveredTargets, RejectedTargetInfo, RegisterDirectoryResult } from '../../shared/ipc';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * W4a 定案（handoff/visual-fix-plan-2026-09-24/W4A-EVIDENCE.md）：
 * 直接 spawn exe（F1 老路）拉起的 OpenCode 环境不完整、加载不了对话；
 * `cmd /c start "" "<exe>"` 走 ShellExecute、与用户双击同路径，实测会话完整恢复。
 * start 的第一枚参数是窗口标题占位（空串），缺了它带引号的路径会被当成标题吞掉。
 */
export function buildLaunchCommand(exePath: string): {
  command: string;
  args: string[];
  options: { detached: true; stdio: 'ignore'; env: NodeJS.ProcessEnv };
} {
  const env = { ...process.env };
  // 工具若被 node 链路拉起，这个变量会把目标的 Electron 应用变成纯 Node 进程
  delete env.ELECTRON_RUN_AS_NODE;
  return { command: 'cmd.exe', args: ['/c', 'start', '', exePath], options: { detached: true, stdio: 'ignore', env } };
}

export interface TargetServiceOptions {
  localAppData?: string;
  /** 额外候选根目录：测试注入，或用户手动登记过的目录 */
  extraRoots?: string[];
  /** 是否查询 Windows 卸载登记表补充候选 */
  useRegistry?: boolean;
  /** 进程探针（与 precheck 同口径），测试注入避免真的查系统 */
  processProbe?: ProcessProbe;
  /** 启动通道注入点：测试不真起进程 */
  launchIo?: { exists: (p: string) => boolean; start: (exePath: string) => void };
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
        const t = await this.withProcessState(o.target);
        targets.push(t);
        this.cache.set(t.targetId, t);
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
      const t = await this.withProcessState(r.data.target);
      this.cache.set(t.targetId, t);
      if (!this.extraRoots.includes(dir)) this.extraRoots.push(dir);
      return ok({ target: t });
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
    const t = await this.withProcessState(r.data.target);
    this.cache.set(targetId, t);
    return ok(t);
  }

  /** 按 adapter 声明的 exe 相对路径定位可执行文件；路径永远不出主进程 */
  private resolveExePath(target: TargetInfo): Result<string> {
    const adapter = adapterById(target.adapterId);
    if (!adapter) {
      return fail('TARGET_UNSUPPORTED', '找不到该目标对应的适配器', '请重新检测安装目标。');
    }
    const root = path.resolve(target.installPath);
    const exePath = path.resolve(root, adapter.layout.exe);
    // adapter 声明是固定的，但仍复验拼接结果落在安装根内——防声明被日后改坏
    if (!exePath.toLowerCase().startsWith(root.toLowerCase() + path.sep)) {
      return fail('INVALID_PARAMS', 'exe 路径越出安装根', '请重新检测安装目标。');
    }
    return ok(exePath);
  }

  private async withProcessState(target: TargetInfo): Promise<TargetInfo> {
    const exe = this.resolveExePath(target);
    if (!exe.success) return target;
    try {
      const state = await (this.opts.processProbe ?? systemProcessProbe)(exe.data);
      return { ...target, processState: state };
    } catch {
      return { ...target, processState: 'unknown' };
    }
  }

  /**
   * 「启动 OpenCode」：ShellExecute 等价路径拉起（W4a 定案），不等待、不持句柄；
   * 单实例下二次启动会聚焦已有窗口。失败只返回干净错误——不动归档、不改任何目标内容。
   */
  async launch(targetId: string): Promise<Result<{ launched: boolean }>> {
    const t = this.get(targetId);
    if (!t.success) return t;

    const exe = this.resolveExePath(t.data);
    if (!exe.success) return exe;

    const io = this.opts.launchIo ?? {
      exists: existsSync,
      start: (exePath: string) => {
        const cmd = buildLaunchCommand(exePath);
        spawn(cmd.command, cmd.args, cmd.options).unref();
      },
    };
    if (!io.exists(exe.data)) {
      return fail(
        'LAUNCH_FAILED',
        '安装根下找不到目标可执行文件',
        '目标可能已被移动或卸载，请重新检测后重试。',
      );
    }
    try {
      io.start(exe.data);
    } catch (e) {
      return fail(
        'LAUNCH_FAILED',
        `启动失败：${e instanceof Error ? e.message : String(e)}`,
        '请从系统里手动打开 OpenCode，再回到本工具重试。',
      );
    }
    this.cache.set(targetId, { ...t.data, processState: 'running' });
    return ok({ launched: true });
  }
}
