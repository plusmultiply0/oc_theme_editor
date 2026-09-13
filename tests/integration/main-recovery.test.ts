/**
 * 启动恢复与手动指定目标（R6、R7）。
 *
 * R7 的关键点不是「函数能跑」，而是**启动流程真的会扫描**并且会阻断后续写入：
 * 这里直接测 RecoveryService 的 bootstrap / scan / resolve 与 apply 闸门。
 * R6 的关键点是「用户有出路」：手动登记目录必须真的能变成可操作目标。
 */
import fs from 'node:fs';
import { testTmpRoot } from '../fixtures/test-tmp';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeSyntheticInstall, type SyntheticInstall } from '../fixtures/synthetic-install';
import { TargetService } from '../../src/main/services/target-service';
import { RecoveryService } from '../../src/main/services/recovery-service';
import { ImageStore } from '../../src/main/services/image-store';
import { OperationService } from '../../src/main/services/operation-service';
import { OperationEventBus } from '../../src/main/services/events';
import { sha256File } from '../../src/core/patch/asar';
import { ensureDirs, runtimeDirs } from '../../src/core/patch/layout';
import { writeTx, type TxRecord } from '../../src/core/patch/txlog';
import { instanceIdFromPath } from '../../src/core/patch/paths';
import type { TargetInfo } from '../../src/shared/schema';

const installs: SyntheticInstall[] = [];
const tmpDirs: string[] = [];

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(testTmpRoot(), prefix));
  tmpDirs.push(d);
  return d;
}

async function fixture(): Promise<SyntheticInstall> {
  const inst = await makeSyntheticInstall();
  installs.push(inst);
  return inst;
}

afterEach(() => {
  while (installs.length) installs.pop()?.cleanup();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 3 });
});

function pendingRecord(target: TargetInfo, archivePath: string, beforeHash: string): TxRecord {
  return {
    schema: 1,
    operationId: 'op-interrupted',
    targetId: target.targetId,
    version: target.version,
    adapterId: target.adapterId,
    beforeHash,
    afterHash: 'f'.repeat(64),
    backupHash: beforeHash,
    backupPath: archivePath,
    themeSummary: '中断的操作',
    status: 'committing',
    createdAt: new Date().toISOString(),
    kind: 'apply',
    phases: [{ phase: 'committing', at: new Date().toISOString() }],
    targetPath: archivePath,
  };
}

describe('启动恢复服务（R7）', () => {
  it('bootstrap 会扫描到未完成事务并给出可判定的状态与可执行动作', async () => {
    const inst = await fixture();
    const runtime = tmp('ots-rec-runtime-');
    const targets = new TargetService({ localAppData: '', extraRoots: [inst.root], useRegistry: false });
    const discovered = await targets.discover();
    if (!discovered.success) throw new Error('discover failed');
    const target = discovered.data.targets[0];

    const layout = runtimeDirs(runtime, instanceIdFromPath(target.installPath));
    await ensureDirs(layout);
    const beforeHash = await sha256File(inst.archivePath);
    await writeTx(layout.txDir, pendingRecord(target, inst.archivePath, beforeHash));

    const recovery = new RecoveryService({ runtimeRoot: runtime });
    const status = await recovery.bootstrap();

    expect(status.items).toHaveLength(1);
    const item = status.items[0];
    expect(item.operationId).toBe('op-interrupted');
    // 目标没被改成 afterHash，仍等于 beforeHash → 「未生效」，不阻断
    expect(item.state).toBe('unchanged');
    expect(item.blocking).toBe(false);
    expect(item.actions).toContain('mark-failed');
    expect(item.advice).toContain('操作前');
  });

  it('目标处于中间状态时判为 needs_recovery 并阻断后续 apply', async () => {
    const inst = await fixture();
    const runtime = tmp('ots-rec-runtime2-');
    const targets = new TargetService({ localAppData: '', extraRoots: [inst.root], useRegistry: false });
    const discovered = await targets.discover();
    if (!discovered.success) throw new Error('discover failed');
    const target = discovered.data.targets[0];

    const layout = runtimeDirs(runtime, instanceIdFromPath(target.installPath));
    await ensureDirs(layout);
    const beforeHash = await sha256File(inst.archivePath);
    await writeTx(layout.txDir, pendingRecord(target, inst.archivePath, beforeHash));

    // 把目标改成既不是操作前也不是操作后的第三个状态
    fs.appendFileSync(inst.archivePath, 'external-change');

    const recovery = new RecoveryService({ runtimeRoot: runtime });
    const status = await recovery.bootstrap();
    expect(status.blockingCount).toBe(1);
    expect(status.items[0].state).toBe('needs_recovery');
    // 只允许「知悉」，不允许把中间状态写成已应用
    expect(status.items[0].actions).toEqual(['acknowledge']);

    const guard = await recovery.assertClear();
    expect(guard.success).toBe(false);
    if (!guard.success) {
      expect(guard.error.code).toBe('NEEDS_RECOVERY');
      expect(guard.error.message).toContain('op-interrupted');
    }

    // 落账方向与磁盘事实不符时必须拒绝
    const wrong = await recovery.resolve({ operationId: 'op-interrupted', action: 'mark-applied' });
    expect(wrong.success).toBe(false);
    const ok = await recovery.resolve({ operationId: 'op-interrupted', action: 'acknowledge' });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.items).toHaveLength(0);
  });

  it('未生效的事务按事实落成 failed，之后不再阻断', async () => {
    const inst = await fixture();
    const runtime = tmp('ots-rec-runtime3-');
    const targets = new TargetService({ localAppData: '', extraRoots: [inst.root], useRegistry: false });
    const discovered = await targets.discover();
    if (!discovered.success) throw new Error('discover failed');
    const target = discovered.data.targets[0];

    const layout = runtimeDirs(runtime, instanceIdFromPath(target.installPath));
    await ensureDirs(layout);
    const beforeHash = await sha256File(inst.archivePath);
    await writeTx(layout.txDir, pendingRecord(target, inst.archivePath, beforeHash));

    const recovery = new RecoveryService({ runtimeRoot: runtime });
    await recovery.bootstrap();
    const resolved = await recovery.resolve({ operationId: 'op-interrupted', action: 'mark-failed' });
    expect(resolved.success).toBe(true);
    if (resolved.success) {
      expect(resolved.data.items).toHaveLength(0);
      expect(resolved.data.blockingCount).toBe(0);
    }
    expect((await recovery.assertClear()).success).toBe(true);
  });

  it('bootstrap 会清掉残留准备区，但不碰备份与事务日志', async () => {
    const inst = await fixture();
    const runtime = tmp('ots-rec-runtime4-');
    const targets = new TargetService({ localAppData: '', extraRoots: [inst.root], useRegistry: false });
    const discovered = await targets.discover();
    if (!discovered.success) throw new Error('discover failed');
    const target = discovered.data.targets[0];

    const layout = runtimeDirs(runtime, instanceIdFromPath(target.installPath));
    await ensureDirs(layout);
    const staleStage = path.join(layout.stageDir, 'op-stale');
    fs.mkdirSync(staleStage, { recursive: true });
    fs.writeFileSync(path.join(staleStage, 'leftover.bin'), 'x');
    fs.mkdirSync(path.join(layout.backupsDir, 'original'), { recursive: true });
    fs.writeFileSync(path.join(layout.backupsDir, 'original', 'keep.asar'), 'keep');

    const recovery = new RecoveryService({ runtimeRoot: runtime });
    const status = await recovery.bootstrap();
    expect(status.stagesCleaned).toBe(1);
    expect(fs.existsSync(staleStage)).toBe(false);
    expect(fs.existsSync(path.join(layout.backupsDir, 'original', 'keep.asar'))).toBe(true);
  });
});

describe('手动指定安装目录（R6）', () => {
  it('登记一个包含归档的目录后，它成为可操作目标', async () => {
    const inst = await fixture();
    const targets = new TargetService({ localAppData: '', extraRoots: [], useRegistry: false });

    // 一开始什么都找不到
    const before = await targets.discover();
    if (!before.success) throw new Error('discover failed');
    expect(before.data.targets).toHaveLength(0);

    const registered = await targets.registerDirectory(inst.root);
    expect(registered.success).toBe(true);
    if (!registered.success) return;
    expect(registered.data.target?.support).toBe('supported');

    const after = await targets.discover();
    if (!after.success) throw new Error('discover failed');
    expect(after.data.targets.map((t) => t.installPath)).toEqual([registered.data.target?.installPath]);
  });

  it('登记不认识的目录时返回具体原因，而不是含糊成功', async () => {
    const empty = tmp('ots-r6-empty-');
    const targets = new TargetService({ localAppData: '', extraRoots: [], useRegistry: false });
    const r = await targets.registerDirectory(empty);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.target).toBeUndefined();
    expect(r.data.rejected?.code).toBe('TARGET_NOT_FOUND');
    expect(r.data.rejected?.recoveryHint).not.toBe('');
  });

  it('登记未知版本时给出「未经验证」而不是当成可用目标', async () => {
    const inst = await makeSyntheticInstall({ version: '9.9.9' });
    installs.push(inst);
    const targets = new TargetService({ localAppData: '', extraRoots: [], useRegistry: false });
    const r = await targets.registerDirectory(inst.root);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.target?.support).toBe('unknown');
    expect(r.data.target?.rejectReason ?? '').toContain('未经验证');
  });

  it('apply 闸门：存在阻断性未完成事务时，写入在进入事务之前就被拒绝', async () => {
    const inst = await fixture();
    const runtime = tmp('ots-r7-guard-');
    const targets = new TargetService({ localAppData: '', extraRoots: [inst.root], useRegistry: false });
    const discovered = await targets.discover();
    if (!discovered.success) throw new Error('discover failed');
    const target = discovered.data.targets[0];
    const images = new ImageStore({ runtimeRoot: runtime, picker: async () => null });
    const bus = new OperationEventBus();
    const recovery = new RecoveryService({ runtimeRoot: runtime });
    const operations = new OperationService({
      runtimeRoot: runtime,
      targets,
      images,
      bus,
      probe: async () => 'idle',
      recoveryGuard: () => recovery.assertClear(),
    });

    const layout = runtimeDirs(runtime, instanceIdFromPath(target.installPath));
    await ensureDirs(layout);
    const beforeHash = await sha256File(inst.archivePath);
    await writeTx(layout.txDir, pendingRecord(target, inst.archivePath, beforeHash));
    fs.appendFileSync(inst.archivePath, 'external-change');
    await recovery.bootstrap();

    const before = await sha256File(inst.archivePath);
    const r = await operations.apply({ operationId: 'op-whatever' });
    expect(r.success).toBe(false);
    if (!r.success) {
      // 闸门在「找不到准备记录」之前生效 —— 说明它真的挂在写入路径上
      expect(r.error.code).toBe('NEEDS_RECOVERY');
      expect(r.error.message).toContain('待处理');
    }
    expect(await sha256File(inst.archivePath)).toBe(before);
  });
});
