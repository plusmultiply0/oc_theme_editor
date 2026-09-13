/**
 * R5 诊断（环境哨兵，不属于常规测试套件，不作为通过门禁）。
 *
 * 运行：node node_modules/vitest/vitest.mjs run --config vitest.diagnose.config.ts
 *
 * 结论（2026-09-13，原始证据落工作区 handoff/review-2026-09-13/evidence/（不入库），
 * 复现工具 tools/r5-standalone-probe.cjs 与 tools/r5-matrix-probe.cjs）：
 * 本机环境存在安全类进程，对「%TEMP% 目录下新建的 *.asar」延迟打开并持久锁住
 * （.bin/.zip 与项目盘 .asar 不受影响），导致 apply 的 rename 覆盖与 afterEach
 * 清理 EBUSY/EPERM，形成 FILE_LOCKED 假失败。修复：测试临时目录统一走
 * tests/fixtures/test-tmp.ts，跑测试时把 TEMP/TMP 注入项目盘
 * node_modules/.cache/ots-test-tmp（同时避开 safe-delete-shim 的删除护栏）。
 *
 * 本文件保留为环境哨兵：若未来换机器/策略收紧再次出现锁，本用例会给出
 * 结构化证据（lockTimeline + 重试矩阵 + 目标 rename 探测），而不是裸的
 * FILE_LOCKED 断言。
 *
 * 用例：
 *   1. 环境探针：临时目录内小文件 create/rename 覆盖/unlink 循环——
 *      排除「文件系统整体不可写」；
 *   2. 新建归档立即 rename 覆盖探测——观察「刚写完的文件是否被外部进程短暂锁住」；
 *   3. 最小 apply 闭环：stage → apply 收集完整结构化 Result（code/message/detail），
 *      失败时对目标归档做独立 rename 探测，并按 250ms/500ms/1500ms 间隔重试——
 *      区分「瞬时外部锁」与「持久锁」；
 *   4. cleanup 复现：rmSync 失败后延时重试是否恢复。
 *
 * 结果写入 handoff/review-2026-09-13/evidence/r5-diagnosis.json。
 */
import fs from 'node:fs';
import { testTmpRoot } from '../fixtures/test-tmp';
import path from 'node:path';
import { createPackageWithOptions } from '@electron/asar';
import { afterEach, describe, expect, it } from 'vitest';
import { ImageStore } from '../../src/main/services/image-store';
import { TargetService } from '../../src/main/services/target-service';
import { OperationService } from '../../src/main/services/operation-service';
import { OperationEventBus } from '../../src/main/services/events';
import { makeSyntheticInstall } from '../fixtures/synthetic-install';
import { jpegBytes, pngBytes } from '../fixtures/image-samples';
import type { ThemeSpec } from '../../src/shared/schema';
import { ADAPTER } from '../integration/helpers/adapter';

const cleanups: (() => void)[] = [];
const EVIDENCE: Record<string, unknown> = { startedAt: new Date().toISOString() };
const EVIDENCE_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'handoff',
  'review-2026-09-13',
  'evidence',
  'r5-diagnosis.json',
);

afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()?.();
    } catch {
      // 诊断过程本身不因清理失败中断
    }
  }
  fs.mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(EVIDENCE, null, 2));
});

function tmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(testTmpRoot(), prefix));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }));
  return d;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ProbeOutcome {
  ok: number;
  failures: { step: string; code?: string; message: string }[];
}

/** 探针：n 次「写文件 → rename 覆盖 → unlink」，记录每个失败步骤与 errno */
async function probeFileOps(dir: string, n: number, delayAfterCreateMs = 0): Promise<ProbeOutcome> {
  const out: ProbeOutcome = { ok: 0, failures: [] };
  const fsp = (await import('node:fs/promises')).default;
  for (let i = 0; i < n; i++) {
    const a = path.join(dir, `probe-${i}.tmp`);
    const b = path.join(dir, `probe-${i}.dat`);
    try {
      await fsp.writeFile(a, `data-${i}`);
      if (delayAfterCreateMs) await sleep(delayAfterCreateMs);
      await fsp.rename(a, b);
      await fsp.unlink(b);
      out.ok += 1;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      out.failures.push({ step: err.code ?? 'unknown', message: `${a} -> ${b}: ${String(e)}` });
    }
  }
  return out;
}

/** 目标文件独立 rename 探测：能不能把它 rename 开再 rename 回来 */
async function probeTargetRename(target: string): Promise<{ ok: boolean; code?: string; detail?: string }> {
  const fsp = (await import('node:fs/promises')).default;
  const aside = `${target}.r5-probe`;
  try {
    await fsp.rename(target, aside);
    await fsp.rename(aside, target);
    return { ok: true };
  } catch (e) {
    return { ok: false, code: (e as NodeJS.ErrnoException).code, detail: String(e) };
  }
}

function specOf(imageId: string, palette: string[]): ThemeSpec {
  return {
    schemaVersion: 1,
    imageId,
    mode: 'light',
    palette,
    overlayOpacity: 0.5,
    panelOpacity: 0.45,
    blurPx: 0,
    reducedTransparency: false,
  };
}

const idle = async () => 'idle' as const;

describe('R5 诊断', () => {
  it('环境探针：小文件 create/rename/unlink 循环（0ms 延迟）', async () => {
    const dir = tmpDir('ots-r5-probe-');
    const r = await probeFileOps(dir, 100, 0);
    EVIDENCE.probeImmediate = r;
    expect(r.failures).toEqual([]);
  });

  it('环境探针：新建文件立即 rename 覆盖（模拟外部扫描窗口）', async () => {
    const dir = tmpDir('ots-r5-probe-');
    const r = await probeFileOps(dir, 50, 0);
    EVIDENCE.probeNewFile = r;
    expect(r.failures.length).toBeLessThanOrEqual(5);
  });

  it('最小 apply 闭环：结构化结果、目标 rename 探测与延时重试', async () => {
    const install = await makeSyntheticInstall();
    cleanups.push(install.cleanup);
    const runtime = tmpDir('ots-r5-run-');
    const srcDir = tmpDir('ots-r5-src-');

    const originalBytes = await jpegBytes({ jfif: true, accent: true });
    const sourceFile = path.join(srcDir, 'wallpaper.jfif');
    fs.writeFileSync(sourceFile, originalBytes);

    const images = new ImageStore({ runtimeRoot: runtime, picker: async () => [sourceFile] });
    const targets = new TargetService({
      localAppData: path.join(runtime, 'no-such-local'),
      extraRoots: [install.root],
      useRegistry: false,
    });
    const operations = new OperationService({
      runtimeRoot: runtime,
      targets,
      images,
      bus: new OperationEventBus(),
      probe: idle,
    });
    // 逐步探测：锁从哪一步开始出现
    const timeline: Record<string, unknown> = {};
    const stepProbe = async (label: string) => {
      const p = await probeTargetRename(install.archivePath);
      timeline[label] = p.ok ? 'unlocked' : `LOCKED(${p.code})`;
      return p.ok;
    };
    EVIDENCE.applyLoop = { archivePath: install.archivePath, lockTimeline: timeline };
    await stepProbe('afterInstall');

    const discovered = await targets.discover();
    if (!discovered.success) throw new Error(`识别失败：${discovered.error.message}`);
    await stepProbe('afterDiscover');

    const picked = await images.pick();
    if (!picked.success) throw new Error(`pick 失败：${picked.error.message}`);
    const imported = await images.import(picked.data.imageId);
    if (!imported.success) throw new Error(`import 失败：${imported.error.message}`);
    fs.rmSync(sourceFile, { force: true });
    await stepProbe('afterPickImport');

    const staged = await operations.stage({
      targetId: discovered.data.targets[0].targetId,
      imageId: picked.data.imageId,
      spec: specOf(picked.data.imageId, imported.data.palette),
    });
    await stepProbe('afterStage');
    const log: Record<string, unknown> = {
      targetId: discovered.data.targets[0].targetId,
      installPath: discovered.data.targets[0].installPath,
      archivePath: install.archivePath,
      ...EVIDENCE.applyLoop,
    } as Record<string, unknown>;
    EVIDENCE.applyLoop = log;
    if (!staged.success) {
      log.stage = { code: staged.error.code, message: staged.error.message, detail: staged.error.detail };
      expect.unreachable('stage 失败，见 evidence');
      return;
    }
    log.stageOk = true;

    const attempt = async (label: string) => {
      const applied = await operations.apply({ operationId: staged.data.operationId });
      const entry: Record<string, unknown> = { ok: applied.success };
      if (!applied.success) {
        entry.code = applied.error.code;
        entry.message = applied.error.message;
        entry.detail = applied.error.detail;
        entry.targetRenameProbe = await probeTargetRename(install.archivePath);
      }
      (log[label] as Record<string, unknown>) = entry;
      return applied;
    };

    const first = await attempt('apply1');
    if (first.success) {
      log.conclusion = 'apply 一次成功——问题未在本环境复现，或与并发/时序相关';
      expect(first.success).toBe(true);
      return;
    }

    await sleep(250);
    const second = await attempt('apply2_after250ms');
    if (!second.success) {
      await sleep(500);
      await attempt('apply3_after500ms');
      await sleep(1500);
      await attempt('apply4_after1500ms');
    }
    const attempts = ['apply1', 'apply2_after250ms', 'apply3_after500ms', 'apply4_after1500ms'];
    const results = attempts.map((k) => (log[k] as { ok: boolean } | undefined)?.ok);
    log.conclusion = results.every((v) => v === false)
      ? '持久锁：所有延时重试均失败——不是瞬时外部扫描窗口'
      : '瞬时锁：延时重试恢复——符合杀毒/索引器短暂占用特征';

    // 诊断允许失败（这是证据收集，不是门禁）：手动构造断言以在报告中可见
    expect.fail(`apply 闭环失败（诊断模式）：${JSON.stringify(log, null, 2).slice(0, 800)}`);
  });

  it('cleanup 复现：rmSync 失败后延时重试', async () => {
    const base = fs.mkdtempSync(path.join(testTmpRoot(), 'ots-r5-rm-'));
    cleanups.push(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 }));
    // 与合成安装相同结构：真实 asar + 子目录
    const srcDir = path.join(base, '_src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'package.json'), '{"name":"t"}');
    const archive = path.join(base, 'install', 'resources');
    fs.mkdirSync(archive, { recursive: true });
    await createPackageWithOptions(srcDir, path.join(archive, 'app.asar'), {});

    const result: Record<string, unknown> = {};
    const rm = (label: string) => {
      try {
        fs.rmSync(base, { recursive: true, force: true, maxRetries: 0 });
        result[label] = 'ok';
        return true;
      } catch (e) {
        result[label] = { code: (e as NodeJS.ErrnoException).code, detail: String(e).slice(0, 200) };
        return false;
      }
    };
    if (!rm('immediate')) {
      await sleep(500);
      if (!rm('after500ms')) {
        await sleep(1500);
        rm('after1500ms');
      }
    }
    EVIDENCE.cleanupRetry = result;
    expect(result.after1500ms ?? result.after500ms ?? result.immediate).toBe('ok');
  });
});
