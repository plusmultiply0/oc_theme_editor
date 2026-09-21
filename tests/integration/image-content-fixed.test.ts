/**
 * 图片内容固定（Alpha A2）。
 *
 * 要证的不是「函数返回 success」，而是**预览过的字节就是写进安装的字节**：
 * 源图在导入后被替换/删除都不影响结果；私有副本一旦变化或丢失就拒绝应用；
 * 旧准备记录（没有内容指纹）失效；应用失败时安装 hash 不变。
 *
 * 全部使用临时目录与合成安装，不碰真实安装。
 */
import fs from 'node:fs';
import { testTmpRoot } from '../fixtures/test-tmp';
import path from 'node:path';
import crypto from 'node:crypto';
import { extractFile, uncache } from '@electron/asar';
import { afterEach, describe, expect, it } from 'vitest';
import { ImageStore } from '../../src/main/services/image-store';
import { TargetService } from '../../src/main/services/target-service';
import { OperationService } from '../../src/main/services/operation-service';
import { OperationEventBus } from '../../src/main/services/events';
import { sha256File, toArchivePath } from '../../src/core/patch/asar';
import { runtimeDirs } from '../../src/core/patch/layout';
import { instanceIdFromPath } from '../../src/core/patch/paths';
import { ADAPTER } from './helpers/adapter';
import { makeSyntheticInstall, type SyntheticInstall } from '../fixtures/synthetic-install';
import { jpegBytes, pngBytes } from '../fixtures/image-samples';
import type { ThemeSpec } from '../../src/shared/schema';

const idle = async () => 'idle' as const;
const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()?.();
    } catch {
      // 清理失败不影响判定
    }
  }
});

function tmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(testTmpRoot(), prefix));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }));
  return d;
}

function specOf(imageId: string, palette: string[]): ThemeSpec {
  return {
    schemaVersion: 1,
    imageId,
    mode: 'light',
    palette,
    overlayOpacity: 0.5,
    panelOpacity: 0.45,
    blurPx: 0,
    reducedTransparency: false,
  };
}

const sha = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');

interface Ctx {
  install: SyntheticInstall;
  runtime: string;
  images: ImageStore;
  operations: OperationService;
  sourceFile: string;
  originalBytes: Buffer;
  /** 由 operations 使用的同一个 TargetService 发现，避免跨实例导致「记录已失效」 */
  targetId: string;
  installPath: string;
}

async function setup(): Promise<Ctx> {
  const install = await makeSyntheticInstall();
  cleanups.push(install.cleanup);
  const runtime = tmpDir('ots-a2-');
  const srcDir = tmpDir('ots-a2-src-');

  const originalBytes = await jpegBytes({ jfif: true, accent: true });
  const sourceFile = path.join(srcDir, 'wallpaper.jfif');
  fs.writeFileSync(sourceFile, originalBytes);

  const images = new ImageStore({ runtimeRoot: runtime, picker: async () => [sourceFile] });
  const targets = new TargetService({
    localAppData: path.join(runtime, 'no-such-local'),
    extraRoots: [install.root],
    useRegistry: false, processProbe: async () => 'idle' as const,
  });
  const operations = new OperationService({
    runtimeRoot: runtime,
    targets,
    images,
    bus: new OperationEventBus(),
    probe: idle,
  });

  const discovered = await targets.discover();
  if (!discovered.success || discovered.data.targets.length === 0) throw new Error('识别失败');

  const c: Ctx = {
    install,
    runtime,
    images,
    operations,
    sourceFile,
    originalBytes,
    targetId: discovered.data.targets[0].targetId,
    installPath: discovered.data.targets[0].installPath,
  };
  return c;
}

/** 选图 → 导入，返回 imageId 与导入结果 */
async function importOnce(c: Ctx) {
  const picked = await c.images.pick();
  if (!picked.success) throw new Error(`pick 失败：${picked.error.message}`);
  const imported = await c.images.import(picked.data.imageId);
  return { imageId: picked.data.imageId, imported };
}

describe('源图与已确认内容解绑', () => {
  it('导入后替换源图：内容仍是导入时那份，应用写进安装的也是它', async () => {
    const c = await setup();
    const { imageId, imported } = await importOnce(c);
    expect(imported.success).toBe(true);
    if (!imported.success) return;
    const pinnedHash = imported.data.hash;

    // 用户换了源文件（内容完全不同）
    fs.writeFileSync(c.sourceFile, await pngBytes({ color: { r: 250, g: 10, b: 10 } }));

    const bytes = await c.images.readBytes(imageId);
    expect(bytes.success).toBe(true);
    if (!bytes.success) return;
    expect(sha(bytes.data)).toBe(pinnedHash);
    expect(bytes.data.equals(c.originalBytes)).toBe(true);

    // 走完整应用：归档里的背景条目必须等于导入时那份字节
    const staged = await c.operations.stage({
      targetId: c.targetId,
      imageId,
      spec: specOf(imageId, imported.data.palette),
    });
    expect(staged.success, staged.success ? '' : staged.error.message).toBe(true);
    if (!staged.success) return;
    const applied = await c.operations.apply({ operationId: staged.data.operationId });
    expect(applied.success).toBe(true);
    uncache(c.install.archivePath);
    const written = extractFile(c.install.archivePath, toArchivePath(ADAPTER.injection.imageFile));
    expect(written.equals(c.originalBytes)).toBe(true);
  });

  it('导入后删除源图：照样能准备与应用', async () => {
    const c = await setup();
    const { imageId, imported } = await importOnce(c);
    if (!imported.success) return;
    fs.rmSync(c.sourceFile);

    const staged = await c.operations.stage({
      targetId: c.targetId,
      imageId,
      spec: specOf(imageId, imported.data.palette),
    });
    expect(staged.success, staged.success ? '' : staged.error.message).toBe(true);
    if (!staged.success) return;
    const applied = await c.operations.apply({ operationId: staged.data.operationId });
    expect(applied.success).toBe(true);
  });

  it('私有副本被改一个字节：拒绝使用，安装 hash 不变', async () => {
    const c = await setup();
    const { imageId, imported } = await importOnce(c);
    if (!imported.success) return;

    const copy = c.images.peek(imageId)?.copyPath;
    expect(copy).toBeTruthy();
    const buf = fs.readFileSync(copy as string);
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    fs.writeFileSync(copy as string, buf);

    const bytes = await c.images.readBytes(imageId);
    expect(bytes.success).toBe(false);
    if (!bytes.success) expect(bytes.error.code).toBe('IMAGE_CONTENT_MISMATCH');

    const before = await sha256File(c.install.archivePath);
    const staged = await c.operations.stage({
      targetId: c.targetId,
      imageId,
      spec: specOf(imageId, imported.data.palette),
    });
    // 准备阶段就会失败（读的是同一份副本）
    expect(staged.success).toBe(false);
    expect(await sha256File(c.install.archivePath)).toBe(before);
  });

  it('私有副本被删除：拒绝应用，安装 hash 不变', async () => {
    const c = await setup();
    const { imageId, imported } = await importOnce(c);
    if (!imported.success) return;

    const copy = c.images.peek(imageId)?.copyPath as string;
    fs.rmSync(copy);

    const before = await sha256File(c.install.archivePath);
    const staged = await c.operations.stage({
      targetId: c.targetId,
      imageId,
      spec: specOf(imageId, imported.data.palette),
    });
    expect(staged.success).toBe(false);
    if (!staged.success) expect(staged.error.code).toBe('IMAGE_CONTENT_MISMATCH');
    expect(await sha256File(c.install.archivePath)).toBe(before);
  });
});

describe('准备记录与内容绑定', () => {
  it('准备记录带上内容指纹，且与导入返回的 hash 一致', async () => {
    const c = await setup();
    const { imageId, imported } = await importOnce(c);
    if (!imported.success) return;
    const staged = await c.operations.stage({
      targetId: c.targetId,
      imageId,
      spec: specOf(imageId, imported.data.palette),
    });
    expect(staged.success).toBe(true);
    if (!staged.success) return;

    const layout = runtimeDirs(c.runtime, instanceIdFromPath(c.installPath));
    const file = path.join(layout.instance, 'staged', `${staged.data.operationId}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { contentHash?: string; imagePath?: string };
    expect(raw.contentHash).toBe(imported.data.hash);
    // 不再把用户源路径写进准备记录
    expect(raw.imagePath).toBeUndefined();
  });

  it('旧准备记录（无 contentHash）失效：拒绝应用且安装不变', async () => {
    const c = await setup();
    const { imageId, imported } = await importOnce(c);
    if (!imported.success) return;
    const staged = await c.operations.stage({
      targetId: c.targetId,
      imageId,
      spec: specOf(imageId, imported.data.palette),
    });
    if (!staged.success) throw new Error('准备失败');

    // 模拟旧版本留下的记录：删掉内容指纹
    const layout = runtimeDirs(c.runtime, instanceIdFromPath(c.installPath));
    const file = path.join(layout.instance, 'staged', `${staged.data.operationId}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    delete raw.contentHash;
    fs.writeFileSync(file, JSON.stringify(raw), 'utf8');

    const before = await sha256File(c.install.archivePath);
    const applied = await c.operations.apply({ operationId: staged.data.operationId });
    expect(applied.success).toBe(false);
    if (!applied.success) {
      expect(applied.error.code).toBe('IMAGE_CONTENT_MISMATCH');
      expect(applied.error.message).toContain('旧版本');
    }
    expect(await sha256File(c.install.archivePath)).toBe(before);
  });
});

describe('读取上限与失败清理', () => {
  it('选图之后源文件变大：按上限读取，导入直接拒绝', async () => {
    const c = await setup();
    const picked = await c.images.pick();
    expect(picked.success).toBe(true);
    if (!picked.success) return;

    // pick 之后把源文件撑到超过上限（21 MiB）
    const big = Buffer.concat([c.originalBytes, Buffer.alloc(21 * 1024 * 1024)]);
    fs.writeFileSync(c.sourceFile, big);

    const imported = await c.images.import(picked.data.imageId);
    expect(imported.success).toBe(false);
    if (!imported.success) expect(imported.error.code).toBe('IMAGE_TOO_LARGE');
  });

  it('导入失败时清掉自己产生的副本与缩略图，不留半个文件', async () => {
    const c = await setup();
    // 用损坏内容替换源图，导入必然失败
    fs.writeFileSync(c.sourceFile, Buffer.from('not an image at all', 'utf8'));

    const picked = await c.images.pick();
    if (!picked.success) throw new Error('pick 失败');
    const imported = await c.images.import(picked.data.imageId);
    expect(imported.success).toBe(false);

    const contentDir = path.join(c.runtime, 'content');
    const leftovers = fs.existsSync(contentDir)
      ? fs.readdirSync(contentDir).filter((n) => n.startsWith(picked.data.imageId))
      : [];
    expect(leftovers).toEqual([]);
  });
});

describe('缓存清理只动本工具自己的目录', () => {
  it('保留被引用的副本，删掉没人引用的；不递归进用户目录', async () => {
    const c = await setup();
    const a = await importOnce(c);
    if (!a.imported.success) return;

    // 再造一个「上次运行遗留」的孤儿副本
    const contentDir = path.join(c.runtime, 'content');
    fs.mkdirSync(contentDir, { recursive: true });
    const orphan = path.join(contentDir, 'img-orphan-0000.png');
    fs.writeFileSync(orphan, await pngBytes());

    const removed = await c.images.cleanOrphanCaches([a.imageId]);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(orphan)).toBe(false);
    // 被引用的那份还在
    const kept = c.images.peek(a.imageId)?.copyPath as string;
    expect(fs.existsSync(kept)).toBe(true);
    expect((await c.images.readBytes(a.imageId)).success).toBe(true);
  });
});
