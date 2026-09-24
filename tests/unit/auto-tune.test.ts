/**
 * F3「自动调整」的推导规则单测。
 * 参数区间是硬约束（深浅两图落进各自映射段），对比度自检走真实生成管线，
 * 不允许只测纯函数就宣称「调整后一定可读」。
 */
import { describe, expect, it } from 'vitest';
import {
  AUTO_TUNE,
  autoTuneParams,
  edgeFractionFromRgba,
  hexLuminance,
  overlayStepUp,
  worstMargin,
} from '../../src/renderer/logic';
import { analyzeImage, generateTheme } from '../../src/core/theme/generate';
import { SCHEMA_VERSION, type ContrastReport, type ThemeSpec } from '../../src/shared/schema';
import { pngBytes } from '../fixtures/image-samples';

function makeSpec(overrides: Partial<ThemeSpec> = {}): ThemeSpec {
  return {
    schemaVersion: SCHEMA_VERSION,
    imageId: 'img_test',
    mode: 'auto',
    palette: ['#404558'],
    overlayOpacity: 0.35,
    panelOpacity: 0.86,
    blurPx: 0,
    reducedTransparency: false,
    ...overrides,
  };
}

/** 合一张纯色图，走真实取色管线拿 palette（界面「自动调整」用的就是这份代表色） */
async function paletteOf(color: { r: number; g: number; b: number }): Promise<string[]> {
  const buffer = await pngBytes({ color, width: 96, height: 64 });
  const analyzed = await analyzeImage(buffer);
  if (!analyzed.success) throw new Error(`取色失败：${analyzed.error.message}`);
  return analyzed.data.palette;
}

describe('亮度与遮罩映射（F3）', () => {
  it('深图落在映射段低位、浅图落在高位，面板恒为 0.85', async () => {
    const darkPalette = await paletteOf({ r: 12, g: 14, b: 20 });
    const lightPalette = await paletteOf({ r: 240, g: 240, b: 245 });

    const dark = autoTuneParams(darkPalette, 0);
    const light = autoTuneParams(lightPalette, 0);

    expect(dark.overlayOpacity).toBeGreaterThanOrEqual(AUTO_TUNE.overlayMin);
    expect(dark.overlayOpacity).toBeLessThan(AUTO_TUNE.overlayMin + 0.10);
    expect(light.overlayOpacity).toBeGreaterThan(AUTO_TUNE.overlayMax - 0.10);
    expect(light.overlayOpacity).toBeLessThanOrEqual(AUTO_TUNE.overlayMax);
    expect(dark.overlayOpacity).toBeLessThan(light.overlayOpacity);
    expect(dark.panelOpacity).toBe(AUTO_TUNE.panelOpacity);
    expect(light.panelOpacity).toBe(AUTO_TUNE.panelOpacity);
  });

  it('hexLuminance：黑 0、白 1、无法解析按中灰', () => {
    expect(hexLuminance('#000000')).toBe(0);
    expect(hexLuminance('#ffffff')).toBe(1);
    expect(hexLuminance('not-a-color')).toBe(0.5);
  });

  it('空 palette 按中灰处理，遮罩仍夹在映射段内', () => {
    const t = autoTuneParams([], 0);
    expect(t.overlayOpacity).toBeGreaterThanOrEqual(AUTO_TUNE.overlayMin);
    expect(t.overlayOpacity).toBeLessThanOrEqual(AUTO_TUNE.overlayMax);
  });
});

describe('边缘占比与模糊（F3）', () => {
  function rgba(width: number, height: number, paint: (x: number, y: number) => number): Uint8ClampedArray {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = paint(x, y);
        const i = (y * width + x) * 4;
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
    return data;
  }

  it('平坦图边缘占比为 0，模糊给 0', () => {
    const flat = rgba(16, 16, () => 128);
    const frac = edgeFractionFromRgba(flat, 16, 16);
    expect(frac).toBe(0);
    expect(autoTuneParams(['#808080'], frac).blurPx).toBe(0);
  });

  it('2px 棋盘格边缘占比达满档门槛，模糊给到上限 8px', () => {
    const checker = rgba(32, 32, (x, y) => ((x >> 1) + (y >> 1)) % 2 === 0 ? 0 : 255);
    const frac = edgeFractionFromRgba(checker, 32, 32);
    expect(frac).toBeGreaterThanOrEqual(AUTO_TUNE.edgeFracHigh);
    expect(autoTuneParams(['#808080'], frac).blurPx).toBe(AUTO_TUNE.blurHigh);
  });

  it('介于门槛之间时模糊在 4–8 线性取值', () => {
    const mid = AUTO_TUNE.edgeFracLow + (AUTO_TUNE.edgeFracHigh - AUTO_TUNE.edgeFracLow) / 2;
    const blur = autoTuneParams(['#808080'], mid).blurPx;
    expect(blur).toBeGreaterThanOrEqual(AUTO_TUNE.blurLow);
    expect(blur).toBeLessThanOrEqual(AUTO_TUNE.blurHigh);
    expect(blur).toBe(6);
  });

  it('小于 3×3 的图不做测量，按平坦处理', () => {
    expect(edgeFractionFromRgba(new Uint8ClampedArray(2 * 2 * 4), 2, 2)).toBe(0);
  });
});

describe('遮罩步进与余量（F3）', () => {
  it('每次 +0.05，封顶 0.95 后原地不动', () => {
    expect(overlayStepUp(0.55)).toBe(0.6);
    expect(overlayStepUp(0.93)).toBe(AUTO_TUNE.stepUpCap);
    expect(overlayStepUp(AUTO_TUNE.stepUpCap)).toBe(AUTO_TUNE.stepUpCap);
  });

  it('worstMargin 取余量最差的一项；空报告为 Infinity', () => {
    const report = (entries: { ratio: number; required: number }[]): ContrastReport => ({
      entries: entries.map((e, i) => ({
        element: `el${i}`,
        state: 'normal',
        foreground: '#111111',
        background: '#eeeeee',
        ratio: e.ratio,
        required: e.required,
        target: 'text',
        pass: e.ratio >= e.required,
        estimated: false,
        samples: 1,
      })),
      passed: true,
      scope: 'test',
      sampling: 'test',
      verified: true,
    });
    expect(worstMargin(report([{ ratio: 7, required: 4.5 }, { ratio: 3.2, required: 3 }]))).toBeCloseTo(3.2 / 3);
    expect(worstMargin(report([]))).toBe(Infinity);
  });
});

describe('自动调整后的参数走真实生成管线对比度达标（F3 验收）', () => {
  it.each([
    ['深图', { r: 12, g: 14, b: 20 }],
    ['浅图', { r: 240, g: 240, b: 245 }],
  ])('%s：generateTheme 成功且 report.passed', async (_label, color) => {
    const buffer = await pngBytes({ color, accent: true, width: 96, height: 64 });
    const analyzed = await analyzeImage(buffer);
    if (!analyzed.success) throw new Error(`取色失败：${analyzed.error.message}`);

    const tuned = autoTuneParams(analyzed.data.palette, 0.2);
    expect(tuned.overlayOpacity).toBeGreaterThanOrEqual(AUTO_TUNE.overlayMin);
    expect(tuned.overlayOpacity).toBeLessThanOrEqual(AUTO_TUNE.overlayMax);
    expect(tuned.panelOpacity).toBe(AUTO_TUNE.panelOpacity);

    const spec = makeSpec({ ...tuned, palette: analyzed.data.palette });
    const generated = await generateTheme({ buffer, spec, imageRef: './bg.jpg' });
    expect(generated.success).toBe(true);
    if (generated.success) {
      expect(generated.data.report.passed).toBe(true);
    }
  });
});
