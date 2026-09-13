/**
 * 图片登记、导入与**内容固定**（T20、T21、T52；Alpha A2）。
 *
 * 安全约束：
 * - renderer 只拿到 imageId，永远拿不到真实路径；路径只存在于主进程。
 * - 用户原图**只读**：不写回、不移动、不删除、不改名。
 * - 导入时把「这一次确认过的字节」写进应用私有副本，此后一切（取色、预览、
 *   准备、应用）都只认这份副本 —— 源图在导入后被替换或删除都不影响结果。
 *
 * 为什么必须固定内容（Alpha 修的就是这个）：
 * 旧实现只在准备时记下用户源文件路径，应用时**重新读那个路径**。
 * 用户在中途换掉/删掉源图，就会出现「预览用的是旧图配色，写进安装的是新图」——
 * 预览与生效内容不一致，而且没有任何提示。现在改成：
 *   读入受限字节 → 验证 → 落私有副本 + 记内容 hash → 应用前按同一份字节核对。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { errorResult, fail, ok, type Result } from '../../shared/errors';
import type { ImportedImage, PickedImage } from '../../shared/ipc';
import { DEFAULT_LIMITS, sniffFormat, type ImageLimits } from '../../core/theme/validate';
import { analyzeImage } from '../../core/theme/generate';
import {
  ALLOWED_EXTENSIONS,
  describeExtensionMismatch,
  extensionOf,
  formatIdForExtension,
  IMAGE_FORMATS,
  labelForFormatId,
  SUPPORTED_FORMATS_HINT,
  type ImageFormatId,
} from '../../shared/image-formats';

export { ALLOWED_EXTENSIONS };

/** 文件选择器可注入，测试不需要真的弹对话框 */
export type FilePicker = () => Promise<string[] | null>;

export interface ImageRecord {
  imageId: string;
  /** 用户选择时的文件名，仅用于界面回显 */
  fileName: string;
  /**
   * 用户源文件的路径。**只作为诊断信息保存，绝不再用它读取内容**
   * （A2：读一次、定内容，之后一律走私有副本）。
   */
  sourcePath?: string;
  /** 应用私有副本：本次确认过的字节，后续读取的唯一来源 */
  copyPath?: string;
  /** 本次确认内容的 SHA256（源文件哈希语义与它区分开） */
  contentHash?: string;
  byteSize: number;
  /** 实际内容格式（由内容识别，不看后缀） */
  format?: ImageFormatId;
  width?: number;
  height?: number;
  brightness?: number;
  palette?: string[];
  thumbnailId: string;
  thumbnailPath?: string;
}

export interface ImageStoreOptions {
  /** 运行数据根目录，私有副本与缩略图写在这里 */
  runtimeRoot: string;
  picker: FilePicker;
  limits?: ImageLimits;
  now?: () => string;
}

function newId(prefix: string, now?: () => string): string {
  const stamp = (now ? now() : new Date().toISOString()).replace(/[^0-9A-Za-z]/g, '');
  return `${prefix}-${stamp}-${crypto.randomBytes(4).toString('hex')}`;
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 归档用的扩展名：取该格式的第一个别名（jpeg → jpg） */
function extForFormat(format: ImageFormatId): string {
  const spec = IMAGE_FORMATS.find((f) => f.id === format);
  return `.${spec?.extensions[0] ?? 'png'}`;
}

export class ImageStore {
  private readonly records = new Map<string, ImageRecord>();
  private readonly thumbsDir: string;
  private readonly contentDir: string;
  private readonly limits: ImageLimits;

  constructor(private readonly opts: ImageStoreOptions) {
    this.thumbsDir = path.join(opts.runtimeRoot, 'thumbnails');
    this.contentDir = path.join(opts.runtimeRoot, 'content');
    this.limits = opts.limits ?? DEFAULT_LIMITS;
  }

  /**
   * 弹出系统选择框并登记图片；此阶段只做「后缀 + 体积」的快速筛除，
   * 真正的内容验证与私有副本在 import 阶段完成。
   */
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
      fileName: path.basename(file),
      sourcePath: file,
      byteSize: size,
      thumbnailId: newId('thumb', this.opts.now),
    };
    this.records.set(record.imageId, record);
    return ok({ imageId: record.imageId, fileName: record.fileName, byteSize: record.byteSize });
  }

  /**
   * 拖拽导入：renderer 只交出文件内容和文件名，不交出路径（T52）。
   * 内容同样落私有副本，之后与选图路径完全一致。
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
    this.records.set(imageId, {
      imageId,
      fileName: path.basename(fileName),
      byteSize: data.byteLength,
      thumbnailId: newId('thumb', this.opts.now),
    });
    return this.materialize(imageId, Buffer.from(data));
  }

  /** 解码、取色、落私有副本；返回可安全回显给界面的元信息 */
  async import(imageId: string): Promise<Result<ImportedImage>> {
    const record = this.records.get(imageId);
    if (!record) {
      return fail('IMAGE_NOT_FOUND', '图片记录已失效', '请重新选择图片。');
    }

    // 已经固定过内容：直接回显缓存结果，不再读任何文件
    if (record.copyPath && record.contentHash) {
      return this.describe(record);
    }

    if (!record.sourcePath) {
      return fail('IMAGE_NOT_FOUND', '图片内容不存在', '请重新导入这张图片。');
    }

    /*
     * 按上限读取，而不是先 stat 再整读：从 stat 到读取之间文件可能变大，
     * 只信 stat 会让超大文件被完整读进内存。
     */
    const read = await this.readCapped(record.sourcePath, this.limits.maxBytes);
    if (!read.success) return read;

    return this.materialize(imageId, read.data);
  }

  /**
   * 读取归档/生成要用的字节：一律来自私有副本，并核对其内容指纹。
   * 副本丢失或被改动 → 拒绝使用（调用方据此要求重新导入），绝不用旧参数配新内容。
   *
   * R4 修复：副本读取同样受限额约束——上限是「导入时确认的字节数 + 1」，
   * 多出的 1 字节用于识别「副本被换成更大的文件」。旧实现把副本**整读进内存**
   * 之后才比对体积与 hash：被换大的副本会先完整分配内存再被拒绝，
   * 资源上限承诺在拒绝发生前就已经被打破（受控复现：4 KiB 限额读入 64 KiB）。
   */
  async readBytes(imageId: string): Promise<Result<Buffer>> {
    const record = this.records.get(imageId);
    if (!record) {
      return fail('IMAGE_NOT_FOUND', '图片记录已失效', '请重新选择图片。');
    }
    if (!record.copyPath || !record.contentHash) {
      return fail(
        'IMAGE_CONTENT_MISMATCH',
        '这张图片还没有完成内容固定',
        '请重新导入并等待配色生成完成后再应用。',
      );
    }

    const capped = await this.readCapped(record.copyPath, record.byteSize);
    if (!capped.success) {
      const missing = capped.error.code === 'IMAGE_NOT_FOUND';
      return fail(
        'IMAGE_CONTENT_MISMATCH',
        missing ? '已确认的图片副本不存在' : '已确认的图片副本内容发生了变化',
        '为避免把没预览过的图片写进安装，已拒绝本次操作；请重新导入。',
        capped.error.detail,
      );
    }

    const bytes = capped.data;
    if (bytes.byteLength !== record.byteSize || sha256(bytes) !== record.contentHash) {
      return fail(
        'IMAGE_CONTENT_MISMATCH',
        '已确认的图片副本内容发生了变化',
        '为避免把没预览过的图片写进安装，已拒绝本次操作；请重新导入。',
        `副本 ${record.copyPath}`,
      );
    }
    return ok(bytes);
  }

  /** 缩略图只读上限：工具自己生成的 320px PNG；超过即为异常文件（R4） */
  private static readonly THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

  /**
   * 界面回显用的缩小副本（data URL）。
   *
   * 读取顺序（R3）：
   *   1. 已登记缩略图可读 → 直接用；
   *   2. 缩略图缺失或读不到（含被缓存清理误删的场景）→ 从**已校验私有副本**
   *      回退重建，并尽力把缩略图落盘恢复；不再把「缩略图丢了」误报成
   *      「图片已损坏」；
   *   3. 尚未固定内容的记录 → 仍可从用户源文件生成预览（只读、受限）。
   *
   * R4：所有读取入口都受限额约束——缩略图按自身体积上限读取且必须仍像 PNG；
   * 源文件回退源与导入共用同一套格式/帧数/像素/体积限制（超限在 raw 分配前拒绝）。
   * 错误语义区分（R3）：副本丢失/被改动 = IMAGE_CONTENT_MISMATCH（缓存与副本
   * 问题，重导入即可）；字节读到了但解码失败 = IMAGE_DECODE_FAILED（图片本身
   * 可能损坏）。
   */
  async previewDataUrl(imageId: string): Promise<Result<string>> {
    const record = this.records.get(imageId);
    if (!record) {
      return fail('IMAGE_NOT_FOUND', '图片记录已失效', '请重新选择图片。');
    }
    if (record.thumbnailPath) {
      const thumb = await this.readThumbnail(record.thumbnailPath);
      if (thumb.success) {
        return ok(`data:image/png;base64,${thumb.data.toString('base64')}`);
      }
      // 缩略图失效（缺失/超限/内容异常）：清掉标记，走下面的回退重建
      record.thumbnailPath = undefined;
    }

    if (record.copyPath && record.contentHash) {
      const source = await this.readBytes(imageId);
      if (!source.success) return source;
      return this.renderPreview(record, source.data);
    }

    if (record.sourcePath) {
      const read = await this.readCapped(record.sourcePath, this.limits.maxBytes);
      if (!read.success) {
        return fail(
          'IMAGE_NOT_FOUND',
          '无法读取该图片',
          '文件可能已被移动或删除，请重新选择。',
          read.error.detail,
        );
      }
      // R4：回退源与导入共用 analyzeImage 的格式/帧数/像素/体积限制
      const analyzed = await analyzeImage(read.data, this.limits);
      if (!analyzed.success) return analyzed;
      return this.renderPreview(record, read.data);
    }

    return fail('IMAGE_NOT_FOUND', '图片内容不存在', '请重新导入这张图片。');
  }

  /** 缩略图受限读取：体积上限 + 必须仍是我们生成的 PNG，否则按缺失处理 */
  private async readThumbnail(file: string): Promise<Result<Buffer>> {
    const capped = await this.readCapped(file, ImageStore.THUMBNAIL_MAX_BYTES);
    if (!capped.success) return capped;
    if (sniffFormat(capped.data) !== 'png') {
      return fail('IMAGE_INVALID_FORMAT', '缩略图内容异常', '');
    }
    return capped;
  }

  /** 用源字节生成 512 预览；同时尽力恢复 320 缩略图文件（恢复失败不阻断预览） */
  private async renderPreview(record: ImageRecord, source: Buffer): Promise<Result<string>> {
    try {
      const buf = await sharp(source, { limitInputPixels: this.limits.maxPixels })
        .rotate()
        .resize(512, 512, { fit: 'inside' })
        .png()
        .toBuffer();
      try {
        await fs.mkdir(this.thumbsDir, { recursive: true });
        const thumbnailPath = path.join(this.thumbsDir, `${record.thumbnailId}.png`);
        await sharp(source, { limitInputPixels: this.limits.maxPixels })
          .rotate()
          .resize(320, 320, { fit: 'inside' })
          .png()
          .toFile(thumbnailPath);
        record.thumbnailPath = thumbnailPath;
      } catch {
        // 缩略图文件恢复失败不影响本次预览结果
      }
      return ok(`data:image/png;base64,${buf.toString('base64')}`);
    } catch (e) {
      return fail('IMAGE_DECODE_FAILED', '无法生成预览图', '图片可能已损坏，请换一张。', String(e));
    }
  }

  /**
   * 清理没人引用的私有副本与缩略图（启动时调用）。
   *
   * 只动本工具自己的两个目录，**不递归、不触碰用户目录**。
   * R3 修复：content 与 thumbnail 的保留集合**分开**计算，并且：
   *   - content：文件名去扩展名后与 imageId **精确相等**才算引用
   *     （imageId 来自调用方 keep 与内存 records；后者同时覆盖「导入进行中」，
   *     先登记后写文件的顺序保证清理不会删掉正在写入的副本），
   *     另加内存 records 的 copyPath 规范化路径兜底；
   *   - thumbnail：只认内存 records 的 thumbnailPath 规范化路径与 thumbnailId。
   *     旧实现用 imageId 前缀猜关联，而缩略图文件名是独立的 thumb-… 命名，
   *     永远匹配不上 → 在用缩略图被当孤儿删除、预览误报「图片已损坏」。
   *     重启后 keep 引用的 imageId 无法反推 thumbnailId（未持久化关联），
   *     其缩略图允许被清 —— 预览会从已校验私有副本回退重建（派生数据）。
   */
  async cleanOrphanCaches(keep: Iterable<string>): Promise<number> {
    const keepContentIds = new Set<string>([...keep, ...this.records.keys()]);
    const keepThumbIds = new Set<string>();
    const keepContentPaths = new Set<string>();
    const keepThumbPaths = new Set<string>();
    for (const r of this.records.values()) {
      if (r.copyPath) keepContentPaths.add(path.resolve(r.copyPath));
      if (r.thumbnailPath) keepThumbPaths.add(path.resolve(r.thumbnailPath));
      keepThumbIds.add(r.thumbnailId);
    }

    let removed = 0;
    for (const [dir, ids, paths] of [
      [this.contentDir, keepContentIds, keepContentPaths],
      [this.thumbsDir, keepThumbIds, keepThumbPaths],
    ] as const) {
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const id = name.replace(/\.[^.]+$/, '');
        if (ids.has(id) || paths.has(path.resolve(dir, name))) continue;
        try {
          await fs.rm(path.join(dir, name), { force: true });
          removed += 1;
        } catch {
          // 删不掉就留着，下次再清
        }
      }
    }
    return removed;
  }

  /** 只给主进程内部用的元信息，不含对外 IPC 数据 */
  peek(imageId: string): ImageRecord | undefined {
    return this.records.get(imageId);
  }

  // ---------------------------------------------------------------- 内部实现

  /**
   * 验证 + 固定内容：分析、写私有副本、算内容指纹、生成缩略图。
   * 任何一步失败都会清掉本次产生的文件，不留下半个副本。
   */
  private async materialize(imageId: string, bytes: Buffer): Promise<Result<ImportedImage>> {
    const record = this.records.get(imageId);
    if (!record) {
      return fail('IMAGE_NOT_FOUND', '图片记录已失效', '请重新选择图片。');
    }

    const analyzed = await analyzeImage(bytes, this.limits);
    if (!analyzed.success) {
      await this.discard(imageId);
      return analyzed;
    }

    const format = formatIdForExtension(analyzed.data.format);
    if (!format) {
      await this.discard(imageId);
      return fail('IMAGE_INVALID_FORMAT', '无法识别图片格式', `请使用 ${SUPPORTED_FORMATS_HINT}。`);
    }

    const copyPath = path.join(this.contentDir, `${imageId}${extForFormat(format)}`);
    const thumbnailPath = path.join(this.thumbsDir, `${record.thumbnailId}.png`);
    try {
      await fs.mkdir(this.contentDir, { recursive: true });
      await fs.writeFile(copyPath, bytes);

      // 缩略图失败不阻断主流程，但也不写回原图路径
      try {
        await fs.mkdir(this.thumbsDir, { recursive: true });
        await sharp(bytes, { limitInputPixels: this.limits.maxPixels })
          .rotate()
          .resize(320, 320, { fit: 'inside' })
          .png()
          .toFile(thumbnailPath);
        record.thumbnailPath = thumbnailPath;
      } catch {
        record.thumbnailPath = undefined;
      }
    } catch (e) {
      await this.discard(imageId);
      return fail('IMAGE_DECODE_FAILED', '无法保存图片副本', '请重试或换一张图片。', String(e));
    }

    record.copyPath = copyPath;
    record.contentHash = sha256(bytes);
    record.byteSize = bytes.byteLength;
    record.format = format;
    record.width = analyzed.data.width;
    record.height = analyzed.data.height;
    record.brightness = analyzed.data.brightness;
    record.palette = analyzed.data.palette;

    return this.describe(record);
  }

  /** 汇总回显信息（同时给出后缀与实际内容不一致时的说明） */
  private describe(record: ImageRecord): Result<ImportedImage> {
    if (!record.copyPath || !record.contentHash || !record.format) {
      return fail('IMAGE_CONTENT_MISMATCH', '这张图片还没有完成内容固定', '请重新导入该图片。');
    }
    const mismatch = describeExtensionMismatch(record.fileName, record.format);
    return ok({
      imageId: record.imageId,
      hash: record.contentHash,
      width: record.width ?? 0,
      height: record.height ?? 0,
      thumbnailId: record.thumbnailId,
      palette: record.palette ?? [],
      format: record.format,
      formatLabel: labelForFormatId(record.format),
      ...(mismatch ? { note: mismatch } : {}),
    });
  }

  /** 清掉本次导入自己产生的文件（副本 + 缩略图），不碰用户目录 */
  private async discard(imageId: string): Promise<void> {
    const record = this.records.get(imageId);
    if (!record) return;
    if (record.copyPath) {
      await fs.rm(record.copyPath, { force: true }).catch(() => undefined);
      record.copyPath = undefined;
    }
    await fs.rm(path.join(this.thumbsDir, `${record.thumbnailId}.png`), { force: true }).catch(
      () => undefined,
    );
    record.thumbnailPath = undefined;
  }

  /**
   * 按上限读取文件：最多读 maxBytes + 1 字节。
   * 多出来的那 1 字节用来判断「读到这里还没完」——说明文件超限，直接拒绝，
   * 不会把整个超大文件读进内存。
   *
   * R4 修复：循环处理短读直到 EOF。单次 handle.read 不保证读满请求的字节数，
   * 旧实现把「一次没读满」当成文件结束，可能把大文件静默截断成小图。
   */
  private async readCapped(file: string, maxBytes: number): Promise<Result<Buffer>> {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(file, 'r');
      const buf = Buffer.alloc(maxBytes + 1);
      let total = 0;
      while (total < maxBytes + 1) {
        const { bytesRead } = await handle.read(buf, total, maxBytes + 1 - total, null);
        if (bytesRead <= 0) break; // EOF
        total += bytesRead;
      }
      if (total > maxBytes) {
        const mb = (maxBytes / 1024 / 1024).toFixed(0);
        return fail(
          'IMAGE_TOO_LARGE',
          `图片体积超过限制（上限 ${mb} MiB）`,
          '请压缩图片或选择更小的文件。',
        );
      }
      return ok(buf.subarray(0, total));
    } catch (e) {
      return fail('IMAGE_NOT_FOUND', '无法读取该图片', '文件可能已被移动或删除，请重新选择。', String(e));
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}
