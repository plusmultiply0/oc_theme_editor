/**
 * 可读性报告（T25、T26；R4）。
 *
 * 这一版修的三件事：
 * 1. **不再只测 default 状态**：侧栏、正文、输入、菜单、选中项、按钮
 *    default/hover/pressed、链接、状态色、diff 色都在覆盖范围内。
 * 2. **不再只看一个代表色**：对每个图片采样点分别合成取**最差**对比度，
 *    并在条目上标 `estimated: true`，不把估算说成「实际底色」。
 * 3. **不再用单层合成冒充双层**：对话气泡是两层半透明面板叠加，
 *    按 1-(1-a)² 的等效不透明度计算。
 *
 * 诚实边界：
 * - scope 只声明本工具写入的语义 token，不含终端配色与语法高亮。
 * - sampling 明确写「按代表色逐点合成取最差」，没有对真实界面做像素采样。
 * - verified 恒为 false：未做真实界面采样就不得宣称「安全通过」。
 * - `disabled` 状态豁免对比度要求，不参与测量（也不该被当成正常文字淡化显示）。
 */
import type {
  ContrastEntry,
  ContrastReport,
  ContrastTarget,
  ThemeSpec,
  ThemeTokens,
} from '../../shared/schema';
import { CONTRAST_TARGETS, contrastRatio } from './contrast';
import type { Rgb } from './palette';
import { regionBackground, regionsFor, type RegionLayers } from './surfaces';

/** disabled 控件豁免对比度要求，不参与测量 */
type MeasuredTarget = Extract<ContrastTarget, 'text' | 'largeText' | 'ui'>;

export const CONTRAST_SCOPE =
  '仅覆盖本工具写入的语义 token：正文、次要文字、侧栏与选中项、对话气泡、输入区、封面（新建会话页' +
  '输入框与大字，按固定不透明计）、菜单、' +
  '次级按钮、主按钮三态、边框、焦点环、状态色、diff 色；不含终端配色与代码语法高亮。' +
  '按钮 disabled 状态按无障碍惯例豁免对比度要求，不参与测量。';

export const CONTRAST_SAMPLING =
  '按「图片代表色 → 遮罩 → 面板（→ 区域叠加）」逐点合成后取最差对比度，' +
  '用 WCAG 相对亮度公式计算；代表色来自缩略图聚类，因此这是保守估算，不是真实界面像素采样。';

export interface ReportInput {
  tokens: ThemeTokens;
  spec: ThemeSpec;
  /** 图片采样点（代表色）；空数组表示没有图片，从纯背景色起算 */
  imageSamples: Rgb[];
  /** 用于界面展示的代表性底色 */
  effective: string;
}

interface EntrySpec {
  element: string;
  state: 'default' | 'hover' | 'pressed' | 'focus';
  /** 从区域合成拿底色 */
  region?: string;
  /** 或用显式不透明底色（主按钮自身颜色） */
  opaqueBackground?: (t: ThemeTokens) => string;
  foreground: (t: ThemeTokens) => string;
  target: MeasuredTarget;
}

/** 报告覆盖的条目表；顺序即界面展示顺序 */
const ENTRY_TABLE: EntrySpec[] = [
  { element: '正文', state: 'default', region: 'body', foreground: (t) => t.text, target: 'text' },
  { element: '次要文字', state: 'default', region: 'body', foreground: (t) => t.muted, target: 'text' },
  { element: '链接', state: 'default', region: 'body', foreground: (t) => t.accentText, target: 'text' },
  { element: '侧栏文字', state: 'default', region: 'sidebar', foreground: (t) => t.text, target: 'text' },
  { element: '侧栏次要文字', state: 'default', region: 'sidebar', foreground: (t) => t.muted, target: 'text' },
  {
    element: '侧栏选中项',
    state: 'default',
    region: 'sidebar-selected',
    foreground: (t) => t.text,
    target: 'text',
  },
  { element: '对话气泡正文', state: 'default', region: 'bubble', foreground: (t) => t.text, target: 'text' },
  {
    element: '对话气泡次要文字',
    state: 'default',
    region: 'bubble',
    foreground: (t) => t.muted,
    target: 'text',
  },
  {
    element: '用户消息气泡',
    state: 'default',
    region: 'user-bubble',
    foreground: (t) => t.text,
    target: 'text',
  },
  { element: '代码块文字', state: 'default', region: 'code', foreground: (t) => t.text, target: 'text' },
  { element: '代码块次要文字', state: 'default', region: 'code', foreground: (t) => t.muted, target: 'text' },
  { element: '菜单项', state: 'default', region: 'menu', foreground: (t) => t.text, target: 'text' },
  {
    element: '菜单项悬停',
    state: 'hover',
    region: 'menu-hover',
    foreground: (t) => t.text,
    target: 'text',
  },
  { element: '输入文字', state: 'default', region: 'input', foreground: (t) => t.text, target: 'text' },
  {
    element: '输入占位文字',
    state: 'default',
    region: 'input',
    foreground: (t) => t.muted,
    target: 'text',
  },
  // 封面（新建会话页，新布局）固定不透明两处（X3c）：区域 panelAlpha 是固定值，
  // 面板不透明度滑杆不动这两条——与 css.ts 封面规则的实际渲染同口径。
  // 大字直接压在图片+遮罩上，前景用单列的 coverText（推导时已按 3:1 在同批底色上保障）。
  { element: '封面输入文字', state: 'default', region: 'cover-input', foreground: (t) => t.text, target: 'text' },
  {
    element: '封面大字标语',
    state: 'default',
    region: 'cover-wordmark',
    foreground: (t) => t.coverText,
    target: 'largeText',
  },
  {
    element: '次级按钮文字',
    state: 'default',
    region: 'neutral-button',
    foreground: (t) => t.text,
    target: 'text',
  },
  {
    element: '主按钮文字',
    state: 'default',
    opaqueBackground: (t) => t.primary,
    foreground: (t) => t.onPrimary,
    target: 'text',
  },
  {
    element: '主按钮文字',
    state: 'hover',
    opaqueBackground: (t) => t.hover,
    foreground: (t) => t.onPrimary,
    target: 'text',
  },
  {
    element: '主按钮文字',
    state: 'pressed',
    opaqueBackground: (t) => t.pressed,
    foreground: (t) => t.onPrimary,
    target: 'text',
  },
  { element: '边框', state: 'default', region: 'body', foreground: (t) => t.border, target: 'ui' },
  // 主色本身当控件底色/轮廓用时，与面板的区分度按重要非文本的 3:1 要求
  { element: '主色控件', state: 'default', region: 'body', foreground: (t) => t.primary, target: 'ui' },
  { element: '焦点环', state: 'focus', region: 'page', foreground: (t) => t.focus, target: 'ui' },
  { element: '错误提示', state: 'default', region: 'body', foreground: (t) => t.status.error, target: 'text' },
  { element: '警告提示', state: 'default', region: 'body', foreground: (t) => t.status.warning, target: 'text' },
  { element: '成功提示', state: 'default', region: 'body', foreground: (t) => t.status.success, target: 'text' },
  { element: '信息提示', state: 'default', region: 'body', foreground: (t) => t.status.info, target: 'text' },
  { element: 'diff 新增', state: 'default', region: 'code', foreground: (t) => t.diff.added, target: 'text' },
  { element: 'diff 删除', state: 'default', region: 'code', foreground: (t) => t.diff.removed, target: 'text' },
];

function regionMap(spec: ThemeSpec): Map<string, RegionLayers> {
  return new Map(regionsFor(spec).map((r) => [r.id, r] as const));
}

function buildEntry(spec: EntrySpec, report: ReportInput, regions: Map<string, RegionLayers>): ContrastEntry {
  const { tokens } = report;
  const required = CONTRAST_TARGETS[spec.target];
  const foreground = spec.foreground(tokens);

  if (spec.opaqueBackground) {
    const background = spec.opaqueBackground(tokens);
    const ratio = contrastRatio(foreground, background);
    return {
      element: spec.element,
      state: spec.state,
      foreground,
      background,
      ratio: Math.round(ratio * 100) / 100,
      required,
      target: spec.target,
      pass: ratio >= required,
      estimated: false,
      samples: 1,
    };
  }

  const region = regions.get(spec.region ?? '');
  if (!region) {
    // 区域描述缺失属于实现缺陷，按最保守方式判失败而不是悄悄放过
    return {
      element: spec.element,
      state: spec.state,
      foreground,
      background: report.effective,
      ratio: 0,
      required,
      target: spec.target,
      pass: false,
      estimated: true,
      samples: 0,
    };
  }

  const samples: (Rgb | null)[] =
    region.base === 'image' && report.imageSamples.length > 0 ? report.imageSamples : [null];

  let worstBackground = report.effective;
  let worstRatio = Number.POSITIVE_INFINITY;
  for (const sample of samples) {
    const background = regionBackground(region, report, tokens, sample);
    const ratio = contrastRatio(foreground, background);
    if (ratio < worstRatio) {
      worstRatio = ratio;
      worstBackground = background;
    }
  }

  return {
    element: spec.element,
    state: spec.state,
    foreground,
    background: worstBackground,
    ratio: Math.round(worstRatio * 100) / 100,
    required,
    target: spec.target,
    pass: worstRatio >= required,
    estimated: region.base === 'image',
    samples: samples.length,
  };
}

export function buildContrastReport(input: ReportInput): ContrastReport {
  const regions = regionMap(input.spec);
  const entries = ENTRY_TABLE.map((e) => buildEntry(e, input, regions));

  return {
    entries,
    passed: entries.every((e) => e.pass),
    scope: CONTRAST_SCOPE,
    sampling: CONTRAST_SAMPLING,
    verified: false,
  };
}

/** 报告里必须通过的正文条目；生成阶段用它决定要不要直接拦下 */
export function bodyEntry(report: ContrastReport): ContrastEntry | undefined {
  return report.entries.find((e) => e.element === '正文');
}
