/**
 * 「启动 OpenCode」通道单测（U2；W4b 复活）。
 * 安全基线：入口只有 targetId；exe 路径由主进程按适配器声明解析，
 * 失败必须收敛为干净错误（码 + recoveryHint），绝不抛裸异常。
 * W4a 定案后启动方式 = ShellExecute 等价路径（cmd /c start），
 * 「spawn 参数正确」按 buildLaunchCommand 断言，不真起进程。
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { TargetService, buildLaunchCommand } from '../../src/main/services/target-service';
import { adapterById } from '../../src/adapters/registry';
import { OPENCODE_DESKTOP_ADAPTER } from '../../src/adapters/opencode-desktop';
import { makeSyntheticInstall, type SyntheticInstall } from '../fixtures/synthetic-install';
import type { TargetInfo } from '../../src/shared/schema';
import type { ProcessState } from '../../src/core/patch/precheck';

const idleProbe = async (): Promise<ProcessState> => 'idle';

async function harness(opts: {
  exists?: (p: string) => boolean;
  start?: (exePath: string) => void;
} = {}): Promise<{ svc: TargetService; target: TargetInfo; install: SyntheticInstall }> {
  const install = await makeSyntheticInstall({ version: '1.18.29' });
  const svc = new TargetService({
    localAppData: '',
    extraRoots: [install.root],
    useRegistry: false,
    processProbe: idleProbe,
    ...(opts.exists || opts.start
      ? { launchIo: { exists: opts.exists ?? (() => true), start: opts.start ?? (() => undefined) } }
      : {}),
  });
  const r = await svc.discover();
  if (!r.success) throw new Error('discover 失败：' + r.error.message);
  const target = r.data.targets[0];
  if (!target) throw new Error('合成安装未被识别');
  return { svc, target, install };
}

describe('TargetService.launch（W4b 启动通道）', () => {
  it('未知 targetId → TARGET_NOT_FOUND 干净拒绝，不抛异常', async () => {
    const svc = new TargetService({
      localAppData: '',
      extraRoots: [],
      useRegistry: false,
      processProbe: idleProbe,
    });
    const r = await svc.launch('no-such-target');
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.code).toBe('TARGET_NOT_FOUND');
    expect(r.error.recoveryHint).toBeTruthy();
  });

  it('discover 为 targets 补充 processState（与 precheck 同探针口径）', async () => {
    const { target } = await harness();
    expect(target.processState).toBe('idle');
  });

  it('安装根下 exe 不存在 → LAUNCH_FAILED，不拉起', async () => {
    const starts: string[] = [];
    const { svc, target } = await harness({
      exists: () => false,
      start: (p) => starts.push(p),
    });
    const r = await svc.launch(target.targetId);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.code).toBe('LAUNCH_FAILED');
    expect(r.error.recoveryHint).toBeTruthy();
    expect(starts).toEqual([]);
  });

  it('拉起成功 → launched:true，exe 路径 = 安装根 + 适配器声明的 exe', async () => {
    const starts: string[] = [];
    const { svc, target, install } = await harness({ start: (p) => starts.push(p) });
    const r = await svc.launch(target.targetId);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toEqual({ launched: true });
    const adapter = adapterById('opencode-desktop-win-asar');
    expect(adapter).not.toBeNull();
    expect(starts).toEqual([path.resolve(install.root, adapter!.layout.exe)]);
  });

  it('拉起抛错 → LAUNCH_FAILED 干净错误（含原因与恢复提示）', async () => {
    const { svc, target } = await harness({
      start: () => {
        throw new Error('EACCES-simulated');
      },
    });
    const r = await svc.launch(target.targetId);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.code).toBe('LAUNCH_FAILED');
    expect(r.error.message).toContain('EACCES-simulated');
    expect(r.error.recoveryHint).toBeTruthy();
  });
});

describe('launch exe 路径解析守卫（U3）', () => {
  it('适配器声明逃逸安装根 → INVALID_PARAMS，不拉起', async () => {
    const starts: string[] = [];
    const { svc, target } = await harness({ start: (p) => starts.push(p) });
    const original = OPENCODE_DESKTOP_ADAPTER.layout.exe;
    try {
      // 模拟「日后适配器声明被改坏」：守卫必须拦住，而不是照着拼出去拉起
      OPENCODE_DESKTOP_ADAPTER.layout.exe = path.join('..', 'evil.exe');
      const r = await svc.launch(target.targetId);
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.error.code).toBe('INVALID_PARAMS');
      expect(starts).toEqual([]);
    } finally {
      OPENCODE_DESKTOP_ADAPTER.layout.exe = original;
    }
  });

  it('子目录相对声明仍在安装根内 → 正常解析', async () => {
    const starts: string[] = [];
    const { svc, target, install } = await harness({ start: (p) => starts.push(p) });
    const original = OPENCODE_DESKTOP_ADAPTER.layout.exe;
    try {
      OPENCODE_DESKTOP_ADAPTER.layout.exe = path.join('bin', 'OpenCode.exe');
      const r = await svc.launch(target.targetId);
      expect(r.success).toBe(true);
      expect(starts).toEqual([path.resolve(install.root, 'bin', 'OpenCode.exe')]);
    } finally {
      OPENCODE_DESKTOP_ADAPTER.layout.exe = original;
    }
  });
});

describe('buildLaunchCommand（W4a 定案的 ShellExecute 等价路径）', () => {
  it('命令 = cmd /c start "" "<exe>"：标题占位必须保留，否则带引号路径被吞', () => {
    const cmd = buildLaunchCommand('C:\\Program Files\\OpenCode\\OpenCode.exe');
    expect(cmd.command).toBe('cmd.exe');
    expect(cmd.args).toEqual(['/c', 'start', '', 'C:\\Program Files\\OpenCode\\OpenCode.exe']);
  });

  it('detached + 不持句柄 + 环境剔除 ELECTRON_RUN_AS_NODE', () => {
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try {
      const cmd = buildLaunchCommand('C:\\x\\OpenCode.exe');
      expect(cmd.options.detached).toBe(true);
      expect(cmd.options.stdio).toBe('ignore');
      expect('ELECTRON_RUN_AS_NODE' in cmd.options.env).toBe(false);
      expect(cmd.options.env.PATH).toBe(process.env.PATH);
    } finally {
      delete process.env.ELECTRON_RUN_AS_NODE;
    }
  });
});
