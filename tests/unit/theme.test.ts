import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { contrastRatio, composite, effectiveBackground, hexToRgb } from '../../src/core/theme/contrast';
import { extractPalette, isMostlyGray } from '../../src/core/theme/palette';
import { DEFAULT_LIMITS, looksLikeSvg, sniffFormat, validateImage } from '../../src/core/theme/validate';
import { validateImageRef } from '../../src/core/theme/css';
import { ensureContrast } from '../../src/core/theme/color';
import { analyzeImage, deriveTokens, generateTheme } from '../../src/core/theme/generate';
import { buildContrastReport } from '../../src/core/theme/report';
import { bubbleAlpha, overlayAlpha, panelAlpha } from '../../src/core/theme/surfaces';
import { renderTokenDeclarations as tokenDeclarations } from '../../src/core/theme/tokens';
import { renderThemeCss, menuSurfaceColor } from '../../src/core/theme/css';
import { SCHEMA_VERSION, type ThemeSpec, type ThemeTokens } from '../../src/shared/schema';

/** 直接渲染 CSS，跳过图片解码：层级与 token 的正确性不该依赖抓图 */
function generateCss(tokens: ThemeTokens, spec: ThemeSpec): string {
  return renderThemeCss({
    tokens,
    spec,
    imageRef: './bg.jpg',
    resolvedMode: spec.mode === 'light' ? 'light' : 'dark',
  });
}

async function solid(width: number, height: number, color: { r: number; g: number; b: number; alpha?: number }) {
  return sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer();
}

function makeSpec(overrides: Partial<ThemeSpec> = {}): ThemeSpec {
  return {
    schemaVersion: SCHEMA_VERSION,
    imageId: 'img_test',
    mode: 'auto',
    palette: ['#404558'],
    overlayOpacity: 0.35,
    panelOpacity: 0.86,
    blurPx: 0,
    reducedTransparency: false,
    ...overrides,
  };
}

describe('格式识别（T20）', () => {
  it('依据 magic bytes 识别 PNG/JPEG/WebP', async () => {
    const png = await solid(8, 8, { r: 10, g: 20, b: 30 });
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg()
      .toBuffer();
    const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .webp()
      .toBuffer();

    expect(sniffFormat(png)).toBe('png');
    expect(sniffFormat(jpeg)).toBe('jpeg');
    expect(sniffFormat(webp)).toBe('webp');
  });

  it('拒绝无法识别的内容与 SVG', () => {
    expect(sniffFormat(Buffer.from('not an image at all!!'))).toBeNull();
    expect(looksLikeSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(true);
  });
});

describe('体积与像素限制（T20）', () => {
  it('超限返回可展示的原因与建议', () => {
    const r = validateImage({ bytes: DEFAULT_LIMITS.maxBytes + 1 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.code).toBe('IMAGE_TOO_LARGE');
      expect(r.error.recoveryHint).not.toBe('');
    }
  });

  it('解码像素超限时拒绝', () => {
    const r = validateImage({ bytes: 1024, width: 8000, height: 6000 });
    expect(r.success).toBe(false);
  });
});

describe('取色确定性（T22）', () => {
  it('同输入同参数结果一致', () => {
    const pixels = new Uint8Array(300);
    for (let i = 0; i < 100; i += 1) {
      pixels[i * 3] = (i * 7) % 256;
      pixels[i * 3 + 1] = (i * 13) % 256;
      pixels[i * 3 + 2] = (i * 29) % 256;
    }
    const a = extractPalette(pixels, 3, { count: 5 });
    const b = extractPalette(pixels, 3, { count: 5 });
    expect(a).toEqual(b);
  });

  it('灰度图被识别为低饱和，供 UI 提示', () => {
    expect(isMostlyGray(['#808080', '#7a7a7a'])).toBe(true);
    expect(isMostlyGray(['#c0392b'])).toBe(false);
  });
});

describe('对比度（T25、T26）', () => {
  it('黑白对比度为 21', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });

  it('相同颜色对比度为 1', () => {
    expect(contrastRatio('#123456', '#123456')).toBeCloseTo(1, 5);
  });

  it('半透明面板必须合成后再比较，不能直比较两枚 token', () => {
    const image = { r: 20, g: 30, b: 40 };
    const panel = { r: 255, g: 255, b: 255 };
    const effective = effectiveBackground(image, { r: 0, g: 0, b: 0 }, 0, panel, 0.5);
    expect(effective.r).toBeGreaterThan(image.r);
    expect(effective.r).toBeLessThan(panel.r);
  });

  it('合成公式符合 alpha 混合', () => {
    const c = composite({ r: 255, g: 255, b: 255 }, 0.5, { r: 0, g: 0, b: 0 });
    expect(c).toEqual({ r: 127.5, g: 127.5, b: 127.5 });
  });
});

describe('图片引用白名单（T23）', () => {
  it('接受归档内相对路径', () => {
    expect(validateImageRef('./oc-theme-background.jpg').success).toBe(true);
  });

  it.each(['https://example.com/a.jpg', '//cdn.example.com/a.jpg', '/abs/a.jpg', "a.jpg';}body{"])(
    '拒绝 %s',
    (ref) => {
      expect(validateImageRef(ref).success).toBe(false);
    },
  );
});

describe('主题生成', () => {
  it('纯黑图片生成主题后正文对比度达标', async () => {
    const buf = await solid(64, 64, { r: 0, g: 0, b: 0 });
    const r = await generateTheme({ buffer: buf, spec: makeSpec(), imageRef: './bg.jpg' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(contrastRatio(r.data.tokens.text, r.data.tokens.panel)).toBeGreaterThanOrEqual(4.5);
      expect(r.data.css).toContain("url('./bg.jpg')");
    }
  });

  it('纯白图片生成主题后正文对比度达标', async () => {
    const buf = await solid(64, 64, { r: 255, g: 255, b: 255 });
    const r = await generateTheme({ buffer: buf, spec: makeSpec(), imageRef: './bg.jpg' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(contrastRatio(r.data.tokens.text, r.data.tokens.panel)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('同一张图两次生成结果完全一致（可重放）', async () => {
    const buf = await solid(48, 48, { r: 64, g: 96, b: 160 });
    const a = await generateTheme({ buffer: buf, spec: makeSpec(), imageRef: './bg.jpg' });
    const b = await generateTheme({ buffer: buf, spec: makeSpec(), imageRef: './bg.jpg' });
    expect(a).toEqual(b);
  });

  it('损坏图片被拒绝并给出原因', async () => {
    const r = await analyzeImage(Buffer.from('not an image at all!!'));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('IMAGE_INVALID_FORMAT');
  });

  it('SVG 被明确拒绝', async () => {
    const r = await analyzeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toContain('SVG');
  });

  it('auto 模式按图片明暗选择基调', async () => {
    const dark = await solid(32, 32, { r: 8, g: 8, b: 12 });
    const light = await solid(32, 32, { r: 240, g: 240, b: 245 });
    const d = await generateTheme({ buffer: dark, spec: makeSpec(), imageRef: './bg.jpg' });
    const l = await generateTheme({ buffer: light, spec: makeSpec(), imageRef: './bg.jpg' });
    expect(d.success && d.data.mode).toBe('dark');
    expect(l.success && l.data.mode).toBe('light');
  });

  it('color-scheme 与解析后的基调一致，不跟随 spec.mode 的字面值', async () => {
    const dark = await solid(32, 32, { r: 8, g: 8, b: 12 });
    const light = await solid(32, 32, { r: 240, g: 240, b: 245 });
    const d = await generateTheme({ buffer: dark, spec: makeSpec(), imageRef: './bg.jpg' });
    const l = await generateTheme({ buffer: light, spec: makeSpec(), imageRef: './bg.jpg' });
    expect(d.success && d.data.css).toContain('color-scheme: dark');
    expect(l.success && l.data.css).toContain('color-scheme: light');
  });

  it('显式指定 dark 时，即便图片偏亮也输出 dark', async () => {
    const light = await solid(32, 32, { r: 240, g: 240, b: 245 });
    const r = await generateTheme({
      buffer: light,
      spec: makeSpec({ mode: 'dark' }),
      imageRef: './bg.jpg',
    });
    expect(r.success && r.data.mode).toBe('dark');
    expect(r.success && r.data.css).toContain('color-scheme: dark');
  });

  it('返回三层合成后的实际底色与对比度报告', async () => {
    const buf = await solid(48, 48, { r: 64, g: 96, b: 160 });
    const r = await generateTheme({ buffer: buf, spec: makeSpec(), imageRef: './bg.jpg' });
    expect(r.success).toBe(true);
    if (r.success) {
      const text = r.data.report.entries.find((e) => e.element === '正文');
      expect(text?.pass).toBe(true);
      expect(r.data.effectiveBackground).toMatch(/^#[0-9a-f]{6}$/);
      // 实际底色应当既不是纯图片色，也不是纯面板色
      expect(r.data.effectiveBackground).not.toBe(r.data.palette[0]);
      expect(r.data.effectiveBackground).not.toBe(r.data.tokens.panel);
    }
  });

  it('报告逐条给出元素、实测值与目标值，且未做真实采样时不得标记 verified', async () => {
    const buf = await solid(48, 48, { r: 64, g: 96, b: 160 });
    const r = await generateTheme({ buffer: buf, spec: makeSpec(), imageRef: './bg.jpg' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.report.entries.length).toBeGreaterThan(5);
      for (const e of r.data.report.entries) {
        expect(e.required).toBeGreaterThan(0);
        expect(e.ratio).toBeGreaterThan(0);
      }
      expect(r.data.report.verified).toBe(false);
      expect(r.data.report.scope).toContain('不含终端配色');
    }
  });

  it('主色可覆盖，且 hover/pressed 三态互不相同', () => {
    const tokens = deriveTokens(['#404558'], 'light', '#2f6fd0');
    expect(tokens.primary).toBe('#2f6fd0');
    expect(new Set([tokens.primary, tokens.hover, tokens.pressed]).size).toBe(3);
  });

  it('状态色与 diff 色独立于主色，不被主题污染（T27）', () => {
    const tokens = deriveTokens(['#c0392b'], 'dark');
    // 保持色相语义：错误偏红、成功偏绿，且两者不同
    const err = hexToRgb(tokens.status.error);
    const ok = hexToRgb(tokens.status.success);
    expect(err.r).toBeGreaterThan(err.g);
    expect(ok.g).toBeGreaterThan(ok.r);
    expect(tokens.status.error).not.toBe(tokens.primary);
    expect(tokens.diff.added).not.toBe(tokens.diff.removed);
  });

  it('深色基调下状态色与 diff 色仍满足正文对比度', () => {
    const tokens = deriveTokens(['#101418'], 'dark', undefined, '#1b1f27');
    for (const c of [
      tokens.status.error,
      tokens.status.warning,
      tokens.status.success,
      tokens.status.info,
      tokens.diff.added,
      tokens.diff.removed,
    ]) {
      expect(contrastRatio(c, '#1b1f27')).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('hex 解析正确', () => {
    expect(hexToRgb('#ff8000')).toEqual({ r: 255, g: 128, b: 0 });
  });
});

describe('中间调底色上的可读性（真实数据回归）', () => {
  // 真实安装上出现过：主色为中间调时，主按钮文字只有 4.11，达不到 4.5。
  // 原因是 ensureContrast 只沿「远离背景」一个方向调整，而起点已经是纯白。
  it.each(['#5b6ea8', '#6a7bb5', '#7a86c9', '#4a5b8f', '#8a93d0'])(
    '主色 %s 下主按钮文字仍达到 4.5',
    (primary) => {
      const tokens = deriveTokens([primary], 'dark', primary, '#20242e');
      expect(contrastRatio(tokens.onPrimary, tokens.primary)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('ensureContrast 在两个方向都试过之后再判无解', () => {
    const mid = '#6a7bb5';
    const r = ensureContrast('#ffffff', mid, 'text');
    expect(r.pass).toBe(true);
    expect(r.ratio).toBeGreaterThanOrEqual(4.5);
  });
});

describe('层级模型与报告覆盖（R4、R5）', () => {
  it('面板/气泡/遮罩的不透明度只有一份定义，预览、输出与报告共用', () => {
    const spec = makeSpec({ panelOpacity: 0.5, overlayOpacity: 0.4 });
    expect(panelAlpha(spec)).toBe(0.5);
    expect(overlayAlpha(spec)).toBe(0.4);
    // 两层同样不透明度的面板叠加，等效不透明度是 1-(1-a)²
    expect(bubbleAlpha(spec)).toBeCloseTo(0.75, 6);
  });

  it('「减少透明度」直接决定面板不透明度，不再是仅预览的装饰', () => {
    const spec = makeSpec({ panelOpacity: 0.2, reducedTransparency: true });
    expect(panelAlpha(spec)).toBe(1);
    expect(bubbleAlpha(spec)).toBe(1);
  });

  it('报告覆盖侧栏、输入、菜单、选中项与按钮三态，且不再只测 default', () => {
    const tokens = deriveTokens(['#404558'], 'dark', undefined, '#1b1f27');
    const report = buildContrastReport({
      tokens,
      spec: makeSpec({ mode: 'dark' }),
      imageSamples: [hexToRgb('#404558'), hexToRgb('#787e9f')],
      effective: '#1b1f27',
    });
    const keys = report.entries.map((e) => `${e.element}:${e.state}`);
    for (const want of [
      '侧栏文字:default',
      '侧栏选中项:default',
      '对话气泡正文:default',
      '输入占位文字:default',
      '菜单项悬停:hover',
      '次级按钮文字:default',
      '主按钮文字:default',
      '主按钮文字:hover',
      '主按钮文字:pressed',
      '焦点环:focus',
      'diff 新增:default',
    ]) {
      expect(keys).toContain(want);
    }
  });

  it('多采样点取最差：同一主题在不同底图上不会因为只测一个代表色而误判通过', () => {
    const tokens = deriveTokens(['#404558'], 'light', undefined, '#f2f2f4');
    const report = buildContrastReport({
      tokens,
      spec: makeSpec({ panelOpacity: 0, mode: 'light' }),
      imageSamples: [hexToRgb('#ffffff'), hexToRgb('#000000')],
      effective: '#ffffff',
    });
    const body = report.entries.find((e) => e.element === '正文');
    expect(body).toBeDefined();
    expect(body?.samples).toBe(2);
    // 底色取到最差的黑色，白色正文不可能达标
    expect(body?.pass).toBe(false);
    expect(body?.estimated).toBe(true);
  });

  it('条目上标明是否为估算，不把代表色结果说成「实际底色」', () => {
    const tokens = deriveTokens(['#404558'], 'dark', undefined, '#1b1f27');
    const report = buildContrastReport({
      tokens,
      spec: makeSpec(),
      imageSamples: [hexToRgb('#404558')],
      effective: '#1b1f27',
    });
    for (const e of report.entries) expect(typeof e.estimated).toBe('boolean');
    // 主按钮底色是不透明的 token 自身，不依赖图片，因此不是估算
    const button = report.entries.find((e) => e.element === '主按钮文字' && e.state === 'default');
    expect(button?.estimated).toBe(false);
  });
});

describe('token 映射与输出一致性（R3、R5）', () => {
  const tokens = deriveTokens(['#404558'], 'dark', undefined, '#1b1f27');

  it('映射到 1.18.29 真实存在的语义 token，不再自造 --ts-* 变量', () => {
    const names = tokenDeclarations(tokens, makeSpec({ mode: 'dark' })).map((d) => d.name);
    for (const must of [
      '--background-base',
      '--surface-base',
      '--text-base',
      '--text-weak',
      '--icon-base',
      '--icon-weak-base',
      '--border-base',
      '--border-focus',
      '--button-primary-base',
      '--button-ghost-hover',
      '--input-base',
      '--v2-background-bg-layer-01',
      '--v2-text-text-muted',
      '--v2-icon-icon-accent',
      '--v2-border-border-focus',
      '--v2-state-fg-danger',
      '--text-diff-add-base',
      '--surface-diff-delete-base',
    ]) {
      expect(names).toContain(must);
    }
    expect(names.some((n) => n.startsWith('--ts-'))).toBe(false);
  });

  it('语法高亮与终端 token 不在覆盖范围内（T27 的边界仍然成立）', () => {
    const names = tokenDeclarations(tokens, makeSpec()).map((d) => d.name);
    expect(names.some((n) => n.startsWith('--syntax-'))).toBe(false);
    expect(names.some((n) => n.startsWith('--markdown-'))).toBe(false);
  });

  it('面板用真实 rgba，透明度不再是「改色」', () => {
    const css = generateCss(tokens, makeSpec({ panelOpacity: 0.5 }));
    const { r, g, b } = hexToRgb(tokens.panel);
    expect(css).toContain(`rgba(${r}, ${g}, ${b}, 0.5)`);
  });

  it('减少透明度开启后，输出的面板必须是实底', () => {
    const css = generateCss(tokens, makeSpec({ panelOpacity: 0.2, reducedTransparency: true }));
    const { r, g, b } = hexToRgb(tokens.panel);
    expect(css).toContain(`rgba(${r}, ${g}, ${b}, 1)`);
    expect(css).not.toContain(`rgba(${r}, ${g}, ${b}, 0.2)`);
  });

  it('模糊只作用图片层，遮罩是叠在图片之上的独立层', () => {
    const css = generateCss(tokens, makeSpec({ blurPx: 10 }));
    expect(css).toContain('filter: blur(10px)');
    // 图片在 ::before，遮罩在 ::after —— 后画的叠在上面
    expect(css.indexOf('#root::before')).toBeLessThan(css.indexOf('#root::after'));
  });

  it('按钮按 variant 分开处理，不再把危险/次级按钮一起染成主色', () => {
    const css = generateCss(tokens, makeSpec());
    expect(css).toContain('[data-component="button"][data-variant="primary"]');
    expect(css).toContain('[data-component="button"][data-variant="secondary"]');
    expect(css).toContain('[data-component="button"][data-variant="ghost"]');
    // 不存在不分 variant 的粗放规则
    expect(css).not.toMatch(/\[data-component="button"\]\s*\{/);
  });

  it('输入区停靠容器透明，全宽底色带不再露出（W1 回归）', () => {
    const css = generateCss(tokens, makeSpec());
    // dock 本体透明（新旧布局两条工具类都由这一条属性选择器盖住），且不需要 !important
    expect(css).toContain('#root [data-component="session-prompt-dock"] {\n  background-color: transparent;\n}');
    // 输入框本体的面板底色规则仍在，透明只作用于外层容器
    expect(css).toContain('[data-component="prompt-input-v2"]');
  });

  it('菜单/弹层拆成不透明深色面，与 dialog/prompt-input 的半透明组分开（X1 回归）', () => {
    const css = generateCss(tokens, makeSpec());
    const menu = menuSurfaceColor(tokens, 'dark');
    // 菜单组底色是实色 hex（menu.bg），不是 rgba 半透明
    expect(menu.bg).toMatch(/^#[0-9a-f]{6}$/);
    expect(css).toContain(`[data-component="menu-v2-content"],`);
    expect(css).toContain(`[data-component="session-tab-popover"] {\n  background-color: ${menu.bg} !important;`);
    // dialog 与 prompt-input 仍在半透明面板组里，未随菜单一起变实色
    const { r, g, b } = hexToRgb(tokens.panel);
    const panelRgba = `rgba(${r}, ${g}, ${b}, ${0.86})`;
    expect(css).toContain(`[data-component="dialog"],\n[data-component="dialog-v2"],\n[data-component="dock-prompt"],\n[data-component="prompt-input"],\n[data-component="prompt-input-v2"] {\n  background-color: ${panelRgba} !important;`);
    // 菜单组里不应出现半透明 rgba 面板底（拆组前是这样）
    const menuBlock = css.slice(css.indexOf('[data-component="menu-v2-content"]'));
    expect(menuBlock.slice(0, menuBlock.indexOf('}') + 1)).not.toContain(`rgba(${r}, ${g}, ${b}`);
  });

  it('菜单文字对新底色在明暗两模式下都达到正文对比度（X1 自证）', () => {
    const darkTokens = deriveTokens(['#404558'], 'dark', undefined, '#1b1f27');
    const lightTokens = deriveTokens(['#cfd6dd'], 'light', undefined, '#eef1f4');
    for (const [mode, tk] of [['dark', darkTokens], ['light', lightTokens]] as const) {
      const m = menuSurfaceColor(tk, mode);
      expect(m.bg).not.toBe(tk.panel); // 确实按 mode 加深了一档
      expect(contrastRatio(m.text, m.bg)).toBeGreaterThanOrEqual(4.5);
      expect(m.ratio).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('占位文字稀释混向不透明的次要文字色，不再混向 transparent（P2 回归）', () => {
    const css = generateCss(tokens, makeSpec());
    // 官方预置的形状是 50% 混向 transparent（浅输入底上实测只剩 2.07:1）；
    // 我们的覆盖必须是 50% 混向本主题的 muted，且整表不得再出现 transparent 稀释
    expect(css).toContain(`::placeholder {\n  color: color-mix(in oklab, currentcolor 50%, ${tokens.muted});\n}`);
    expect(css).not.toContain('currentcolor 50%, transparent');
  });
});
