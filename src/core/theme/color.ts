/** 颜色推导工具：明度调整与自动修正，供主题生成使用。 */
import type { Rgb } from './palette';
import { contrastRatio, hexToRgb, rgbToHex } from './contrast';
import { CONTRAST_TARGETS } from './contrast';

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/** amount > 0 变亮，< 0 变暗；在 sRGB 空间线性插值，结果确定 */
export function shift(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  const target = amount > 0 ? 255 : 0;
  const t = Math.abs(amount);
  return rgbToHex({
    r: clamp255(r + (target - r) * t),
    g: clamp255(g + (target - g) * t),
    b: clamp255(b + (target - b) * t),
  });
}

export function lighten(hex: string, amount: number): string {
  return shift(hex, Math.abs(amount));
}

export function darken(hex: string, amount: number): string {
  return shift(hex, -Math.abs(amount));
}

export function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const k = Math.max(0, Math.min(1, t));
  return rgbToHex({
    r: clamp255(ca.r + (cb.r - ca.r) * k),
    g: clamp255(ca.g + (cb.g - ca.g) * k),
    b: clamp255(ca.b + (cb.b - ca.b) * k),
  });
}

/**
 * 逐步调整前景色直到满足对比度目标。
 * 只改文字/遮罩/面板参数，不修改用户的原图（T26）。
 * 无法达标时返回最接近的一次结果，由调用方决定是否判失败。
 */
export function ensureContrast(
  foreground: string,
  background: string,
  target: keyof typeof CONTRAST_TARGETS = 'text',
): { color: string; ratio: number; pass: boolean } {
  const required = CONTRAST_TARGETS[target];
  const bgLum = hexToRgb(background);
  const isDarkBg = (bgLum.r * 0.299 + bgLum.g * 0.587 + bgLum.b * 0.114) < 128;

  let best = foreground;
  let bestRatio = contrastRatio(foreground, background);
  if (bestRatio >= required) return { color: best, ratio: bestRatio, pass: true };

  // 先沿「远离背景」的方向走；走不通再试反方向。
  // 中间调底色（L≈0.18–0.21）上纯白达不到 4.5，此时反方向的深色反而达标，
  // 只认一个方向就会把这种底色判成无解。
  const directions = isDarkBg ? [1, -1] : [-1, 1];
  for (const dir of directions) {
    for (let i = 1; i <= 20; i += 1) {
      const candidate = dir > 0 ? lighten(foreground, i * 0.05) : darken(foreground, i * 0.05);
      const ratio = contrastRatio(candidate, background);
      if (ratio > bestRatio) {
        bestRatio = ratio;
        best = candidate;
      }
      if (ratio >= required) return { color: candidate, ratio, pass: true };
    }
  }
  return { color: best, ratio: bestRatio, pass: false };
}

/** 依据主色推导 hover / pressed，保证三态可区分 */
export function deriveStates(primary: string): { hover: string; pressed: string } {
  return {
    hover: lighten(primary, 0.16),
    pressed: darken(primary, 0.14),
  };
}

export function toRgbTuple(hex: string): Rgb {
  return hexToRgb(hex);
}
