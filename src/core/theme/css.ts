/**
 * 主题 CSS 生成（T23、T24、T27；R3、R5）。
 *
 * 原则：
 * - 以 token 模板生成，不从旧 CSS 做字符串替换。
 * - token 名取自真实安装 1.18.29 的官方 CSS（见 tokens.ts 的说明），不是猜的。
 * - 层级只有一份描述（图片 → 遮罩 → 面板 → 叠加 → 文字），与预览、对比度报告共用，
 *   避免「预览半透明、输出实底」这类不一致。
 * - 只引用工具自己的本地图片引用，拒绝远程 URL、@import 与用户代码。
 * - 终端（.xterm）与 `--syntax-*` / `--markdown-*` 语法色不在覆盖范围内（T27）。
 * - 不叠加 `!important`：本表在 `<head>` 最后加载，同特异性下后者胜出；
 *   旧主题那种 `#root { --x: … !important }` 由迁移预检先行撤下（见 legacy-theme.ts）。
 */
import type { ThemeSpec, ThemeTokens } from '../../shared/schema';
import { fail, ok, type Result } from '../../shared/errors';
import { hexToRgb, composite, rgbToHex } from './contrast';
import { bubbleAlpha, overlayAlpha, panelAlpha, REGION_ALPHAS } from './surfaces';
import { renderTokenCss } from './tokens';

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

/** 面板色按不透明度合成到图片遮罩之上，得到实际面板底色（报告与输出共用这一口径） */
export function panelColorOver(tokens: ThemeTokens, alpha: number, under: string): string {
  return rgbToHex(composite(hexToRgb(tokens.panel), alpha, hexToRgb(under)));
}

export function renderThemeCss(input: RenderCssInput): string {
  const { tokens, spec, imageRef, resolvedMode } = input;
  const ref = imageRef;
  const overlay = rgba(tokens.background, overlayAlpha(spec));
  const blur = spec.blurPx > 0 ? spec.blurPx : 0;
  const panel = panelAlpha(spec);
  const bubble = bubbleAlpha(spec);

  /*
   * 背景层始终是「图片层 + 遮罩层」两个独立伪元素：
   * - ::before 画图片（模糊只作用在它身上，正文不受影响）
   * - ::after 画遮罩，顺序在 ::before 之后，因此叠在图片**之上**
   *   （旧实现把遮罩当 #root 背景、图片画在 ::before 上，遮罩被压到图片下面，等于没生效）
   * - #root 用 isolation 自建层叠上下文，两层用负 z-index 落到内容之后，
   *   不需要去改应用自己子元素的 position/z-index
   */
  const backgroundBlock = `html, body {
  background-color: ${tokens.background};
}

#root {
  position: relative;
  isolation: isolate;
  background-color: transparent;
}

#root::before {
  content: '';
  position: fixed;
  inset: ${blur > 0 ? `-${blur * 2}px` : '0'};
  background-image: url('${ref}');
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  ${blur > 0 ? `filter: blur(${blur}px);\n  ` : ''}pointer-events: none;
  z-index: -2;
}

#root::after {
  content: '';
  position: fixed;
  inset: 0;
  background: ${overlay};
  pointer-events: none;
  z-index: -1;
}`;

  return `/* 由 OpenCode 换肤助手生成；非官方本地资源定制，应用更新后可能失效。
   token 名依据 OpenCode 1.18.29 官方 main CSS 的语义变量清单，不含终端与语法高亮。 */
${backgroundBlock}

:root {
  color-scheme: ${resolvedMode};

${renderTokenCss(tokens, spec)}
}

/* 面板与容器：半透明真实透出背景图片，与预览、对比度报告同一口径 */
[data-component="dialog"],
[data-component="dialog-v2"],
[data-component="menu-v2-content"],
[data-component="dropdown-menu-content"],
[data-component="dropdown-menu-sub-content"],
[data-component="context-menu-content"],
[data-component="context-menu-sub-content"],
[data-component="tooltip"],
[data-component="tooltip-v2"],
[data-component="session-tab-popover"],
[data-component="dock-prompt"],
[data-component="prompt-input"],
[data-component="prompt-input-v2"] {
  background-color: ${rgba(tokens.panel, panel)} !important;
  border-color: ${rgba(tokens.border, 0.9)} !important;
  color: ${tokens.text} !important;
}

[data-slot="session-turn-assistant-content"] {
  background-color: ${rgba(tokens.panel, bubble)} !important;
  color: ${tokens.text} !important;
}

[data-slot="user-message-text"] {
  background-color: ${rgba(tokens.selection, REGION_ALPHAS.userBubble)} !important;
  color: ${tokens.text} !important;
}

[data-component="markdown-code"],
[data-component="code"] {
  background-color: ${rgba(tokens.panel, panel)} !important;
}

/*
 * 按钮按 variant 分开处理（R3）：早先不分 primary / secondary / ghost / destructive
 * 就把所有按钮染成同一个主色，把危险按钮也变成「确认」。现在只碰能确定语义的部分：
 * - primary：底色与文字由本工具决定（要保证对比度）
 * - secondary / ghost：只给 hover 叠加，底色交给应用自己的 token
 * - destructive 与 disabled：完全交给应用，避免把危险操作化装成普通按钮
 */
[data-component="button"][data-variant="primary"] {
  background-color: ${tokens.primary};
  border-color: ${tokens.primary};
  color: ${tokens.onPrimary};
}
[data-component="button"][data-variant="primary"] [data-slot="icon-svg"] {
  color: ${tokens.onPrimary};
}
[data-component="button"][data-variant="primary"]:hover:not(:disabled),
[data-component="button"][data-variant="primary"]:focus-visible:not(:disabled) {
  background-color: ${tokens.hover};
  border-color: ${tokens.hover};
}
[data-component="button"][data-variant="primary"]:active:not(:disabled) {
  background-color: ${tokens.pressed};
  border-color: ${tokens.pressed};
}
[data-component="button"][data-variant="primary"]:disabled {
  background-color: ${rgba(tokens.text, 0.06)};
  border-color: ${rgba(tokens.border, 0.5)};
  color: ${tokens.muted};
}
[data-component="button"][data-variant="secondary"]:hover:not(:disabled) {
  background-color: ${rgba(tokens.hover, 0.16)};
}
[data-component="button"][data-variant="ghost"]:hover:not(:disabled) {
  background-color: ${rgba(tokens.hover, REGION_ALPHAS.hover)};
}
[data-component="button"]:focus-visible {
  outline: 2px solid ${tokens.focus};
  outline-offset: 1px;
}

::selection {
  background: ${rgba(tokens.selection, 0.9)};
  color: ${tokens.text};
}

:focus-visible {
  outline-color: ${tokens.focus};
}
`;
}
