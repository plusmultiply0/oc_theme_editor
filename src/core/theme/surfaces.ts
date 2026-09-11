/**
 * 统一主题层级模型（R4、R5）。
 *
 * 之前预览、对比度计算、实际写进归档的 CSS 各算各的：预览用 RGBA 半透明面板、
 * 输出却把面板合成成 HEX 实底，报告又按第三种口径估，于是「预览好看、应用变样」。
 *
 * 这里给出**唯一一份**层级描述，三处共用：
 *
 *   图片层 → 图片遮罩层 → 区域面板层 → （可选）区域叠加层 → 文字
 *
 * 每一层只有「颜色 + 不透明度」两个参数，合成一律用 Source-Over，
 * 因此预览 CSS、归档 CSS、对比度报告能逐项对上。
 */
import type { ThemeSpec, ThemeTokens } from '../../shared/schema';
import { composite, hexToRgb, rgbToHex } from './contrast';
import type { Rgb } from './palette';

/** 面板层不透明度：开了「减少透明度」就退化为纯色（这个开关是真参数，不只是预览辅助） */
export function panelAlpha(spec: ThemeSpec): number {
  return spec.reducedTransparency ? 1 : spec.panelOpacity;
}

/**
 * 多层 Source-Over 叠加后的**累计**不透明度（从最底层起算）。
 * 报告要的是这个值：文字实际压在几层之上，对比度必须按累计结果算。
 */
export function stackedAlpha(layers: readonly number[]): number {
  let transparent = 1;
  for (const a of layers) transparent *= 1 - a;
  return 1 - transparent;
}

/**
 * 对话气泡：叠在正文面板**之上**的又一层面板，两层都是 p。
 *
 * 注意区分两种口径（事故 F4）：
 * - **累计口径**（报告用）：从图片/遮罩起算到气泡为止 = 1-(1-p)²；
 * - **局部口径**（CSS 与预览用）：气泡这一层自己只画 p —— 它下面的面板层已经算过一次，
 *   若把累计值再当作局部 alpha 画上去，实际会变成 1-(1-p)³，比报告假定的更实，
 *   图更淡、对比度判断也随之失真。
 *
 * Portal（对话框/菜单）没有面板祖先，它们的局部值就是 p，不要套用累计值。
 */
export function bubbleAlpha(spec: ThemeSpec): number {
  const a = panelAlpha(spec);
  return stackedAlpha([a, a]);
}

/** 气泡层的**局部** alpha：CSS 与预览画这一层时用（面板层已单独画过） */
export function bubbleLayerAlpha(spec: ThemeSpec): number {
  return panelAlpha(spec);
}

/** 图片遮罩不透明度 */
export function overlayAlpha(spec: ThemeSpec): number {
  return spec.overlayOpacity;
}

export type ExtraLayerToken = 'selection' | 'hover' | 'pressed' | 'text' | 'primary';

/** 区域自带的一层叠加（选中底色、悬停底色、中性底等） */
export interface ExtraLayer {
  token: ExtraLayerToken;
  alpha: number;
}

/** 一个显示区域的层级描述 */
export interface RegionLayers {
  id: string;
  label: string;
  /** 'image' 表示从图片层起算；'solid' 表示从纯背景色起算（不透出图片） */
  base: 'image' | 'solid';
  /** 是否叠图片遮罩（只有从图片起算时才需要） */
  withOverlay: boolean;
  /** 面板层不透明度；0 表示该区域没有面板层 */
  panelAlpha: number;
  /** 面板层之上的额外叠加 */
  extra?: ExtraLayer;
}

export interface RegionInput {
  spec: ThemeSpec;
  /** 图片采样点（代表色）；空数组表示没有图片，用纯背景色 */
  imageSamples: Rgb[];
}

function tokenColor(tokens: ThemeTokens, token: ExtraLayerToken): string {
  switch (token) {
    case 'selection':
      return tokens.selection;
    case 'hover':
      return tokens.hover;
    case 'pressed':
      return tokens.pressed;
    case 'primary':
      return tokens.primary;
    default:
      return tokens.text;
  }
}

/** 某个区域在某个图片采样点上的实际底色 */
export function regionBackground(
  region: RegionLayers,
  input: RegionInput,
  tokens: ThemeTokens,
  imageSample: Rgb | null,
): string {
  const { spec } = input;
  let base: Rgb;
  if (region.base === 'image' && imageSample) {
    base = imageSample;
    if (region.withOverlay) {
      base = composite(hexToRgb(tokens.background), overlayAlpha(spec), base);
    }
  } else {
    base = hexToRgb(tokens.background);
  }
  if (region.panelAlpha > 0) {
    base = composite(hexToRgb(tokens.panel), region.panelAlpha, base);
  }
  if (region.extra) {
    base = composite(hexToRgb(tokenColor(tokens, region.extra.token)), region.extra.alpha, base);
  }
  return rgbToHex(base);
}

/** 区域的上层叠加常量：与实际写入归档的 CSS 一一对应 */
export const REGION_ALPHAS = {
  /** 次级按钮/中性底的叠加（--v2-background-bg-button-neutral） */
  neutral: 0.06,
  /** 用户消息气泡（选区色叠在面板上） */
  userBubble: 0.9,
  /** 菜单/列表项悬停 */
  hover: 0.12,
  /** 菜单/列表项按下 */
  pressed: 0.18,
  /** 列表项选中 */
  selected: 0.16,
  /** 状态色的弱背景 */
  statusWeak: 0.14,
} as const;

/** 所有需要在报告里覆盖到的区域，顺序即展示顺序 */
export function regionsFor(spec: ThemeSpec): RegionLayers[] {
  const p = panelAlpha(spec);
  const b = bubbleAlpha(spec);
  return [
    { id: 'body', label: '正文', base: 'image', withOverlay: true, panelAlpha: p },
    { id: 'sidebar', label: '侧栏文字', base: 'image', withOverlay: true, panelAlpha: p },
    {
      id: 'sidebar-selected',
      label: '侧栏选中项',
      base: 'image',
      withOverlay: true,
      panelAlpha: p,
      extra: { token: 'selection', alpha: REGION_ALPHAS.selected },
    },
    { id: 'bubble', label: '对话气泡', base: 'image', withOverlay: true, panelAlpha: b },
    {
      id: 'user-bubble',
      label: '用户消息气泡',
      base: 'image',
      withOverlay: true,
      panelAlpha: p,
      extra: { token: 'selection', alpha: REGION_ALPHAS.userBubble },
    },
    { id: 'code', label: '代码块', base: 'image', withOverlay: true, panelAlpha: p },
    { id: 'menu', label: '菜单面板', base: 'image', withOverlay: true, panelAlpha: p },
    {
      id: 'menu-hover',
      label: '菜单项悬停',
      base: 'image',
      withOverlay: true,
      panelAlpha: p,
      extra: { token: 'hover', alpha: REGION_ALPHAS.hover },
    },
    { id: 'input', label: '输入区', base: 'image', withOverlay: true, panelAlpha: p },
    {
      id: 'neutral-button',
      label: '次级按钮',
      base: 'image',
      withOverlay: true,
      panelAlpha: p,
      extra: { token: 'text', alpha: REGION_ALPHAS.neutral },
    },
    // 焦点环、按钮自身底色不依赖图片，从纯背景起算
    { id: 'page', label: '页面背景', base: 'image', withOverlay: true, panelAlpha: 0 },
  ];
}

/** 预览与报告共用的可选区域（按 id 取） */
export function regionById(spec: ThemeSpec, id: string): RegionLayers | undefined {
  return regionsFor(spec).find((r) => r.id === id);
}
