/**
 * 动图策略（Alpha A2）。
 *
 * 本轮**明确拒绝**多帧图片，而不是「按第一帧预览 + 把动图原字节写进安装」——
 * 后者会让用户确认的图与实际生效的图不是同一份。
 *
 * 真实样本：tests/fixtures/animated/ 下的双帧 GIF / 动画 WebP / APNG 由
 * tools/make-animated-fixtures.py（Pillow）生成并已提交 —— sharp 能稳定
 * **读取** GIF/WebP 的多帧（pages=2），只是**生成**不出多帧，所以用 Pillow 造夹具。
 *
 * 拒绝分两层，这是有意为之：
 *   1. GIF 不在支持格式白名单里，在格式检查就被拒（IMAGE_INVALID_FORMAT）；
 *   2. 白名单容器里的多帧（动画 WebP、APNG）才会走到帧数检查（IMAGE_ANIMATED）。
 * 其中 APNG 靠字节层 looksLikeApng（acTL 块）识别——本环境 libvips 8.18.6
 * 读 APNG 不报 pages，只信 pages 会漏放动画 PNG（实测发现并修复）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAnimatedFrameCount, looksLikeApng } from '../../src/core/theme/validate';
import { analyzeImage } from '../../src/core/theme/generate';
import { jpegBytes, pngBytes, webpBytes } from '../fixtures/image-samples';

const fixture = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`../fixtures/animated/${name}`, import.meta.url)));

describe('多帧判定谓词', () => {
  it('页数 > 1 判为动图', () => {
    expect(isAnimatedFrameCount(2)).toBe(true);
    expect(isAnimatedFrameCount(64)).toBe(true);
  });

  it('单帧或拿不到页数都不算动图（APNG 由 acTL 块另行拦截）', () => {
    expect(isAnimatedFrameCount(1)).toBe(false);
    expect(isAnimatedFrameCount(undefined)).toBe(false);
  });
});

describe('looksLikeApng（字节层）', () => {
  it('双帧 APNG 夹具检出 acTL 且 num_frames≠1', () => {
    expect(looksLikeApng(fixture('sample-apng.png'))).toBe(true);
  });

  it('静态 PNG 不误报', async () => {
    expect(looksLikeApng(await pngBytes({ accent: true }))).toBe(false);
  });

  it('非 PNG 签名直接返回 false', () => {
    expect(looksLikeApng(Buffer.from('RIFFxxxxWEBPVP8 '))).toBe(false);
    expect(looksLikeApng(Buffer.alloc(0))).toBe(false);
  });
});

describe('真实多帧样本在 analyzeImage 的拒绝行为', () => {
  it('动画 GIF 在格式白名单被拒（IMAGE_INVALID_FORMAT）——GIF 本就不支持', async () => {
    const r = await analyzeImage(fixture('sample.gif'));
    expect(r.success, 'GIF 必须被拒').toBe(false);
    if (r.success) return;
    expect(r.error.code).toBe('IMAGE_INVALID_FORMAT');
  });

  it.each([
    ['动画 WebP', 'sample.webp', `pages=2`],
    ['APNG（PNG 容器）', 'sample-apng.png', 'APNG acTL'],
  ])('%s 被拒绝：IMAGE_ANIMATED，提示改用静态图片', async (_name, file, detailPart) => {
    const r = await analyzeImage(fixture(file));
    expect(r.success, `${file} 必须被拒`).toBe(false);
    if (r.success) return;
    expect(r.error.code).toBe('IMAGE_ANIMATED');
    expect(r.error.message).toContain('动图');
    expect(r.error.recoveryHint).toContain('静态');
    expect(r.error.detail).toContain(detailPart);
  });
});

describe('静态图片不受影响（回归）', () => {
  it.each([
    ['JPEG', jpegBytes],
    ['PNG', pngBytes],
    ['WebP', webpBytes],
  ])('%s 仍然可以分析', async (_name, make) => {
    const r = await analyzeImage(await make({ accent: true }));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.palette.length).toBeGreaterThan(0);
  });
});
