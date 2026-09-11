/**
 * 图片 → 主题（T21、T22、T23）。
 *
 * - 原图只读：只读取 buffer，不写回、不覆盖原文件。
 * - 分析使用缩小副本，避免大图阻塞。
 * - 取色与 token 推导均为确定性函数，同输入同参数结果一致。
 */
import sharp, { type Metadata } from 'sharp';
import { fail, ok, type Result } from '../../shared/errors';
import type { ContrastReport, ThemeMode, ThemeSpec, ThemeTokens } from '../../shared/schema';
import { extractPalette } from './palette';
import {
  CONTRAST_TARGETS,
  composite,
  contrastRatio,
  effectiveBackground,
  hexToRgb,
  rgbToHex,
} from './contrast';
import { deriveStates, ensureContrast, lighten, darken, mix } from './color';
import { renderThemeCss } from './css';
import { REGION_ALPHAS } from './surfaces';
import { buildContrastReport, bodyEntry } from './report';
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

/**
 * 让一个前景色在**所有**候选背景上都达到目标对比度。
 *
 * 只对一个背景调是不够的：图片上总有更亮/更暗的区域，
 * 报告按采样点取最差，于是会出现「按主导色校正过、报告仍判不合格」。
 * 这里反复挑当前最差的背景去调整，直到全部达标或达到迭代上限。
 */
function ensureAcross(
  start: string,
  backgrounds: string[],
  target: keyof typeof CONTRAST_TARGETS,
): { color: string; ratio: number; pass: boolean } {
  const required = CONTRAST_TARGETS[target];
  const minRatio = (fg: string) => Math.min(...backgrounds.map((bg) => contrastRatio(fg, bg)));
  const worstBg = (fg: string) =>
    backgrounds.reduce((worst, bg) => (contrastRatio(fg, bg) < contrastRatio(fg, worst) ? bg : worst), backgrounds[0] ?? '#000000');

  let current = start;
  if (minRatio(current) >= required) return { color: current, ratio: minRatio(current), pass: true };
  for (let i = 0; i < 32; i += 1) {
    const step = ensureContrast(current, worstBg(current), target);
    current = step.color;
    const r = minRatio(current);
    if (r >= required) return { color: current, ratio: r, pass: true };
  }
  return { color: current, ratio: minRatio(current), pass: false };
}

function asList(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * 选区色（用户消息气泡底色）要保证其上的正文仍读得清。
 * 气泡是「选区色按 alpha 叠在面板上」，所以要比对合成后的底色，而不是选区色本身。
 */
function ensureSelectionReadable(
  candidate: string,
  refs: string[],
  foreground: string,
  alpha: number,
): string {
  const worst = (color: string): number =>
    Math.min(
      ...refs.map((r) =>
        contrastRatio(foreground, rgbToHex(composite(hexToRgb(color), alpha, hexToRgb(r)))),
      ),
    );
  let current = candidate;
  for (let i = 0; i < 24; i += 1) {
    if (worst(current) >= CONTRAST_TARGETS.text) return current;
    current = ensureContrast(current, foreground, 'text').color;
  }
  return current;
}

/**
 * 由代表色推导完整语义 token；primary 可被用户覆盖。
 *
 * `refBg` 是语义文字层要面对的背景集合（面板之上的实际底色）；传多个值时
 * 按**最差**的那个保障对比度。`pageRefBg` 是面板之下、直接落在图片上的底色集合，
 * 用于焦点环这种不经过面板的元素。都不传时退化为按面板色保障（仅供纯 token 单测）。
 */
export function deriveTokens(
  palette: string[],
  mode: 'light' | 'dark',
  primaryOverride?: string,
  refBg?: string | string[],
  pageRefBg?: string | string[],
): ThemeTokens {
  const base = palette[0] ?? '#808080';
  const refList = asList(refBg);
  const firstRef = refList[0];

  // 自动取的主色会在实际底色上按 3:1 校正；用户明确指定的主色原样保留，
  // 读不清时由报告如实判定并阻断应用，不偷偷改掉用户的选择。
  const primary = primaryOverride
    ? primaryOverride
    : firstRef
      ? ensureAcross(base, refList, 'ui').color
      : base;

  const background =
    mode === 'dark' ? mix(base, '#0b0e14', 0.82) : mix(base, '#ffffff', 0.86);
  const panel = mode === 'dark' ? lighten(background, 0.10) : darken(background, 0.04);
  // 没给合成底色时退化为按面板色/背景色保障（仅供纯 token 单测）
  const refs = refList.length > 0 ? refList : [panel];

  const textStart = mode === 'dark' ? '#e8ecf4' : '#141922';
  const textFixed = ensureAcross(textStart, refs, 'text');

  const baseStates = deriveStates(primary);
  const mutedStart = mix(textFixed.color, refs[0], 0.42);
  const muted = ensureAcross(mutedStart, refs, 'text');

  /*
   * 主按钮文字要求在 default / hover / pressed 三态上都读得清（R4：
   * 之前只按 default 校正，真机 pressed 态实测只有 3.77）。
   * 做法是先按 default 定下文字色，再把 hover / pressed 两态的背景往
   * 「远离该文字色」的方向推——按钮三态本来就是同一按钮的明暗变化，
   * 改背景比换文字色更不突兀。
   */
  const onPrimary = ensureContrast(
    contrastRatio('#ffffff', primary) >= contrastRatio('#101418', primary) ? '#ffffff' : '#101418',
    primary,
    'text',
  ).color;
  const hover = ensureContrast(baseStates.hover, onPrimary, 'text').color;
  const pressed = ensureContrast(baseStates.pressed, onPrimary, 'text').color;

  // 链接/强调文字是正文尺寸，必须按 4.5 而不是控件的 3:1
  const accentText = ensureAcross(primary, refs, 'text').color;

  // 焦点环直接落在图片/遮罩上，不经过面板
  const focusRefsList = asList(pageRefBg);
  const focus = ensureAcross(primary, focusRefsList.length > 0 ? focusRefsList : [background], 'ui').color;

  const statusSource = {
    error: STATUS.error,
    warning: STATUS.warning,
    success: STATUS.success,
    info: STATUS.info,
  };
  const diffSource = { added: DIFF.added, removed: DIFF.removed, context: DIFF.context };

  const status = {
    error: ensureAcross(statusSource.error, refs, 'text').color,
    warning: ensureAcross(statusSource.warning, refs, 'text').color,
    success: ensureAcross(statusSource.success, refs, 'text').color,
    info: ensureAcross(statusSource.info, refs, 'text').color,
  };
  const diff = {
    added: ensureAcross(diffSource.added, refs, 'text').color,
    removed: ensureAcross(diffSource.removed, refs, 'text').color,
    context: ensureAcross(diffSource.context, refs, 'text').color,
  };

  return {
    background,
    panel,
    text: textFixed.color,
    muted: muted.color,
    primary,
    onPrimary,
    hover,
    pressed,
    // 边框是可识别控件，按 3:1 保障（1.4.11）
    border: ensureAcross(
      mode === 'dark' ? lighten(background, 0.20) : darken(background, 0.12),
      refs,
      'ui',
    ).color,
    focus,
    // 用户消息气泡：选区色叠在面板上，必须保证其上的正文仍达标
    selection: ensureSelectionReadable(
      mix(primary, background, 0.62),
      refs,
      textFixed.color,
      REGION_ALPHAS.userBubble,
    ),
    accentText,
    status,
    diff,
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

export interface GenerateThemeResult {
  tokens: ThemeTokens;
  css: string;
  palette: string[];
  mode: 'light' | 'dark';
  /** 三层合成后的代表性实际底色，界面展示用（报告本身按多点取最差，见 report.ts） */
  effectiveBackground: string;
  report: ContrastReport;
}

export async function generateTheme(
  input: GenerateThemeInput,
): Promise<Result<GenerateThemeResult>> {
  const analyzed = await analyzeImage(input.buffer, input.limits);
  if (!analyzed.success) return analyzed;

  const mode = resolveMode(input.spec.mode, analyzed.data.brightness);

  // 先按「图片 → 遮罩 → 面板」合成出实际底色，再据此保障所有语义色的对比度（T26）。
  // 顺序不能反：先出 token 再测，等于拿面板色冒充用户真正看到的底色。
  const initial = deriveTokens(analyzed.data.palette, mode, input.primaryOverride);
  const panelA = input.spec.reducedTransparency ? 1 : input.spec.panelOpacity;
  const compositeFor = (sample: string, panelAlphaValue: number): string =>
    rgbToHex(
      effectiveBackground(
        hexToRgb(sample),
        hexToRgb(initial.background),
        input.spec.overlayOpacity,
        hexToRgb(initial.panel),
        panelAlphaValue,
      ),
    );

  // 代表性底色只用于界面回显（用户看到的主要是主导色那一块）
  const effectiveHex = compositeFor(analyzed.data.palette[0] ?? '#808080', panelA);

  /*
   * token 推导用的是**最不利**的那块底色，而不是主导色：
   * 图片上总会有更亮或更暗的区域，只按主导色保障对比度，等于把边缘区域的可读性赌掉。
   * 深色基调下最亮的那块最伤浅色文字，浅色基调下反之。
   * 这里直接把全部采样点交给推导函数，由它逐点保障（见 ensureAcross）。
   */
  const panelRefs = analyzed.data.palette.map((c) => compositeFor(c, panelA));
  const pageRefs = analyzed.data.palette.map((c) => compositeFor(c, 0));

  const tokens = deriveTokens(analyzed.data.palette, mode, input.primaryOverride, panelRefs, pageRefs);

  const css = renderThemeCss({
    tokens,
    spec: input.spec,
    imageRef: input.imageRef,
    resolvedMode: mode,
  });

  // 报告按多个图片采样点逐点合成取最差，而不是只看一个代表色（R4）
  const report = buildContrastReport({
    tokens,
    spec: input.spec,
    imageSamples: analyzed.data.palette.map((c) => hexToRgb(c)),
    effective: effectiveHex,
  });

  // 不达标就判失败，而不是静默放行（T25）
  const textEntry = bodyEntry(report);
  if (!textEntry || textEntry.ratio < CONTRAST_TARGETS.text) {
    return fail(
      'CONTRAST_BELOW_TARGET',
      `正文对比度 ${textEntry ? textEntry.ratio.toFixed(2) : '未知'} 未达到 ${CONTRAST_TARGETS.text}`,
      '请调高背景遮罩或面板不透明度后重新生成。',
    );
  }

  return ok({
    tokens,
    css,
    palette: analyzed.data.palette,
    mode,
    effectiveBackground: effectiveHex,
    report,
  });
}
