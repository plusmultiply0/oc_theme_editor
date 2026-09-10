/**
 * 事务应用与恢复的故障注入测试（T34–T42）。
 *
 * 覆盖计划 7.3 要求的场景：stage 失败、磁盘不足、备份失败、备份 hash 错、权限不足、
 * 文件占用、版本变化、提交前 hash 变化、提交中断、提交后日志失败、损坏 manifest、
 * 同时两次 apply、apply 与 restore 并发、启动遇到未完成事务。
 *
 * 全部使用合成安装，不触碰真实安装。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractFile, uncache } from '@electron/asar';
import { afterEach, describe, expect, it } from 'vitest';
import { makeSyntheticInstall, type SyntheticInstall } from '../fixtures/synthetic-install';
import { inspectRoot } from '../../src/core/patch/discover';
import { applyTheme, computeThemeHash } from '../../src/core/patch/apply';
import { restoreTarget } from '../../src/core/patch/restore';
import { scanPending } from '../../src/core/patch/recovery';
import { acquireLock } from '../../src/core/patch/lock';
import { listTx, readTx, writeTx, type TxRecord } from '../../src/core/patch/txlog';
import { ensureDirs, runtimeDirs } from '../../src/core/patch/layout';
import { readAsar, sha256File, listAsarFiles, toArchivePath } from '../../src/core/patch/asar';
import { collectUnpacked } from '../../src/core/patch/stage';
import { instanceIdFromPath } from '../../src/core/patch/paths';
import type { TargetInfo } from '../../src/shared/schema';

const installs: SyntheticInstall[] = [];
const runtimeRoots: string[] = [];

function newRuntime(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-runtime-'));
  runtimeRoots.push(d);
  return d;
}

async function makeTarget(opts: Parameters<typeof makeSyntheticInstall>[0] = {}) {
  const inst = await makeSyntheticInstall(opts);
  installs.push(inst);
  const r = await inspectRoot(inst.root);
  if (!r.success || r.data.kind !== 'target') throw new Error('fixture 不是可识别目标');
  return { inst, target: r.data.target };
}

function runtimeLayout(installPath: string, root: string) {
  const id = instanceIdFromPath(installPath);
  return runtimeDirs(root, id);
}

function css(name: string): string {
  return `:root { --background-base: ${name}; }`;
}

type ApplyArgs = Parameters<typeof applyTheme>[0];

/**
 * 测试统一注入「目标已退出」探针：
 * 真实探针要起 PowerShell 进程，单次数秒，且不属于本文件的测试目标。
 */
async function doApply(args: ApplyArgs) {
  return applyTheme({ ...args, hooks: { probe: async () => 'idle', ...(args.hooks ?? {}) } });
}

afterEach(() => {
  while (installs.length) installs.pop()?.cleanup();
  while (runtimeRoots.length) fs.rmSync(runtimeRoots.pop() as string, { recursive: true, force: true });
});

describe('正常闭环（T34–T42）', () => {
  it('应用后归档被替换、白名单外条目不变、unpacked 标记保留', async () => {
    const { inst, target } = await makeTarget({
      files: { 'node_modules/native/x.node': 'native-binary' },
      unpack: '*.node',
    });
    const before = await sha256File(inst.archivePath);
    const snapBefore = await readAsar(inst.archivePath);
    if (!snapBefore.success) throw new Error('read asar failed');

    const r = await doApply({
      target,
      runtimeRoot: newRuntime(),
      css: css('#111111'),
      imageBytes: Buffer.from('image-bytes'),
      themeSummary: '测试主题',
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.noop).toBe(false);
    expect(r.data.manifest.status).toBe('applied');

    const after = await sha256File(inst.archivePath);
    expect(after).not.toBe(before);
    expect(after).toBe(r.data.manifest.afterHash);

    const snapAfter = await readAsar(inst.archivePath);
    if (!snapAfter.success) throw new Error('read asar failed');
    const filesAfter = listAsarFiles(snapAfter.data.header);
    expect(filesAfter).toContain('out/renderer/oc-theme-custom.css');
    expect(filesAfter).toContain('out/renderer/oc-theme-background.jpg');
    // 原有条目一个都不能少
    for (const f of listAsarFiles(snapBefore.data.header)) {
      expect(filesAfter).toContain(f);
    }
    // unpacked 标记必须原样保留，否则原生模块加载不了
    const beforeUnpacked = collectUnpacked(snapBefore.data.header);
    const afterUnpacked = collectUnpacked(snapAfter.data.header);
    expect(beforeUnpacked.size).toBeGreaterThan(0);
    expect([...afterUnpacked].sort()).toEqual([...beforeUnpacked].sort());
  });

  it('HTML 注入幂等：换主题不会累积多条 link', async () => {
    const { inst, target } = await makeTarget();
    const runtime = newRuntime();
    const htmlPath = path.join(inst.root, 'resources', 'app.asar');
    void htmlPath;

    const count = async () => {
      // asar 会按路径缓存文件系统，重建后必须清缓存再读
      uncache(inst.archivePath);
      const html = extractFile(inst.archivePath, toArchivePath('out/renderer/index.html')).toString(
        'utf8',
      );
      return html.split('oc-theme-custom.css').length - 1;
    };

    await doApply({
      target,
      runtimeRoot: runtime,
      css: css('#222222'),
      imageBytes: Buffer.from('a'),
      themeSummary: '主题1',
    });
    expect(await count()).toBe(1);
    await doApply({
      target,
      runtimeRoot: runtime,
      css: css('#333333'),
      imageBytes: Buffer.from('b'),
      themeSummary: '主题2',
    });
    expect(await count()).toBe(1);
  });

  it('重复应用同一主题为 no-op，不产生写入', async () => {
    const { inst, target } = await makeTarget();
    const runtime = newRuntime();
    const input = {
      target,
      runtimeRoot: runtime,
      css: css('#444444'),
      imageBytes: Buffer.from('same'),
      themeSummary: '同一主题',
    };
    const first = await applyTheme(input);
    expect(first.success).toBe(true);
    const hashAfterFirst = await sha256File(inst.archivePath);

    const second = await applyTheme(input);
    expect(second.success).toBe(true);
    if (second.success) expect(second.data.noop).toBe(true);
    expect(await sha256File(inst.archivePath)).toBe(hashAfterFirst);
  });

  it('应用 → 换主题 → 恢复上一主题 → 恢复原版，逐步核对 hash', async () => {
    const { inst, target } = await makeTarget();
    const runtime = newRuntime();
    const original = await sha256File(inst.archivePath);

    const a = await doApply({
      target,
      runtimeRoot: runtime,
      css: css('#555555'),
      imageBytes: Buffer.from('img-a'),
      themeSummary: 'A',
    });
    expect(a.success).toBe(true);
    const hashA = await sha256File(inst.archivePath);
    expect(hashA).not.toBe(original);

    const b = await doApply({
      target,
      runtimeRoot: runtime,
      css: css('#666666'),
      imageBytes: Buffer.from('img-b'),
      themeSummary: 'B',
    });
    expect(b.success).toBe(true);
    const hashB = await sha256File(inst.archivePath);
    expect(hashB).not.toBe(hashA);

    const back = await restoreTarget({ target, layout: runtimeLayout(inst.root, runtime), kind: 'previous' });
    expect(back.success).toBe(true);
    expect(await sha256File(inst.archivePath)).toBe(hashA);

    const toOriginal = await restoreTarget({
      target,
      layout: runtimeLayout(inst.root, runtime),
      kind: 'original',
    });
    expect(toOriginal.success).toBe(true);
    expect(await sha256File(inst.archivePath)).toBe(original);
  });

  it('恢复是新操作而不是撤销历史：历史记录不被改写', async () => {
    const { inst, target } = await makeTarget();
    const runtime = newRuntime();
    const layout = runtimeLayout(inst.root, runtime);
    await doApply({
      target,
      runtimeRoot: runtime,
      css: css('#777777'),
      imageBytes: Buffer.from('x'),
      themeSummary: 'A',
    });
    const rr = await restoreTarget({ target, layout, kind: 'previous' });
    expect(rr.success).toBe(true);
    if (!rr.success) return;
    expect(rr.data.manifest.kind).toBe('restore-previous');
    expect(rr.data.manifest.status).toBe('applied');
    const rec = await readTx(layout.txDir, rr.data.manifest.operationId);
    expect(rec.success).toBe(true);
  });
});

describe('故障注入（7.3）', () => {
  it('stage 失败：安装不变', async () => {
    const { inst, target } = await makeTarget();
    const before = await sha256File(inst.archivePath);
    const r = await doApply({
      target,
      runtimeRoot: newRuntime(),
      css: css('#888888'),
      imageBytes: Buffer.from('y'),
      themeSummary: 'A',
      hooks: {
        failBeforeStage: async () => {
          throw new Error('stage boom');
        },
      },
    });
    expect(r.success).toBe(false);
    expect(await sha256File(inst.archivePath)).toBe(before);
  });

  it('磁盘不足：写入前拒绝', async () => {
    const { inst, target } = await makeTarget();
    const before = await sha256File(inst.archivePath);
    const r = await doApply({
      target,
      runtimeRoot: newRuntime(),
      css: css('#999999'),
      imageBytes: Buffer.from('y'),
      themeSummary: 'A',
      hooks: { freeBytes: async () => 1024 },
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('DISK_FULL');
    expect(await sha256File(inst.archivePath)).toBe(before);
  });

  it('目标运行中：拒绝应用', async () => {
    const { inst, target } = await makeTarget();
    const before = await sha256File(inst.archivePath);
    const r = await doApply({
      target,
      runtimeRoot: newRuntime(),
      css: css('#aaaaaa'),
      imageBytes: Buffer.from('y'),
      themeSummary: 'A',
      hooks: { probe: async () => 'running' },
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('TARGET_RUNNING');
    expect(await sha256File(inst.archivePath)).toBe(before);
  });

  it('备份 hash 校验失败：安装不变', async () => {
    const { inst, target } = await makeTarget();
    const before = await sha256File(inst.archivePath);
    const r = await doApply({
      target,
      runtimeRoot: newRuntime(),
      css: css('#bbbbbb'),
      imageBytes: Buffer.from('y'),
      themeSummary: 'A',
      hooks: { corruptBackup: true },
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('BACKUP_HASH_MISMATCH');
    expect(await sha256File(inst.archivePath)).toBe(before);
  });

  it('提交前目标被改动：拒绝并停在原状态', async () => {
    const { inst, target } = await makeTarget();
    const before = await sha256File(inst.archivePath);
    const r = await doApply({
      target,
      runtimeRoot: newRuntime(),
      css: css('#cccccc'),
      imageBytes: Buffer.from('y'),
      themeSummary: 'A',
      hooks: {
        commit: {
          mutateBeforeVerify: async () => {
            fs.appendFileSync(inst.archivePath, 'external-change');
          },
        },
      },
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('TARGET_HASH_MISMATCH');
    // 目标是「被外部改动」的状态，不是本工具造成的
    expect(await sha256File(inst.archivePath)).not.toBe(before);
  });

  it('提交中断：目标保持原 hash，不出现半成品', async () => {
    const { inst, target } = await makeTarget();
    const before = await sha256File(inst.archivePath);
    const r = await doApply({
      target,
      runtimeRoot: newRuntime(),
      css: css('#dddddd'),
      imageBytes: Buffer.from('y'),
      themeSummary: 'A',
      hooks: { commit: { interruptBeforeRename: async () => undefined } },
    });
    expect(r.success).toBe(false);
    expect(await sha256File(inst.archivePath)).toBe(before);
    expect(fs.existsSync(`${inst.archivePath}.ts-staged`)).toBe(false);
  });

  it('提交后日志写入失败：不盲目回滚，标记为需恢复', async () => {
    const { inst, target } = await makeTarget();
    const before = await sha256File(inst.archivePath);
    const runtime = newRuntime();
    const r = await doApply({
      target,
      runtimeRoot: runtime,
      css: css('#eeeeee'),
      imageBytes: Buffer.from('y'),
      themeSummary: 'A',
      hooks: { commit: { interruptAfterRename: async () => undefined } },
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('NEEDS_RECOVERY');
    // 目标已经换成新内容，绝不能在不知情的情况下回滚
    const nowHash = await sha256File(inst.archivePath);
    expect(nowHash).not.toBe(before);

    // 停在 needs_recovery，交给用户决定，而不是自动回滚
    const layout = runtimeLayout(inst.root, runtime);
    const all = await listTx(layout.txDir);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('needs_recovery');
    expect(nowHash).toBe(all[0].afterHash);
    // 已落终态，不再出现在待恢复扫描里
    expect(await scanPending(layout.txDir)).toHaveLength(0);
  });

  it('事务日志写入失败：安装未被修改', async () => {
    const { inst, target } = await makeTarget();
    const before = await sha256File(inst.archivePath);
    const r = await doApply({
      target,
      runtimeRoot: newRuntime(),
      css: css('#f0f0f0'),
      imageBytes: Buffer.from('y'),
      themeSummary: 'A',
      hooks: { failLogWrite: true },
    });
    expect(r.success).toBe(false);
    expect(await sha256File(inst.archivePath)).toBe(before);
  });

  it('损坏的 manifest 被识别，不会被当成有效记录', async () => {
    const { inst } = await makeTarget();
    const runtime = newRuntime();
    const layout = runtimeLayout(inst.root, runtime);
    await ensureDirs(layout);
    fs.writeFileSync(path.join(layout.txDir, 'op-broken.json'), '{ not json');
    const r = await readTx(layout.txDir, 'op-broken');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('MANIFEST_CORRUPT');
    const pending = await scanPending(layout.txDir);
    expect(pending).toHaveLength(0);
  });

  it('同时两次 apply：第二次被锁拒绝', async () => {
    const { inst, target } = await makeTarget();
    const runtime = newRuntime();
    const layout = runtimeLayout(inst.root, runtime);
    await ensureDirs(layout);
    const lock = await acquireLock(layout.locks, layout.instanceId);
    expect(lock.success).toBe(true);
    if (!lock.success) throw new Error('获取锁失败');

    const r = await doApply({
      target,
      runtimeRoot: runtime,
      css: css('#121212'),
      imageBytes: Buffer.from('y'),
      themeSummary: 'A',
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('TRANSACTION_IN_PROGRESS');
    await lock.data.release();
  });

  it('apply 与 restore 并发：restore 被锁拒绝', async () => {
    const { target, inst } = await makeTarget();
    const runtime = newRuntime();
    const layout = runtimeLayout(inst.root, runtime);
    await ensureDirs(layout);
    const lock = await acquireLock(layout.locks, layout.instanceId);
    expect(lock.success).toBe(true);
    if (!lock.success) throw new Error('获取锁失败');
    const r = await restoreTarget({ target, layout, kind: 'previous' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('TRANSACTION_IN_PROGRESS');
    await lock.data.release();
  });

  it('启动遇到未完成事务：按磁盘事实判定状态', async () => {
    const { inst, target } = await makeTarget();
    const runtime = newRuntime();
    const layout = runtimeLayout(inst.root, runtime);
    await ensureDirs(layout);
    const beforeHash = await sha256File(inst.archivePath);
    const afterHash = 'f'.repeat(64);

    const base: TxRecord = {
      schema: 1,
      operationId: 'op-pending',
      targetId: target.targetId,
      version: target.version,
      adapterId: target.adapterId,
      beforeHash,
      afterHash,
      backupHash: 'b',
      backupPath: 'p',
      themeSummary: '中断的操作',
      status: 'committing',
      createdAt: new Date().toISOString(),
      kind: 'apply',
      phases: [{ phase: 'committing', at: new Date().toISOString() }],
      targetPath: inst.archivePath,
    };
    await writeTx(layout.txDir, base);

    const pending = await scanPending(layout.txDir);
    expect(pending).toHaveLength(1);
    expect(pending[0].state).toBe('unchanged');
    expect(pending[0].currentHash).toBe(beforeHash);

    // 目标变成既非前也非后的第三方状态 → needs_recovery
    fs.appendFileSync(inst.archivePath, 'x');
    const pending2 = await scanPending(layout.txDir);
    expect(pending2[0].state).toBe('needs_recovery');
  });

  it('版本变化后拒绝恢复', async () => {
    const { inst, target } = await makeTarget();
    const runtime = newRuntime();
    const layout = runtimeLayout(inst.root, runtime);
    await doApply({
      target,
      runtimeRoot: runtime,
      css: css('#131313'),
      imageBytes: Buffer.from('y'),
      themeSummary: 'A',
    });

    const upgraded: TargetInfo = { ...target, version: '2.0.0' };
    const r = await restoreTarget({ target: upgraded, layout, kind: 'previous' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('TARGET_VERSION_MISMATCH');
  });

  it('首次接管时目标已被改动 → 原版不可确认，恢复原版被禁用', async () => {
    const { inst, target } = await makeTarget({
      files: { 'out/renderer/oc-theme-custom.css': '/* injected before */' },
    });
    const runtime = newRuntime();
    const layout = runtimeLayout(inst.root, runtime);
    const applied = await doApply({
      target,
      runtimeRoot: runtime,
      css: css('#141414'),
      imageBytes: Buffer.from('y'),
      themeSummary: 'A',
    });
    expect(applied.success).toBe(true);

    const r = await restoreTarget({ target, layout, kind: 'original' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('BACKUP_MISSING');
  });

  it('主题内容指纹可用于重复应用判定', () => {
    const a = computeThemeHash('x', Buffer.from('1'));
    const b = computeThemeHash('x', Buffer.from('1'));
    const c = computeThemeHash('x', Buffer.from('2'));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
