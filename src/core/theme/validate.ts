/**
 * 图片校验（T20）：校验 magic bytes 与实际解码，不只检查扩展名。
 * 本文件保持纯函数，便于单元测试，不引入解码库。
 */
import { fail, ok, type Result } from '../../shared/errors';

export const DEFAULT_LIMITS = {
  /** 文件体积上限：20 MiB */
  maxBytes: 20 * 1024 * 1024,
  /** 解码后像素上限：40 MP */
  maxPixels: 40_000_000,
} as const;

export type ImageFormat = 'png' | 'jpeg' | 'webp';

export interface ImageLimits {
  maxBytes: number;
  maxPixels: number;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];

/** 依据文件头判断格式，不信任扩展名。无法识别返回 null。 */
export function sniffFormat(buf: Buffer | Uint8Array): ImageFormat | null {
  if (buf.length < 12) return null;
  if (PNG.every((b, i) => buf[i] === b)) return 'png';
  if (JPEG.every((b, i) => buf[i] === b)) return 'jpeg';
  // WebP: 'RIFF' + 4 字节长度 + 'WEBP'
  const isWebp =
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
  if (isWebp) return 'webp';
  return null;
}

/**
 * 多帧判定（Alpha 的动图策略）。
 *
 * 本轮**明确拒绝**动图：一边按第一帧预览、一边把动图原字节写进安装，
 * 会让「你确认的图」和「实际生效的图」不一致。
 * 首帧静态化属于后续版本，不在 Alpha 范围内。
 *
 * 拿不到帧数（undefined）按单帧处理：静态 PNG/JPEG/WebP 不会带 pages。
 */
export function isAnimatedFrameCount(pages: number | undefined): boolean {
  return typeof pages === 'number' && pages > 1;
}

/** SVG 是文本，可能被当作图片上传后引发解析差异，首版明确拒绝。 */
export function looksLikeSvg(buf: Buffer | Uint8Array): boolean {
  const head = Buffer.from(buf.subarray(0, 512)).toString('utf8').toLowerCase();
  return head.includes('<svg') || (head.includes('<?xml') && head.includes('svg'));
}

export interface ValidateInput {
  bytes: number;
  /** 解码后的宽高，由解码库提供；仅在做像素校验时必填 */
  width?: number;
  height?: number;
}

/**
 * 校验体积与像素规模。返回 Result，失败时给出中文原因与下一步建议。
 */
export function validateImage(
  input: ValidateInput,
  limits: ImageLimits = DEFAULT_LIMITS,
): Result<{ bytes: number; pixels: number }> {
  if (!Number.isFinite(input.bytes) || input.bytes <= 0) {
    return fail('IMAGE_INVALID_FORMAT', '文件为空或无法读取', '请选择一个有效的图片文件。');
  }
  if (input.bytes > limits.maxBytes) {
    const mb = (limits.maxBytes / 1024 / 1024).toFixed(0);
    return fail(
      'IMAGE_TOO_LARGE',
      `图片体积超过限制（上限 ${mb} MiB）`,
      '请压缩图片或选择更小的文件后重试。',
    );
  }
  const pixels =
    input.width && input.height ? input.width * input.height : 0;
  if (pixels > limits.maxPixels) {
    const mp = (limits.maxPixels / 1_000_000).toFixed(0);
    return fail(
      'IMAGE_TOO_LARGE',
      `图片尺寸超过限制（解码后上限 ${mp} MP）`,
      '请使用分辨率更低的图片。',
    );
  }
  return ok({ bytes: input.bytes, pixels });
}
