/**
 * 对比度计算（T25、T26）。
 * 按 WCAG 相对亮度公式实现；透明场景必须先把「图像 + 遮罩 + 面板」
 * 合成后的颜色算出来再比较，不能只比较两枚 token（T26）。
 */
import type { Rgb } from './palette';

export function hexToRgb(hex: string): Rgb {
  const s = hex.replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function channelToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);
}

/** WCAG 对比度，返回 1–21 */
export function contrastRatio(a: Rgb | string, b: Rgb | string): number {
  const ca = typeof a === 'string' ? hexToRgb(a) : a;
  const cb = typeof b === 'string' ? hexToRgb(b) : b;
  const la = relativeLuminance(ca);
  const lb = relativeLuminance(cb);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * 把带 alpha 的前景合成到背景上，得到实际显示颜色。
 * 用于「半透明面板叠在图片上」这类场景，避免直接比较 token 造成误判。
 */
export function composite(over: Rgb, alpha: number, under: Rgb): Rgb {
  const a = Math.max(0, Math.min(1, alpha));
  return {
    r: over.r * a + under.r * (1 - a),
    g: over.g * a + under.g * (1 - a),
    b: over.b * a + under.b * (1 - a),
  };
}

/**
 * 图片 → 遮罩 → 面板 三层合成后的实际底色。
 * 顺序：先按遮罩把图片压暗/提亮，再把半透明面板叠上去。
 */
export function effectiveBackground(
  imagePixel: Rgb,
  overlayColor: Rgb,
  overlayOpacity: number,
  panelColor: Rgb,
  panelOpacity: number,
): Rgb {
  const masked = composite(overlayColor, overlayOpacity, imagePixel);
  return composite(panelColor, panelOpacity, masked);
}

/** 对比度目标（T25）：正文 4.5，重要非文本控件/焦点 3 */
export const CONTRAST_TARGETS = {
  text: 4.5,
  largeText: 3,
  ui: 3,
} as const;

export function meetsTarget(ratio: number, target: keyof typeof CONTRAST_TARGETS): boolean {
  return ratio >= CONTRAST_TARGETS[target];
}
