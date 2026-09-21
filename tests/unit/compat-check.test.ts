/**
 * 结构验证判据（compat-check）单元测试 —— structural-compat 计划 S4。
 *
 * 全部对着合成归档跑（@electron/asar 真实打包），只读不写；
 * 场景对照 PLAN：锚点 0/1/2 次、css 被第三方占用、孤儿图片、自身产物再应用、
 * htmlEntry 缺失、unpacked 缺项（信息项不阻断）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { makeSyntheticInstall, type SyntheticInstallOptions } from '../fixtures/synthetic-install';
import { adapterById } from '../../src/adapters/registry';
import type { TargetAdapter } from '../../src/adapters/types';
import { readAsar, type AsarSnapshot } from '../../src/core/patch/asar';
import { describeFailed, verifyStructure, type CompatReport } from '../../src/core/patch/compat-check';
import { CSS_OWN_BANNER, HTML_INJECT_COMMENT } from '../../src/core/patch/markers';

const adapter = adapterById('opencode-desktop-win-asar') as TargetAdapter;

const installs: Array<{ cleanup(): void }> = [];

afterEach(() => {
  while (installs.length) installs.pop()?.cleanup();
});

/** 默认 fs 缝：unpacked 目录不存在（合成安装本就没有磁盘目录），聚焦归档内容判据 */
const noUnpacked = {
  fs: {
    existsSync: () => false,
    statSync: () => {
      throw new Error('not called when existsSync is false');
    },
  },
};

async function snapshotFor(opts: SyntheticInstallOptions = {}): Promise<AsarSnapshot> {
  const inst = await makeSyntheticInstall(opts);
  installs.push(inst);
  const r = await readAsar(inst.archivePath);
  if (!r.success) throw new Error('合成归档读取失败');
  return r.data;
}

function check(report: CompatReport, key: string) {
  const c = report.checks.find((x) => x.key === key);
  if (!c) throw new Error(`缺少检查项 ${key}`);
  return c;
}

describe('verifyStructure：锚点唯一性', () => {
  it('锚点恰好 1 次（默认夹具）→ PASS 且整体兼容', async () => {
    const report = await verifyStructure(await snapshotFor(), adapter, noUnpacked);
    expect(check(report, 'anchor').status).toBe('PASS');
    expect(report.compatible).toBe(true);
    expect(report.failedNames).toEqual([]);
  });

  it('锚点 0 次 → FAIL「结构已变」', async () => {
    const snap = await snapshotFor({
      files: { 'out/renderer/index.html': '<html><body>no head here</body></html>' },
    });
    const report = await verifyStructure(snap, adapter, noUnpacked);
    expect(check(report, 'anchor').status).toBe('FAIL');
    expect(check(report, 'anchor').detail).toContain('0 次');
    expect(report.compatible).toBe(false);
  });

  it('锚点 2 次 → FAIL 不唯一（不猜测、不降级为 WARN）', async () => {
    const snap = await snapshotFor({
      files: {
        'out/renderer/index.html':
          '<html><head><title>a</title></head><head><title>b</title></head><body></body></html>',
      },
    });
    const report = await verifyStructure(snap, adapter, noUnpacked);
    expect(check(report, 'anchor').status).toBe('FAIL');
    expect(check(report, 'anchor').detail).toContain('2 次');
    expect(report.compatible).toBe(false);
  });

  it('htmlEntry 条目缺失 → 按 0 次处理，FAIL「注入落点不存在」', async () => {
    const snap = await snapshotFor();
    const broken: TargetAdapter = {
      ...adapter,
      injection: { ...adapter.injection, htmlEntry: 'out/renderer/nonexistent.html' },
    };
    const report = await verifyStructure(snap, broken, noUnpacked);
    expect(check(report, 'anchor').status).toBe('FAIL');
    expect(check(report, 'anchor').detail).toContain('读不到');
    expect(report.compatible).toBe(false);
  });
});

describe('verifyStructure：变更集合归属', () => {
  it('css/image 都不存在 → PASS，detail 报条目总数', async () => {
    const report = await verifyStructure(await snapshotFor(), adapter, noUnpacked);
    expect(check(report, 'changeSet').status).toBe('PASS');
    expect(check(report, 'changeSet').detail).toContain('两文件均不存在（干净）');
    expect(check(report, 'changeSet').detail).toMatch(/归档共 \d+ 条目/);
  });

  it('css 被第三方占用（无归属标记）→ FAIL 点名文件', async () => {
    const snap = await snapshotFor({ files: { 'out/renderer/oc-theme-custom.css': 'body{}' } });
    const report = await verifyStructure(snap, adapter, noUnpacked);
    expect(check(report, 'changeSet').status).toBe('FAIL');
    expect(check(report, 'changeSet').detail).toContain('第三方占用');
    expect(check(report, 'changeSet').detail).toContain('oc-theme-custom.css');
    expect(report.compatible).toBe(false);
  });

  it('只有图片没有 css（孤儿产物）→ 无法自证归属，按占用 FAIL', async () => {
    const snap = await snapshotFor({ files: { 'out/renderer/oc-theme-background.jpg': 'jpegbytes' } });
    const report = await verifyStructure(snap, adapter, noUnpacked);
    expect(check(report, 'changeSet').status).toBe('FAIL');
    expect(check(report, 'changeSet').detail).toContain('oc-theme-background.jpg');
  });

  it('自身产物（注入标记+生成横幅齐全）→ PASS「本工具产物」', async () => {
    const snap = await snapshotFor({
      files: {
        'out/renderer/index.html':
          '<!doctype html><html><head><title>t</title>' +
          `<link rel="stylesheet" href="./${adapter.injection.cssFile.split('/').pop()}"> ${HTML_INJECT_COMMENT}\n` +
          '</head><body></body></html>',
        [adapter.injection.cssFile]: `/* ${CSS_OWN_BANNER}；测试夹具 */\nhtml{}`,
        [adapter.injection.imageFile]: 'jpegbytes',
      },
    });
    const report = await verifyStructure(snap, adapter, noUnpacked);
    expect(check(report, 'changeSet').status).toBe('PASS');
    expect(check(report, 'changeSet').detail).toContain('本工具产物');
    expect(report.compatible).toBe(true);
  });

  it('CSS 有横幅但 HTML 无注入标记 → 归属不成立，FAIL', async () => {
    const snap = await snapshotFor({
      files: { [adapter.injection.cssFile]: `/* ${CSS_OWN_BANNER} */\nhtml{}` },
    });
    const report = await verifyStructure(snap, adapter, noUnpacked);
    expect(check(report, 'changeSet').status).toBe('FAIL');
  });
});

describe('verifyStructure：unpacked 信息项 + 报告组装', () => {
  it('unpacked 目录缺失 → WARN 但不阻断（compatible 仍 true）', async () => {
    const report = await verifyStructure(await snapshotFor(), adapter, noUnpacked);
    expect(check(report, 'unpacked').status).toBe('WARN');
    expect(report.compatible).toBe(true);
    expect(report.failedNames).toEqual([]);
  });

  it('unpacked 目录在位 → PASS', async () => {
    const snap = await snapshotFor();
    const fakeFs = {
      existsSync: () => true,
      statSync: () => ({ isDirectory: () => true }),
    };
    const report = await verifyStructure(snap, adapter, { fs: fakeFs });
    expect(check(report, 'unpacked').status).toBe('PASS');
    expect(snap.archivePath).toContain('app.asar');
  });

  it('describeFailed 只组装 FAIL 项为「名称——细节」', async () => {
    const snap = await snapshotFor({
      files: {
        'out/renderer/index.html': '<html><body>no head</body></html>',
        'out/renderer/oc-theme-custom.css': 'body{}',
      },
    });
    const report = await verifyStructure(snap, adapter, noUnpacked);
    const text = describeFailed(report);
    expect(text).toContain('注入锚点——');
    expect(text).toContain('变更集合归属——');
    expect(text).not.toContain('unpacked');
    expect(report.failedNames).toEqual(['注入锚点', '变更集合归属']);
  });
});
