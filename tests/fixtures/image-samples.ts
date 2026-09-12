/**
 * 图片测试样本（T2）。
 *
 * 全部**程序生成**，不依赖任何私人图片：JPEG / PNG / WebP 用 sharp 现编码，
 * JFIF 容器样本在有效 JPEG 前插入符合规范的 APP0/JFIF 段
 * （sharp 自身不输出 JFIF 标记，但 .jfif 文件就是这么构成的），
 * 另附截断、空文件、SVG 伪装、超大等异常样本。
 *
 * 每个通过性样本都可选择带 JFIF 标记，用来验证「同一份字节换个后缀照样能进」。
 */
import sharp, { type Sharp } from 'sharp';

export interface ImageSample {
  fileName: string;
  bytes: Buffer;
}

/** APP0/JFIF 段：FF E0 + 长度(16) + 'JFIF\0' + 版本 1.1 + 无单位 + 1x1 dpi + 无缩略图 */
const JFIF_APP0 = Buffer.from([
  0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
  0x00, 0x00,
]);

/** 该字节串是否是带 JFIF 容器标记的 JPEG */
export function hasJfifMarker(bytes: Buffer): boolean {
  return (
    bytes.length > 18 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes[3] === 0xe0 &&
    bytes.subarray(6, 10).toString('latin1') === 'JFIF'
  );
}

/** 在 SOI 之后插入 JFIF APP0，得到标准 JFIF 容器 */
export function withJfifHeader(jpeg: Buffer): Buffer {
  if (hasJfifMarker(jpeg)) return jpeg;
  return Buffer.concat([jpeg.subarray(0, 2), JFIF_APP0, jpeg.subarray(2)]);
}

export interface MakeOptions {
  width?: number;
  height?: number;
  color?: { r: number; g: number; b: number };
  /** 是否构造成 JFIF 容器（.jfif 文件的实际形态） */
  jfif?: boolean;
  /** 叠加一层不同的色块，保证取色不是单色退化 */
  accent?: boolean;
}

async function base(options: MakeOptions = {}): Promise<Sharp> {
  const width = options.width ?? 96;
  const height = options.height ?? 64;
  const color = options.color ?? { r: 32, g: 96, b: 176 };
  const img = sharp({ create: { width, height, channels: 3, background: color } });
  if (!options.accent) return img;
  const accent = await sharp({
    create: { width: width / 2, height: height / 2, channels: 3, background: { r: 240, g: 200, b: 60 } },
  })
    .png()
    .toBuffer();
  return sharp(await img.png().toBuffer()).composite([{ input: accent, top: 8, left: 8 }]);
}

/** 有效 JPEG；options.jfif 为真时带 JFIF 容器标记 */
export async function jpegBytes(options: MakeOptions = {}): Promise<Buffer> {
  const encoded = await (await base(options)).jpeg({ quality: 82 }).toBuffer();
  return options.jfif ? withJfifHeader(encoded) : encoded;
}

export async function pngBytes(options: MakeOptions = {}): Promise<Buffer> {
  return (await base(options)).png().toBuffer();
}

export async function webpBytes(options: MakeOptions = {}): Promise<Buffer> {
  return (await base(options)).webp().toBuffer();
}

/** 同一份 JPEG 字节、不同别名（含大写与中文名） */
export async function jpegAliasSamples(): Promise<ImageSample[]> {
  const bytes = await jpegBytes({ jfif: true, accent: true });
  return [
    { fileName: 'wallpaper.jpg', bytes },
    { fileName: 'wallpaper.jpeg', bytes },
    { fileName: 'wallpaper.jfif', bytes },
    { fileName: 'wallpaper.JFIF', bytes },
    { fileName: 'wallpaper.jpe', bytes },
    { fileName: '壁纸示例.JFIF', bytes },
  ];
}

/** 截断的 JPEG：头部合法、数据不全 */
export async function truncatedJpeg(): Promise<Buffer> {
  const bytes = await jpegBytes({ accent: true });
  return bytes.subarray(0, Math.floor(bytes.length * 0.4));
}

/** 空文件 */
export function emptyBytes(): Buffer {
  return Buffer.alloc(0);
}

/** 文本内容伪装成图片后缀 */
export function textDisguised(): Buffer {
  return Buffer.from('这不是图片，只是一段文本。\n', 'utf8');
}

/** SVG 伪装成受支持后缀 */
export function svgDisguised(): Buffer {
  return Buffer.from(
    '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    'utf8',
  );
}

/** 超过体积上限（20 MiB）的「图片」：头部是 JPEG，后面用零填充 */
export async function oversizedJpeg(mb = 21): Promise<Buffer> {
  const head = await jpegBytes();
  return Buffer.concat([head, Buffer.alloc(mb * 1024 * 1024)]);
}
