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
 * - 不叠加 `!important` 去救变量：官方运行时会在本表**之后**追加 `style#oc-theme`
 *   （普通 `:root`），同特异性下后者胜出，所以 token 声明改用更具体的 `html:root`
 *   （见下方注释）；`!important` 只用于确实需要压过官方组件类选择器的少数规则。
 *   旧主题那种 `#root { --x: … !important }` 由迁移预检先行撤下（见 legacy-theme.ts）。
 */
import type { ThemeSpec, ThemeTokens } from '../../shared/schema';
import { fail, ok, type Result } from '../../shared/errors';
import { hexToRgb, composite, rgbToHex } from './contrast';
import { darken, ensureContrast } from './color';
import { bubbleLayerAlpha, overlayAlpha, panelAlpha, REGION_ALPHAS } from './surfaces';
import { renderTokenCss } from './tokens';
import { CSS_OWN_BANNER } from '../patch/markers';

/**
 * 菜单/弹层的不透明深色面（X1，2026-09-25）。
 *
 * 菜单与弹层原本和 dialog、prompt-input 共用同一半透明面板 alpha，
 * 盖在壁纸上发闷、文字看不清。这里把它们单列成一组「不透明深色面」：
 * - 深色模式：把面板色再加深一档做不透明底，读起来是一块实色浮层；
 * - 浅色模式：只做轻微加深，保持浅色系但完全不透明；
 * - 文字用 ensureContrast 兜底，保证对新底色 ≥4.5（明暗两模式都成立）。
 * 导出以便单测直接断言对比度，不依赖正则抠 CSS。
 */
export function menuSurfaceColor(
  tokens: ThemeTokens,
  resolvedMode: 'light' | 'dark',
): { bg: string; text: string; ratio: number } {
  const bg = resolvedMode === 'dark' ? darken(tokens.panel, 0.22) : darken(tokens.panel, 0.06);
  const { color: text, ratio } = ensureContrast(tokens.text, bg, 'text');
  return { bg, text, ratio };
}

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
  // 气泡叠在面板之上：这里画的是它**自己**那一层（局部 p），累计效果才是 1-(1-p)²
  const bubble = bubbleLayerAlpha(spec);
  // 菜单/弹层的不透明深色面与文字（X1）
  const menu = menuSurfaceColor(tokens, resolvedMode);

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

  return `/* ${CSS_OWN_BANNER}；非官方本地资源定制，应用更新后可能失效。
   token 名依据 OpenCode 1.18.29 官方 main CSS 的语义变量清单，不含终端与语法高亮。 */
${backgroundBlock}

/*
 * token 声明必须用 html:root 而不是 :root（事故 F1）。
 *
 * 官方在启动后通过 ensureThemeStyleElement() 把 style#oc-theme（普通 :root 规则）
 * append 到 head，位置在助手样式表**之后**；切主题/明暗模式时会再次写入。
 * 助手若也用 :root，两者特异性相同（0,1,0），后加载者胜出 ——
 * 官方的实色变量会盖掉助手的 RGBA 面板值，根布局重新变实底，
 * 图片虽然加载成功却被完全挡住。
 *
 * html:root 是类型选择器 + 伪类（0,1,1），在同一根元素上比官方 :root 更具体，
 * 因此不必到处加 !important，也不改官方主题函数。
 * 不要退化成 #root：官方根级的 --color-* 别名可能已在祖先解析，
 * body 下的 Portal 也不一定继承 #root。
 *
 * 此方案针对已确认的 1.18.29 普通 :root 规则；若官方改用 inline style /
 * !important / 更强选择器，需要重新适配，不能宣称全版本通用。
 */
html:root {
  color-scheme: ${resolvedMode};

${renderTokenCss(tokens, spec)}
}

/* 面板与容器：半透明真实透出背景图片，与预览、对比度报告同一口径 */
/*
 * 大面积 NewLayout 外壳不再额外叠一层底色（事故 F2）。
 * 官方 main 里外壳是 relative + bg-v2-background-bg-deep + flex-1，
 * 它铺满整屏、下面还有各自的面板，等于给整个内容区又盖了一层；
 * 这里只让**这一处**外壳透明，保留标题栏、小控件、悬浮层各自的设计。
 *
 * 选择器取自本版本实际布局（1.18.29），升级后必须重新核对；
 * 若不再匹配就停止自动应用并补适配器布局证据，
 * 不能退化成 #root * { background: transparent !important } 这类全局清空。
 */
#root .bg-v2-background-bg-deep.flex-1 {
  background-color: transparent;
}

/*
 * 输入区停靠容器去横带（W1，2026-09-24 真机坐实）。
 *
 * 官方 SessionComposerRegion 的根是 data-component="session-prompt-dock"：
 * 全宽、实底（新版布局挂 bg-v2-background-bg-base，旧版挂 bg-background-stronger），
 * 里面才是居中限宽的输入列（md:max-w-200 / 2xl:max-w-[1000px]）。
 * 官方实底设计下这条底色带看不出来；换成半透明主题后，
 * 输入框两侧的容器底色就成了横贯的「白条」。
 * 让容器透明，面板色只由输入框本体承担——与 mock 预览同构（预览里输入框本就浮在壁纸上）。
 *
 * 选择器取自 1.18.32 实际 DOM（main-*.js classList 证据见 handoff W1-EVIDENCE.md），
 * 升级后需重新核对；两种布局变体由同一条属性选择器一并覆盖。
 */
#root [data-component="session-prompt-dock"] {
  background-color: transparent;
}

/*
 * 对话框与输入框：保留 W1/W2 定过的半透明面板观感，不随菜单一起改（X1 边界）。
 */
[data-component="dialog"],
[data-component="dialog-v2"],
[data-component="dock-prompt"],
[data-component="prompt-input"],
[data-component="prompt-input-v2"] {
  background-color: ${rgba(tokens.panel, panel)} !important;
  border-color: ${rgba(tokens.border, 0.9)} !important;
  color: ${tokens.text} !important;
}

/*
 * 菜单 / 弹层 / 提示：从上面共享半透明组里拆出来单列，改成不透明深色面（X1）。
 * 这些是浮在内容之上的短时层，半透明会让它们「发闷、字看不清」；
 * 底色用不透明深色、文字经对比度兜底（≥4.5），边框仍沿用 0.9 的面板边框色。
 * 输入框与对话框不在此列——它们的半透明是 W1/W2 定过的观感。
 */
[data-component="menu-v2-content"],
[data-component="dropdown-menu-content"],
[data-component="dropdown-menu-sub-content"],
[data-component="context-menu-content"],
[data-component="context-menu-sub-content"],
[data-component="tooltip"],
[data-component="tooltip-v2"],
[data-component="session-tab-popover"] {
  background-color: ${menu.bg} !important;
  border-color: ${rgba(tokens.border, 0.9)} !important;
  color: ${menu.text} !important;
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

/*
 * 输入框占位文字（P2，2026-09-19 真机坐实）：官方 Tailwind 预置把占位色定义为
 * 「currentcolor 与 transparent 各 50% 的 oklab 混合」。
 * 50% 透明稀释把次要文字色（#585e63）打到浅输入底（rgba(228,233,236,0.86)）上
 * 只剩 2.07:1——报告按未稀释的 muted 计量所以「通过」，真机却近乎不可读。
 * 这里保留官方的稀释形状，但把 transparent 换成主题自身的次要文字色：
 * 弱色占位恢复为 muted 原色，正文色占位混向 muted，均为不透明可读结果，
 * 也让 report.ts 的「输入占位文字」条目与实际渲染回到同一口径。
 * 本表不在 @layer 内，无层声明压过官方层内预置，不需要 important。
 */
::placeholder {
  color: color-mix(in oklab, currentcolor 50%, ${tokens.muted});
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
