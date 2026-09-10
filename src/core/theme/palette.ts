/**
 * 确定性取色（T22）：同一版本算法、同输入同参数必须得到一致结果。
 * 不使用随机初始化的聚类（如随机种子 k-means），改用量化 + 频次统计 +
 * 稳定排序，保证可重放。
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface PaletteOptions {
  /** 返回的代表色数量 */
  count?: number;
  /** 每通道量化位数，默认 5（32 级） */
  bits?: number;
  /** 忽略接近全透明的像素（仅 RGBA 输入有效） */
  alphaThreshold?: number;
}

const DEFAULTS: Required<PaletteOptions> = {
  count: 6,
  bits: 5,
  alphaThreshold: 8,
};

function toHex({ r, g, b }: Rgb): string {
  const h = (v: number) => v.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** 按 bits 把 0–255 压缩到更少级别，再还原到 0–255，实现确定性量化 */
function quantizeChannel(v: number, bits: number): number {
  const levels = 1 << bits;
  const step = 256 / levels;
  const idx = Math.min(levels - 1, Math.floor(v / step));
  return Math.min(255, Math.round(idx * step + step / 2));
}

function saturation({ r, g, b }: Rgb): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return 0;
  return (max - min) / max;
}

function luminance({ r, g, b }: Rgb): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function distance(a: Rgb, b: Rgb): number {
  // 加权欧氏距离，近似人眼对绿色更敏感
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db);
}

/**
 * 从 RGB（或 RGBA）像素中提取代表色。
 * 输出按「频次降序 + 颜色值升序」稳定排序，保证确定性。
 */
export function extractPalette(
  pixels: Uint8Array | Uint8ClampedArray,
  channels: 3 | 4 = 3,
  options: PaletteOptions = {},
): string[] {
  const opts = { ...DEFAULTS, ...options };
  const step = channels;
  const total = Math.floor(pixels.length / step);
  if (total === 0) return [];

  const counts = new Map<number, { color: Rgb; count: number }>();
  const bits = opts.bits;

  for (let i = 0; i < total; i += 1) {
    const o = i * step;
    if (channels === 4 && pixels[o + 3] < opts.alphaThreshold) continue;
    const r = quantizeChannel(pixels[o], bits);
    const g = quantizeChannel(pixels[o + 1], bits);
    const b = quantizeChannel(pixels[o + 2], bits);
    const key = (r << 16) | (g << 8) | b;
    const hit = counts.get(key);
    if (hit) hit.count += 1;
    else counts.set(key, { color: { r, g, b }, count: 1 });
  }

  if (counts.size === 0) return [];

  const sorted = [...counts.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    const ka = (a.color.r << 16) | (a.color.g << 8) | a.color.b;
    const kb = (b.color.r << 16) | (b.color.g << 8) | b.color.b;
    return ka - kb;
  });

  // 合并视觉上过于接近的颜色，避免取到一串几乎相同的色
  const merged: { color: Rgb; count: number }[] = [];
  const threshold = 48;
  for (const cand of sorted) {
    if (merged.some((m) => distance(m.color, cand.color) < threshold)) continue;
    merged.push({ color: cand.color, count: cand.count });
    if (merged.length >= opts.count * 3) break;
  }

  // 优先保留有饱和度且亮度适中的颜色，纯黑/纯白/灰度图走 fallback
  const scored = merged.map((m) => ({
    ...m,
    score: m.count * (1 + saturation(m.color)) * (1 - Math.abs(luminance(m.color) - 0.5)),
  }));
  scored.sort((a, b) => b.score - a.score);

  let picked = scored.slice(0, opts.count).map((s) => toHex(s.color));

  // fallback：极低饱和或空结果时给出中性灰，避免下游拿到空调色板
  if (picked.length === 0) picked = ['#808080'];
  return picked;
}

/** 判断调色板是否整体偏灰（用于提示用户换图或手动指定主色） */
export function isMostlyGray(palette: string[]): boolean {
  if (palette.length === 0) return true;
  const toRgb = (hex: string): Rgb => ({
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  });
  return palette.every((c) => saturation(toRgb(c)) < 0.12);
}
