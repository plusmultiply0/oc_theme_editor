/**
 * 图片核验探测（Alpha A3）。
 *
 * 核心要求：**识别**与**解码**必须是两件独立的事。
 * 旧核验脚本把「首字节 0xff / 出现 PNG 字符」当成「可解码」，
 * 于是只剩头部的残图也能拿到一个 OK —— 那是名不副实的检查。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { isMultiFrame, probeImageBytes } from '../../src/core/theme/image-probe';
import {
  emptyBytes,
  jpegBytes,
  pngBytes,
  svgDisguised,
  textDisguised,
  truncatedJpeg,
  webpBytes,
} from '../fixtures/image-samples';

describe('正常图片：识别与解码都通过', () => {
  it.each([
    ['PNG', pngBytes, 'png'],
    ['JPEG', jpegBytes, 'jpeg'],
    ['WebP', webpBytes, 'webp'],
  ] as const)('%s', async (_name, make, want) => {
    const bytes = await make({ accent: true });
    const r = await probeImageBytes(bytes);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.headerFormat).toBe(want);
    expect(r.data.decoded).toBe(true);
    expect(r.data.format).toBe(want);
    expect(r.data.width).toBe(96);
    expect(r.data.height).toBe(64);
    expect(isMultiFrame(r.data)).toBe(false);
    // 内容是完整的一份，字节数与哈希可核对
    expect(r.data.bytes).toBe(bytes.byteLength);
    expect(r.data.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('损坏样本必须失败（不能再靠文件头蒙过）', () => {
  it('截断的 JPEG：文件头仍能识别，但解码失败', async () => {
    const cut = await truncatedJpeg();
    const r = await probeImageBytes(cut);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe('IMAGE_DECODE_FAILED');
  });

  it('只剩 JPEG 文件头的字节：识别为 jpeg，解码必须失败', async () => {
    // 这正是旧检查会误判的形状：前三字节就是 JPEG 魔数
    const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
    const r = await probeImageBytes(head);
    expect(r.success).toBe(false);
  });

  it('PNG 文件头 + 垃圾数据：解码必须失败', async () => {
    const png = await pngBytes();
    const brokeHeader = Buffer.concat([png.subarray(0, 8), Buffer.alloc(2048, 0x41)]);
    const r = await probeImageBytes(brokeHeader);
    expect(r.success).toBe(false);
  });

  it('空文件与文本：解码失败', async () => {
    for (const buf of [emptyBytes(), textDisguised(), svgDisguised()]) {
      const r = await probeImageBytes(buf);
      expect(r.success).toBe(false);
    }
  });
});

describe('元数据不等于解码', () => {
  it('截断样本上 metadata 可能成功，但 probe 仍判失败', async () => {
    const cut = await truncatedJpeg();
    // 只读头部的 metadata 可能拿得到尺寸 —— 说明「metadata 成功」不能当解码通过
    const meta = await sharp(cut).metadata().catch(() => null);
    const r = await probeImageBytes(cut);
    expect(r.success).toBe(false);
    // 若 metadata 也失败，这条断言依然成立（只是更强了）
    expect(meta === null || meta.format === 'jpeg').toBe(true);
  });
});

describe('APNG：解码器不报 pages 时的多帧判定（A2 缺口补验）', () => {
  /**
   * 本环境实测 libvips 8.18.6 读 APNG 时 pages=undefined，
   * 只看 pages 会把动画 PNG 当静态图放行。probe 通过字节层
   * looksLikeApng（acTL 块）补上这一路，isMultiFrame 两者都看。
   */
  it('真实 APNG 夹具：animated=true 且 isMultiFrame 判真（尽管 pages=1）', async () => {
    const apng = readFileSync(
      fileURLToPath(new URL('../fixtures/animated/sample-apng.png', import.meta.url)),
    );
    const meta = await sharp(apng).metadata();
    // 先固化前提：解码器确实不报帧数，这正是本用例存在的理由
    expect(meta.pages ?? 1).toBe(1);

    const r = await probeImageBytes(apng);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.animated).toBe(true);
    expect(isMultiFrame(r.data)).toBe(true);
  });
});
