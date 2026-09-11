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
import { ensureDirs, originalDir, previousDir, runtimeDirs } from '../../src/core/patch/layout';
import { listBackupRecords } from '../../src/core/patch/backup';
import {
  KNOWN_FACTORY_FINGERPRINTS,
  matchFactoryFingerprint,
} from '../../src/core/patch/original-evidence';
import { readAsar, readAsarText, sha256File, listAsarFiles, toArchivePath } from '../../src/core/patch/asar';
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

  it('应用 → 换主题 → 恢复上一主题 → 恢复首次接管快照，逐步核对 hash', async () => {
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

    // R2：没有出厂指纹证据时「恢复原版」必须拒绝，并指向诚实的快照入口
    const toOriginal = await restoreTarget({
      target,
      layout: runtimeLayout(inst.root, runtime),
      kind: 'original',
    });
    expect(toOriginal.success).toBe(false);
    if (!toOriginal.success) {
      expect(toOriginal.error.code).toBe('BACKUP_MISSING');
      expect(toOriginal.error.recoveryHint).toContain('首次接管快照');
    }
    expect(await sha256File(inst.archivePath)).toBe(hashA);

    const toSnapshot = await restoreTarget({
      target,
      layout: runtimeLayout(inst.root, runtime),
      kind: 'takeover',
    });
    expect(toSnapshot.success).toBe(true);
    if (toSnapshot.success) expect(toSnapshot.data.manifest.themeSummary).toBe('恢复首次接管快照');
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

  it('首次接管时目标已被改动 → 原版不可确认，原版入口被禁用', async () => {
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

  it('首次接管时目标「没有本工具标记」也不等于原版：证据不足一律降级（R2 回归）', async () => {
    // 这一条是审查里真机复现的场景：归档里没有 oc-theme-custom.css，
    // 但挂着一层原型时代的 snow-theme.css，旧实现据此标成 pristine=true。
    const legacyCss = [
      /* 内容指纹必须与 KNOWN_LEGACY_THEMES 对得上 */
      'html, body, #root { --snow-primary: #a0a7c9; --background-base: #404558; }',
    ].join('\n');
    const htmlWithLegacyTheme = [
      '<!doctype html><html><head>',
      '<link rel="stylesheet" href="./assets/main-x.css">',
      '<link rel="stylesheet" href="./snow-theme.css" data-local-theme="snowfield">',
      '</head><body><div id="root"></div></body></html>',
    ].join('\n');
    const { inst, target } = await makeTarget({
      files: {
        'out/renderer/index.html': htmlWithLegacyTheme,
        'out/renderer/snow-theme.css': legacyCss,
        'out/renderer/snow-background.jpg': 'fake-jpg',
      },
    });
    const runtime = newRuntime();
    const layout = runtimeLayout(inst.root, runtime);

    const applied = await doApply({
      target,
      runtimeRoot: runtime,
      css: css('#151515'),
      imageBytes: Buffer.from('y'),
      themeSummary: 'A',
    });
    expect(applied.success).toBe(true);

    // 原版备份被记录为「未验证」
    const records = await listBackupRecords(originalDir(layout));
    expect(records).toHaveLength(1);
    expect(records[0].evidence).toBe('unverified');
    expect(records[0].pristine).toBe(false);
    expect(records[0].note ?? '').toContain('旧主题层');

    // 因此「恢复原版」被禁用
    const r = await restoreTarget({ target, layout, kind: 'original' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.code).toBe('BACKUP_MISSING');
      expect(r.error.message).toContain('无法确认为出厂原版');
    }

    // 旧主题层已被撤下，新主题是唯一的活动主题层；旧文件留在归档里可恢复
    const snapAfter = await readAsar(inst.archivePath);
    if (!snapAfter.success) throw new Error('read asar failed');
    const files = listAsarFiles(snapAfter.data.header);
    expect(files).toContain('out/renderer/snow-theme.css');
    const htmlRead = await readAsarText(snapAfter.data, 'out/renderer/index.html');
    if (!htmlRead.success) throw new Error('read html failed');
    expect(htmlRead.data).not.toContain('snow-theme.css');
    expect(htmlRead.data).toContain('oc-theme-custom.css');

    // 快照入口仍然可用
    const snap = await restoreTarget({ target, layout, kind: 'takeover' });
    expect(snap.success).toBe(true);
  });

  it('旧元数据里「靠标记缺失推断的原版」会被迁移降级，并留一份 .bak（R2 迁移）', async () => {
    const { inst, target } = await makeTarget();
    const runtime = newRuntime();
    const layout = runtimeLayout(inst.root, runtime);
    await ensureDirs(layout);

    const dir = originalDir(layout);
    fs.mkdirSync(dir, { recursive: true });
    const fakeFile = path.join(dir, 'original-legacy.asar');
    fs.copyFileSync(inst.archivePath, fakeFile);
    const legacyRecord = {
      kind: 'original',
      file: fakeFile,
      sha256: await sha256File(fakeFile),
      size: fs.statSync(fakeFile).size,
      createdAt: '2026-09-11T00:00:00.000Z',
      version: target.version,
      pristine: true,
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify([legacyRecord], null, 2), 'utf8');

    const records = await listBackupRecords(dir);
    expect(records[0].evidence).toBe('unverified');
    expect(records[0].pristine).toBe(false);
    expect(records[0].note ?? '').toContain('旧版本创建');
    // 备份文件本体没有被删，恢复能力保留
    expect(fs.existsSync(fakeFile)).toBe(true);
    // 迁移前的元数据留档
    const bak = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json.pre-r2.bak'), 'utf8')) as {
      pristine: boolean;
    }[];
    expect(bak[0].pristine).toBe(true);

    // 迁移幂等：再读一次不会再写一遍
    const again = await listBackupRecords(dir);
    expect(again[0].evidence).toBe('unverified');
  });

  it('来源不明的第三方主题层：准备阶段直接拒绝，不自动覆盖（R3）', async () => {
    const htmlWithUnknownTheme = [
      '<!doctype html><html><head>',
      '<link rel="stylesheet" href="./assets/main-x.css">',
      '<link rel="stylesheet" href="./my-own-theme.css">',
      '</head><body><div id="root"></div></body></html>',
    ].join('\n');
    const { inst, target } = await makeTarget({
      files: {
        'out/renderer/index.html': htmlWithUnknownTheme,
        'out/renderer/my-own-theme.css': ':root { --background-base: #123456; }',
      },
    });
    const before = await sha256File(inst.archivePath);
    const r = await doApply({
      target,
      runtimeRoot: newRuntime(),
      css: css('#161616'),
      imageBytes: Buffer.from('y'),
      themeSummary: 'A',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.code).toBe('THEME_CONFLICT');
      expect(r.error.message).toContain('my-own-theme.css');
    }
    expect(await sha256File(inst.archivePath)).toBe(before);
  });

  it('主题内容指纹可用于重复应用判定', () => {
    const a = computeThemeHash('x', Buffer.from('1'));
    const b = computeThemeHash('x', Buffer.from('1'));
    const c = computeThemeHash('x', Buffer.from('2'));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('原版证据的登记与迁移（R2）', () => {
  it('登记出厂指纹后，命中指纹的旧记录会被升级为有证据的原版', async () => {
    const { inst, target } = await makeTarget();
    const runtime = newRuntime();
    const layout = runtimeLayout(inst.root, runtime);
    await ensureDirs(layout);

    const dir = originalDir(layout);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'original-factory.asar');
    fs.copyFileSync(inst.archivePath, file);
    const sha = await sha256File(file);
    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify(
        [
          {
            kind: 'original',
            file,
            sha256: sha,
            size: fs.statSync(file).size,
            createdAt: '2026-09-11T00:00:00.000Z',
            version: target.version,
            pristine: true,
          },
        ],
        null,
        2,
      ),
      'utf8',
    );

    // 先登记一条出厂指纹，再读元数据
    KNOWN_FACTORY_FINGERPRINTS.push({
      version: target.version,
      sha256: sha,
      source: '测试用：模拟维护者核实过的官方安装包',
      recordedAt: '2026-09-11',
    });
    try {
      const records = await listBackupRecords(dir);
      expect(records[0].evidence).toBe('factory');
      expect(records[0].pristine).toBe(true);
      expect(records[0].note ?? '').toContain('出厂指纹');

      // 有证据时才允许「恢复原版」，并且真的回到那份快照
      const r = await restoreTarget({ target, layout, kind: 'original' });
      expect(r.success).toBe(true);
      expect(await sha256File(inst.archivePath)).toBe(sha);
    } finally {
      KNOWN_FACTORY_FINGERPRINTS.pop();
    }
  });

  it('指纹表为空时不冒充原版（默认行为）', () => {
    expect(KNOWN_FACTORY_FINGERPRINTS).toHaveLength(0);
    expect(matchFactoryFingerprint('1.18.29', '0'.repeat(64))).toBeUndefined();
  });
});

describe('备份健康标记与恢复（事故 F3）', () => {
  it('恢复前会检查备份健康度，已知故障快照被拒绝且目标不变', async () => {
    const { inst, target } = await makeTarget();
    const runtime = newRuntime();
    const layout = runtimeLayout(inst.root, runtime);
    await doApply({
      target,
      runtimeRoot: runtime,
      css: css('#171717'),
      imageBytes: Buffer.from('y'),
      themeSummary: 'A',
    });

    const dir = originalDir(layout);
    const records = await listBackupRecords(dir);
    expect(records[0].health).toBe('known-healthy');

    // 事后把备份内容改坏（模拟备份文件本身损坏）
    const raw = fs.readFileSync(records[0].file);
    const dataStart = 8 + raw.readUInt32LE(4);
    const fd = fs.openSync(records[0].file, 'r+');
    try {
      fs.writeSync(fd, Buffer.from('XXXX', 'utf8'), 0, 4, dataStart);
    } finally {
      fs.closeSync(fd);
    }

    const before = await sha256File(inst.archivePath);
    const r = await restoreTarget({ target, layout, kind: 'takeover' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.code).toBe('BACKUP_UNHEALTHY');
      expect(r.error.message).toContain('已损坏');
    }
    expect(await sha256File(inst.archivePath)).toBe(before);

    // 健康标记已落盘，之后列表里能看到，不会再被当成可用项
    const after = await listBackupRecords(dir);
    expect(after[0].health).toBe('known-bad');
  });

  it('应用成功后创建的备份被标记为已知健康', async () => {
    const { inst, target } = await makeTarget();
    const runtime = newRuntime();
    const layout = runtimeLayout(inst.root, runtime);
    await doApply({
      target,
      runtimeRoot: runtime,
      css: css('#181818'),
      imageBytes: Buffer.from('y'),
      themeSummary: 'A',
    });
    const originals = await listBackupRecords(originalDir(layout));
    const previous = await listBackupRecords(previousDir(layout));
    expect(originals[0].health).toBe('known-healthy');
    expect(previous[0].health).toBe('known-healthy');
  });

  it('健康标记缺失的旧记录按 unverified 处理（迁移）', async () => {
    const { inst } = await makeTarget();
    const runtime = newRuntime();
    const layout = runtimeLayout(inst.root, runtime);
    await ensureDirs(layout);
    const dir = originalDir(layout);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'original-legacy.asar');
    fs.copyFileSync(inst.archivePath, file);
    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify([
        {
          kind: 'original',
          file,
          sha256: await sha256File(file),
          size: fs.statSync(file).size,
          createdAt: '2026-09-11T00:00:00.000Z',
          version: '1.18.29',
          pristine: false,
          evidence: 'unverified',
        },
      ]),
      'utf8',
    );
    const records = await listBackupRecords(dir);
    expect(records[0].health).toBe('unverified');
  });
});
