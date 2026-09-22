/**
 * 基线门禁分类放行的端到端回归（baseline-drift B2）。
 *
 * 真实事故形态：OpenCode 自动更新整体替换 asar → 成千条目与基线不符 →
 * 旧逻辑一票否决且无路可走（A5）。这里验证两扇门：
 * - 官方整体更新（合法重打包、版本变化）→ 自动重新接管放行，
 *   旧基线按序号归档留存，操作记录留下证据；
 * - 局部篡改/锚点丢失/变更集合被占用/原生模块集合变化 → 维持拒绝，
 *   安装字节逐字节不变。
 * 全部使用临时目录合成安装，不触碰任何真实安装。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeSyntheticInstall, type SyntheticInstall } from '../fixtures/synthetic-install';
import { testTmpRoot } from '../fixtures/test-tmp';
import { applyTheme } from '../../src/core/patch/apply';
import { sha256File } from '../../src/core/patch/asar';
import { buildBaseline, writeBaselineFile } from '../../src/core/patch/archive-verify';
import { ensureDirs, originalDir, runtimeDirs, type RuntimeLayout } from '../../src/core/patch/layout';
import { instanceIdFromPath } from '../../src/core/patch/paths';
import { listTx } from '../../src/core/patch/txlog';
import { ADAPTER } from './helpers/adapter';

const installs: SyntheticInstall[] = [];
const runtimes: string[] = [];

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(testTmpRoot(), prefix));
}

async function fixture(opts: Parameters<typeof makeSyntheticInstall>[0] = {}) {
  const inst = await makeSyntheticInstall(opts);
  installs.push(inst);
  return inst;
}

afterEach(() => {
  while (installs.length) installs.pop()?.cleanup();
  while (runtimes.length) fs.rmSync(runtimes.pop() as string, { recursive: true, force: true, maxRetries: 3 });
});

const isAllowed = (entry: string): boolean => ADAPTER.allowedChanges.includes(entry);

/**
 * 主题 css 必须带生成横幅（与 src/core/theme/css.ts 的产物同形态）——
 * 结构验证按「横幅 + HTML 注入标记」识别变更集合归属，裸 css 会被当成第三方占用。
 */
function themeCss(hex: string): string {
  return `/* 由 OpenCode 换肤助手生成；测试夹具同产线形态 */\nhtml:root { --background-base: ${hex}; }`;
}

async function targetOf(inst: SyntheticInstall) {
  const { inspectRoot } = await import('../../src/core/patch/discover');
  const r = await inspectRoot(inst.root);
  if (!r.success || r.data.kind !== 'target') throw new Error('fixture 不是可识别目标');
  return r.data.target;
}

/** 用一次合法重打包替换安装目录里的归档（模拟官方更新的产物形态） */
async function repackOver(inst: SyntheticInstall, opts: Parameters<typeof makeSyntheticInstall>[0]) {
  const upd = await makeSyntheticInstall(opts);
  try {
    fs.copyFileSync(upd.archivePath, inst.archivePath);
  } finally {
    upd.cleanup();
  }
}

function layoutOf(inst: SyntheticInstall, runtime: string): RuntimeLayout {
  return runtimeDirs(runtime, instanceIdFromPath(inst.root));
}

async function applyThemeWith(
  runtime: string,
  target: Awaited<ReturnType<typeof targetOf>>,
  css: string,
  events?: string[],
) {
  return applyTheme({
    target,
    runtimeRoot: runtime,
    css,
    imageBytes: Buffer.from('image'),
    themeSummary: 'drift 验证用主题',
    hooks: { probe: async () => 'idle' },
    ...(events ? { onEvent: (e) => events.push(e.message) } : {}),
  });
}

describe('端到端：官方整体更新自动重新接管（A5 死循环的正式修复）', () => {
  it('更新后重应用放行；基线迁移到新归档、旧基线按序号留存、操作记录有证据；后续重应用回归 noop', async () => {
    const inst = await fixture();
    const runtime = tmp('ots-drift-runtime-');
    runtimes.push(runtime);
    const layout = layoutOf(inst, runtime);
    await ensureDirs(layout);

    // 1) 首次接管：基线以接手时状态为准（v2 信封带版本与 unpacked 记录）
    const target = await targetOf(inst);
    const first = await applyThemeWith(runtime, target, themeCss('#111111'));
    expect(first.success).toBe(true);
    const baselinePath = path.join(originalDir(layout), 'baseline.json');
    const stored = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as {
      schema: number;
      meta: { version: string | null; unpackedPaths: string[] };
    };
    expect(stored.schema).toBe(2);
    expect(stored.meta.version).toBe('1.18.29');
    expect(stored.meta.unpackedPaths).toEqual([]);

    // 2) 模拟自动更新：整体重打包（版本变、内容大量变化），应用侧仍握着更新前的目标记录
    await repackOver(inst, {
      version: '1.18.31',
      files: {
        'out/main/index.js': 'console.log(9);\n',
        'node_modules/dep/index.js': 'module.exports = 1;\n',
      },
    });
    const updatedHash = await sha256File(inst.archivePath);

    // 3) 用更新前的目标记录重应用（A5 的真实链路）：分类判定 official-update → 放行
    const secondEvents: string[] = [];
    const second = await applyThemeWith(runtime, target, themeCss('#222222'), secondEvents);
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data.noop).toBe(false);
    // 放行不是静默搬家：进度事件里告知基线已随更新迁移（B3）
    expect(secondEvents.some((m) => m.includes('已更新至 1.18.31') && m.includes('已自动更新基线'))).toBe(
      true,
    );
    const appliedHash = await sha256File(inst.archivePath);
    expect(appliedHash).not.toBe(updatedHash);

    // 4) 基线已迁移到新归档，旧基线 v1 留存可追溯
    const migrated = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as {
      schema: number;
      meta: { version: string | null };
      entries: { path: string }[];
    };
    expect(migrated.meta.version).toBe('1.18.31');
    expect(migrated.entries.some((e) => e.path === 'node_modules/dep/index.js')).toBe(true);
    const archivedOld = path.join(originalDir(layout), 'baseline.v1.json');
    expect(fs.existsSync(archivedOld)).toBe(true);
    const old = JSON.parse(fs.readFileSync(archivedOld, 'utf8')) as {
      meta: { version: string | null };
    };
    expect(old.meta.version).toBe('1.18.29');

    // 5) 操作记录落证据：rebaselined + 旧基线版本
    const txs = await listTx(layout.txDir);
    const last = txs[txs.length - 1];
    expect(last?.status).toBe('applied');
    expect(last?.rebaselined).toBe(true);
    expect(last?.baselineFromVersion).toBe('1.18.29');

    // 6) 回归：迁移后对同一主题重复应用 → noop，逐字节不动，也不再产生新序号
    const t2 = await targetOf(inst);
    expect(t2.support).toBe('supported');
    const before3 = await sha256File(inst.archivePath);
    const third = await applyThemeWith(runtime, t2, themeCss('#222222'));
    expect(third.success, JSON.stringify(third.success ? null : third.error)).toBe(true);
    if (!third.success) return;
    expect(third.data.noop).toBe(true);
    expect(await sha256File(inst.archivePath)).toBe(before3);
    expect(fs.existsSync(path.join(originalDir(layout), 'baseline.v2.json'))).toBe(false);
    const stillMigrated = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as {
      meta: { version: string | null };
    };
    expect(stillMigrated.meta.version).toBe('1.18.31');
  });
});

/**
 * 负例公用布置：先按「基线对应 A 版归档」写好基线，再把归档整体换成 B 版重打包。
 * inspect 用的是换后的现场（fingerprint 一致），保证负例尽量走到基线门本体；
 * 锚点/变更集合类可能在更前面的门（structural inspect / 竞态重验）就被拦下——
 * 那也是拒绝，多道门互不依赖是设计使然。
 */
async function setupReplaced(opts: {
  base: Parameters<typeof makeSyntheticInstall>[0];
  updated: Parameters<typeof makeSyntheticInstall>[0];
  baselineVersion: string;
  overrideUnpackedPaths?: string[];
}) {
  const inst = await fixture(opts.base);
  const runtime = tmp('ots-drift-runtime-');
  runtimes.push(runtime);
  const layout = layoutOf(inst, runtime);
  await ensureDirs(layout);

  const built = await buildBaseline(inst.archivePath, isAllowed);
  if (!built.success) throw new Error(built.error.message);
  const w = await writeBaselineFile(originalDir(layout), built.data.entries, {
    version: opts.baselineVersion,
    fingerprint: await sha256File(inst.archivePath),
    unpackedPaths: opts.overrideUnpackedPaths ?? built.data.unpackedPaths,
  });
  if (!w.success) throw new Error(w.error.message);

  await repackOver(inst, opts.updated);
  const before = await sha256File(inst.archivePath);
  const target = await targetOf(inst);
  const r = await applyThemeWith(runtime, target, themeCss('#333333'));
  return { inst, layout, before, r };
}

/** 拒绝场景的公共断言：安装字节不动、基线未迁移、没有新的序号归档 */
async function expectRejectedUntouched(
  t: { inst: SyntheticInstall; layout: RuntimeLayout; before: string },
) {
  expect(await sha256File(t.inst.archivePath)).toBe(t.before);
  expect(fs.existsSync(path.join(originalDir(t.layout), 'baseline.v1.json'))).toBe(false);
}

describe('端到端：不满足自动放行条件的差异维持拒绝', () => {
  it('局部篡改（版本不变、只换一个文件后重打包）→ 拒绝，基线与安装字节不动', async () => {
    const t = await setupReplaced({
      base: {},
      updated: { files: { 'out/main/index.js': 'console.log(2);\n' } },
      baselineVersion: '1.18.29',
    });
    expect(t.r.success).toBe(false);
    if (!t.r.success) {
      expect(t.r.error.code).toBe('ARCHIVE_CORRUPT');
      // 版本没变 → 疑似第三方改动一类文案；明细里能看到分类判定依据
      expect(t.r.error.message).toContain('疑似第三方改动');
      expect(t.r.error.detail ?? '').toContain('自动放行判定未通过');
      expect(t.r.error.detail ?? '').toContain('✗ versionChanged');
    }
    await expectRejectedUntouched(t);
    const stored = JSON.parse(
      fs.readFileSync(path.join(originalDir(t.layout), 'baseline.json'), 'utf8'),
    ) as { meta: { version: string | null } };
    expect(stored.meta.version).toBe('1.18.29');
  });

  it('锚点消失（哪怕版本变了）→ 拒绝且安装字节不变', async () => {
    const t = await setupReplaced({
      base: {},
      updated: {
        version: '1.18.31',
        files: {
          'out/main/index.js': 'console.log(9);\n',
          'out/renderer/index.html':
            '<!doctype html><html><head><title>anchor removed</title><body></body></html>',
        },
      },
      baselineVersion: '1.18.29',
    });
    expect(t.r.success).toBe(false);
    if (!t.r.success) {
      expect(['TARGET_UNSUPPORTED', 'TARGET_HASH_MISMATCH', 'ARCHIVE_CORRUPT']).toContain(
        t.r.error.code,
      );
    }
    await expectRejectedUntouched(t);
  });

  it('变更集合被第三方文件占用 → 拒绝且安装字节不变', async () => {
    const t = await setupReplaced({
      base: {},
      updated: {
        version: '1.18.31',
        files: {
          'out/main/index.js': 'console.log(9);\n',
          'out/renderer/oc-theme-custom.css': 'body{background:url(evil.png)}',
        },
      },
      baselineVersion: '1.18.29',
    });
    expect(t.r.success).toBe(false);
    if (!t.r.success) {
      expect(['TARGET_UNSUPPORTED', 'TARGET_HASH_MISMATCH', 'ARCHIVE_CORRUPT']).toContain(
        t.r.error.code,
      );
    }
    await expectRejectedUntouched(t);
  });

  it('unpacked 原生模块路径集合变化 → 基线门第五条不过，拒绝且安装字节不变', async () => {
    const t = await setupReplaced({
      base: {
        files: {
          'out/main/index.js': 'console.log(1);\n',
          'native/x.node': 'NATIVE',
        },
        unpack: '*.node',
      },
      updated: {
        version: '1.18.31',
        files: {
          'out/main/index.js': 'console.log(9);\n',
          'native/x.node': 'NATIVE2',
        },
      },
      baselineVersion: '1.18.29',
      overrideUnpackedPaths: ['native/x.node'],
    });
    expect(t.r.success).toBe(false);
    if (!t.r.success) {
      expect(t.r.error.code).toBe('ARCHIVE_CORRUPT');
      // 版本变了但原生模块集合不稳 → 「疑似官方更新但未达自动放行条件」一类文案
      expect(t.r.error.message).toContain('疑似被官方更新');
      expect(t.r.error.detail ?? '').toContain('✗ unpackedSet');
    }
    await expectRejectedUntouched(t);
  });
});
