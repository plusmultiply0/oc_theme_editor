/* Read-only installation audit + isolated rendering fixture. No target application JS is executed.
 * Usage: node verify-background.cjs [project] [archive] [output-directory]
 * Output directory must not already exist. Dependencies are resolved from the project.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const project = path.resolve(process.argv[2] || 'D:/zjcfile/weblearn/vibecoding/OpenCode_Theme_Switcher');
const archive = path.resolve(process.argv[3] || 'C:/Users/ylzho/AppData/Local/Programs/@opencode-aidesktop/resources/app.asar');
const output = path.resolve(process.argv[4] || path.join(__dirname, `verification-${Date.now()}`));
const requireProject = createRequire(path.join(project, 'package.json'));
const asar = requireProject('@electron/asar');
const sharp = requireProject('sharp');
const { chromium } = requireProject('playwright');
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
const entries = asar.listPackage(archive);
function read(entry) {
  const original = entries.find((e) => e.replace(/\\/g, '/').replace(/^\//, '') === entry);
  if (!original) throw new Error(`Missing archive entry: ${entry}`);
  return asar.extractFile(archive, original.slice(1));
}
function excerpt(text, marker, length = 1500) {
  const index = text.indexOf(marker);
  if (index < 0) throw new Error(`Version unsupported: missing ${marker}`);
  return { line: text.slice(0, index).split('\n').length, text: text.slice(index, index + length) };
}
async function main() {
  const beforeHash = hash(fs.readFileSync(archive));
  const html = read('out/renderer/index.html').toString();
  const css = read('out/renderer/oc-theme-custom.css').toString();
  const jpeg = read('out/renderer/oc-theme-background.jpg');
  const jsRef = html.match(/src="\.\/(assets\/main-[^"]+\.js)"/)?.[1];
  const cssRef = html.match(/href="\.\/(assets\/main-[^"]+\.css)"/)?.[1];
  if (!jsRef || !cssRef) throw new Error('Unsupported renderer HTML');
  const nativeCss = read(`out/renderer/${cssRef}`).toString();
  const nativeJs = read(`out/renderer/${jsRef}`).toString();
  const imageInfo = await sharp(jpeg).metadata();
  await sharp(jpeg).raw().toBuffer(); // full decode, not only metadata
  fs.mkdirSync(output, { recursive: false });
  const result = {
    scope: 'Isolated fixture, not the live OpenCode DOM. Official CSS + installed custom CSS and image; simplified shell. Official runtime :root insertion simulated with resolved native token values. No target business JS, storage or network.',
    project, archive, archiveHash: beforeHash,
    image: { bytes: jpeg.length, sha256: hash(jpeg), width: imageInfo.width, height: imageInfo.height, fullDecode: true },
    htmlIncludesCustomCss: html.includes('./oc-theme-custom.css'),
    officialSources: {
      jsEntry: jsRef,
      ensureThemeStyleElement: excerpt(nativeJs, 'function ensureThemeStyleElement()', 440),
      applyThemeCss: excerpt(nativeJs, 'function applyThemeCss(', 1250),
      shell: excerpt(nativeJs, '<div class="relative bg-v2-background-bg-deep', 550),
    },
    states: {}, assertions: {}
  };
  const { injectLink } = require(path.join(project, 'out/core/patch/stage.js'));
  let previousHtml = html;
  result.injectionPasses = [];
  for (let pass = 1; pass <= 3; pass++) {
    const injected = injectLink(previousHtml, './oc-theme-custom.css', '</head>');
    if (!injected.success) throw new Error('Injection reproduction failed');
    result.injectionPasses.push({ pass, unchanged: injected.data === previousHtml, bytes: Buffer.byteLength(injected.data) });
    previousHtml = injected.data;
  }
  console.log('Decoded archive image; launching isolated Edge fixture. Output:', output);
  const browser = await chromium.launch({ channel: 'msedge', headless: true, chromiumSandbox: true, timeout: 20000 });
  console.log('Isolated browser launched.');
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 650 }, colorScheme: 'light' });
    // All requests are served from memory or rejected. Never load the installed app's JS.
    await page.route('**/*', async (route) => {
      const p = new URL(route.request().url()).pathname;
      const files = {
        '/': ['text/html', '<!doctype html><html><head><link rel="stylesheet" href="/native.css"></head><body style="margin:0"><div id="root" class="flex flex-col h-dvh"><div id="shell" class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col"><div style="display:flex;height:100%"><aside id="base" class="bg-background-base" style="width:35%;height:100%">Sidebar fixture</aside><main id="stronger" class="bg-background-stronger" style="width:65%;height:100%">Session fixture</main></div></div></div></body></html>'],
        '/native.css': ['text/css', nativeCss],
        '/custom.css': ['text/css', css],
        '/oc-theme-background.jpg': ['image/jpeg', jpeg],
      };
      if (!files[p]) return route.abort();
      return route.fulfill({ status: 200, contentType: files[p][0], body: files[p][1] });
    });
    await page.goto('https://theme-fixture.invalid/');
    console.log('Fixture loaded.');
    const keys = [...new Set([...css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]))];
    const nativeTokens = await page.evaluate((names) => {
      const computed = getComputedStyle(document.documentElement);
      return Object.fromEntries(names.map((n) => [n, computed.getPropertyValue(n).trim()]).filter(([, v]) => v));
    }, keys);
    await page.addStyleTag({ url: '/custom.css' });
    result.image.browserDecode = await page.evaluate(async () => {
      const img = new Image(); img.src = '/oc-theme-background.jpg'; await img.decode();
      return [img.naturalWidth, img.naturalHeight];
    });
    async function state(label) {
      const values = await page.evaluate(() => {
        const names = ['--background-base', '--background-stronger', '--v2-background-bg-deep'];
        const root = document.querySelector('#root');
        return {
          tokens: Object.fromEntries(names.map((n) => [n, getComputedStyle(document.documentElement).getPropertyValue(n).trim()])),
          surfaces: Object.fromEntries(['shell', 'base', 'stronger'].map((id) => [id, getComputedStyle(document.getElementById(id)).backgroundColor])),
          image: getComputedStyle(root, '::before').backgroundImage,
          imageZ: getComputedStyle(root, '::before').zIndex,
          isolation: getComputedStyle(root).isolation,
        };
      });
      const on = await page.screenshot({ path: path.join(output, `${label}.png`) });
      const hidden = await page.addStyleTag({ content: '#root::before { background-image: none !important; }' });
      const off = await page.screenshot(); await hidden.evaluate((el) => el.remove());
      const a = await sharp(on).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const b = await sharp(off).removeAlpha().raw().toBuffer();
      const diffs = {};
      for (const [region, x0, x1] of [['sidebar', 5, 340], ['session', 360, 990]]) {
        let changed = 0, total = 0;
        for (let y = 50; y < 630; y++) for (let x = x0; x < x1; x++) {
          const i = (y * a.info.width + x) * a.info.channels;
          if (Math.abs(a.data[i] - b[i]) + Math.abs(a.data[i + 1] - b[i + 1]) + Math.abs(a.data[i + 2] - b[i + 2]) > 6) changed++;
          total++;
        }
        diffs[region] = +(changed / total).toFixed(4);
      }
      values.backgroundVisiblePixelFraction = diffs;
      result.states[label] = values;
      console.log(label, JSON.stringify(values));
    }
    await state('01-static-custom');
    const dynamic = ':root {\n' + Object.entries(nativeTokens).map(([n, v]) => `${n}: ${v};`).join('\n') + '\n}';
    await page.evaluate((content) => {
      const element = document.createElement('style'); element.id = 'oc-theme';
      element.textContent = content; document.head.appendChild(element);
    }, dynamic);
    await state('02-runtime-overrides');
    await page.addStyleTag({ content: css.replace(/\n:root\s*\{/g, '\nhtml:root {') });
    await state('03-specificity-only');
    // Proposed scoped ownership: shell transparent; actual content panels translucent.
    // Do not change non-alpha fallback token semantics globally.
    await page.addStyleTag({ content: 'html:root { --background-stronger: var(--background-base); } #root .bg-v2-background-bg-deep.flex-1 { background-color: transparent; }' });
    await state('04-surface-fix');
    await page.evaluate((content) => {
      const style = document.getElementById('oc-theme'); style.remove();
      const replacement = document.createElement('style'); replacement.id = 'oc-theme';
      replacement.textContent = content; document.head.appendChild(replacement);
    }, dynamic);
    await state('05-runtime-reinserted');
    result.assertions = {
      runtimeHidesImage: Object.values(result.states['02-runtime-overrides'].backgroundVisiblePixelFraction).every((v) => v === 0),
      specificityRestoresSidebar: result.states['03-specificity-only'].backgroundVisiblePixelFraction.sidebar > 0.1,
      specificityAloneLeavesSessionOpaque: result.states['03-specificity-only'].backgroundVisiblePixelFraction.session === 0,
      surfaceFixRestoresBoth: Object.values(result.states['04-surface-fix'].backgroundVisiblePixelFraction).every((v) => v > 0.1),
      survivesRuntimeReinsert: Object.values(result.states['05-runtime-reinserted'].backgroundVisiblePixelFraction).every((v) => v > 0.1),
      archiveNotModified: hash(fs.readFileSync(archive)) === beforeHash,
    };
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ output, states: result.states, assertions: result.assertions }, null, 2));
    if (Object.values(result.assertions).some((v) => !v)) process.exitCode = 2;
  } finally { await browser.close(); }
}
const guard = setTimeout(() => { console.error('Fixture timed out; no successful verification claimed.'); process.exit(3); }, 90000);
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => clearTimeout(guard));
