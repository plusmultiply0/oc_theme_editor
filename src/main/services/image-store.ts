/**
 * 图片登记与导入（T20、T21、T52）。
 *
 * 安全约束：
 * - renderer 只拿到 imageId，永远拿不到真实路径；路径只存在于主进程。
 * - 原图只读：只读取内容，不写回、不移动、不删除。
 * - 分析用缩小副本写到用户数据目录，不污染原图所在目录。
 * - 导入新图会作废上一次的分析结果，避免旧结果覆盖新图（T52）。
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { errorResult, fail, ok, type Result } from '../../shared/errors';
import type { ImportedImage, PickedImage } from '../../shared/ipc';
import { DEFAULT_LIMITS, type ImageLimits } from '../../core/theme/validate';
import { analyzeImage } from '../../core/theme/generate';
import {
  ALLOWED_EXTENSIONS,
  describeExtensionMismatch,
  extensionOf,
  formatIdForExtension,
  labelForFormatId,
  SUPPORTED_FORMATS_HINT,
} from '../../shared/image-formats';

export { ALLOWED_EXTENSIONS };

/** 文件选择器可注入，测试不需要真的弹对话框 */
export type FilePicker = () => Promise<string[] | null>;

export interface ImageRecord {
  imageId: string;
  /** 原图真实路径，仅主进程持有，绝不通过 IPC 外传 */
  path: string;
  fileName: string;
  byteSize: number;
  hash?: string;
  width?: number;
  height?: number;
  format?: string;
  brightness?: number;
  palette?: string[];
  thumbnailId: string;
  thumbnailPath?: string;
}

export interface ImageStoreOptions {
  /** 运行数据根目录，缩略图写在这里 */
  runtimeRoot: string;
  picker: FilePicker;
  limits?: ImageLimits;
  now?: () => string;
}

function newId(prefix: string, now?: () => string): string {
  const stamp = (now ? now() : new Date().toISOString()).replace(/[^0-9A-Za-z]/g, '');
  return `${prefix}-${stamp}-${crypto.randomBytes(4).toString('hex')}`;
}

export class ImageStore {
  private readonly records = new Map<string, ImageRecord>();
  private readonly thumbsDir: string;
  private readonly limits: ImageLimits;

  constructor(private readonly opts: ImageStoreOptions) {
    this.thumbsDir = path.join(opts.runtimeRoot, 'thumbnails');
    this.limits = opts.limits ?? DEFAULT_LIMITS;
  }

  /** 弹出系统选择框并登记图片；此处只做登记，解码在 import 阶段 */
  async pick(): Promise<Result<PickedImage>> {
    let picked: string[] | null;
    try {
      picked = await this.opts.picker();
    } catch (e) {
      return errorResult(e, 'IMAGE_NOT_FOUND');
    }
    if (!picked || picked.length === 0) {
      return fail('IMAGE_NOT_FOUND', '未选择任何图片', '请重新选择一张本地图片。');
    }

    const file = picked[0];
    const ext = extensionOf(file);
    if (formatIdForExtension(ext) === null) {
      return fail(
        'IMAGE_INVALID_FORMAT',
        `不支持的文件类型 ${ext || '（无扩展名）'}`,
        `请选择 ${SUPPORTED_FORMATS_HINT} 格式的图片。`,
      );
    }

    let size = 0;
    try {
      size = (await fs.stat(file)).size;
    } catch (e) {
      return fail('IMAGE_NOT_FOUND', '文件不存在或无法读取', '请重新选择图片。', String(e));
    }
    if (size > this.limits.maxBytes) {
      const mb = (this.limits.maxBytes / 1024 / 1024).toFixed(0);
      return fail(
        'IMAGE_TOO_LARGE',
        `图片体积超过限制（${(size / 1024 / 1024).toFixed(1)} MiB，上限 ${mb} MiB）`,
        '请压缩图片或选择更小的文件。',
      );
    }

    const record: ImageRecord = {
      imageId: newId('img', this.opts.now),
      path: file,
      fileName: path.basename(file),
      byteSize: size,
      thumbnailId: newId('thumb', this.opts.now),
    };
    this.records.set(record.imageId, record);
    return ok({ imageId: record.imageId, fileName: record.fileName, byteSize: record.byteSize });
  }

  /**
   * 拖拽导入：renderer 只交出文件内容和文件名，不交出路径（T52）。
   * 内容落在运行数据目录，后续读取与预览都走这条副本，原文件不再被引用。
   */
  async importData(fileName: string, data: Uint8Array): Promise<Result<ImportedImage>> {
    const ext = extensionOf(fileName);
    if (formatIdForExtension(ext) === null) {
      return fail(
        'IMAGE_INVALID_FORMAT',
        `不支持的文件类型 ${ext || '（无扩展名）'}`,
        `请拖入 ${SUPPORTED_FORMATS_HINT} 格式的图片。`,
      );
    }
    if (data.byteLength > this.limits.maxBytes) {
      const mb = (this.limits.maxBytes / 1024 / 1024).toFixed(0);
      return fail(
        'IMAGE_TOO_LARGE',
        `图片体积超过限制（${(data.byteLength / 1024 / 1024).toFixed(1)} MiB，上限 ${mb} MiB）`,
        '请压缩图片或选择更小的文件。',
      );
    }

    const imageId = newId('img', this.opts.now);
    const dir = path.join(this.opts.runtimeRoot, 'imports');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${imageId}${ext}`);
    await fs.writeFile(file, Buffer.from(data));

    this.records.set(imageId, {
      imageId,
      path: file,
      fileName: path.basename(fileName),
      byteSize: data.byteLength,
      thumbnailId: newId('thumb', this.opts.now),
    });
    return this.import(imageId);
  }

  /** 解码、取色、写缩略图；返回可安全回显给界面的元信息 */
  async import(imageId: string): Promise<Result<ImportedImage>> {
    const record = this.records.get(imageId);
    if (!record) {
      return fail('IMAGE_NOT_FOUND', '图片记录已失效', '请重新选择图片。');
    }

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(record.path);
    } catch (e) {
      return fail('IMAGE_NOT_FOUND', '无法读取该图片', '文件可能已被移动或删除，请重新选择。', String(e));
    }

    const analyzed = await analyzeImage(buffer, this.limits);
    if (!analyzed.success) {
      return analyzed;
    }

    record.hash = crypto.createHash('sha256').update(buffer).digest('hex');
    record.width = analyzed.data.width;
    record.height = analyzed.data.height;
    record.format = analyzed.data.format;
    record.brightness = analyzed.data.brightness;
    record.palette = analyzed.data.palette;

    // 缩略图只用于界面回显，失败不阻断主流程
    try {
      await fs.mkdir(this.thumbsDir, { recursive: true });
      const file = path.join(this.thumbsDir, `${record.thumbnailId}.png`);
      await sharp(buffer).rotate().resize(320, 320, { fit: 'inside' }).png().toFile(file);
      record.thumbnailPath = file;
    } catch {
      record.thumbnailPath = undefined;
    }

    /*
     * 实际格式以内容识别为准（扩展名只做筛选）。
     * 后缀与实际内容都是受支持格式但不一致时，如实告知，不静默按后缀解释。
     */
    const actual = formatIdForExtension(analyzed.data.format);
    const mismatch = describeExtensionMismatch(record.fileName, actual);
    return ok({
      imageId,
      hash: record.hash,
      width: record.width,
      height: record.height,
      thumbnailId: record.thumbnailId,
      palette: analyzed.data.palette,
      ...(actual ? { format: actual, formatLabel: labelForFormatId(actual) } : {}),
      ...(mismatch ? { note: mismatch } : {}),
    });
  }

  /** 读取原图内容；应用阶段需要它写入归档 */
  async readBytes(imageId: string): Promise<Result<Buffer>> {
    const record = this.records.get(imageId);
    if (!record) {
      return fail('IMAGE_NOT_FOUND', '图片记录已失效', '请重新选择图片。');
    }
    try {
      return ok(await fs.readFile(record.path));
    } catch (e) {
      return fail('IMAGE_NOT_FOUND', '无法读取该图片', '文件可能已被移动或删除，请重新选择。', String(e));
    }
  }

  /**
   * 界面回显用的缩小副本（data URL）。
   * 只用工具自己生成的缩略图；即便缩略图没写成功，也在内存里临时缩一张，
   * 总之不会把原图路径交给 renderer。
   */
  async previewDataUrl(imageId: string): Promise<Result<string>> {
    const record = this.records.get(imageId);
    if (!record) {
      return fail('IMAGE_NOT_FOUND', '图片记录已失效', '请重新选择图片。');
    }
    try {
      if (record.thumbnailPath) {
        const buf = await fs.readFile(record.thumbnailPath);
        return ok(`data:image/png;base64,${buf.toString('base64')}`);
      }
      const original = await fs.readFile(record.path);
      const buf = await sharp(original).rotate().resize(512, 512, { fit: 'inside' }).png().toBuffer();
      return ok(`data:image/png;base64,${buf.toString('base64')}`);
    } catch (e) {
      return fail('IMAGE_DECODE_FAILED', '无法生成预览图', '图片可能已损坏，请换一张。', String(e));
    }
  }

  /** 只给主进程内部用的元信息，不含路径之外的 IPC 数据 */
  peek(imageId: string): ImageRecord | undefined {
    return this.records.get(imageId);
  }
}
