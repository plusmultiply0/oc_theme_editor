/**
 * 图片核验探测（Alpha A3）。
 *
 * 为什么单独一层：核验脚本原来把「首字节像不像 PNG/JPEG」当成「可解码」，
 * 于是只剩头部的残图也能拿到一个 OK。这里把两件事彻底分开：
 *
 *   1. `headerFormat`：只看 magic bytes 的**识别**结果；
 *   2. `decoded`：真的让解码器把像素解出来，并给出实际格式、尺寸、帧数。
 *
 * 只有解码成功才算通过；识别成功但解码失败（截断、损坏）必须判失败。
 * 元数据读取（metadata）不算解码：它可能只读头部就返回。
 */
import crypto from 'node:crypto';
import sharp from 'sharp';
import { fail, ok, type Result } from '../../shared/errors';
import { looksLikeSvg, sniffFormat } from './validate';

export interface ImageProbe {
  /** 仅凭文件头识别出的格式；无法识别为 null */
  headerFormat: string | null;
  /** 是否完整解码成功 */
  decoded: boolean;
  /** 解码器报告的实际格式（如 jpeg / png / webp） */
  format?: string;
  width?: number;
  height?: number;
  /** 帧数：> 1 表示动图 */
  pages?: number;
  bytes: number;
  sha256: string;
}

/** 完整解码一份图片字节；失败时给出中文原因 */
export async function probeImageBytes(buf: Buffer): Promise<Result<ImageProbe>> {
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const headerFormat = sniffFormat(buf);

  /*
   * SVG 要在这里就挡住：sharp 自带的 SVG 解码器能把矢量图解成像素，
   * 若只看「解码是否成功」，一张 SVG 会被判为可用背景 ——
   * 而本工具明确不把 SVG 当作受支持格式（见 validate.ts）。
   */
  if (looksLikeSvg(buf)) {
    return fail('IMAGE_INVALID_FORMAT', '不支持 SVG 图片', '请改用位图：PNG、JPEG 或 WebP。');
  }

  let meta;
  try {
    meta = await sharp(buf).metadata();
  } catch (e) {
    return fail(
      'IMAGE_DECODE_FAILED',
      '图片无法解码（文件可能已损坏或被截断）',
      '请重新导出该图片后再试。',
      e instanceof Error ? e.message : String(e),
    );
  }

  /*
   * 真正解码像素：metadata 只读头部，残图也可能拿到尺寸。
   * 这里要求解码器把全部像素吐出来，失败即判失败。
   */
  try {
    const { info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    return ok({
      headerFormat,
      decoded: true,
      ...(meta.format ? { format: meta.format } : {}),
      width: info.width,
      height: info.height,
      pages: meta.pages ?? 1,
      bytes: buf.byteLength,
      sha256,
    });
  } catch (e) {
    return fail(
      'IMAGE_DECODE_FAILED',
      '图片只有文件头能被识别，像素解码失败',
      '文件很可能被截断；请换用完整图片。',
      e instanceof Error ? e.message : String(e),
    );
  }
}

/** 帧数 > 1 视为动图（Alpha 不支持） */
export function isMultiFrame(probe: ImageProbe): boolean {
  return (probe.pages ?? 1) > 1;
}
