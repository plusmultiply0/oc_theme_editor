/**
 * 基线门禁分类放行的端到端回归（baseline-drift B2 → drift-gate-r2 Y1/Y2）。
 *
 * 真实事故形态：OpenCode 自动更新整体替换 asar → 成千条目与基线不符 →
 * 旧逻辑一票否决且无路可走（A5）；B 轮修复后又被「版本陌生/量级/unpacked」
 * 三条件误伤（真机 1081 拒绝）。R2 之后放行判据与 discover 的 structural
 * 通道完全同源——verifyStructure 无 FAIL 即放行。这里验证两扇门：
 * - 结构可行（版本陌生/零星差异/unpacked 集合变化都不否决）→ 自动重新接管放行，
 *   旧基线按序号归档留存，操作记录留下证据，事件文案明示「经结构验证放行」；
 * - 结构验证 FAIL（锚点丢失/变更集合被第三方占用）→ 维持拒绝，安装字节逐字节不变。
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

describe('端到端：结构可行的目标更新自动重新接管（A5 死循环的正式修复）', () => {
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

    // 3) 用更新前的目标记录重应用（A5 的真实链路）：分类判定 injectable → 放行
    const secondEvents: string[] = [];
    const second = await applyThemeWith(runtime, target, themeCss('#222222'), secondEvents);
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data.noop).toBe(false);
    // 放行不是静默搬家（B3+Y2）：进度事件明示新版本、结构验证口径与基线迁移
    expect(
      secondEvents.some(
        (m) =>
          m.includes('已更新至 1.18.31') &&
          m.includes('未在白名单，经结构验证放行') &&
          m.includes('已自动更新基线'),
      ),
    ).toBe(true);
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
 * 正例公用布置：先按「基线对应 A 版归档」写好基线，再把归档整体换成 B 版重打包。
 * 与 setupReplaced 相同的布置，但预期 R2 之后**放行**——零星差异、版本陌生、
 * unpacked 集合变化都不再是否决理由，只有结构验证 FAIL 才拒。
 */
async function setupDrifted(opts: {
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
  const target = await targetOf(inst);
  const events: string[] = [];
  const r = await applyThemeWith(runtime, target, themeCss('#333333'), events);
  return { inst, runtime, layout, r, events };
}

/** 负例公用布置：与 setupDrifted 相同，但预期拒绝。 */
async function setupReplaced(opts: {
  base: Parameters<typeof makeSyntheticInstall>[0];
  updated: Parameters<typeof makeSyntheticInstall>[0];
  baselineVersion: string;
  overrideUnpackedPaths?: string[];
}) {
  const t = await setupDrifted(opts);
  return { inst: t.inst, layout: t.layout, before: await sha256File(t.inst.archivePath), r: t.r };
}

/** 拒绝场景的公共断言：安装字节不动、基线未迁移、没有新的序号归档 */
async function expectRejectedUntouched(
  t: { inst: SyntheticInstall; layout: RuntimeLayout; before: string },
) {
  expect(await sha256File(t.inst.archivePath)).toBe(t.before);
  expect(fs.existsSync(path.join(originalDir(t.layout), 'baseline.v1.json'))).toBe(false);
}

/** 放行场景的公共断言：基线已迁移到新版本、旧基线按序号留存、事件含结构验证口径 */
async function expectRebaselined(
  t: { layout: RuntimeLayout; events: string[] },
  newVersion: string,
) {
  expect(fs.existsSync(path.join(originalDir(t.layout), 'baseline.v1.json'))).toBe(true);
  const migrated = JSON.parse(
    fs.readFileSync(path.join(originalDir(t.layout), 'baseline.json'), 'utf8'),
  ) as { meta: { version: string | null } };
  expect(migrated.meta.version).toBe(newVersion);
  expect(t.events.some((m) => m.includes('经结构验证放行') && m.includes('已自动更新基线'))).toBe(
    true,
  );
}

describe('端到端：差异只是证据——结构可行即放行（真机 1081 缺陷的钉子）', () => {
  it('未知版本 + unpacked 原生模块集合变化（锚点在、变更集合净）→ 放行重新接管', async () => {
    const t = await setupDrifted({
      base: {
        files: {
          'out/main/index.js': 'console.log(1);\n',
          'native/x.node': 'NATIVE',
        },
        unpack: '*.node',
      },
      updated: {
        version: '1.18.99',
        files: {
          'out/main/index.js': 'console.log(9);\n',
          'native/x.node': 'NATIVE2',
        },
      },
      baselineVersion: '1.18.29',
      overrideUnpackedPaths: ['native/x.node'],
    });
    expect(t.r.success, JSON.stringify(t.r.success ? null : t.r.error)).toBe(true);
    await expectRebaselined(t, '1.18.99');
  });

  it('零星差异（版本相同、只换一个文件）但结构完好 → 放行；量级与版本证据不再否决', async () => {
    const t = await setupDrifted({
      base: {},
      updated: { files: { 'out/main/index.js': 'console.log(2);\n' } },
      baselineVersion: '1.18.29',
    });
    expect(t.r.success, JSON.stringify(t.r.success ? null : t.r.error)).toBe(true);
    await expectRebaselined(t, '1.18.29');
  });

  it('legacy 基线（无版本记录）+ 版本陌生 + 结构可行 → 放行', async () => {
    const t = await setupDrifted({
      base: {},
      updated: {
        version: '1.18.40',
        files: { 'out/main/index.js': 'console.log(9);\n' },
      },
      baselineVersion: '1.18.29',
    });
    expect(t.r.success, JSON.stringify(t.r.success ? null : t.r.error)).toBe(true);
    await expectRebaselined(t, '1.18.40');
  });
});

describe('端到端：结构验证 FAIL 维持拒绝', () => {
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

  it('归档读不出（头部被破坏）→ 拒绝且安装字节不变', async () => {
    const inst = await fixture();
    const runtime = tmp('ots-drift-runtime-');
    runtimes.push(runtime);
    const layout = layoutOf(inst, runtime);
    await ensureDirs(layout);
    // 无基线（首次接管形态）+ 归档损坏：门禁照旧拒绝，绝不带病接管
    const target = await targetOf(inst);
    const fd = fs.openSync(inst.archivePath, 'r+');
    fs.writeSync(fd, Buffer.from([0, 0, 0, 0]), 0, 4, 0);
    fs.closeSync(fd);
    const before = await sha256File(inst.archivePath);
    const r = await applyThemeWith(runtime, target, themeCss('#333333'));
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(['TARGET_UNSUPPORTED', 'ARCHIVE_CORRUPT']).toContain(r.error.code);
    }
    expect(await sha256File(inst.archivePath)).toBe(before);
  });
});
