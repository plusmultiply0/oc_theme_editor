/**
 * 真机核验脚本的可信度（Alpha A3）。
 *
 * 直接跑 `tools/verify-real-install.cjs`：合成一个安装归档，
 * 分别放「完整图片」和「只剩头部的残图」，断言脚本的退出码与判词。
 * 这样验的是脚本**实际接线**，而不是只验背后的模块。
 */
import fs from 'node:fs';
import { testTmpRoot } from '../fixtures/test-tmp';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPackageWithOptions } from '@electron/asar';
import { afterEach, describe, expect, it } from 'vitest';
import { jpegBytes, truncatedJpeg } from '../fixtures/image-samples';

const ROOT = path.resolve(__dirname, '..', '..');
const TOOL = path.join(ROOT, 'tools', 'verify-real-install.cjs');

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()?.();
    } catch {
      // 清理失败不影响判定
    }
  }
});

/** 造一个最小可核验归档：只放核验脚本会看的几个条目 */
async function makeArchiveWithImage(imageBytes: Buffer): Promise<string> {
  const base = fs.mkdtempSync(path.join(testTmpRoot(), 'ots-vri-'));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 }));
  const src = path.join(base, 'src');
  fs.mkdirSync(path.join(src, 'out/renderer'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: '@opencode-ai/desktop', version: '1.18.29' }));
  fs.writeFileSync(
    path.join(src, 'out/renderer/index.html'),
    '<!doctype html><html><head>\n<link rel="stylesheet" href="./oc-theme-custom.css"> <!-- opencode-theme-switcher -->\n</head><body></body></html>',
  );
  // 核验脚本会检查这几个标记，夹具要写成真实产物的形态
  fs.writeFileSync(
    path.join(src, 'out/renderer/oc-theme-custom.css'),
    [
      'html:root {',
      '  --background-base: rgba(1, 2, 3, 0.5);',
      '  --background-stronger: rgba(1, 2, 3, 0.5);',
      '}',
      '#root .bg-v2-background-bg-deep.flex-1 { background-color: transparent; }',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(src, 'out/renderer/oc-theme-background.jpg'), imageBytes);

  const archive = path.join(base, 'app.asar');
  const prev = process.noAsar;
  process.noAsar = true;
  try {
    await createPackageWithOptions(src, archive, {});
  } finally {
    process.noAsar = prev;
  }
  return archive;
}

function runTool(archive: string, extra: string[] = []) {
  return spawnSync(process.execPath, [TOOL, '--archive', archive, ...extra], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
}

describe('verify-real-install：图片核验必须真实解码', () => {
  it('完整 JPEG：识别与解码两项都通过，退出码 0', async () => {
    const archive = await makeArchiveWithImage(await jpegBytes({ accent: true }));
    const r = runTool(archive);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('文件头可识别');
    expect(r.stdout).toContain('完整解码成功');
    // 实际格式来自解码器，不靠条目名后缀推断
    expect(r.stdout).toContain('实际格式 jpeg');
  }, 120_000);

  it('只剩文件头的残图：解码项失败，退出码非 0', async () => {
    const archive = await makeArchiveWithImage(await truncatedJpeg());
    const r = runTool(archive);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('完整解码成功');
    expect(r.stdout).toMatch(/\[FAIL\]\s+完整解码成功|完整解码成功 \|/);
  }, 120_000);

  it('期望哈希不符时退出码非 0', async () => {
    const archive = await makeArchiveWithImage(await jpegBytes({ accent: true }));
    const r = runTool(archive, ['--expect-image-sha256', 'f'.repeat(64)]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('图片哈希等于期望值');
  }, 120_000);

  it('期望尺寸不符时退出码非 0', async () => {
    const archive = await makeArchiveWithImage(await jpegBytes({ accent: true }));
    const r = runTool(archive, ['--expect-image-size', '1234x5678']);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('尺寸等于期望值');
  }, 120_000);
});
