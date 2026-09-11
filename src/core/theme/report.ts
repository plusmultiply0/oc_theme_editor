/**
 * 可读性报告（T25、T26）。
 *
 * 全部条目都在「图片 → 遮罩 → 面板」三层合成后的实际底色上测量，
 * 而不是拿两枚 token 直接比——后者会把半透明面板的实测值算高。
 *
 * 诚实边界：
 * - scope 只声明本工具渲染的语义 token，不含应用自带终端配色与语法高亮。
 * - sampling 明确写「按公式计算」，没有对真实界面做像素采样。
 * - verified 恒为 false：未做真实界面采样就不得宣称「安全通过」。
 */
import type { ContrastEntry, ContrastReport, ContrastTarget, ThemeTokens } from '../../shared/schema';

/** disabled 控件豁免对比度要求，不参与测量 */
type MeasuredTarget = Extract<ContrastTarget, 'text' | 'largeText' | 'ui'>;
import { CONTRAST_TARGETS, contrastRatio } from './contrast';

export const CONTRAST_SCOPE =
  '仅覆盖本工具写入的语义 token：正文、次要文字、主按钮、边框、焦点环、状态色、diff 色；不含应用自带的终端配色与代码语法高亮。';

export const CONTRAST_SAMPLING =
  '按「图片代表色 → 遮罩 → 面板」三层 alpha 合成后，用 WCAG 相对亮度公式计算；未对真实界面做像素采样。';

export interface ReportInput {
  tokens: ThemeTokens;
  /** 三层合成后的实际底色（#rrggbb） */
  effective: string;
  /** 未合成的背景色，用于焦点环这类直接落在背景上的元素 */
  background: string;
}

function entry(
  element: string,
  foreground: string,
  background: string,
  target: MeasuredTarget,
): ContrastEntry {
  const required = CONTRAST_TARGETS[target];
  const ratio = contrastRatio(foreground, background);
  return {
    element,
    state: 'default',
    foreground,
    background,
    ratio: Math.round(ratio * 100) / 100,
    required,
    target,
    pass: ratio >= required,
  };
}

export function buildContrastReport(input: ReportInput): ContrastReport {
  const { tokens, effective, background } = input;
  const entries: ContrastEntry[] = [
    entry('正文', tokens.text, effective, 'text'),
    entry('次要文字', tokens.muted, effective, 'text'),
    entry('主按钮文字', tokens.onPrimary, tokens.primary, 'text'),
    entry('主色控件', tokens.primary, effective, 'ui'),
    entry('边框', tokens.border, effective, 'ui'),
    entry('焦点环', tokens.focus, background, 'ui'),
    entry('错误提示', tokens.status.error, effective, 'text'),
    entry('警告提示', tokens.status.warning, effective, 'text'),
    entry('成功提示', tokens.status.success, effective, 'text'),
    entry('信息提示', tokens.status.info, effective, 'text'),
    entry('diff 新增', tokens.diff.added, effective, 'text'),
    entry('diff 删除', tokens.diff.removed, effective, 'text'),
  ];

  return {
    entries,
    passed: entries.every((e) => e.pass),
    scope: CONTRAST_SCOPE,
    sampling: CONTRAST_SAMPLING,
    verified: false,
  };
}
