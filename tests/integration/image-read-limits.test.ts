/**
 * 读图/解码资源上限（R4）。
 *
 * 修复前的受控复现：4 KiB 限额下副本被换成 64 KiB，readBytes 先完整读入
 * 64 KiB 才以 IMAGE_CONTENT_MISMATCH 拒绝——资源上限承诺在拒绝前被打破。
 * readCapped 只调一次 handle.read，把「一次没读满」当成 EOF，可能截断大图。
 *
 * 要证的是：
 *  - 短读被循环处理：底层每次只给 1 字节时文件仍能完整读出（不误判 EOF）；
 *  - 副本被换大时实际读取字节数不超过「确认字节数 + 1」，且拒绝语义不变；
 *  - probeImageBytes 接受产品级限额，超限像素在 raw 分配前被拒绝；
 *  - 未固定记录的源文件预览与导入共用同一套限制（超限一致拒绝）；
 *  - 缩略图读取受自身体积上限约束、内容必须仍像 PNG，异常时回退重建。
 *
 * 全部使用临时目录与合成图片，不碰真实安装。
 */
import fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import { testTmpRoot } from '../fixtures/test-tmp';
import path from 'node:path';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ImageStore } from '../../src/main/services/image-store';
import { probeImageBytes } from '../../src/core/theme/image-probe';
import { sniffFormat } from '../../src/core/theme/validate';
import { pngBytes } from '../fixtures/image-samples';

const cleanups: (() => void)[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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

type ReadFn = typeof fsPromises.open;
type OpenSpy = MockInstance<ReadFn>;

/**
 * 包装 fs.promises.open：对目标文件返回 read 被改造过的 FileHandle。
 * mode 'short'：每次 read 最多返回 maxChunk 字节（模拟底层短读）；
 * mode 'observe'：累计该 handle 实际读取的字节数。
 */
function interceptFile(
  target: string,
  mode: 'short' | 'observe',
  opts: { maxChunk?: number; counter?: { bytes: number } },
): OpenSpy {
  // spyOn 之前取原始引用，避免 mockImplementation 内递归命中 mock 自身
  const realOpen = fsPromises.open;
  return vi.spyOn(fsPromises, 'open').mockImplementation(async (...args: Parameters<ReadFn>) => {
    const handle = await realOpen.apply(fsPromises, args as Parameters<ReadFn>);
    if (String(args[0]) !== target) return handle;
    const origRead = handle.read.bind(handle);
    handle.read = async (...readArgs: unknown[]) => {
      const [buf, off, len, pos] = readArgs as [Buffer, number, number, number | null];
      const capped = mode === 'short' ? Math.min(len, opts.maxChunk ?? 1) : len;
      const r = await origRead(buf, off, capped, pos);
      if (mode === 'observe' && opts.counter) opts.counter.bytes += r.bytesRead;
      return r;
    };
    return handle;
  });
}

describe('readCapped：短读与读取量（R4）', () => {
  it('底层每次只给 1 字节（极端短读）时，文件仍被完整读出，不误判 EOF', async () => {
    const runtime = tmpDir('ots-r4-');
    const srcDir = tmpDir('ots-r4-src-');
    const sourceFile = path.join(srcDir, 'photo.png');
    const bytes = await pngBytes({ accent: true });
    fs.writeFileSync(sourceFile, bytes);

    const store = new ImageStore({ runtimeRoot: runtime, picker: async () => [sourceFile] });
    interceptFile(sourceFile, 'short', { maxChunk: 1 });

    const imported = await store.importData('photo.png', bytes);
    // importData 本身不读源文件；触发真正的受限读取走 import()
    expect(imported.success).toBe(true);
    if (!imported.success) return;
    const described = await store.import(imported.data.imageId);
    expect(described.success).toBe(true);
    if (described.success) {
      expect(described.data.width).toBeGreaterThan(0);
    }
  });

  it('副本被换成 64 KiB 时，实际读取不超过确认字节数 + 1，且仍以 IMAGE_CONTENT_MISMATCH 拒绝', async () => {
    const runtime = tmpDir('ots-r4-');
    const store = new ImageStore({
      runtimeRoot: runtime,
      picker: async () => null,
      limits: { maxBytes: 4096, maxPixels: 40_000_000 },
    });
    const bytes = await pngBytes({ accent: true });
    const imported = await store.importData('small.png', bytes);
    expect(imported.success).toBe(true);
    if (!imported.success) return;
    const imageId = imported.data.imageId;
    const record = store.peek(imageId);
    if (!record?.copyPath) throw new Error('缺少副本');

    fs.writeFileSync(record.copyPath, Buffer.alloc(65536, 65));
    const counter = { bytes: 0 };
    interceptFile(record.copyPath, 'observe', { counter });

    const read = await store.readBytes(imageId);
    expect(read.success).toBe(false);
    if (!read.success) {
      expect(read.error.code).toBe('IMAGE_CONTENT_MISMATCH');
    }
    expect(counter.bytes).toBeGreaterThan(0);
    expect(counter.bytes).toBeLessThanOrEqual(record.byteSize + 1);
  });
});

describe('probeImageBytes：产品级限额（R4）', () => {
  it('超限像素在 raw 分配前被拒绝（IMAGE_TOO_LARGE）', async () => {
    const bytes = await pngBytes({ accent: true });
    const probe = await probeImageBytes(bytes, { maxBytes: 20 * 1024 * 1024, maxPixels: 100 });
    expect(probe.success).toBe(false);
    if (!probe.success) {
      expect(probe.error.code).toBe('IMAGE_TOO_LARGE');
    }
  });

  it('默认限额下正常小图解码成功', async () => {
    const bytes = await pngBytes({ accent: true });
    const probe = await probeImageBytes(bytes);
    expect(probe.success).toBe(true);
    if (probe.success) {
      expect(probe.data.decoded).toBe(true);
      expect(probe.data.width).toBeGreaterThan(0);
    }
  });
});

describe('previewDataUrl：回退源与缩略图限额（R4）', () => {
  it('未固定记录的源文件预览与导入共用限制：超限像素一致拒绝', async () => {
    const runtime = tmpDir('ots-r4-');
    const srcDir = tmpDir('ots-r4-src-');
    const sourceFile = path.join(srcDir, 'photo.png');
    fs.writeFileSync(sourceFile, await pngBytes({ accent: true }));

    const store = new ImageStore({
      runtimeRoot: runtime,
      picker: async () => [sourceFile],
      limits: { maxBytes: 20 * 1024 * 1024, maxPixels: 100 },
    });
    const picked = await store.pick();
    expect(picked.success).toBe(true);
    if (!picked.success) return;
    // 尚未 import（未固定内容）→ 走 sourcePath 回退 → 与导入同一套限额
    const preview = await store.previewDataUrl(picked.data.imageId);
    expect(preview.success).toBe(false);
    if (!preview.success) {
      expect(preview.error.code).toBe('IMAGE_TOO_LARGE');
    }
  });

  it('未固定记录的源文件预览：限额内正常成功', async () => {
    const runtime = tmpDir('ots-r4-');
    const srcDir = tmpDir('ots-r4-src-');
    const sourceFile = path.join(srcDir, 'photo.png');
    fs.writeFileSync(sourceFile, await pngBytes({ accent: true }));

    const store = new ImageStore({ runtimeRoot: runtime, picker: async () => [sourceFile] });
    const picked = await store.pick();
    expect(picked.success).toBe(true);
    if (!picked.success) return;
    const preview = await store.previewDataUrl(picked.data.imageId);
    expect(preview.success).toBe(true);
    if (preview.success) {
      expect(preview.data.startsWith('data:image/png;base64,')).toBe(true);
    }
  });

  it('缩略图被换成超大文件：按异常处理回退重建，预览仍成功且缩略图恢复', async () => {
    const runtime = tmpDir('ots-r4-');
    const store = new ImageStore({ runtimeRoot: runtime, picker: async () => null });
    const imported = await store.importData('photo.png', await pngBytes({ accent: true }));
    expect(imported.success).toBe(true);
    if (!imported.success) return;
    const record = store.peek(imported.data.imageId);
    if (!record?.thumbnailPath) throw new Error('缺少缩略图');

    fs.writeFileSync(record.thumbnailPath, Buffer.alloc(3 * 1024 * 1024, 1));
    const preview = await store.previewDataUrl(imported.data.imageId);
    expect(preview.success).toBe(true);
    const restored = fs.readFileSync(record.thumbnailPath);
    expect(restored.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(sniffFormat(restored)).toBe('png');
  });

  it('缩略图被换成非 PNG 内容：回退重建成功', async () => {
    const runtime = tmpDir('ots-r4-');
    const store = new ImageStore({ runtimeRoot: runtime, picker: async () => null });
    const imported = await store.importData('photo.png', await pngBytes({ accent: true }));
    expect(imported.success).toBe(true);
    if (!imported.success) return;
    const record = store.peek(imported.data.imageId);
    if (!record?.thumbnailPath) throw new Error('缺少缩略图');

    fs.writeFileSync(record.thumbnailPath, '<html>not a png</html>');
    const preview = await store.previewDataUrl(imported.data.imageId);
    expect(preview.success).toBe(true);
    expect(sniffFormat(fs.readFileSync(record.thumbnailPath))).toBe('png');
  });
});
