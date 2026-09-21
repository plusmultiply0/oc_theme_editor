/**
 * U2：「启动 OpenCode」通道单测。
 * 安全基线：入口只有 targetId；exe 路径由主进程按适配器声明解析，
 * 失败必须收敛为干净错误（码 + recoveryHint），绝不抛裸异常。
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { TargetService } from '../../src/main/services/target-service';
import { adapterById } from '../../src/adapters/registry';
import { makeSyntheticInstall, type SyntheticInstall } from '../fixtures/synthetic-install';
import type { TargetInfo } from '../../src/shared/schema';
import type { ProcessState } from '../../src/core/patch/precheck';

const idleProbe = async (): Promise<ProcessState> => 'idle';

async function harness(opts: {
  exists?: (p: string) => boolean;
  spawn?: (exePath: string) => void;
} = {}): Promise<{ svc: TargetService; target: TargetInfo; install: SyntheticInstall }> {
  const install = await makeSyntheticInstall({ version: '1.18.29' });
  const svc = new TargetService({
    localAppData: '',
    extraRoots: [install.root],
    useRegistry: false,
    processProbe: idleProbe,
    ...(opts.exists || opts.spawn
      ? { launchIo: { exists: opts.exists ?? (() => true), spawn: opts.spawn ?? (() => undefined) } }
      : {}),
  });
  const r = await svc.discover();
  if (!r.success) throw new Error('discover 失败：' + r.error.message);
  const target = r.data.targets[0];
  if (!target) throw new Error('合成安装未被识别');
  return { svc, target, install };
}

describe('TargetService.launch（U2 启动通道）', () => {
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

  it('安装根下 exe 不存在 → LAUNCH_FAILED，不 spawn', async () => {
    const spawns: string[] = [];
    const { svc, target } = await harness({
      exists: () => false,
      spawn: (p) => spawns.push(p),
    });
    const r = await svc.launch(target.targetId);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.code).toBe('LAUNCH_FAILED');
    expect(r.error.recoveryHint).toBeTruthy();
    expect(spawns).toEqual([]);
  });

  it('spawn 成功 → launched:true，exe 路径 = 安装根 + 适配器声明的 exe', async () => {
    const spawns: string[] = [];
    const { svc, target, install } = await harness({ spawn: (p) => spawns.push(p) });
    const r = await svc.launch(target.targetId);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toEqual({ launched: true });
    const adapter = adapterById('opencode-desktop-win-asar');
    expect(adapter).not.toBeNull();
    expect(spawns).toEqual([path.resolve(install.root, adapter!.layout.exe)]);
  });

  it('spawn 抛错 → LAUNCH_FAILED 干净错误（含原因与恢复提示）', async () => {
    const { svc, target } = await harness({
      spawn: () => {
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
