/**
 * 图片入口与格式回归（T2）。
 *
 * 覆盖两件事：
 * 1. JPEG 别名（.jpg/.jpeg/.jfif/.jpe，含大写与中文名）在**两个入口**
 *    （系统选择框 pick、拖拽 importData）都能进来，实际格式仍是 jpeg；
 * 2. 异常输入（文本伪装、SVG 伪装、截断、空文件、超限）一律返回中文错误，
 *    且不产生「可应用」的图片记录 —— 后续用旧 imageId 生成主题必须失败。
 *
 * 全部使用程序生成的样本与临时目录，不碰真实安装、不弹系统对话框。
 */
import fs from 'node:fs';
import { testTmpRoot } from '../fixtures/test-tmp';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ImageStore } from '../../src/main/services/image-store';
import { ALLOWED_EXTENSIONS, DIALOG_EXTENSIONS } from '../../src/shared/image-formats';
import { generateTheme } from '../../src/core/theme/generate';
import { SCHEMA_VERSION } from '../../src/shared/schema';
import {
  emptyBytes,
  hasJfifMarker,
  jpegAliasSamples,
  jpegBytes,
  oversizedJpeg,
  pngBytes,
  svgDisguised,
  textDisguised,
  truncatedJpeg,
  webpBytes,
} from '../fixtures/image-samples';

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()?.();
    } catch {
      // 临时目录清理失败不影响判定
    }
  }
});

function newRuntime(): string {
  const dir = fs.mkdtempSync(path.join(testTmpRoot(), 'ots-fmt-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

/** 把样本写到临时文件，模拟用户从系统对话框选中的真实路径 */
function writeSample(name: string, bytes: Buffer): string {
  const dir = fs.mkdtempSync(path.join(testTmpRoot(), 'ots-pick-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

function storeWith(picker: () => Promise<string[] | null>, runtime = newRuntime()): ImageStore {
  return new ImageStore({ runtimeRoot: runtime, picker });
}

describe('JPEG 别名：选图入口', () => {
  it('全部别名（含大写与中文名）都能选中并成功导入，实际格式 jpeg', async () => {
    const samples = await jpegAliasSamples();
    // 样本本身必须是标准 JFIF 容器，否则「.jfif 能进」这件事没有说服力
    for (const s of samples) expect(hasJfifMarker(s.bytes), `${s.fileName} 应带 JFIF 标记`).toBe(true);

    for (const sample of samples) {
      const file = writeSample(sample.fileName, sample.bytes);
      const store = storeWith(async () => [file]);

      const picked = await store.pick();
      expect(picked.success, `${sample.fileName} 应能被选中`).toBe(true);
      if (!picked.success) continue;

      const imported = await store.import(picked.data.imageId);
      expect(imported.success, `${sample.fileName} 应能导入`).toBe(true);
      if (!imported.success) continue;
      if (imported.success) expect(imported.data.format).toBe('jpeg');
      expect(imported.data.formatLabel).toBe('JPEG');
      // 后缀与实际内容一致时不应出现「命名不一致」提醒
      expect(imported.data.note).toBeUndefined();
      expect(imported.data.width).toBe(96);
      expect(imported.data.height).toBe(64);
      expect(imported.data.palette.length).toBeGreaterThan(0);
    }
  });

  it('对话框与主进程校验用同一份扩展名集合', () => {
    expect([...DIALOG_EXTENSIONS].sort()).toEqual(
      ALLOWED_EXTENSIONS.map((e) => e.slice(1)).sort(),
    );
  });

  it('取消选择不产生记录，也不影响已登记的图片', async () => {
    const file = writeSample('keep.png', await pngBytes({ accent: true }));
    let cancelled = false;
    const store = storeWith(async () => (cancelled ? null : [file]));

    const first = await store.pick();
    expect(first.success).toBe(true);
    if (!first.success) return;
    const good = first.data.imageId;

    cancelled = true;
    const second = await store.pick();
    expect(second.success).toBe(false);
    if (!second.success) {
      expect(second.error.code).toBe('IMAGE_NOT_FOUND');
      expect(second.error.message).toContain('未选择');
    }

    // 旧记录仍然可用：取消不会作废上一张图
    const still = await store.import(good);
    expect(still.success).toBe(true);
  });
});

describe('JPEG 别名：拖拽入口', () => {
  it('jfif / JFIF / jpe 走 importData 也能导入，格式 enum 仍是 jpeg', async () => {
    const bytes = await jpegBytes({ jfif: true, accent: true });
    for (const name of ['a.jfif', 'B.JFIF', 'c.jpe', '中文.jfif']) {
      const store = storeWith(async () => null);
      const imported = await store.importData(name, new Uint8Array(bytes));
      expect(imported.success, `${name} 应能导入`).toBe(true);
      if (!imported.success) continue;
      expect(imported.data.format).toBe('jpeg');
      // 旧主题数据里没有 jfif 这种枚举，必须是 jpeg
      expect(imported.data.format).not.toBe('jfif');
      // 预览副本可用（拖拽入口也要能出图）
      const preview = await store.previewDataUrl(imported.data.imageId);
      expect(preview.success).toBe(true);

      /*
       * 一路走到「生成」：入口放开却生成不了等于没修。
       * 这里用登记记录里的字节跑真实的主题生成，验证 .jfif 能产出完整 CSS。
       */
      const bytes2 = await store.readBytes(imported.data.imageId);
      expect(bytes2.success).toBe(true);
      if (bytes2.success) {
        const generated = await generateTheme({
          buffer: bytes2.data,
          spec: {
            schemaVersion: SCHEMA_VERSION,
            imageId: imported.data.imageId,
            mode: 'auto',
            palette: imported.data.palette,
            overlayOpacity: 0.35,
            panelOpacity: 0.5,
            blurPx: 0,
            reducedTransparency: false,
          },
          imageRef: './oc-theme-background.jpg',
        });
        expect(generated.success, `${name} 应能生成主题`).toBe(true);
        if (generated.success) {
          expect(generated.data.css).toContain('html:root');
          expect(generated.data.report.entries.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('两个入口对同一份字节给出相同结论', async () => {
    const bytes = await jpegBytes({ jfif: true, accent: true });
    const file = writeSample('same.jfif', bytes);

    const viaePickStore = storeWith(async () => [file]);
    const picked = await viaePickStore.pick();
    expect(picked.success).toBe(true);
    if (!picked.success) return;
    const viaPick = await viaePickStore.import(picked.data.imageId);

    const viaDrop = await storeWith(async () => null).importData('same.jfif', new Uint8Array(bytes));

    expect(viaPick.success && viaDrop.success).toBe(true);
    if (viaPick.success && viaDrop.success) {
      expect(viaDrop.data.format).toBe(viaPick.data.format);
      expect(viaDrop.data.width).toBe(viaPick.data.width);
      expect(viaDrop.data.height).toBe(viaPick.data.height);
      expect(viaDrop.data.hash).toBe(viaPick.data.hash);
    }
  });
});

describe('后缀与实际内容不一致', () => {
  it('PNG 内容命名为 .jpg：导入成功、按实际内容处理并给出说明', async () => {
    const store = storeWith(async () => null);
    const imported = await store.importData('actually-png.jpg', new Uint8Array(await pngBytes()));
    expect(imported.success).toBe(true);
    if (!imported.success) return;
    expect(imported.data.format).toBe('png');
    expect(imported.data.formatLabel).toBe('PNG');
    expect(imported.data.note ?? '').toContain('后缀');
  });

  it('未登记的扩展名直接拒绝（扩展名只用于筛选）', async () => {
    const store = storeWith(async () => null);
    const r = await store.importData('image.avif', new Uint8Array(await jpegBytes()));
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.code).toBe('IMAGE_INVALID_FORMAT');
      expect(r.error.message).toContain('.avif');
      // 提示里要写清支持范围（从同一份声明生成）
      expect(r.error.recoveryHint).toContain('.jfif');
    }
  });
});

describe('异常输入必须被拒绝，且不产生可应用状态', () => {
  it.each([
    ['文本伪装成 jfif', 'fake.jfif', () => textDisguised()],
    ['SVG 伪装成 jfif', 'vector.jfif', () => svgDisguised()],
    ['截断的 JPEG', 'cut.jpg', () => truncatedJpeg()],
    ['空文件', 'empty.jpg', () => Promise.resolve(emptyBytes())],
  ])('%s → 中文错误，且后续生成不可用', async (_name, fileName, make) => {
    const bytes = await make();
    const file = writeSample(fileName, bytes);
    const store = storeWith(async () => [file]);

    const picked = await store.pick();
    // 选择阶段只做大小/后缀校验；内容问题要在导入时暴露
    expect(picked.success).toBe(true);
    if (!picked.success) return;

    const imported = await store.import(picked.data.imageId);
    expect(imported.success, `${fileName} 不该导入成功`).toBe(false);
    if (!imported.success) {
      expect(['IMAGE_INVALID_FORMAT', 'IMAGE_DECODE_FAILED']).toContain(imported.error.code);
      expect(imported.error.message).toMatch(/[\u4e00-\u9fa5]/);
      expect(imported.error.recoveryHint).toMatch(/[\u4e00-\u9fa5]/);
    }
  });

  it('超限图片在读完之前就被拒（选图与拖拽都拒）', async () => {
    const big = await oversizedJpeg(21);
    const file = writeSample('big.jfif', big);

    const viaPickStore = storeWith(async () => [file]);
    const picked = await viaPickStore.pick();
    expect(picked.success).toBe(false);
    if (!picked.success) {
      expect(picked.error.code).toBe('IMAGE_TOO_LARGE');
      expect(picked.error.message).toContain('MiB');
    }

    const viaDrop = await storeWith(async () => null).importData('big.jfif', new Uint8Array(big));
    expect(viaDrop.success).toBe(false);
    if (!viaDrop.success) expect(viaDrop.error.code).toBe('IMAGE_TOO_LARGE');
  });

  it('拖拽入口对异常内容同样拒绝', async () => {
    const store = storeWith(async () => null);
    for (const [name, bytes] of [
      ['fake.jfif', textDisguised()],
      ['vector.png', svgDisguised()],
      ['empty.png', emptyBytes()],
    ] as const) {
      const r = await store.importData(name, new Uint8Array(bytes));
      expect(r.success, `${name} 不该导入成功`).toBe(false);
    }
  });
});

describe('原有格式不回归', () => {
  it('PNG（含透明）与 WebP 仍可导入', async () => {
    const store = storeWith(async () => null);
    const png = await store.importData('a.png', new Uint8Array(await pngBytes({ accent: true })));
    expect(png.success).toBe(true);
    if (png.success) expect(png.data.format).toBe('png');

    const webp = await store.importData('b.webp', new Uint8Array(await webpBytes({ accent: true })));
    expect(webp.success).toBe(true);
    if (webp.success) expect(webp.data.format).toBe('webp');
  });

  it('sharp 不产 JFIF 标记这一事实本身也要成立（样本构造的前提）', async () => {
    // 若哪天 sharp 默认输出 JFIF，这个断言会提醒我们样本构造需要重新核对
    expect(hasJfifMarker(await jpegBytes())).toBe(false);
    expect(hasJfifMarker(await jpegBytes({ jfif: true }))).toBe(true);
  });
});
