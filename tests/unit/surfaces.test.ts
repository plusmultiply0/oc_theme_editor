/**
 * 层级不透明度模型（事故 F4）。
 *
 * 关键区分：
 * - **局部 alpha**：某一层自己画多少 —— CSS 与预览用它；
 * - **累计 alpha**：从图片/遮罩起算到该层为止 —— 对比度报告用它。
 *
 * 把累计值当局部值画上去，等于重复计算：气泡叠在面板上时实际会变成 1-(1-p)³，
 * 比报告假定的 1-(1-p)² 更实，图更淡、对比度判断也随之失真。
 * Portal（对话框/菜单）没有面板祖先，局部值就是 p，不能套用累计值。
 */
import { describe, expect, it } from 'vitest';
import {
  bubbleAlpha,
  bubbleLayerAlpha,
  overlayAlpha,
  panelAlpha,
  regionById,
  stackedAlpha,
} from '../../src/core/theme/surfaces';
import { renderThemeCss } from '../../src/core/theme/css';
import { deriveTokens } from '../../src/core/theme/generate';
import { hexToRgb } from '../../src/core/theme/contrast';
import { SCHEMA_VERSION, type ThemeSpec } from '../../src/shared/schema';

function spec(over: Partial<ThemeSpec> = {}): ThemeSpec {
  return {
    schemaVersion: SCHEMA_VERSION,
    imageId: 'x',
    mode: 'light',
    palette: ['#5f7396'],
    overlayOpacity: 0.35,
    panelOpacity: 0.31,
    blurPx: 0,
    reducedTransparency: false,
    ...over,
  };
}

describe('局部 alpha 与累计 alpha 分开', () => {
  it('累计值 = 1-(1-p)²，局部值 = p', () => {
    const s = spec({ panelOpacity: 0.31 });
    expect(panelAlpha(s)).toBeCloseTo(0.31, 6);
    expect(bubbleLayerAlpha(s)).toBeCloseTo(0.31, 6);
    expect(bubbleAlpha(s)).toBeCloseTo(1 - 0.69 * 0.69, 6);
    expect(bubbleAlpha(s)).toBeCloseTo(0.5239, 4);
  });

  it('多层叠加以 stackedAlpha 为准，两层 p 等于 bubbleAlpha', () => {
    const s = spec({ panelOpacity: 0.4 });
    expect(stackedAlpha([0.4, 0.4])).toBeCloseTo(bubbleAlpha(s), 6);
    expect(stackedAlpha([0.4, 0.4, 0.4])).toBeCloseTo(1 - 0.6 ** 3, 6);
    expect(stackedAlpha([])).toBe(0);
  });

  it('减少透明度时局部与累计都退化为 1', () => {
    const s = spec({ panelOpacity: 0.2, reducedTransparency: true });
    expect(panelAlpha(s)).toBe(1);
    expect(bubbleLayerAlpha(s)).toBe(1);
    expect(bubbleAlpha(s)).toBe(1);
  });

  it('写入归档的气泡层用局部 p，不是累计 b', () => {
    const s = spec({ panelOpacity: 0.31 });
    const tokens = deriveTokens(s.palette, 'light', undefined, '#e8e8ea');
    const css = renderThemeCss({ tokens, spec: s, imageRef: './bg.jpg', resolvedMode: 'light' });
    const { r, g, b } = hexToRgb(tokens.panel);
    // 局部层画 p
    expect(css).toContain(`[data-slot="session-turn-assistant-content"]`);
    expect(css).toContain(`rgba(${r}, ${g}, ${b}, 0.31)`);
    // 不能再出现累计值 0.52
    expect(css).not.toContain(`rgba(${r}, ${g}, ${b}, 0.52`);
  });

  it('报告里的气泡区域仍按累计值算（文字实际压在两层之上）', () => {
    const s = spec({ panelOpacity: 0.31 });
    const bubble = regionById(s, 'bubble');
    expect(bubble).toBeDefined();
    expect(bubble?.panelAlpha).toBeCloseTo(bubbleAlpha(s), 6);
    // 没有面板祖先的菜单/对话框：局部就是 p，不能用累计值
    const menu = regionById(s, 'menu');
    expect(menu?.panelAlpha).toBeCloseTo(panelAlpha(s), 6);
  });

  it('遮罩不透明度独立，不参与面板层的累计', () => {
    const s = spec({ overlayOpacity: 0.6 });
    expect(overlayAlpha(s)).toBeCloseTo(0.6, 6);
    expect(bubbleAlpha(s)).toBeCloseTo(1 - 0.69 ** 2, 6);
  });
});
