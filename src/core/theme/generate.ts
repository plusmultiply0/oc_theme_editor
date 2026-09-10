/**
 * 图片 → 主题（T21、T22、T23）。
 *
 * - 原图只读：只读取 buffer，不写回、不覆盖原文件。
 * - 分析使用缩小副本，避免大图阻塞。
 * - 取色与 token 推导均为确定性函数，同输入同参数结果一致。
 */
import sharp, { type Metadata } from 'sharp';
import { fail, ok, type Result } from '../../shared/errors';
import type { ThemeMode, ThemeSpec, ThemeTokens } from '../../shared/schema';
import { extractPalette } from './palette';
import {
  CONTRAST_TARGETS,
  contrastRatio,
  effectiveBackground,
  hexToRgb,
  rgbToHex,
} from './contrast';
import { deriveStates, ensureContrast, lighten, darken, mix } from './color';
import { renderThemeCss } from './css';
import { DEFAULT_LIMITS, sniffFormat, looksLikeSvg, validateImage, type ImageLimits } from './validate';

/** 分析用的最大边长，控制解码成本 */
const ANALYZE_EDGE = 256;

const STATUS = {
  error: '#c0392b',
  warning: '#b7791f',
  success: '#2f855a',
  info: '#2b6cb0',
};
const DIFF = { added: '#2f855a', removed: '#c0392b', context: '#6b7280' };

export interface AnalyzeResult {
  width: number;
  height: number;
  format: string;
  /** 平均亮度 0–1，用于 auto 模式判断明暗基调 */
  brightness: number;
  palette: string[];
}

/** 只读解析图片元信息与代表色，不修改任何文件 */
export async function analyzeImage(
  buffer: Buffer,
  limits: ImageLimits = DEFAULT_LIMITS,
): Promise<Result<AnalyzeResult>> {
  if (looksLikeSvg(buffer)) {
    return fail('IMAGE_INVALID_FORMAT', '不支持 SVG 图片', '请改用 PNG、JPEG 或 WebP 格式。');
  }
  const format = sniffFormat(buffer);
  if (!format) {
    return fail('IMAGE_INVALID_FORMAT', '无法识别图片格式', '请选择 PNG、JPEG 或 WebP 图片。');
  }

  let meta: Metadata;
  try {
    meta = await sharp(buffer).metadata();
  } catch (e) {
    return fail('IMAGE_DECODE_FAILED', '图片无法解码', '文件可能已损坏，请换一张图片。', String(e));
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  const sizeCheck = validateImage(
    { bytes: buffer.byteLength, width, height },
    limits,
  );
  if (!sizeCheck.success) return sizeCheck;

  try {
    // rotate() 依据 EXIF 方向纠正，保证取到的颜色与用户看到的一致（T20）
    const { data, info } = await sharp(buffer)
      .rotate()
      .resize(ANALYZE_EDGE, ANALYZE_EDGE, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const palette = extractPalette(data, info.channels === 4 ? 4 : 3, { count: 6 });

    let sum = 0;
    const step = info.channels;
    const total = Math.floor(data.length / step);
    for (let i = 0; i < total; i += 1) {
      const o = i * step;
      sum += (data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114) / 255;
    }

    return ok({
      width,
      height,
      format,
      brightness: total ? sum / total : 0,
      palette,
    });
  } catch (e) {
    return fail('IMAGE_DECODE_FAILED', '图片解码失败', '请换一张图片重试。', String(e));
  }
}

function resolveMode(mode: ThemeMode, brightness: number): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') return mode;
  return brightness < 0.5 ? 'dark' : 'light';
}

/** 由代表色推导完整语义 token；primary 可被用户覆盖 */
export function deriveTokens(
  palette: string[],
  mode: 'light' | 'dark',
  primaryOverride?: string,
): ThemeTokens {
  const base = palette[0] ?? '#808080';
  const primary = primaryOverride ?? base;

  const background = mode === 'dark'
    ? mix(base, '#0b0e14', 0.82)
    : mix(base, '#ffffff', 0.86);
  const panel = mode === 'dark'
    ? lighten(background, 0.10)
    : darken(background, 0.04);

  const textFixed = ensureContrast(
    mode === 'dark' ? '#e8ecf4' : '#141922',
    panel,
    'text',
  );

  const { hover, pressed } = deriveStates(primary);
  const muted = ensureContrast(mix(textFixed.color, panel, 0.42), panel, 'text');

  return {
    background,
    panel,
    text: textFixed.color,
    muted: muted.color,
    primary,
    onPrimary: ensureContrast(
      (hexToRgb(primary).r * 0.299 + hexToRgb(primary).g * 0.587 + hexToRgb(primary).b * 0.114) > 150
        ? '#101418'
        : '#ffffff',
      primary,
      'text',
    ).color,
    hover,
    pressed,
    border: mode === 'dark' ? lighten(background, 0.20) : darken(background, 0.12),
    focus: primary,
    selection: mix(primary, background, 0.62),
    status: { ...STATUS },
    diff: { ...DIFF },
  };
}

export interface GenerateThemeInput {
  buffer: Buffer;
  spec: ThemeSpec;
  /** 归档内的本地图片相对引用 */
  imageRef: string;
  primaryOverride?: string;
  limits?: ImageLimits;
}

/** 三层合成后的可读性实测值，供界面展示与回归比对 */
export interface ContrastReport {
  /** 参与合成的主色（图片代表色） */
  imagePixel: string;
  /** 图片 → 遮罩 → 面板合成后的实际底色 */
  effectiveBackground: string;
  textOnPanel: number;
  primaryOnPanel: number;
  textTarget: number;
  uiTarget: number;
}

export interface GenerateThemeResult {
  tokens: ThemeTokens;
  css: string;
  palette: string[];
  mode: 'light' | 'dark';
  contrast: ContrastReport;
}

export async function generateTheme(
  input: GenerateThemeInput,
): Promise<Result<GenerateThemeResult>> {
  const analyzed = await analyzeImage(input.buffer, input.limits);
  if (!analyzed.success) return analyzed;

  const mode = resolveMode(input.spec.mode, analyzed.data.brightness);
  const tokens = deriveTokens(analyzed.data.palette, mode, input.primaryOverride);
  const css = renderThemeCss({
    tokens,
    spec: input.spec,
    imageRef: input.imageRef,
    resolvedMode: mode,
  });

  // 自检：按「图片 → 遮罩 → 面板」三层合成后的实际底色计算对比度（T26），
  // 不达标就判失败，而不是静默放行（T25）。
  const dominant = hexToRgb(analyzed.data.palette[0] ?? '#808080');
  const effective = effectiveBackground(
    dominant,
    hexToRgb(tokens.background),
    input.spec.overlayOpacity,
    hexToRgb(tokens.panel),
    input.spec.panelOpacity,
  );
  const ratio = contrastRatio(tokens.text, effective);
  if (ratio < CONTRAST_TARGETS.text) {
    return fail(
      'CONTRAST_BELOW_TARGET',
      `正文对比度 ${ratio.toFixed(2)} 未达到 ${CONTRAST_TARGETS.text}`,
      '请调高背景遮罩或面板不透明度后重新生成。',
    );
  }
  const uiRatio = contrastRatio(tokens.primary, effective);

  return ok({
    tokens,
    css,
    palette: analyzed.data.palette,
    mode,
    contrast: {
      imagePixel: rgbToHex(dominant),
      effectiveBackground: rgbToHex(effective),
      textOnPanel: ratio,
      primaryOnPanel: uiRatio,
      textTarget: CONTRAST_TARGETS.text,
      uiTarget: CONTRAST_TARGETS.ui,
    },
  });
}
