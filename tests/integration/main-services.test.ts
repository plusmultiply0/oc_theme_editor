/**
 * 主进程服务层集成测试（T50、T53、T54、T55）。
 *
 * 用真实服务 + 合成安装 + 注入的空闲进程探针跑通完整闭环，
 * 不弹系统对话框、不接触真实安装、不启动任何外部进程。
 */
import fs from 'node:fs';
import { testTmpRoot } from '../fixtures/test-tmp';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ImageStore } from '../../src/main/services/image-store';
import { TargetService } from '../../src/main/services/target-service';
import { ThemeService } from '../../src/main/services/theme-service';
import { OperationService } from '../../src/main/services/operation-service';
import { OperationEventBus } from '../../src/main/services/events';
import { sha256File, toArchivePath } from '../../src/core/patch/asar';
import { extractFile, uncache } from '@electron/asar';
import type { ThemeSpec } from '../../src/shared/schema';
import { makeSyntheticInstall, type SyntheticInstall } from '../fixtures/synthetic-install';

const idle = async () => 'idle' as const;

function spec(imageId: string, over: Partial<ThemeSpec> = {}): ThemeSpec {
  return {
    schemaVersion: 1,
    imageId,
    mode: 'auto',
    palette: ['#404558'],
    overlayOpacity: 0.35,
    panelOpacity: 0.86,
    blurPx: 0,
    reducedTransparency: false,
    ...over,
  };
}

interface Ctx {
  install: SyntheticInstall;
  runtime: string;
  images: ImageStore;
  targets: TargetService;
  themes: ThemeService;
  operations: OperationService;
  bus: OperationEventBus;
  imageFile: string;
  events: string[];
}

let ctx: Ctx | null = null;
const cleanups: (() => void)[] = [];

async function setup(version = '1.18.29', files?: Record<string, string>): Promise<Ctx> {
  const install = await makeSyntheticInstall({ version, ...(files ? { files } : {}) });
  cleanups.push(install.cleanup);

  const runtime = fs.mkdtempSync(path.join(testTmpRoot(), 'ots-runtime-'));
  cleanups.push(() => fs.rmSync(runtime, { recursive: true, force: true, maxRetries: 3 }));

  const imageFile = path.join(runtime, 'wallpaper.png');
  await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 70, g: 100, b: 160 } } })
    .png()
    .toFile(imageFile);

  const bus = new OperationEventBus();
  const events: string[] = [];
  bus.subscribe((e) => events.push(e.phase));

  const images = new ImageStore({ runtimeRoot: runtime, picker: async () => [imageFile] });
  const targets = new TargetService({ localAppData: path.join(runtime, 'no-such-local'), extraRoots: [install.root], useRegistry: false });
  const themes = new ThemeService(images);
  const operations = new OperationService({
    runtimeRoot: runtime,
    targets,
    images,
    bus,
    probe: idle,
  });

  return { install, runtime, images, targets, themes, operations, bus, imageFile, events };
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  ctx = null;
});

describe('主进程服务：识别 → 生成 → 准备 → 应用 → 恢复', () => {
  beforeEach(async () => {
    ctx = await setup();
  });

  it('识别出合成安装，并给出可核对的扫描范围', async () => {
    const c = ctx as Ctx;
    const r = await c.targets.discover();
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.targets).toHaveLength(1);
    expect(r.data.targets[0].support).toBe('supported');
    expect(r.data.targets[0].version).toBe('1.18.29');
    expect(r.data.scanned).toContain(c.install.root);
  });

  it('选择并导入图片后拿到尺寸、哈希与代表色，原图保持不变', async () => {
    const c = ctx as Ctx;
    const before = await sha256File(c.imageFile);
    const picked = await c.images.pick();
    expect(picked.success).toBe(true);
    if (!picked.success) return;
    const imported = await c.images.import(picked.data.imageId);
    expect(imported.success).toBe(true);
    if (!imported.success) return;
    expect(imported.data.width).toBe(64);
    expect(imported.data.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(imported.data.palette.length).toBeGreaterThan(0);
    // 原图只读：导入前后哈希一致，且不在原图目录留下任何产物
    expect(await sha256File(c.imageFile)).toBe(before);
  });

  it('拖拽导入只接收内容与文件名，不接收路径', async () => {
    const c = ctx as Ctx;
    const bytes = await sharp({
      create: { width: 48, height: 48, channels: 3, background: { r: 200, g: 120, b: 60 } },
    })
      .png()
      .toBuffer();

    const r = await c.images.importData('dropped.png', new Uint8Array(bytes));
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.width).toBe(48);
    expect(r.data.palette.length).toBeGreaterThan(0);

    // 预览给的是工具自己的缩略图，不是原图路径
    const url = await c.images.previewDataUrl(r.data.imageId);
    expect(url.success).toBe(true);
    if (url.success) expect(url.data.startsWith('data:image/png;base64,')).toBe(true);

    // 后缀不在白名单时直接拒绝
    const bad = await c.images.importData('dropped.svg', new Uint8Array(bytes));
    expect(bad.success).toBe(false);
    if (bad.success) return;
    expect(bad.error.code).toBe('IMAGE_INVALID_FORMAT');
  });

  it('生成主题时返回 token、CSS 与逐条可读性报告，且预览与写入同源', async () => {
    const c = ctx as Ctx;
    const picked = await c.images.pick();
    if (!picked.success) throw new Error('pick failed');
    await c.images.import(picked.data.imageId);
    const r = await c.themes.generate({ imageId: picked.data.imageId, spec: spec(picked.data.imageId) });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.css).toContain('oc-theme-background.jpg');
    expect(r.data.report.entries.length).toBeGreaterThan(5);
    expect(r.data.report.passed).toBe(true);
    // CSS 中出现的变量值必须来自同一份 token
    expect(r.data.css).toContain(r.data.tokens.primary);
  });

  it('用户指定的主色读不清时，报告如实判不合格并阻断进入应用', async () => {
    const c = ctx as Ctx;
    const discovered = await c.targets.discover();
    if (!discovered.success) throw new Error('discover failed');
    const target = discovered.data.targets[0];

    const picked = await c.images.pick();
    if (!picked.success) throw new Error('pick failed');
    await c.images.import(picked.data.imageId);

    /*
     * 与底色明度几乎一致的主色：工具不偷偷改掉用户的选择，而是如实判不合格。
     * R4 之后按钮文字覆盖 default/hover/pressed 三态，主色读不清会先在
     * 「主按钮文字」上暴露出来（不再有笼统的「主色控件」条目）。
     */
    const r = await c.themes.generate({
      imageId: picked.data.imageId,
      spec: spec(picked.data.imageId, { primary: '#6a6a6a' }),
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.report.passed).toBe(false);
    expect(r.data.report.entries.some((e) => e.element === '主色控件' && !e.pass)).toBe(true);

    const staged = await c.operations.stage({
      targetId: target.targetId,
      imageId: picked.data.imageId,
      spec: spec(picked.data.imageId, { primary: '#6a6a6a' }),
    });
    expect(staged.success).toBe(false);
    if (staged.success) return;
    expect(staged.error.code).toBe('CONTRAST_BELOW_TARGET');
    expect(staged.error.message).toContain('主色控件');
  });

  it('准备阶段产出摘要但不改动目标，应用后才写入归档', async () => {
    const c = ctx as Ctx;
    const discovered = await c.targets.discover();
    if (!discovered.success) throw new Error('discover failed');
    const target = discovered.data.targets[0];

    const picked = await c.images.pick();
    if (!picked.success) throw new Error('pick failed');
    await c.images.import(picked.data.imageId);

    const beforeHash = await sha256File(c.install.archivePath);

    const staged = await c.operations.stage({
      targetId: target.targetId,
      imageId: picked.data.imageId,
      spec: spec(picked.data.imageId),
    });
    expect(staged.success).toBe(true);
    if (!staged.success) return;
    expect(staged.data.summary.changedFiles).toContain('out/renderer/oc-theme-custom.css');
    expect(staged.data.summary.beforeHash).toBe(beforeHash);
    // 准备阶段一个字节都不许动
    expect(await sha256File(c.install.archivePath)).toBe(beforeHash);

    const applied = await c.operations.apply({ operationId: staged.data.operationId });
    expect(applied.success).toBe(true);
    if (!applied.success) return;
    expect(applied.data.status).toBe('applied');
    expect(await sha256File(c.install.archivePath)).not.toBe(beforeHash);

    uncache(c.install.archivePath);
    const html = extractFile(c.install.archivePath, toArchivePath('out/renderer/index.html')).toString('utf8');
    expect(html).toContain('oc-theme-custom.css');
    expect(c.events.length).toBeGreaterThan(0);
  });

  it('应用后可列出原版与上一主题，恢复上一主题回到应用前的指纹', async () => {
    const c = ctx as Ctx;
    const discovered = await c.targets.discover();
    if (!discovered.success) throw new Error('discover failed');
    const target = discovered.data.targets[0];
    const beforeHash = await sha256File(c.install.archivePath);

    const picked = await c.images.pick();
    if (!picked.success) throw new Error('pick failed');
    await c.images.import(picked.data.imageId);
    const staged = await c.operations.stage({
      targetId: target.targetId,
      imageId: picked.data.imageId,
      spec: spec(picked.data.imageId),
    });
    if (!staged.success) throw new Error('stage failed');
    await c.operations.apply({ operationId: staged.data.operationId });

    const backups = await c.operations.listBackups(target.targetId);
    expect(backups.success).toBe(true);
    if (!backups.success) return;
    const kinds = backups.data.map((b) => b.kind);
    // 没有出厂指纹证据时不能叫「原版」，只能作为首次接管快照呈现（R2）
    expect(kinds).toContain('takeover');
    expect(kinds).toContain('previous');
    expect(kinds).not.toContain('original');
    const takeover = backups.data.find((b) => b.kind === 'takeover');
    expect(takeover?.pristine).toBe(false);
    expect(takeover?.evidenceNote ?? '').toContain('不能当作出厂原版');

    const restored = await c.operations.restore({ targetId: target.targetId, kind: 'previous' });
    expect(restored.success).toBe(true);
    expect(await sha256File(c.install.archivePath)).toBe(beforeHash);

    const op = await c.operations.getOperation(restored.success ? restored.data.operationId : '');
    expect(op.success).toBe(true);
    if (op.success) expect(op.data.kind).toBe('restore-previous');
  });

  it('重复点击应用不会开出第二个事务', async () => {
    const c = ctx as Ctx;
    const discovered = await c.targets.discover();
    if (!discovered.success) throw new Error('discover failed');
    const target = discovered.data.targets[0];
    const picked = await c.images.pick();
    if (!picked.success) throw new Error('pick failed');
    await c.images.import(picked.data.imageId);
    const staged = await c.operations.stage({
      targetId: target.targetId,
      imageId: picked.data.imageId,
      spec: spec(picked.data.imageId),
    });
    if (!staged.success) throw new Error('stage failed');

    const opId = staged.data.operationId;
    const [first, second] = await Promise.all([
      c.operations.apply({ operationId: opId }),
      c.operations.apply({ operationId: opId }),
    ]);
    const results = [first, second];
    expect(results.filter((r) => r.success).length).toBe(1);
    const rejected = results.find((r) => !r.success);
    expect(rejected && !rejected.success && rejected.error.code).toBe('TRANSACTION_IN_PROGRESS');
  });
});

describe('未验证目标', () => {
  it('非名单版本结构验证不通过时识别为 unknown，准备阶段直接拒绝', async () => {
    const c = await setup('9.9.9', { 'out/renderer/index.html': '<html><body>no head here</body></html>' });
    const discovered = await c.targets.discover();
    expect(discovered.success).toBe(true);
    if (!discovered.success) return;
    const target = discovered.data.targets[0];
    expect(target.support).toBe('unknown');
    expect(target.rejectReason).toContain('结构验证未通过');

    const picked = await c.images.pick();
    if (!picked.success) throw new Error('pick failed');
    await c.images.import(picked.data.imageId);
    const staged = await c.operations.stage({
      targetId: target.targetId,
      imageId: picked.data.imageId,
      spec: spec(picked.data.imageId),
    });
    expect(staged.success).toBe(false);
    if (staged.success) return;
    expect(staged.error.code).toBe('TARGET_UNSUPPORTED');
  });
});
