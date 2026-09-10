/**
 * 主题 CSS 生成（T23、T24、T27）。
 *
 * 原则：
 * - 以 token 模板生成，不从旧 CSS 做字符串替换。
 * - 只使用已核实的目标变量与选择器（见 docs/discovery.md 的原型取证）。
 * - 只引用工具自己的本地图片引用，拒绝远程 URL、@import 与用户代码。
 * - 终端（.xterm）与代码语法高亮不在覆盖范围内，保持原渲染（T27）。
 * - 不使用 `* { ... !important }` 这类全局覆盖。
 */
import type { ThemeSpec, ThemeTokens } from '../../shared/schema';
import { fail, ok, type Result } from '../../shared/errors';
import { rgbToHex, hexToRgb, composite } from './contrast';

export interface RenderCssInput {
  tokens: ThemeTokens;
  spec: ThemeSpec;
  /** 归档内的本地图片相对引用，例如 './oc-theme-background.jpg' */
  imageRef: string;
  /** auto 解析后的实际模式，决定 color-scheme，不能直接用 spec.mode */
  resolvedMode: 'light' | 'dark';
}

/**
 * 图片引用必须是归档内的相对路径，禁止远程地址与协议相对地址，
 * 也禁止注入换行闭合后追加任意 CSS（T23）。
 */
export function validateImageRef(ref: string): Result<string> {
  const trimmed = ref.trim();
  if (!trimmed) {
    return fail('INVALID_PARAMS', '缺少背景图片引用', '请重新生成主题。');
  }
  if (/^([a-z]+:)?\/\//i.test(trimmed) || /^(https?|data|file):/i.test(trimmed)) {
    return fail('INVALID_PARAMS', '背景图片只允许使用归档内的本地相对路径', '请重新导入图片。');
  }
  if (/[;'"`\n\r]/.test(trimmed) || trimmed.includes('@import')) {
    return fail('INVALID_PARAMS', '背景图片引用包含非法字符', '请重新导入图片。');
  }
  if (trimmed.startsWith('/') || /^[a-z]:/i.test(trimmed)) {
    return fail('INVALID_PARAMS', '背景图片引用必须是相对路径', '请重新导入图片。');
  }
  return ok(trimmed);
}

function rgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 把面板色与背景色按不透明度合成，得到实际面板底色（T26） */
function panelColorOver(tokens: ThemeTokens, panelOpacity: number): string {
  return rgbToHex(composite(hexToRgb(tokens.panel), panelOpacity, hexToRgb(tokens.background)));
}

export function renderThemeCss(input: RenderCssInput): string {
  const { tokens, spec, imageRef, resolvedMode } = input;
  const ref = imageRef;
  const overlay = rgba(tokens.background, spec.overlayOpacity);
  const blur = spec.blurPx > 0 ? spec.blurPx : 0;
  const panel = panelColorOver(tokens, spec.panelOpacity);

  const backgroundBlock = blur > 0
    ? /* 模糊只作用于背景层，正文不被模糊（T24） */
      `#root {
  background: ${overlay} !important;
}
#root::before {
  content: '';
  position: fixed;
  inset: -${blur * 2}px;
  background-image: url('${ref}');
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  filter: blur(${blur}px);
  pointer-events: none;
  z-index: 0;
}
#root > * {
  position: relative;
  z-index: 1;
}`
    : `#root {
  background-image: linear-gradient(${overlay}, ${overlay}), url('${ref}');
  background-size: cover;
  background-position: ${spec.backgroundPosition === 'cover' ? 'center' : spec.backgroundPosition};
  background-repeat: no-repeat;
  background-attachment: fixed;
}`;

  return `/* 由 OpenCode 换肤助手生成；非官方本地资源定制，应用更新后可能失效。 */
${backgroundBlock}

body {
  background-image: none;
  background-color: ${tokens.background};
}

:root {
  color-scheme: ${resolvedMode};

  --background-base: ${tokens.background};
  --surface-interactive-weak: ${rgba(tokens.primary, 0.14)};
  --surface-interactive-hover: ${rgba(tokens.hover, 0.22)};
  --text-interactive-base: ${tokens.primary};

  --v2-background-bg-base: ${tokens.background};
  --v2-background-bg-layer-01: ${panel};
  --v2-background-bg-layer-02: ${panel};
  --v2-background-bg-contrast: ${rgba(tokens.text, 0.08)};
  --v2-background-bg-accent: ${tokens.primary};
  --v2-background-bg-button-neutral: ${rgba(tokens.text, 0.06)};

  --v2-border-border-focus: ${tokens.focus};

  --v2-icon-icon-accent: ${tokens.primary};
  --v2-icon-icon-accent-hover: ${tokens.hover};

  --v2-text-text-accent: ${tokens.primary};
  --v2-text-text-accent-hover: ${tokens.hover};
  --v2-text-text-code-accent: ${tokens.muted};

  --v2-overlay-simple-overlay-hover: ${rgba(tokens.hover, 0.12)};
  --v2-overlay-simple-overlay-pressed: ${rgba(tokens.pressed, 0.18)};
  --v2-overlay-simple-tab-active-scrim: ${rgba(tokens.primary, 0.16)};
  --v2-overlay-simple-tab-hover-scrim: ${rgba(tokens.hover, 0.10)};
}

/* 半透明面板：聊天容器、菜单、对话框、输入区 */
[data-component="dialog"],
[data-component="menu-v2-content"],
[data-component="dropdown-menu-sub-content"],
[data-component="tooltip-v2"],
[data-component="dock-prompt"],
[data-slot="session-turn-assistant-content"] {
  background-color: ${panel} !important;
  border-color: ${rgba(tokens.border, 0.9)} !important;
  color: ${tokens.text} !important;
}

[data-slot="user-message-text"] {
  background-color: ${rgba(tokens.selection, 0.9)} !important;
  color: ${tokens.text} !important;
}

/* 按钮三态：默认 / 悬停 / 按下 */
[data-component="button"] {
  background-color: ${tokens.primary} !important;
  color: ${tokens.onPrimary} !important;
  border-color: ${tokens.border} !important;
}
[data-component="button"]:hover {
  background-color: ${tokens.hover} !important;
}
[data-component="button"]:active {
  background-color: ${tokens.pressed} !important;
}
[data-component="button"]:focus-visible {
  outline: 2px solid ${tokens.focus} !important;
  outline-offset: 1px;
}

/* 选中与焦点 */
::selection {
  background: ${tokens.selection};
}

/* 语义状态色：错误 / 警告 / 成功 / 信息，与 diff 分开表达（T27） */
:root {
  --ts-status-error: ${tokens.status.error};
  --ts-status-warning: ${tokens.status.warning};
  --ts-status-success: ${tokens.status.success};
  --ts-status-info: ${tokens.status.info};
  --ts-diff-added: ${tokens.diff.added};
  --ts-diff-removed: ${tokens.diff.removed};
  --ts-diff-context: ${tokens.diff.context};
}

/* 代码块：只改容器底色，不动语法高亮 token（T27） */
[data-component="markdown-code"] {
  background-color: ${panel} !important;
}
`;
}
