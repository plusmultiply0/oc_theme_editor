/**
 * 目标应用 token 映射（R3、R5）。
 *
 * 依据是 2026-09-11 从真实安装 `out/renderer/assets/main-*.css` 只读提取的
 * OpenCode 1.18.29 语义 token 清单（见 docs/discovery.md 的取证记录），
 * 不是凭命名猜出来的：
 *
 * - 基础层：--background-*、--surface-*、--text-*、--icon-*、--border-*、
 *   --button-*、--input-*
 * - v2 层：--v2-background-*、--v2-text-*、--v2-icon-*、--v2-border-*、
 *   --v2-overlay-*、--v2-state-*
 * - diff 层：--surface-diff-*、--text-diff-*、--icon-diff-*
 *
 * 官方把这套变量定义在 `:root`（含一个 `@media (prefers-color-scheme: dark)` 分支）。
 * 本工具的样式表在 `<head>` 里最后加载，同特异性下后者胜出，因此这里用普通
 * `:root` 声明即可覆盖；**不再叠加更多 !important**。
 *
 * 明确不覆盖：终端（.xterm）与 `--syntax-*` / `--markdown-*` 语法色（T27）。
 */
import type { ThemeSpec, ThemeTokens } from '../../shared/schema';
import { hexToRgb } from './contrast';
import { panelAlpha, REGION_ALPHAS } from './surfaces';

export interface TokenDeclaration {
  name: string;
  value: string;
  /** 说明这行对应界面上的什么，便于审查时核对 */
  note: string;
}

function rgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function pct(alpha: number): number {
  return Math.max(0, Math.min(1, Math.round(alpha * 100) / 100));
}

/**
 * 生成基础 + v2 语义层的 token 声明。全部来自已核实的名字，
 * 值由本工具的 ThemeTokens 推导，保证「预览里看到的颜色就是应用后生效的颜色」。
 */
export function renderTokenDeclarations(tokens: ThemeTokens, spec: ThemeSpec): TokenDeclaration[] {
  const p = pct(panelAlpha(spec));
  const strong = pct(Math.min(1, p + 0.12));
  const raised = pct(Math.min(1, p + 0.06));
  const weak = pct(Math.max(0, p * 0.55));

  const weakStatus = (
    key: 'error' | 'warning' | 'success' | 'info',
  ): string => rgba(tokens.status[key], REGION_ALPHAS.statusWeak);

  return [
    // ---------- 背景层 ----------
    { name: '--background-base', value: rgba(tokens.panel, p), note: '主面板底色（透出背景图片）' },
    { name: '--background-weak', value: rgba(tokens.panel, weak), note: '更弱的面板底色' },
    { name: '--background-strong', value: rgba(tokens.panel, strong), note: '更强的面板底色' },
    { name: '--background-stronger', value: tokens.panel, note: '实底面板色' },

    // ---------- 表面层 ----------
    { name: '--surface-base', value: rgba(tokens.text, 0.04), note: '表面底纹' },
    { name: '--surface-base-hover', value: rgba(tokens.hover, REGION_ALPHAS.hover), note: '表面悬停' },
    { name: '--surface-base-active', value: rgba(tokens.pressed, REGION_ALPHAS.pressed), note: '表面按下' },
    {
      name: '--surface-base-interactive-active',
      value: rgba(tokens.pressed, 0.22),
      note: '可交互表面按下',
    },
    { name: '--surface-inset-base', value: rgba(tokens.background, 0.72), note: '内凹区域（输入、代码）' },
    { name: '--surface-raised-base', value: rgba(tokens.panel, raised), note: '浮起表面' },
    { name: '--surface-raised-base-hover', value: rgba(tokens.hover, REGION_ALPHAS.hover), note: '浮起表面悬停' },
    { name: '--surface-raised-base-active', value: rgba(tokens.pressed, REGION_ALPHAS.pressed), note: '浮起表面按下' },
    { name: '--surface-raised-stronger-non-alpha', value: tokens.panel, note: '浮起实底' },
    { name: '--surface-strong', value: rgba(tokens.border, 0.38), note: '强调表面' },
    { name: '--surface-interactive-base', value: tokens.primary, note: '主色交互面' },
    { name: '--surface-interactive-hover', value: tokens.hover, note: '主色交互面悬停' },
    { name: '--surface-interactive-weak', value: rgba(tokens.primary, 0.14), note: '主色弱交互面' },
    { name: '--surface-interactive-weak-hover', value: rgba(tokens.hover, 0.22), note: '主色弱交互面悬停' },
    { name: '--surface-brand-base', value: tokens.primary, note: '品牌色面' },
    { name: '--surface-brand-hover', value: tokens.hover, note: '品牌色面悬停' },

    // ---------- 文字层 ----------
    { name: '--text-base', value: tokens.text, note: '正文' },
    { name: '--text-strong', value: tokens.text, note: '强调正文' },
    { name: '--text-stronger', value: tokens.text, note: '更强正文' },
    { name: '--text-weak', value: tokens.muted, note: '次要文字' },
    { name: '--text-weaker', value: tokens.muted, note: '更弱文字' },
    { name: '--text-interactive-base', value: tokens.accentText, note: '可交互文字/链接（正文尺寸，按 4.5 保障）' },
    { name: '--text-on-interactive-base', value: tokens.onPrimary, note: '主色上的文字' },
    { name: '--text-on-interactive-weak', value: tokens.text, note: '弱主色上的文字' },
    { name: '--text-invert-base', value: tokens.background, note: '反色文字' },

    // ---------- 图标层 ----------
    { name: '--icon-base', value: tokens.text, note: '基础图标' },
    { name: '--icon-hover', value: tokens.text, note: '图标悬停' },
    { name: '--icon-active', value: tokens.primary, note: '图标按下' },
    { name: '--icon-selected', value: tokens.primary, note: '图标选中' },
    { name: '--icon-focus', value: tokens.focus, note: '图标焦点' },
    { name: '--icon-disabled', value: tokens.muted, note: '图标禁用' },
    { name: '--icon-weak-base', value: tokens.muted, note: '弱图标' },
    { name: '--icon-weak-hover', value: tokens.text, note: '弱图标悬停' },
    { name: '--icon-strong-base', value: tokens.text, note: '强图标' },
    { name: '--icon-strong-hover', value: tokens.text, note: '强图标悬停' },
    { name: '--icon-strong-focus', value: tokens.text, note: '强图标焦点' },
    { name: '--icon-interactive-base', value: tokens.primary, note: '可交互图标' },
    { name: '--icon-on-interactive-base', value: tokens.onPrimary, note: '主色上的图标' },
    { name: '--icon-brand-base', value: tokens.primary, note: '品牌图标' },
    { name: '--icon-on-brand-base', value: tokens.onPrimary, note: '品牌色上的图标' },
    { name: '--icon-brand-hover', value: tokens.hover, note: '品牌图标悬停' },

    // ---------- 边框层 ----------
    { name: '--border-base', value: rgba(tokens.border, 0.9), note: '基础边框' },
    { name: '--border-color', value: rgba(tokens.border, 0.9), note: '边框默认色' },
    { name: '--border-hover', value: tokens.hover, note: '边框悬停' },
    { name: '--border-active', value: tokens.pressed, note: '边框按下' },
    { name: '--border-selected', value: tokens.primary, note: '边框选中' },
    { name: '--border-focus', value: tokens.focus, note: '边框焦点' },
    { name: '--border-disabled', value: rgba(tokens.muted, 0.4), note: '边框禁用' },
    { name: '--border-weak-base', value: rgba(tokens.border, 0.5), note: '弱边框' },
    { name: '--border-weaker-base', value: rgba(tokens.border, 0.28), note: '更弱边框' },
    { name: '--border-strong-base', value: tokens.border, note: '强边框' },
    { name: '--border-interactive-base', value: rgba(tokens.primary, 0.6), note: '可交互边框' },
    { name: '--border-interactive-hover', value: tokens.hover, note: '可交互边框悬停' },
    { name: '--border-interactive-focus', value: tokens.focus, note: '可交互边框焦点' },

    // ---------- 按钮层 ----------
    { name: '--button-primary-base', value: tokens.primary, note: '主按钮底色' },
    { name: '--button-secondary-base', value: rgba(tokens.text, 0.06), note: '次级按钮底色' },
    { name: '--button-secondary-hover', value: rgba(tokens.hover, 0.16), note: '次级按钮悬停' },
    { name: '--button-ghost-hover', value: rgba(tokens.hover, 0.12), note: '幽灵按钮悬停' },
    { name: '--button-ghost-hover2', value: rgba(tokens.hover, 0.2), note: '幽灵按钮悬停（强）' },

    // ---------- 输入层 ----------
    { name: '--input-base', value: rgba(tokens.panel, p), note: '输入框底色' },
    { name: '--input-hover', value: rgba(tokens.panel, strong), note: '输入框悬停' },
    { name: '--input-active', value: rgba(tokens.panel, raised), note: '输入框激活' },
    { name: '--input-selected', value: rgba(tokens.selection, 0.6), note: '输入框选中' },
    { name: '--input-focus', value: rgba(tokens.panel, strong), note: '输入框焦点' },
    { name: '--input-disabled', value: rgba(tokens.panel, weak), note: '输入框禁用' },

    // ---------- v2 背景 / 文字 / 图标 / 边框 ----------
    { name: '--v2-background-bg-base', value: rgba(tokens.panel, p), note: 'v2 主面板' },
    { name: '--v2-background-bg-deep', value: rgba(tokens.background, 0.6), note: 'v2 更深底' },
    { name: '--v2-background-bg-layer-01', value: rgba(tokens.panel, p), note: 'v2 一层' },
    { name: '--v2-background-bg-layer-02', value: rgba(tokens.panel, raised), note: 'v2 二层' },
    { name: '--v2-background-bg-layer-03', value: rgba(tokens.panel, strong), note: 'v2 三层' },
    { name: '--v2-background-bg-layer-04', value: tokens.panel, note: 'v2 四层（实底）' },
    { name: '--v2-background-bg-inverse', value: tokens.text, note: 'v2 反色底' },
    { name: '--v2-background-bg-contrast', value: tokens.primary, note: 'v2 对比底' },
    { name: '--v2-background-bg-button-neutral', value: rgba(tokens.text, REGION_ALPHAS.neutral), note: 'v2 中性按钮底' },
    { name: '--v2-background-bg-accent', value: tokens.primary, note: 'v2 强调底' },
    { name: '--v2-text-text-base', value: tokens.text, note: 'v2 正文' },
    { name: '--v2-text-text-muted', value: tokens.muted, note: 'v2 次要文字' },
    { name: '--v2-text-text-faint', value: tokens.muted, note: 'v2 更弱文字' },
    { name: '--v2-text-text-inverse', value: tokens.background, note: 'v2 反色文字' },
    { name: '--v2-text-text-contrast', value: tokens.onPrimary, note: 'v2 对比文字' },
    { name: '--v2-text-text-accent', value: tokens.accentText, note: 'v2 强调文字/链接（正文尺寸，按 4.5 保障）' },
    { name: '--v2-text-text-accent-hover', value: tokens.accentText, note: 'v2 强调文字悬停' },
    { name: '--v2-text-text-code-accent', value: tokens.muted, note: 'v2 代码强调文字' },
    { name: '--v2-icon-icon-base', value: tokens.text, note: 'v2 基础图标' },
    { name: '--v2-icon-icon-muted', value: tokens.muted, note: 'v2 弱图标' },
    { name: '--v2-icon-icon-inverse', value: tokens.background, note: 'v2 反色图标' },
    { name: '--v2-icon-icon-contrast', value: tokens.onPrimary, note: 'v2 对比图标' },
    { name: '--v2-icon-icon-accent', value: tokens.accentText, note: 'v2 强调图标（按可辨识 3:1 保障）' },
    { name: '--v2-icon-icon-accent-hover', value: tokens.hover, note: 'v2 强调图标悬停' },
    { name: '--v2-border-border-muted', value: rgba(tokens.border, 0.28), note: 'v2 弱边框' },
    { name: '--v2-border-border-base', value: rgba(tokens.border, 0.5), note: 'v2 基础边框' },
    { name: '--v2-border-border-strong', value: tokens.border, note: 'v2 强边框' },
    { name: '--v2-border-border-inverse', value: tokens.text, note: 'v2 反色边框' },
    { name: '--v2-border-border-focus', value: tokens.focus, note: 'v2 焦点环' },

    // ---------- v2 叠加 ----------
    { name: '--v2-overlay-simple-overlay-hover', value: rgba(tokens.hover, REGION_ALPHAS.hover), note: 'v2 悬停叠加' },
    { name: '--v2-overlay-simple-overlay-pressed', value: rgba(tokens.pressed, REGION_ALPHAS.pressed), note: 'v2 按下叠加' },
    {
      name: '--v2-overlay-simple-overlay-contrast-hover',
      value: rgba(tokens.border, 0.28),
      note: 'v2 对比悬停叠加',
    },
    {
      name: '--v2-overlay-simple-overlay-contrast-pressed',
      value: rgba(tokens.pressed, 0.25),
      note: 'v2 对比按下叠加',
    },
    { name: '--v2-overlay-simple-overlay-scrim', value: rgba(tokens.background, 0.65), note: 'v2 遮罩' },
    { name: '--v2-overlay-simple-tab-active-scrim', value: rgba(tokens.primary, REGION_ALPHAS.selected), note: 'v2 标签选中' },
    { name: '--v2-overlay-simple-tab-hover-scrim', value: rgba(tokens.hover, 0.1), note: 'v2 标签悬停' },

    // ---------- 状态语义（绑定到应用真正在用的 token，而不是自造 --ts-*） ----------
    { name: '--v2-state-fg-danger', value: tokens.status.error, note: '错误文字' },
    { name: '--v2-state-fg-warning', value: tokens.status.warning, note: '警告文字' },
    { name: '--v2-state-fg-success', value: tokens.status.success, note: '成功文字' },
    { name: '--v2-state-fg-info', value: tokens.status.info, note: '信息文字' },
    { name: '--v2-state-bg-danger', value: weakStatus('error'), note: '错误弱背景' },
    { name: '--v2-state-bg-warning', value: weakStatus('warning'), note: '警告弱背景' },
    { name: '--v2-state-bg-success', value: weakStatus('success'), note: '成功弱背景' },
    { name: '--v2-state-bg-info', value: weakStatus('info'), note: '信息弱背景' },
    { name: '--v2-state-border-danger', value: rgba(tokens.status.error, 0.5), note: '错误边框' },
    { name: '--v2-state-border-warning', value: rgba(tokens.status.warning, 0.5), note: '警告边框' },
    { name: '--v2-state-border-success', value: rgba(tokens.status.success, 0.5), note: '成功边框' },
    { name: '--v2-state-border-info', value: rgba(tokens.status.info, 0.5), note: '信息边框' },
    { name: '--border-critical-base', value: tokens.status.error, note: '错误边框（基础层）' },
    { name: '--border-warning-base', value: tokens.status.warning, note: '警告边框（基础层）' },
    { name: '--border-success-base', value: tokens.status.success, note: '成功边框（基础层）' },
    { name: '--border-info-base', value: tokens.status.info, note: '信息边框（基础层）' },
    { name: '--icon-critical-base', value: tokens.status.error, note: '错误图标' },
    { name: '--icon-warning-base', value: tokens.status.warning, note: '警告图标' },
    { name: '--icon-success-base', value: tokens.status.success, note: '成功图标' },
    { name: '--icon-info-base', value: tokens.status.info, note: '信息图标' },

    // ---------- diff 语义 ----------
    { name: '--text-diff-add-base', value: tokens.diff.added, note: 'diff 新增文字' },
    { name: '--text-diff-delete-base', value: tokens.diff.removed, note: 'diff 删除文字' },
    { name: '--icon-diff-add-base', value: tokens.diff.added, note: 'diff 新增图标' },
    { name: '--icon-diff-delete-base', value: tokens.diff.removed, note: 'diff 删除图标' },
    { name: '--icon-diff-modified-base', value: tokens.status.warning, note: 'diff 修改图标' },
    { name: '--surface-diff-add-base', value: rgba(tokens.diff.added, 0.16), note: 'diff 新增底色' },
    { name: '--surface-diff-delete-base', value: rgba(tokens.diff.removed, 0.16), note: 'diff 删除底色' },
    { name: '--surface-diff-unchanged-base', value: rgba(tokens.panel, p), note: 'diff 未变行底色' },

    // ---------- 其他 ----------
    { name: '--surface-success-base', value: weakStatus('success'), note: '成功面' },
    { name: '--surface-success-strong', value: tokens.status.success, note: '成功面（强）' },
    { name: '--surface-warning-base', value: weakStatus('warning'), note: '警告面' },
    { name: '--surface-warning-strong', value: tokens.status.warning, note: '警告面（强）' },
    { name: '--surface-critical-base', value: weakStatus('error'), note: '错误面' },
    { name: '--surface-critical-strong', value: tokens.status.error, note: '错误面（强）' },
    { name: '--surface-info-base', value: weakStatus('info'), note: '信息面' },
    { name: '--surface-info-strong', value: tokens.status.info, note: '信息面（强）' },
  ];
}

/** 渲染成 CSS 声明块文本 */
export function renderTokenCss(tokens: ThemeTokens, spec: ThemeSpec, indent = '  '): string {
  return renderTokenDeclarations(tokens, spec)
    .map((d) => `${indent}${d.name}: ${d.value};`)
    .join('\n');
}
