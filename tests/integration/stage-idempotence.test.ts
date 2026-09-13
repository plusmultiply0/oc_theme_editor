/**
 * 换图幂等与 HTML 结构性门禁（事故 F3）。
 *
 * 背景：换图时 CSS/图片会变，但 HTML 里的 link 本来就应该保持不变
 * （injectLink 是幂等的：先删掉带标记的旧行，再插入同一行）。
 * 旧门禁却要求「HTML 必须出现在 touched 列表里」，于是第二次换图
 * 直接返回 STAGE_FAILED —— 与「写入成功却看不见」是两个不同分支。
 *
 * 这里覆盖两件事：
 * 1. 连续换图必须一路成功，且 HTML 里始终保持**恰好一个**本工具链接；
 * 2. 门禁改成结构性验证后，缺 link / 重复 link / href 不对 / 锚点缺失
 *    这些真正的异常仍需被拒绝（不能为了绕过报错而放宽）。
 *
 * 全部使用合成安装，不触碰真实安装。
 */
import fs from 'node:fs';
import { testTmpRoot } from '../fixtures/test-tmp';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeSyntheticInstall, type SyntheticInstall } from '../fixtures/synthetic-install';
import { inspectRoot } from '../../src/core/patch/discover';
import { applyTheme } from '../../src/core/patch/apply';
import { readAsar, readAsarText, sha256File } from '../../src/core/patch/asar';
import { listTx } from '../../src/core/patch/txlog';
import { runtimeDirs } from '../../src/core/patch/layout';
import { instanceIdFromPath } from '../../src/core/patch/paths';
import { injectLink, verifyStagedHtml } from '../../src/core/patch/stage';
import { ADAPTER } from './helpers/adapter';
import type { TargetInfo } from '../../src/shared/schema';

const installs: SyntheticInstall[] = [];
const runtimeRoots: string[] = [];

function newRuntime(): string {
  const d = fs.mkdtempSync(path.join(testTmpRoot(), 'ots-idem-'));
  runtimeRoots.push(d);
  return d;
}

async function makeTarget(): Promise<{ inst: SyntheticInstall; target: TargetInfo }> {
  const inst = await makeSyntheticInstall();
  installs.push(inst);
  const r = await inspectRoot(inst.root);
  if (!r.success || r.data.kind !== 'target') throw new Error('fixture 不是可识别目标');
  return { inst, target: r.data.target };
}

function css(color: string): string {
  return `html:root { --background-base: ${color}; }`;
}

/** 三张不同的图，保证内容指纹每次都变 */
const IMAGES = ['image-A-bytes', 'image-B-bytes-longer', 'image-C-bytes!'] as const;

async function doApply(args: Parameters<typeof applyTheme>[0]) {
  return applyTheme({ ...args, hooks: { probe: async () => 'idle', ...(args.hooks ?? {}) } });
}

async function readEntry(inst: SyntheticInstall, entry: string): Promise<string> {
  const snap = await readAsar(inst.archivePath);
  if (!snap.success) throw new Error(`读取归档失败：${snap.error.message}`);
  const r = await readAsarText(snap.data, entry);
  if (!r.success) throw new Error(`读取 ${entry} 失败：${r.error.message}`);
  return r.data;
}

async function htmlOf(inst: SyntheticInstall): Promise<string> {
  return readEntry(inst, ADAPTER.injection.htmlEntry);
}

afterEach(() => {
  while (installs.length) installs.pop()?.cleanup();
  while (runtimeRoots.length) fs.rmSync(runtimeRoots.pop() as string, { recursive: true, force: true });
});

describe('连续换图（A→B→C）', () => {
  it('每次都成功：HTML 链接始终恰好一个，图片更新，白名单外条目不变', async () => {
    const { inst, target } = await makeTarget();
    const runtime = newRuntime();
    const layout = runtimeDirs(runtime, instanceIdFromPath(target.installPath));

    const entryBefore = await readEntry(inst, 'out/main/index.js');
    const hashes: string[] = [];

    for (const [i, bytes] of IMAGES.entries()) {
      const r = await doApply({
        target,
        runtimeRoot: runtime,
        css: css(`#00000${i}`),
        imageBytes: Buffer.from(bytes),
        themeSummary: `主题 ${String.fromCharCode(65 + i)}`,
      });
      expect(r.success, `第 ${i + 1} 次应用失败：${r.success ? '' : `${r.error.code} ${r.error.message}`}`).toBe(
        true,
      );
      if (!r.success) return;

      // HTML 里本工具链接必须恰好一个（换图不该叠加）
      const html = await htmlOf(inst);
      const links = html.match(/<link[^>]*oc-theme-custom\.css[^>]*>/g) ?? [];
      expect(links, `第 ${i + 1} 次应用后链接数异常`).toHaveLength(1);
      expect(html.match(/opencode-theme-switcher/g) ?? []).toHaveLength(1);

      // 图片确实换成了本次的字节
      expect(await readEntry(inst, ADAPTER.injection.imageFile)).toBe(bytes);
      hashes.push(await sha256File(inst.archivePath));
    }

    // 三次归档各不相同（内容确实变了），但白名单外条目保持原样
    expect(new Set(hashes).size).toBe(3);
    expect(await readEntry(inst, 'out/main/index.js')).toBe(entryBefore);

    // 每次应用都留下了事务记录
    const tx = await listTx(layout.txDir);
    expect(tx.length).toBeGreaterThanOrEqual(3);
  });

  it('同图重复应用（C→C）走 no-op：不改写归档、不新增事务', async () => {
    const { inst, target } = await makeTarget();
    const runtime = newRuntime();
    const layout = runtimeDirs(runtime, instanceIdFromPath(target.installPath));

    const applyC = async () =>
      doApply({
        target,
        runtimeRoot: runtime,
        css: css('#333333'),
        imageBytes: Buffer.from(IMAGES[2]),
        themeSummary: '主题 C',
      });

    const first = await applyC();
    expect(first.success).toBe(true);
    if (!first.success) return;
    expect(first.data.noop).toBe(false);
    const afterFirst = await sha256File(inst.archivePath);
    const txAfterFirst = (await listTx(layout.txDir)).length;

    const second = await applyC();
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data.noop).toBe(true);
    expect(await sha256File(inst.archivePath)).toBe(afterFirst);
    expect((await listTx(layout.txDir)).length).toBe(txAfterFirst);
  });
});

describe('HTML 结构性门禁（替换「HTML 必须变化」）', () => {
  const cssFile = ADAPTER.injection.cssFile;
  const href = `./${path.basename(cssFile)}`;
  const marker = '<!-- opencode-theme-switcher -->';

  const good = `<!doctype html><html><head><title>t</title>\n<link rel="stylesheet" href="${href}"> ${marker}\n</head><body></body></html>`;

  it('正常注入通过', () => {
    expect(verifyStagedHtml(good, ADAPTER).success).toBe(true);
  });

  it('缺少本工具链接 → 拒绝', () => {
    const html = '<!doctype html><html><head><title>t</title></head><body></body></html>';
    const r = verifyStagedHtml(html, ADAPTER);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toContain('链接');
  });

  it('重复链接 → 拒绝', () => {
    const html = `<!doctype html><html><head>\n<link rel="stylesheet" href="${href}"> ${marker}\n<link rel="stylesheet" href="${href}"> ${marker}\n</head><body></body></html>`;
    const r = verifyStagedHtml(html, ADAPTER);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toContain('链接');
  });

  it('href 不正确 → 拒绝', () => {
    const html = `<!doctype html><html><head>\n<link rel="stylesheet" href="./other.css"> ${marker}\n</head><body></body></html>`;
    const r = verifyStagedHtml(html, ADAPTER);
    expect(r.success).toBe(false);
    // href 不对时等于「本工具链接不存在」，拒绝并点名期望的文件
    if (!r.success) expect(r.error.message).toContain('oc-theme-custom.css');
  });

  it('链接不在 head 内（在锚点之后）→ 拒绝', () => {
    const html = `<!doctype html><html><head></head><body>\n<link rel="stylesheet" href="${href}"> ${marker}\n</body></html>`;
    const r = verifyStagedHtml(html, ADAPTER);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toContain('head');
  });

  it('锚点缺失 → 拒绝', () => {
    const html = `<!doctype html><html><body>\n<link rel="stylesheet" href="${href}"> ${marker}\n</body></html>`;
    const r = verifyStagedHtml(html, ADAPTER);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toContain('锚点');
  });

  // ---- A3：真实 head 区间 + 属性容错 + 注释不参与 ----

  it('注释里的伪 link 不算数：只有注释版时必须拒绝', () => {
    const html = `<!doctype html><html><head><title>t</title>
<!-- <link rel="stylesheet" href="${href}"> ${marker} -->
</head><body></body></html>`;
    const r = verifyStagedHtml(html, ADAPTER);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toContain('缺少');
  });

  it('注释里的伪 link 不影响真实注入的判定', () => {
    const html = `<!doctype html><html><head><title>t</title>
<link rel="stylesheet" href="${href}"> ${marker}
<!-- 说明：这里以前有过 <link rel="stylesheet" href="${href}"> -->
</head><body></body></html>`;
    const r = verifyStagedHtml(html, ADAPTER);
    expect(r.success, r.success ? '' : r.error.message).toBe(true);
  });

  it('属性写法容错：单引号、大小写、无引号、多余空白、去 ./ 都认', () => {
    const bare = href.replace('./', '');
    for (const tag of [
      `<link rel='stylesheet' href='${href}'>`,
      `<link REL="StyleSheet" HREF="${href}">`,
      `<link rel=stylesheet href=${href}>`,
      `<link   rel = "stylesheet"   href = "${href}"  >`,
      `<link rel="stylesheet" href="${bare}">`,
    ]) {
      const html = `<!doctype html><html><head>\n${tag} ${marker}\n</head><body></body></html>`;
      const r = verifyStagedHtml(html, ADAPTER);
      expect(r.success, `${tag} 应被接受：${r.success ? '' : r.error.message}`).toBe(true);
    }
  });

  it('链接在 head 之前 → 拒绝', () => {
    const html = `<!doctype html><link rel="stylesheet" href="${href}">${marker}<html><head></head><body></body></html>`;
    const r = verifyStagedHtml(html, ADAPTER);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toContain('不在 head 区间内');
  });

  it('链接在 body 里 → 拒绝', () => {
    const html = `<!doctype html><html><head></head><body><link rel="stylesheet" href="${href}">${marker}</body></html>`;
    const r = verifyStagedHtml(html, ADAPTER);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toContain('不在 head 区间内');
  });

  it('缺少闭合 head（连锚点都没有）→ 拒绝', () => {
    const html = `<!doctype html><html><head><link rel="stylesheet" href="${href}"> ${marker}`;
    const r = verifyStagedHtml(html, ADAPTER);
    expect(r.success).toBe(false);
    // 锚点就是 </head>，因此先被锚点检查拦下；同样是拒绝
    if (!r.success) expect(r.error.message).toMatch(/锚点|head 区间/);
  });

  it('有 </head> 但缺开头 <head> → 拒绝（head 区间分支）', () => {
    const html = `<!doctype html><html><body><link rel="stylesheet" href="${href}"> ${marker}</head></body></html>`;
    const r = verifyStagedHtml(html, ADAPTER);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toContain('head 区间');
  });

  it('单引号写法的重复链接 → 拒绝', () => {
    const html = `<!doctype html><html><head>
<link rel='stylesheet' href='${href}'> ${marker}
<link rel="stylesheet" href="${href}"> ${marker}
</head><body></body></html>`;
    const r = verifyStagedHtml(html, ADAPTER);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toContain('2 个');
  });

  it('标记冲突（出现两次）→ 拒绝', () => {
    const html = `<!doctype html><html><head>
<link rel="stylesheet" href="${href}"> ${marker}
<!-- 历史标记残留 ${marker} -->
</head><body></body></html>`;
    const r = verifyStagedHtml(html, ADAPTER);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toContain('工具标记出现 2 次');
  });

  // ---- A3：注入本身不能损坏文档（旧实现会删掉前缀） ----

  it.each([
    ['单行 HTML（注入行与前面内容同一行）', '<!doctype html><html><head><title>t</title></head><body>x</body></html>'],
    [
      '多行 HTML（</head> 自成一行，真实安装的形态）',
      '<!doctype html>\n<html>\n<head>\n  <title>t</title>\n</head>\n<body>x</body>\n</html>\n',
    ],
  ])('重复注入三次不丢内容：%s', (_name, source) => {
    let html = source;
    for (let i = 0; i < 3; i += 1) {
      const r = injectLink(html, href, ADAPTER.injection.anchor);
      expect(r.success).toBe(true);
      if (!r.success) return;
      html = r.data;
    }
    // 文档原有的开头与结尾必须还在（旧实现会把前缀整段删掉）
    expect(html).toContain('<head>');
    expect(html).toContain('</body>');
    expect(html).toContain('<title>t</title>');
    // 链接仍然只有一条，且结构门禁通过
    expect(html.match(/oc-theme-custom\.css/g) ?? []).toHaveLength(1);
    expect(verifyStagedHtml(html, ADAPTER).success, html).toBe(true);
  });

  it('官方自己的样式链接并存时不受影响（只数本工具那一条）', () => {
    const html = `<!doctype html><html><head><link rel="stylesheet" href="./assets/main-abc.css">\n<link rel="stylesheet" href="${href}"> ${marker}\n</head><body></body></html>`;
    const r = verifyStagedHtml(html, ADAPTER);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.linkCount).toBe(1);
  });
});
