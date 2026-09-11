import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { contrastRatio, composite, effectiveBackground, hexToRgb } from '../../src/core/theme/contrast';
import { extractPalette, isMostlyGray } from '../../src/core/theme/palette';
import { DEFAULT_LIMITS, looksLikeSvg, sniffFormat, validateImage } from '../../src/core/theme/validate';
import { validateImageRef } from '../../src/core/theme/css';
import { analyzeImage, deriveTokens, generateTheme } from '../../src/core/theme/generate';
import { SCHEMA_VERSION, type ThemeSpec } from '../../src/shared/schema';

async function solid(width: number, height: number, color: { r: number; g: number; b: number; alpha?: number }) {
  return sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer();
}

function makeSpec(overrides: Partial<ThemeSpec> = {}): ThemeSpec {
  return {
    schemaVersion: SCHEMA_VERSION,
    imageId: 'img_test',
    mode: 'auto',
    palette: ['#404558'],
    overlayOpacity: 0.35,
    panelOpacity: 0.86,
    blurPx: 0,
    backgroundPosition: 'cover',
    ...overrides,
  };
}

describe('格式识别（T20）', () => {
  it('依据 magic bytes 识别 PNG/JPEG/WebP', async () => {
    const png = await solid(8, 8, { r: 10, g: 20, b: 30 });
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg()
      .toBuffer();
    const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .webp()
      .toBuffer();

    expect(sniffFormat(png)).toBe('png');
    expect(sniffFormat(jpeg)).toBe('jpeg');
    expect(sniffFormat(webp)).toBe('webp');
  });

  it('拒绝无法识别的内容与 SVG', () => {
    expect(sniffFormat(Buffer.from('not an image at all!!'))).toBeNull();
    expect(looksLikeSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(true);
  });
});

describe('体积与像素限制（T20）', () => {
  it('超限返回可展示的原因与建议', () => {
    const r = validateImage({ bytes: DEFAULT_LIMITS.maxBytes + 1 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.code).toBe('IMAGE_TOO_LARGE');
      expect(r.error.recoveryHint).not.toBe('');
    }
  });

  it('解码像素超限时拒绝', () => {
    const r = validateImage({ bytes: 1024, width: 8000, height: 6000 });
    expect(r.success).toBe(false);
  });
});

describe('取色确定性（T22）', () => {
  it('同输入同参数结果一致', () => {
    const pixels = new Uint8Array(300);
    for (let i = 0; i < 100; i += 1) {
      pixels[i * 3] = (i * 7) % 256;
      pixels[i * 3 + 1] = (i * 13) % 256;
      pixels[i * 3 + 2] = (i * 29) % 256;
    }
    const a = extractPalette(pixels, 3, { count: 5 });
    const b = extractPalette(pixels, 3, { count: 5 });
    expect(a).toEqual(b);
  });

  it('灰度图被识别为低饱和，供 UI 提示', () => {
    expect(isMostlyGray(['#808080', '#7a7a7a'])).toBe(true);
    expect(isMostlyGray(['#c0392b'])).toBe(false);
  });
});

describe('对比度（T25、T26）', () => {
  it('黑白对比度为 21', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });

  it('相同颜色对比度为 1', () => {
    expect(contrastRatio('#123456', '#123456')).toBeCloseTo(1, 5);
  });

  it('半透明面板必须合成后再比较，不能直比较两枚 token', () => {
    const image = { r: 20, g: 30, b: 40 };
    const panel = { r: 255, g: 255, b: 255 };
    const effective = effectiveBackground(image, { r: 0, g: 0, b: 0 }, 0, panel, 0.5);
    expect(effective.r).toBeGreaterThan(image.r);
    expect(effective.r).toBeLessThan(panel.r);
  });

  it('合成公式符合 alpha 混合', () => {
    const c = composite({ r: 255, g: 255, b: 255 }, 0.5, { r: 0, g: 0, b: 0 });
    expect(c).toEqual({ r: 127.5, g: 127.5, b: 127.5 });
  });
});

describe('图片引用白名单（T23）', () => {
  it('接受归档内相对路径', () => {
    expect(validateImageRef('./oc-theme-background.jpg').success).toBe(true);
  });

  it.each(['https://example.com/a.jpg', '//cdn.example.com/a.jpg', '/abs/a.jpg', "a.jpg';}body{"])(
    '拒绝 %s',
    (ref) => {
      expect(validateImageRef(ref).success).toBe(false);
    },
  );
});

describe('主题生成', () => {
  it('纯黑图片生成主题后正文对比度达标', async () => {
    const buf = await solid(64, 64, { r: 0, g: 0, b: 0 });
    const r = await generateTheme({ buffer: buf, spec: makeSpec(), imageRef: './bg.jpg' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(contrastRatio(r.data.tokens.text, r.data.tokens.panel)).toBeGreaterThanOrEqual(4.5);
      expect(r.data.css).toContain("url('./bg.jpg')");
    }
  });

  it('纯白图片生成主题后正文对比度达标', async () => {
    const buf = await solid(64, 64, { r: 255, g: 255, b: 255 });
    const r = await generateTheme({ buffer: buf, spec: makeSpec(), imageRef: './bg.jpg' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(contrastRatio(r.data.tokens.text, r.data.tokens.panel)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('同一张图两次生成结果完全一致（可重放）', async () => {
    const buf = await solid(48, 48, { r: 64, g: 96, b: 160 });
    const a = await generateTheme({ buffer: buf, spec: makeSpec(), imageRef: './bg.jpg' });
    const b = await generateTheme({ buffer: buf, spec: makeSpec(), imageRef: './bg.jpg' });
    expect(a).toEqual(b);
  });

  it('损坏图片被拒绝并给出原因', async () => {
    const r = await analyzeImage(Buffer.from('not an image at all!!'));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('IMAGE_INVALID_FORMAT');
  });

  it('SVG 被明确拒绝', async () => {
    const r = await analyzeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toContain('SVG');
  });

  it('auto 模式按图片明暗选择基调', async () => {
    const dark = await solid(32, 32, { r: 8, g: 8, b: 12 });
    const light = await solid(32, 32, { r: 240, g: 240, b: 245 });
    const d = await generateTheme({ buffer: dark, spec: makeSpec(), imageRef: './bg.jpg' });
    const l = await generateTheme({ buffer: light, spec: makeSpec(), imageRef: './bg.jpg' });
    expect(d.success && d.data.mode).toBe('dark');
    expect(l.success && l.data.mode).toBe('light');
  });

  it('color-scheme 与解析后的基调一致，不跟随 spec.mode 的字面值', async () => {
    const dark = await solid(32, 32, { r: 8, g: 8, b: 12 });
    const light = await solid(32, 32, { r: 240, g: 240, b: 245 });
    const d = await generateTheme({ buffer: dark, spec: makeSpec(), imageRef: './bg.jpg' });
    const l = await generateTheme({ buffer: light, spec: makeSpec(), imageRef: './bg.jpg' });
    expect(d.success && d.data.css).toContain('color-scheme: dark');
    expect(l.success && l.data.css).toContain('color-scheme: light');
  });

  it('显式指定 dark 时，即便图片偏亮也输出 dark', async () => {
    const light = await solid(32, 32, { r: 240, g: 240, b: 245 });
    const r = await generateTheme({
      buffer: light,
      spec: makeSpec({ mode: 'dark' }),
      imageRef: './bg.jpg',
    });
    expect(r.success && r.data.mode).toBe('dark');
    expect(r.success && r.data.css).toContain('color-scheme: dark');
  });

  it('返回三层合成后的实际底色与对比度报告', async () => {
    const buf = await solid(48, 48, { r: 64, g: 96, b: 160 });
    const r = await generateTheme({ buffer: buf, spec: makeSpec(), imageRef: './bg.jpg' });
    expect(r.success).toBe(true);
    if (r.success) {
      const text = r.data.report.entries.find((e) => e.element === '正文');
      expect(text?.pass).toBe(true);
      expect(r.data.effectiveBackground).toMatch(/^#[0-9a-f]{6}$/);
      // 实际底色应当既不是纯图片色，也不是纯面板色
      expect(r.data.effectiveBackground).not.toBe(r.data.palette[0]);
      expect(r.data.effectiveBackground).not.toBe(r.data.tokens.panel);
    }
  });

  it('报告逐条给出元素、实测值与目标值，且未做真实采样时不得标记 verified', async () => {
    const buf = await solid(48, 48, { r: 64, g: 96, b: 160 });
    const r = await generateTheme({ buffer: buf, spec: makeSpec(), imageRef: './bg.jpg' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.report.entries.length).toBeGreaterThan(5);
      for (const e of r.data.report.entries) {
        expect(e.required).toBeGreaterThan(0);
        expect(e.ratio).toBeGreaterThan(0);
      }
      expect(r.data.report.verified).toBe(false);
      expect(r.data.report.scope).toContain('不含应用自带的终端配色');
    }
  });

  it('主色可覆盖，且 hover/pressed 三态互不相同', () => {
    const tokens = deriveTokens(['#404558'], 'light', '#2f6fd0');
    expect(tokens.primary).toBe('#2f6fd0');
    expect(new Set([tokens.primary, tokens.hover, tokens.pressed]).size).toBe(3);
  });

  it('状态色与 diff 色独立于主色，不被主题污染（T27）', () => {
    const tokens = deriveTokens(['#c0392b'], 'dark');
    // 保持色相语义：错误偏红、成功偏绿，且两者不同
    const err = hexToRgb(tokens.status.error);
    const ok = hexToRgb(tokens.status.success);
    expect(err.r).toBeGreaterThan(err.g);
    expect(ok.g).toBeGreaterThan(ok.r);
    expect(tokens.status.error).not.toBe(tokens.primary);
    expect(tokens.diff.added).not.toBe(tokens.diff.removed);
  });

  it('深色基调下状态色与 diff 色仍满足正文对比度', () => {
    const tokens = deriveTokens(['#101418'], 'dark', undefined, '#1b1f27');
    for (const c of [
      tokens.status.error,
      tokens.status.warning,
      tokens.status.success,
      tokens.status.info,
      tokens.diff.added,
      tokens.diff.removed,
    ]) {
      expect(contrastRatio(c, '#1b1f27')).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('hex 解析正确', () => {
    expect(hexToRgb('#ff8000')).toEqual({ r: 255, g: 128, b: 0 });
  });
});
