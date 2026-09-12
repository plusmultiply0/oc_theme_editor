/**
 * 动图策略（Alpha A2）。
 *
 * 本轮**明确拒绝**多帧图片，而不是「按第一帧预览 + 把动图原字节写进安装」——
 * 后者会让用户确认的图与实际生效的图不是同一份。
 *
 * ⚠️ 覆盖范围限制（如实记录）：本机 sharp 无法**生成**多帧输出
 * （试过 webp/gif 的 pageHeight 构造，读回的 pages 恒为 1），
 * 因此这里只对判定谓词做单测；「真实动画 WebP/APNG 被拒绝」需要
 * 在 A5/A6 用真实动图样本补验，不能凭这条单测声称已验证。
 */
import { describe, expect, it } from 'vitest';
import { isAnimatedFrameCount } from '../../src/core/theme/validate';
import { analyzeImage } from '../../src/core/theme/generate';
import { jpegBytes, pngBytes, webpBytes } from '../fixtures/image-samples';

describe('多帧判定谓词', () => {
  it('页数 > 1 判为动图', () => {
    expect(isAnimatedFrameCount(2)).toBe(true);
    expect(isAnimatedFrameCount(64)).toBe(true);
  });

  it('单帧或拿不到页数都不算动图', () => {
    expect(isAnimatedFrameCount(1)).toBe(false);
    expect(isAnimatedFrameCount(undefined)).toBe(false);
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
