/**
 * 在用缩略图保留与预览回退（R3）。
 *
 * 旧缺陷：cleanOrphanCaches 用 imageId 前缀猜文件归属，而缩略图文件名是
 * 独立的 thumb-… 命名，永远匹配不上 → 在用缩略图被当孤儿删除，随后预览
 * 既不从健康私有副本回退、又误报「图片可能已损坏」。
 *
 * 要证的是：
 *  - 清理后活跃 content 与 thumbnail 都在，孤儿被删（且前缀近似名不再被误保留）；
 *  - 缩略图被删后预览能从已校验私有副本回退重建（并恢复缩略图文件）；
 *  - 副本丢失/被改动返回 IMAGE_CONTENT_MISMATCH（缓存与副本语义），
 *    不再伪装成 IMAGE_DECODE_FAILED「图片已损坏」；
 *  - 清理与导入交错：已登记记录（导入进行中）不会被清理误删；
 *  - 跨重启语义：keep 引用的 imageId 其 content 保留；缩略图无持久化关联、
 *    允许被清（派生数据，预览可回退重建）。
 *
 * 全部使用临时目录与合成图片，不碰真实安装，不经过 apply 闭环。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ImageStore } from '../../src/main/services/image-store';
import { pngBytes } from '../fixtures/image-samples';

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }));
  return d;
}

function newStore(): { store: ImageStore; runtime: string } {
  const runtime = tmpDir('ots-r3-');
  return { store: new ImageStore({ runtimeRoot: runtime, picker: async () => null }), runtime };
}

async function importPng(store: ImageStore, name = 'photo.png'): Promise<string> {
  const bytes = await pngBytes({ accent: true });
  const imported = await store.importData(name, bytes);
  if (!imported.success) throw new Error(`导入失败：${imported.error.code}`);
  return imported.data.imageId;
}

describe('cleanOrphanCaches：在用文件保留（R3）', () => {
  it('清理后活跃 content 与 thumbnail 都保留，孤儿被删，预览仍成功', async () => {
    const { store, runtime } = newStore();
    const imageId = await importPng(store);
    const record = store.peek(imageId);
    if (!record?.copyPath || !record.thumbnailPath) throw new Error('导入后缺少副本/缩略图');

    // 放两个孤儿：一个在 content，一个在 thumbs；再加一个与 imageId 前缀相近的名字
    const orphanContent = path.join(runtime, 'content', 'orphan-content.png');
    const orphanThumb = path.join(runtime, 'thumbnails', 'orphan-thumb.png');
    const nearPrefix = path.join(runtime, 'content', `${imageId}ZZ.png`);
    fs.writeFileSync(orphanContent, 'x');
    fs.writeFileSync(orphanThumb, 'x');
    fs.writeFileSync(nearPrefix, 'x');

    // keep 传空数组：保留判定必须完全来自内存 records（旧实现靠 imageId 前缀也能保住
    // content，但保不住 thumbnail —— 这里两条都必须保住）
    const removed = await store.cleanOrphanCaches([]);

    expect(removed).toBe(3);
    expect(fs.existsSync(record.copyPath)).toBe(true);
    expect(fs.existsSync(record.thumbnailPath)).toBe(true);
    expect(fs.existsSync(orphanContent)).toBe(false);
    expect(fs.existsSync(orphanThumb)).toBe(false);
    expect(fs.existsSync(nearPrefix)).toBe(false);

    const preview = await store.previewDataUrl(imageId);
    expect(preview.success).toBe(true);
  });

  it('keep 引用的 imageId（跨重启、内存无 record）：content 保留，thumb 允许清理', async () => {
    const { store, runtime } = newStore();
    const imageId = await importPng(store);
    const record = store.peek(imageId);
    if (!record?.copyPath || !record.thumbnailPath) throw new Error('缺少副本/缩略图');

    // 模拟重启后：新 store 实例内存为空，keep 来自持久准备记录
    const fresh = new ImageStore({ runtimeRoot: runtime, picker: async () => null });
    const removed = await fresh.cleanOrphanCaches([imageId]);

    expect(removed).toBe(1);
    expect(fs.existsSync(record.copyPath)).toBe(true);
    // 缩略图无持久化关联，允许被清 —— 派生数据，预览可从副本回退重建
    expect(fs.existsSync(record.thumbnailPath)).toBe(false);
  });

  it('清理与导入交错：已登记记录（导入进行中）的文件不被清理', async () => {
    const { store, runtime } = newStore();
    const a = await importPng(store, 'a.png');

    // 并发：一边清理（A 的引用靠内存 records），一边导入 B
    const [, importedB] = await Promise.all([
      store.cleanOrphanCaches([]),
      importPng(store, 'b.png'),
    ]);

    const ra = store.peek(a);
    const rb = store.peek(importedB);
    if (!ra?.copyPath || !rb?.copyPath) throw new Error('缺少副本');
    expect(fs.existsSync(ra.copyPath)).toBe(true);
    expect(fs.existsSync(rb.copyPath)).toBe(true);
    if (ra.thumbnailPath) expect(fs.existsSync(ra.thumbnailPath)).toBe(true);
    if (rb.thumbnailPath) expect(fs.existsSync(rb.thumbnailPath)).toBe(true);

    for (const id of [a, importedB]) {
      const preview = await store.previewDataUrl(id);
      expect(preview.success).toBe(true);
    }
  });
});

describe('previewDataUrl：回退与错误语义（R3）', () => {
  it('缩略图文件被删后，预览从已校验私有副本回退重建，并恢复缩略图', async () => {
    const { store } = newStore();
    const imageId = await importPng(store);
    const record = store.peek(imageId);
    if (!record?.thumbnailPath || !record.copyPath) throw new Error('缺少副本/缩略图');
    const before = await store.previewDataUrl(imageId);
    expect(before.success).toBe(true);

    fs.rmSync(record.thumbnailPath);
    const after = await store.previewDataUrl(imageId);
    expect(after.success).toBe(true);
    // 回退重建后缩略图文件应恢复在盘上
    expect(fs.existsSync(record.thumbnailPath)).toBe(true);
    expect(store.peek(imageId)?.thumbnailPath).toBe(record.thumbnailPath);
  });

  it('缩略图被换坏文件后，预览回退成功且不返回坏内容', async () => {
    const { store } = newStore();
    const imageId = await importPng(store);
    const record = store.peek(imageId);
    if (!record?.thumbnailPath) throw new Error('缺少缩略图');

    fs.writeFileSync(record.thumbnailPath, 'not a png');
    const after = await store.previewDataUrl(imageId);
    expect(after.success).toBe(true);
  });

  it('私有副本丢失：报 IMAGE_CONTENT_MISMATCH（缓存/副本语义），不是「图片已损坏」', async () => {
    const { store } = newStore();
    const imageId = await importPng(store);
    const record = store.peek(imageId);
    if (!record?.copyPath || !record.thumbnailPath) throw new Error('缺少副本');

    // 缩略图仍在时预览命中缓存成功（合理：派生缓存可用，内容校验留给使用方）
    const cached = await store.previewDataUrl(imageId);
    expect(cached.success).toBe(true);

    // 缩略图也没了 → 强制走副本回退 → 副本丢失应报缓存/副本语义
    fs.rmSync(record.thumbnailPath);
    fs.rmSync(record.copyPath);
    const preview = await store.previewDataUrl(imageId);
    expect(preview.success).toBe(false);
    if (!preview.success) {
      expect(preview.error.code).toBe('IMAGE_CONTENT_MISMATCH');
      expect(preview.error.message).not.toContain('损坏');
    }
    const read = await store.readBytes(imageId);
    expect(read.success).toBe(false);
    if (!read.success) expect(read.error.code).toBe('IMAGE_CONTENT_MISMATCH');
  });

  it('私有副本被改动：拒绝使用（IMAGE_CONTENT_MISMATCH），回显不复读旧缓存', async () => {
    const { store } = newStore();
    const imageId = await importPng(store);
    const record = store.peek(imageId);
    if (!record?.copyPath || !record.thumbnailPath) throw new Error('缺少副本/缩略图');

    fs.rmSync(record.thumbnailPath); // 强制走回退，触及副本校验
    fs.writeFileSync(record.copyPath, Buffer.alloc(2048, 7));
    const preview = await store.previewDataUrl(imageId);
    expect(preview.success).toBe(false);
    if (!preview.success) {
      expect(preview.error.code).toBe('IMAGE_CONTENT_MISMATCH');
    }
  });
});
