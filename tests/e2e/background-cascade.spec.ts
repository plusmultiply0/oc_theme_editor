/**
 * 背景层叠回归（事故 F1/F2，见 handoff/background-incident-2026-09-12/BACKGROUND_FIX_PLAN.md）。
 *
 * 背景图片不显示的根因之一是**层叠顺序**：官方在运行时把 `style#oc-theme`
 * （普通 `:root` 规则）append 到 `<head>`，位置在助手样式表**之后**；
 * 助手也用 `:root`，同特异性下后加载者胜出，于是透明面板被官方实色覆盖，
 * 图片虽然加载成功却完全被挡住。
 *
 * 这个夹具复现该机制：先挂助手生成的 CSS，再模拟官方运行时插入 `:root`，
 * 然后断言自定义 token 仍然生效、背景像素确实透出。
 * 它用的是隔离布局与合成图片，**不读取真实安装的业务 JS、聊天内容或设置**。
 *
 * 浏览器用本机已安装的 Edge（`channel: 'msedge'`），不下载浏览器二进制，
 * 保持 sandbox 开启；与事故目录里的只读复现脚本同一策略。
 */
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import sharp from 'sharp';
import { renderThemeCss } from '../../src/core/theme/css';
import { deriveTokens } from '../../src/core/theme/generate';
import { SCHEMA_VERSION, type ThemeSpec } from '../../src/shared/schema';

const LAUNCH = { channel: 'msedge', headless: true, chromiumSandbox: true, timeout: 30_000 };

/** 官方运行时追加的 `:root`：值取自事故证据里的实色覆盖（1.18.29） */
const OFFICIAL_RUNTIME_ROOT = `:root {
  --background-base: #f8f8f8;
  --background-stronger: #fcfcfc;
  --v2-background-bg-deep: #fafafa;
}`;

let cachedImage: string | null = null;

/** 合成一张有明显纹理的小图，保证「图片是否可见」能用像素差判定 */
async function fixtureImage(): Promise<string> {
  if (cachedImage) return cachedImage;
  const png = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 12, g: 90, b: 200 } },
  })
    .composite([
      {
        input: await sharp({
          create: { width: 16, height: 16, channels: 3, background: { r: 240, g: 30, b: 60 } },
        }).png().toBuffer(),
        top: 0,
        left: 0,
      },
    ])
    .png()
    .toBuffer();
  cachedImage = `data:image/png;base64,${png.toString('base64')}`;
  return cachedImage;
}

function spec(): ThemeSpec {
  return {
    schemaVersion: SCHEMA_VERSION,
    imageId: 'cascade',
    mode: 'light',
    palette: ['#5f7396'],
    overlayOpacity: 0.35,
    panelOpacity: 0.4,
    blurPx: 0,
    reducedTransparency: false,
  };
}

/**
 * 官方静态 CSS：变量默认值 + Tailwind 式工具类。
 * 真实安装里 `main-*.css` 负责把 `--background-*` 变量接到 `.bg-*` 类上；
 * 缺了这一层，元素根本没有背景色，断言会空过（第一次写夹具时就踩了这个坑）。
 */
const OFFICIAL_STATIC_CSS = `:root {
  --background-base: #ffffff;
  --background-stronger: #f5f5f5;
  --v2-background-bg-deep: #eeeeee;
}
.bg-background-base { background-color: var(--background-base); }
.bg-background-stronger { background-color: var(--background-stronger); }
.bg-v2-background-bg-deep { background-color: var(--v2-background-bg-deep); }
.flex-1 { flex: 1 1 0%; }
#shell { display: flex; min-height: 200px; }
#sidebar { width: 120px; }
#session { flex: 1 1 0%; }`;

/** 隔离布局：只保留与背景透出有关的外壳/侧栏/正文三层，不加载官方业务 JS */
function fixtureHtml(cssText: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style id="official-static">
${OFFICIAL_STATIC_CSS}
</style>
<style id="ots-custom">
${cssText}
</style>
</head>
<body>
<div id="root">
  <div class="bg-v2-background-bg-deep flex-1" id="shell">
    <aside class="bg-background-base" id="sidebar">侧栏</aside>
    <main class="bg-background-stronger" id="session">正文</main>
  </div>
</div>
</body>
</html>`;
}

/** 模拟官方运行时：在助手样式表之后追加 style#oc-theme */
async function insertOfficialRuntime(page: Page): Promise<void> {
  await page.evaluate((text) => {
    const el = document.createElement('style');
    el.id = 'oc-theme';
    el.textContent = text;
    document.head.appendChild(el);
  }, OFFICIAL_RUNTIME_ROOT);
}

async function alphaOf(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`缺少元素 ${sel}`);
    const bg = getComputedStyle(el).backgroundColor;
    const m = /rgba?\(([^)]+)\)/.exec(bg);
    if (!m) return 1;
    const parts = m[1].split(',').map((s) => Number(s.trim()));
    return parts.length >= 4 ? parts[3] : 1;
  }, selector);
}

/**
 * 该区域的背景图是否真的透出：关掉 #root::before 的图片再截图，
 * 两次像素不同才说明这块区域没有被实色完全挡住。
 * 与事故证据用的是同一判据（可见像素变化），不是「不透明度」。
 */
async function imageVisible(page: Page, selector: string): Promise<boolean> {
  const withImage = await page.locator(selector).screenshot();
  await page.addStyleTag({ content: '#root::before { background-image: none !important; }' });
  const without = await page.locator(selector).screenshot();
  return Buffer.compare(withImage, without) !== 0;
}

async function openFixture(browser: Browser, cssText: string): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(fixtureHtml(cssText), { waitUntil: 'load' });
  return page;
}

test.describe('背景层叠：实色面板与多层外壳（F2）', () => {
  let browser: Browser;

  test.beforeAll(async () => {
    browser = await chromium.launch(LAUNCH);
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  /** 官方运行时覆盖 + 合成 CSS，返回已就夹具页 */
  async function prepared(): Promise<Page> {
    const imageRef = await fixtureImage();
    const s = spec();
    const tokens = deriveTokens(s.palette, 'light', undefined, '#e8e8ea');
    const cssText = renderThemeCss({ tokens, spec: s, imageRef, resolvedMode: 'light' });
    const page = await openFixture(browser, cssText);
    await insertOfficialRuntime(page);
    return page;
  }

  test('使用 --background-stronger 的正文区域不是实色，能透出背景', async () => {
    const page = await prepared();
    // 官方运行时把 stronger 覆盖成实色 #fcfcfc；修好前这里会是 1
    expect(await alphaOf(page, '#session')).toBeLessThan(1);
    expect(await imageVisible(page, '#session')).toBe(true);
    await page.close();
  });

  test('大面积 NewLayout 外壳不再额外叠一层底色', async () => {
    const page = await prepared();
    // 外壳是整屏容器，多叠一层 .6 底色就等于给整块区域加了滤镜
    expect(await alphaOf(page, '#shell')).toBe(0);
    await page.close();
  });

  test('减少透明度时面板退化为实底，这是设计如此而不是缺陷', async () => {
    const imageRef = await fixtureImage();
    const s = { ...spec(), reducedTransparency: true };
    const tokens = deriveTokens(s.palette, 'light', undefined, '#e8e8ea');
    const cssText = renderThemeCss({ tokens, spec: s, imageRef, resolvedMode: 'light' });
    const page = await openFixture(browser, cssText);
    await insertOfficialRuntime(page);
    expect(await alphaOf(page, '#session')).toBe(1);
    await page.close();
  });
});

test.describe('背景层叠：官方运行时覆盖（F1）', () => {
  let browser: Browser;

  test.beforeAll(async () => {
    browser = await chromium.launch(LAUNCH);
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('官方运行时追加 :root 之后，助手的自定义 token 仍然生效', async () => {
    const imageRef = await fixtureImage();
    const s = spec();
    const tokens = deriveTokens(s.palette, 'light', undefined, '#e8e8ea');
    const cssText = renderThemeCss({ tokens, spec: s, imageRef, resolvedMode: 'light' });

    const page = await openFixture(browser, cssText);
    const before = await alphaOf(page, '#sidebar');
    await insertOfficialRuntime(page);
    const after = await alphaOf(page, '#sidebar');

    // 官方用的是实色 #f8f8f8；若被覆盖，alpha 会变成 1
    expect(before).toBeLessThan(1);
    expect(after).toBeLessThan(1);
    expect(after).toBeCloseTo(before, 5);
    await page.close();
  });

  test('官方运行时覆盖后，侧栏仍能看到背景图片（不是被实色挡住）', async () => {
    const imageRef = await fixtureImage();
    const s = spec();
    const tokens = deriveTokens(s.palette, 'light', undefined, '#e8e8ea');
    const cssText = renderThemeCss({ tokens, spec: s, imageRef, resolvedMode: 'light' });

    const page = await openFixture(browser, cssText);
    await insertOfficialRuntime(page);
    expect(await imageVisible(page, '#sidebar')).toBe(true);
    await page.close();
  });

  test('官方主题再次移除并重新插入后，自定义 token 依然保持', async () => {
    const imageRef = await fixtureImage();
    const s = spec();
    const tokens = deriveTokens(s.palette, 'light', undefined, '#e8e8ea');
    const cssText = renderThemeCss({ tokens, spec: s, imageRef, resolvedMode: 'light' });

    const page = await openFixture(browser, cssText);
    await insertOfficialRuntime(page);
    await page.evaluate(() => {
      document.getElementById('oc-theme')?.remove();
    });
    await insertOfficialRuntime(page);

    expect(await alphaOf(page, '#sidebar')).toBeLessThan(1);
    expect(await imageVisible(page, '#sidebar')).toBe(true);
    await page.close();
  });
});
